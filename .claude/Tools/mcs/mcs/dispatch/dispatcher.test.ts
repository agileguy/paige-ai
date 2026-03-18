/**
 * dispatcher.test.ts — Unit tests for Phase 1B dispatch components
 *
 * Tests cover:
 *  - dispatcher.ts  : dispatch tick logic (claims, priority, deps, caps, routing)
 *  - claim-watchdog.ts : expired claim release
 *  - retry-scheduler.ts : exponential backoff and permanent failure
 *  - startup-recovery.ts : stale task release on startup
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test internal logic directly by importing the modules
// and calling their exported functions with a temp in-memory (or temp-file) DB.

import { dispatchTick, stopDispatcher } from "./dispatcher.ts";
import { claimWatchdogTick, stopClaimWatchdog } from "./claim-watchdog.ts";
import { scheduleRetry, calcBackoffSeconds } from "./retry-scheduler.ts";
import { recoverStaleTasks } from "./startup-recovery.ts";

// ---------------------------------------------------------------------------
// Helper: create an in-memory test database with MCS schema
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 2,
      payload TEXT NOT NULL DEFAULT '{}',
      caps_required TEXT NOT NULL DEFAULT '[]',
      routing_hint TEXT NOT NULL DEFAULT 'any',
      created_by TEXT NOT NULL DEFAULT 'test',
      assigned_to TEXT,
      max_retries INTEGER NOT NULL DEFAULT 3,
      attempt INTEGER NOT NULL DEFAULT 0,
      claim_ttl_seconds INTEGER NOT NULL DEFAULT 300,
      claimed_at TEXT,
      claim_expires_at TEXT,
      retry_after TEXT,
      idempotency_key TEXT UNIQUE,
      notify_url TEXT,
      result_status TEXT,
      result_output TEXT,
      result_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      capabilities TEXT NOT NULL DEFAULT '[]',
      notify_url TEXT,
      current_load INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE task_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Helper: insert a task
// ---------------------------------------------------------------------------

interface InsertTaskOpts {
  id: string;
  status?: string;
  priority?: number;
  caps_required?: string;
  routing_hint?: string;
  attempt?: number;
  claim_ttl_seconds?: number;
  claimed_at?: string | null;
  claim_expires_at?: string | null;
  retry_after?: string | null;
  assigned_to?: string | null;
}

function insertTask(db: Database, opts: InsertTaskOpts): void {
  db.prepare(
    `INSERT INTO tasks (id, type, status, priority, caps_required, routing_hint, attempt,
                        claim_ttl_seconds, claimed_at, claim_expires_at, retry_after, assigned_to,
                        created_by, payload)
     VALUES (?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', '{}')`
  ).run(
    opts.id,
    opts.status ?? "pending",
    opts.priority ?? 2,
    opts.caps_required ?? "[]",
    opts.routing_hint ?? "any",
    opts.attempt ?? 0,
    opts.claim_ttl_seconds ?? 300,
    opts.claimed_at ?? null,
    opts.claim_expires_at ?? null,
    opts.retry_after ?? null,
    opts.assigned_to ?? null
  );
}

// ---------------------------------------------------------------------------
// Helper: insert an agent
// ---------------------------------------------------------------------------

interface InsertAgentOpts {
  agent_id: string;
  capabilities?: string;
  current_load?: number;
  expires_at?: string; // default: far future
}

function insertAgent(db: Database, opts: InsertAgentOpts): void {
  db.prepare(
    `INSERT INTO agents (agent_id, capabilities, current_load, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(
    opts.agent_id,
    opts.capabilities ?? "[]",
    opts.current_load ?? 0,
    opts.expires_at ?? "2099-12-31 23:59:59"
  );
}

// ---------------------------------------------------------------------------
// Helper: get task from DB
// ---------------------------------------------------------------------------

function getTask(db: Database, id: string) {
  return db
    .query<Record<string, unknown>, [string]>("SELECT * FROM tasks WHERE id = ?")
    .get(id);
}

function getAgent(db: Database, id: string) {
  return db
    .query<Record<string, unknown>, [string]>("SELECT * FROM agents WHERE agent_id = ?")
    .get(id);
}

function getAuditEvents(db: Database, taskId: string) {
  return db
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM task_audit_log WHERE task_id = ? ORDER BY id ASC"
    )
    .all(taskId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchTick", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    stopDispatcher(); // Ensure no interval is running from a prior test
  });

  afterEach(() => {
    db.close();
    stopDispatcher();
    stopClaimWatchdog();
  });

  // -------------------------------------------------------------------------
  // Test 1: Dispatcher claims a pending task to an active agent
  // -------------------------------------------------------------------------
  test("claims a pending task to an eligible active agent", () => {
    insertTask(db, { id: "t1" });
    insertAgent(db, { agent_id: "ocasia" });

    dispatchTick(db);

    const task = getTask(db, "t1")!;
    expect(task.status).toBe("claimed");
    expect(task.assigned_to).toBe("ocasia");
    expect(task.claimed_at).not.toBeNull();
    expect(task.claim_expires_at).not.toBeNull();
    expect(task.attempt).toBe(1);

    const audit = getAuditEvents(db, "t1");
    expect(audit.length).toBe(1);
    expect(audit[0]!.event_type).toBe("claimed");
    expect(audit[0]!.agent_id).toBe("ocasia");

    const agent = getAgent(db, "ocasia")!;
    expect(agent.current_load).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: Dispatcher respects priority ordering (urgent before normal)
  // -------------------------------------------------------------------------
  test("processes urgent tasks before normal tasks", () => {
    // Use two agents with different routing hints so we can observe ORDER
    // by checking claimed_at timestamps — but since SQLite datetime resolution
    // is 1 second, a better approach is: route each task to a specific agent
    // and verify the urgent one was claimed while normal stays pending when
    // the urgent agent is the only one eligible.
    //
    // Insert normal first, then urgent.
    // Only route urgent to agent1; normal is "any" but there is only agent1.
    // After tick: both claimed, but we verify urgent task attempt incremented
    // and both were claimed in priority order by checking audit log ordering.
    insertTask(db, { id: "normal-task", priority: 2 });
    insertTask(db, { id: "urgent-task", priority: 1 });
    insertAgent(db, { agent_id: "agent1", current_load: 0 });

    // Run tick — dispatcher processes tasks in priority order
    dispatchTick(db);

    // Both tasks will be claimed in a single tick (one agent, two tasks).
    // Verify both are claimed and the audit log shows urgent before normal.
    const urgentTask = getTask(db, "urgent-task")!;
    expect(urgentTask.status).toBe("claimed");

    // Check audit log — urgent task audit entry should have lower id (inserted first)
    const allAudit = db
      .query<{ task_id: string; id: number }, []>(
        "SELECT task_id, id FROM task_audit_log ORDER BY id ASC"
      )
      .all();

    const urgentAuditIdx = allAudit.findIndex((e) => e.task_id === "urgent-task");
    const normalAuditIdx = allAudit.findIndex((e) => e.task_id === "normal-task");

    // Urgent must have been audited (claimed) before normal
    expect(urgentAuditIdx).toBeLessThan(normalAuditIdx);
  });

  // -------------------------------------------------------------------------
  // Test 3: Dispatcher skips tasks with unmet dependencies
  // -------------------------------------------------------------------------
  test("skips a task whose dependencies are not yet completed", () => {
    insertTask(db, { id: "dep-task", status: "claimed" }); // not completed
    insertTask(db, { id: "dependent", priority: 2 });
    db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)"
    ).run("dependent", "dep-task");
    insertAgent(db, { agent_id: "agent1" });

    dispatchTick(db);

    const task = getTask(db, "dependent")!;
    expect(task.status).toBe("pending"); // still pending — dep not done
  });

  // -------------------------------------------------------------------------
  // Test 4: Dispatcher fails tasks whose dependencies failed
  // -------------------------------------------------------------------------
  test("fails a task when a dependency has failed", () => {
    insertTask(db, { id: "failed-dep", status: "failed" });
    insertTask(db, { id: "blocked-task" });
    db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)"
    ).run("blocked-task", "failed-dep");
    insertAgent(db, { agent_id: "agent1" });

    dispatchTick(db);

    const task = getTask(db, "blocked-task")!;
    expect(task.status).toBe("failed");
    expect(task.result_error).toBe("dependency_failed");

    const audit = getAuditEvents(db, "blocked-task");
    expect(audit.some((e) => e.event_type === "failed")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: Dispatcher skips tasks with retry_after in the future
  // -------------------------------------------------------------------------
  test("skips tasks whose retry_after is in the future", () => {
    const futureTs = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);
    insertTask(db, { id: "retry-task", retry_after: futureTs });
    insertAgent(db, { agent_id: "agent1" });

    dispatchTick(db);

    const task = getTask(db, "retry-task")!;
    expect(task.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Test 6: Dispatcher dispatches a task with retry_after in the past
  // -------------------------------------------------------------------------
  test("dispatches tasks whose retry_after has passed", () => {
    const pastTs = new Date(Date.now() - 5_000).toISOString().replace("T", " ").slice(0, 19);
    insertTask(db, { id: "ready-retry", retry_after: pastTs });
    insertAgent(db, { agent_id: "agent1" });

    dispatchTick(db);

    const task = getTask(db, "ready-retry")!;
    expect(task.status).toBe("claimed");
  });

  // -------------------------------------------------------------------------
  // Test 7: Dispatcher prefers agents with lower current_load
  // -------------------------------------------------------------------------
  test("assigns to the agent with the lowest current_load", () => {
    insertTask(db, { id: "load-task" });
    insertAgent(db, { agent_id: "busy-agent", current_load: 5 });
    insertAgent(db, { agent_id: "idle-agent", current_load: 0 });

    dispatchTick(db);

    const task = getTask(db, "load-task")!;
    expect(task.assigned_to).toBe("idle-agent");
  });

  // -------------------------------------------------------------------------
  // Test 8: Dispatcher only assigns to agents whose capabilities match
  // -------------------------------------------------------------------------
  test("does not assign to agents lacking required capabilities", () => {
    insertTask(db, { id: "cap-task", caps_required: '["coding","bash"]' });
    insertAgent(db, { agent_id: "no-caps-agent", capabilities: "[]" });

    dispatchTick(db);

    const task = getTask(db, "cap-task")!;
    expect(task.status).toBe("pending"); // no eligible agents
  });

  // -------------------------------------------------------------------------
  // Test 9: Dispatcher assigns to agent that has all required capabilities
  // -------------------------------------------------------------------------
  test("assigns to agent that has all required capabilities", () => {
    insertTask(db, { id: "cap-task2", caps_required: '["coding","bash"]' });
    insertAgent(db, {
      agent_id: "skilled-agent",
      capabilities: '["coding","bash","web-search"]',
    });

    dispatchTick(db);

    const task = getTask(db, "cap-task2")!;
    expect(task.status).toBe("claimed");
    expect(task.assigned_to).toBe("skilled-agent");
  });

  // -------------------------------------------------------------------------
  // Test 10: Dispatcher respects routing_hint for a specific agent
  // -------------------------------------------------------------------------
  test("only assigns to the agent specified by routing_hint", () => {
    insertTask(db, { id: "routed-task", routing_hint: "rex" });
    insertAgent(db, { agent_id: "ocasia" });
    insertAgent(db, { agent_id: "rex" });

    dispatchTick(db);

    const task = getTask(db, "routed-task")!;
    expect(task.assigned_to).toBe("rex");
  });

  // -------------------------------------------------------------------------
  // Test 11: Dispatcher ignores expired agents
  // -------------------------------------------------------------------------
  test("does not assign to expired agents", () => {
    insertTask(db, { id: "orphan-task" });
    insertAgent(db, {
      agent_id: "expired-agent",
      expires_at: "2020-01-01 00:00:00", // in the past
    });

    dispatchTick(db);

    const task = getTask(db, "orphan-task")!;
    expect(task.status).toBe("pending"); // no active agents
  });

  // -------------------------------------------------------------------------
  // Test 12: No claim if no agents registered at all
  // -------------------------------------------------------------------------
  test("leaves task pending when no agents are registered", () => {
    insertTask(db, { id: "no-agents-task" });

    dispatchTick(db);

    const task = getTask(db, "no-agents-task")!;
    expect(task.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Claim Watchdog
// ---------------------------------------------------------------------------

describe("claimWatchdogTick", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    stopClaimWatchdog();
  });

  test("releases tasks with expired claim_expires_at back to pending", () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);

    insertTask(db, {
      id: "expired-claim",
      status: "claimed",
      assigned_to: "agent1",
      claimed_at: new Date(Date.now() - 600_000).toISOString().replace("T", " ").slice(0, 19),
      claim_expires_at: pastExpiry,
    });
    insertAgent(db, { agent_id: "agent1", current_load: 1 });

    const released = claimWatchdogTick(db);
    expect(released).toBe(1);

    const task = getTask(db, "expired-claim")!;
    expect(task.status).toBe("pending");
    expect(task.assigned_to).toBeNull();
    expect(task.claimed_at).toBeNull();
    expect(task.claim_expires_at).toBeNull();

    const agent = getAgent(db, "agent1")!;
    expect(agent.current_load).toBe(0);

    const audit = getAuditEvents(db, "expired-claim");
    expect(audit.some((e) => e.event_type === "expired")).toBe(true);
  });

  test("does not release tasks with future claim_expires_at", () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    insertTask(db, {
      id: "fresh-claim",
      status: "claimed",
      assigned_to: "agent1",
      claimed_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      claim_expires_at: futureExpiry,
    });
    insertAgent(db, { agent_id: "agent1", current_load: 1 });

    const released = claimWatchdogTick(db);
    expect(released).toBe(0);

    const task = getTask(db, "fresh-claim")!;
    expect(task.status).toBe("claimed");
  });

  test("returns 0 when no expired claims exist", () => {
    const released = claimWatchdogTick(db);
    expect(released).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retry Scheduler
// ---------------------------------------------------------------------------

describe("calcBackoffSeconds", () => {
  test("calculates correct exponential backoff delays", () => {
    // attempt=1 → 10 * 2^0 = 10
    expect(calcBackoffSeconds(1)).toBe(10);
    // attempt=2 → 10 * 2^1 = 20
    expect(calcBackoffSeconds(2)).toBe(20);
    // attempt=3 → 10 * 2^2 = 40
    expect(calcBackoffSeconds(3)).toBe(40);
    // attempt=4 → 10 * 2^3 = 80
    expect(calcBackoffSeconds(4)).toBe(80);
    // attempt=5 → 10 * 2^4 = 160
    expect(calcBackoffSeconds(5)).toBe(160);
    // attempt=6 → 10 * 2^5 = 320
    expect(calcBackoffSeconds(6)).toBe(320);
    // attempt=7 → 10 * 2^6 = 640 → capped at 600
    expect(calcBackoffSeconds(7)).toBe(600);
    // attempt=10 → would be 5120 → capped at 600
    expect(calcBackoffSeconds(10)).toBe(600);
  });
});

describe("scheduleRetry", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test("schedules a retry with correct backoff when under max_retries", () => {
    insertTask(db, { id: "retry-me", status: "claimed", assigned_to: "agent1", attempt: 1 });
    insertAgent(db, { agent_id: "agent1", current_load: 1 });

    const result = scheduleRetry(db, "retry-me", 1, 3, "agent1");

    expect(result.retried).toBe(true);
    expect(result.delay_seconds).toBe(10); // attempt=1 → 10s
    expect(result.retry_after).toBeDefined();

    const task = getTask(db, "retry-me")!;
    expect(task.status).toBe("pending");
    expect(task.assigned_to).toBeNull();
    expect(task.retry_after).toBe(result.retry_after);

    const agent = getAgent(db, "agent1")!;
    expect(agent.current_load).toBe(0);

    const audit = getAuditEvents(db, "retry-me");
    expect(audit.some((e) => e.event_type === "retried")).toBe(true);
  });

  test("marks task as permanently failed when attempt >= max_retries", () => {
    insertTask(db, { id: "fail-me", status: "claimed", assigned_to: "agent1", attempt: 3 });
    insertAgent(db, { agent_id: "agent1", current_load: 1 });

    const result = scheduleRetry(db, "fail-me", 3, 3, "agent1");

    expect(result.retried).toBe(false);
    expect(result.reason).toBe("max_retries_exceeded");

    const task = getTask(db, "fail-me")!;
    expect(task.status).toBe("failed");

    const agent = getAgent(db, "agent1")!;
    expect(agent.current_load).toBe(0);

    const audit = getAuditEvents(db, "fail-me");
    expect(audit.some((e) => e.event_type === "permanently_failed")).toBe(true);
  });

  test("retry_after timestamp is in the future", () => {
    insertTask(db, { id: "future-retry", status: "claimed", assigned_to: "agent1", attempt: 2 });
    insertAgent(db, { agent_id: "agent1", current_load: 1 });

    const before = new Date().toISOString().replace("T", " ").slice(0, 19);
    const result = scheduleRetry(db, "future-retry", 2, 5, "agent1");
    expect(result.retried).toBe(true);

    // retry_after should be after 'before'
    expect(result.retry_after! > before).toBe(true);
    // delay for attempt=2 is 20s
    expect(result.delay_seconds).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Startup Recovery
// ---------------------------------------------------------------------------

describe("recoverStaleTasks", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test("releases stale claimed tasks on startup", () => {
    const expiredTs = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);

    insertTask(db, {
      id: "stale-claimed",
      status: "claimed",
      assigned_to: "agent1",
      claim_expires_at: expiredTs,
    });
    insertAgent(db, { agent_id: "agent1", current_load: 2 });

    const count = recoverStaleTasks(db);
    expect(count).toBe(1);

    const task = getTask(db, "stale-claimed")!;
    expect(task.status).toBe("pending");
    expect(task.assigned_to).toBeNull();

    const audit = getAuditEvents(db, "stale-claimed");
    expect(audit.some((e) => e.event_type === "expired")).toBe(true);
  });

  test("resets all agent current_load to 0 on startup", () => {
    insertAgent(db, { agent_id: "heavy-agent", current_load: 9 });
    insertAgent(db, { agent_id: "busy-agent", current_load: 3 });

    recoverStaleTasks(db);

    expect(getAgent(db, "heavy-agent")!.current_load).toBe(0);
    expect(getAgent(db, "busy-agent")!.current_load).toBe(0);
  });

  test("returns 0 when no stale tasks exist", () => {
    // Insert a currently-valid claim
    const futureExpiry = new Date(Date.now() + 300_000).toISOString().replace("T", " ").slice(0, 19);
    insertTask(db, {
      id: "active-claim",
      status: "claimed",
      assigned_to: "agent1",
      claim_expires_at: futureExpiry,
    });

    const count = recoverStaleTasks(db);
    // Valid future claim should NOT be recovered
    expect(count).toBe(0);

    const task = getTask(db, "active-claim")!;
    expect(task.status).toBe("claimed");
  });

  test("recovers multiple stale tasks in one pass", () => {
    const expiredTs = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);

    for (let i = 1; i <= 5; i++) {
      insertTask(db, {
        id: `stale-${i}`,
        status: "claimed",
        assigned_to: "agent1",
        claim_expires_at: expiredTs,
      });
    }
    insertAgent(db, { agent_id: "agent1", current_load: 5 });

    const count = recoverStaleTasks(db);
    expect(count).toBe(5);

    for (let i = 1; i <= 5; i++) {
      const task = getTask(db, `stale-${i}`)!;
      expect(task.status).toBe("pending");
    }
  });
});
