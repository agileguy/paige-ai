/**
 * routes/tasks.test.ts — Unit tests for Task CRUD and Agent registration routes
 *
 * Uses an in-process SQLite DB (same schema as db.ts) so tests are fully
 * isolated without ever touching the real ~/.mcs/mcs.db.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TaskStatus } from "../types.ts";
import {
  handleCreateTask,
  handleGetTask,
  handleGetMyTasks,
  handleListTasks,
  handleSubmitResult,
  handleHeartbeat,
  handleGetAudit,
} from "./tasks.ts";
import { handleUpdateCapabilities, handleListAgents } from "./agents.ts";

// ---------------------------------------------------------------------------
// Test database helpers — same schema as db.ts migration v1
// ---------------------------------------------------------------------------

function makeTempDb(): Database {
  const dir = join(tmpdir(), `mcs-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);

  const db = new Database(join(dir, "test.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 2,
      payload TEXT NOT NULL,
      caps_required TEXT NOT NULL DEFAULT '[]',
      routing_hint TEXT NOT NULL DEFAULT 'any',
      created_by TEXT NOT NULL,
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
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to, status);

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
    CREATE INDEX idx_audit_task_id ON task_audit_log(task_id);

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    );
    CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);
  `);

  return db;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// Helper: build a minimal Request with optional body
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  queryParams?: Record<string, string>
): Request {
  const base = "http://localhost:7700";
  const url = new URL(path, base);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v);
    }
  }
  return new Request(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Helper: seed a task directly in the DB for testing result/heartbeat/audit
// ---------------------------------------------------------------------------

function seedTask(
  db: Database,
  overrides: Record<string, unknown> = {}
): string {
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const defaults = {
    id: taskId,
    type: "seed-type",
    status: "pending",
    priority: 2,
    payload: '"{}\"',
    caps_required: "[]",
    routing_hint: "any",
    created_by: "dan",
    assigned_to: null,
    max_retries: 3,
    claim_ttl_seconds: 300,
    claim_expires_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO tasks (id, type, status, priority, payload, caps_required,
      routing_hint, created_by, assigned_to, max_retries, claim_ttl_seconds,
      claim_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    defaults.id as string,
    defaults.type as string,
    defaults.status as string,
    defaults.priority as number,
    defaults.payload as string,
    defaults.caps_required as string,
    defaults.routing_hint as string,
    defaults.created_by as string,
    defaults.assigned_to as string | null,
    defaults.max_retries as number,
    defaults.claim_ttl_seconds as number,
    defaults.claim_expires_at as string | null,
    defaults.created_at as string,
    defaults.updated_at as string
  );

  return taskId;
}

// ---------------------------------------------------------------------------
// POST /tasks — Create
// ---------------------------------------------------------------------------

describe("POST /tasks — handleCreateTask", () => {
  test("creates a task and returns 201 with task_id and status pending", async () => {
    const db = makeTempDb();
    const req = makeRequest("POST", "/tasks", { type: "run-job", payload: { x: 1 } });
    const res = await handleCreateTask(req, "dan", db);

    expect(res.status).toBe(201);
    const body = await res.json() as { task_id: string; status: string; created_at: string };
    expect(body.task_id).toBeString();
    expect(body.status).toBe(TaskStatus.Pending);
    expect(body.created_at).toBeString();

    // Verify it landed in the DB
    const row = db.query<{ type: string }, [string]>("SELECT type FROM tasks WHERE id = ?").get(body.task_id);
    expect(row?.type).toBe("run-job");
  });

  test("returns 400 when type field is missing", async () => {
    const db = makeTempDb();
    const req = makeRequest("POST", "/tasks", { payload: {} });
    const res = await handleCreateTask(req, "dan", db);
    expect(res.status).toBe(400);
  });

  test("returns 400 when payload field is missing", async () => {
    const db = makeTempDb();
    const req = makeRequest("POST", "/tasks", { type: "foo" });
    const res = await handleCreateTask(req, "dan", db);
    expect(res.status).toBe(400);
  });

  test("maps priority string 'urgent' to integer 1", async () => {
    const db = makeTempDb();
    const req = makeRequest("POST", "/tasks", { type: "urgent-job", payload: {}, priority: "urgent" });
    const res = await handleCreateTask(req, "dan", db);
    expect(res.status).toBe(201);
    const body = await res.json() as { task_id: string };
    const row = db.query<{ priority: number }, [string]>("SELECT priority FROM tasks WHERE id = ?").get(body.task_id);
    expect(row?.priority).toBe(1);
  });

  test("idempotency_key deduplication returns 409 with existing task_id", async () => {
    const db = makeTempDb();
    const req1 = makeRequest("POST", "/tasks", {
      type: "idem-job",
      payload: {},
      idempotency_key: "my-unique-key-abc",
    });
    const res1 = await handleCreateTask(req1, "dan", db);
    expect(res1.status).toBe(201);
    const body1 = await res1.json() as { task_id: string };

    const req2 = makeRequest("POST", "/tasks", {
      type: "idem-job",
      payload: {},
      idempotency_key: "my-unique-key-abc",
    });
    const res2 = await handleCreateTask(req2, "dan", db);
    expect(res2.status).toBe(409);
    const body2 = await res2.json() as { task_id: string; code: string };
    expect(body2.code).toBe("DUPLICATE_IDEMPOTENCY_KEY");
    expect(body2.task_id).toBe(body1.task_id);
  });

  test("inserts task_dependencies when depends_on is provided", async () => {
    const db = makeTempDb();
    // Create the dependency task first
    const depId = seedTask(db, { type: "dep-task" });

    const req = makeRequest("POST", "/tasks", {
      type: "child-job",
      payload: {},
      depends_on: [depId],
    });
    const res = await handleCreateTask(req, "dan", db);
    expect(res.status).toBe(201);
    const body = await res.json() as { task_id: string };

    const dep = db
      .query<{ depends_on: string }, [string]>(
        "SELECT depends_on FROM task_dependencies WHERE task_id = ?"
      )
      .get(body.task_id);
    expect(dep?.depends_on).toBe(depId);
  });

  test("writes a 'created' audit entry after successful creation", async () => {
    const db = makeTempDb();
    const req = makeRequest("POST", "/tasks", { type: "audit-test", payload: {} });
    const res = await handleCreateTask(req, "dan", db);
    const body = await res.json() as { task_id: string };

    const audit = db
      .query<{ event_type: string; agent_id: string }, [string]>(
        "SELECT event_type, agent_id FROM task_audit_log WHERE task_id = ?"
      )
      .get(body.task_id);
    expect(audit?.event_type).toBe("created");
    expect(audit?.agent_id).toBe("dan");
  });
});

// ---------------------------------------------------------------------------
// GET /tasks/:id — Get task by ID
// ---------------------------------------------------------------------------

describe("GET /tasks/:id — handleGetTask", () => {
  test("returns the task with 200", () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { type: "my-task", payload: '"hello"' });
    const req = makeRequest("GET", `/tasks/${taskId}`);
    const res = handleGetTask(req, "dan", db, taskId);

    expect(res.status).toBe(200);
  });

  test("returns 404 for a non-existent task ID", () => {
    const db = makeTempDb();
    const req = makeRequest("GET", "/tasks/does-not-exist");
    const res = handleGetTask(req, "dan", db, "does-not-exist");

    expect(res.status).toBe(404);
  });

  test("caps_required is parsed from JSON string into an array", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { caps_required: '["code","bash"]' });
    const req = makeRequest("GET", `/tasks/${taskId}`);
    const res = handleGetTask(req, "dan", db, taskId);
    const body = await res.json() as { caps_required: string[] };
    expect(body.caps_required).toEqual(["code", "bash"]);
  });
});

// ---------------------------------------------------------------------------
// GET /tasks/mine — Get tasks assigned to caller
// ---------------------------------------------------------------------------

describe("GET /tasks/mine — handleGetMyTasks", () => {
  test("returns only tasks assigned to the calling agent", async () => {
    const db = makeTempDb();
    // Assign one task to ocasia and one to rex
    seedTask(db, { assigned_to: "ocasia", status: "claimed" });
    seedTask(db, { assigned_to: "rex",    status: "claimed" });

    const req = makeRequest("GET", "/tasks/mine");
    const res = handleGetMyTasks(req, "ocasia", db);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { assigned_to: string }[]; count: number };
    expect(body.count).toBe(1);
    expect(body.tasks[0]!.assigned_to).toBe("ocasia");
  });

  test("returns both claimed and in_progress tasks by default", async () => {
    const db = makeTempDb();
    seedTask(db, { assigned_to: "dan", status: "claimed" });
    seedTask(db, { assigned_to: "dan", status: "in_progress" });
    seedTask(db, { assigned_to: "dan", status: "completed" }); // should not appear

    const req = makeRequest("GET", "/tasks/mine");
    const res = handleGetMyTasks(req, "dan", db);
    const body = await res.json() as { count: number };
    expect(body.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /tasks — List with filters
// ---------------------------------------------------------------------------

describe("GET /tasks — handleListTasks", () => {
  test("returns all tasks when no filters are applied", async () => {
    const db = makeTempDb();
    seedTask(db);
    seedTask(db);
    const req = makeRequest("GET", "/tasks");
    const res = handleListTasks(req, "dan", db);
    const body = await res.json() as { tasks: unknown[]; total: number };
    expect(body.total).toBe(2);
    expect(body.tasks.length).toBe(2);
  });

  test("filters by status", async () => {
    const db = makeTempDb();
    seedTask(db, { status: "pending" });
    seedTask(db, { status: "completed" });
    const req = makeRequest("GET", "/tasks", undefined, { status: "pending" });
    const res = handleListTasks(req, "dan", db);
    const body = await res.json() as { tasks: { status: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.tasks[0]!.status).toBe("pending");
  });

  test("filters by created_by", async () => {
    const db = makeTempDb();
    seedTask(db, { created_by: "ocasia" });
    seedTask(db, { created_by: "rex" });
    const req = makeRequest("GET", "/tasks", undefined, { created_by: "ocasia" });
    const res = handleListTasks(req, "dan", db);
    const body = await res.json() as { total: number };
    expect(body.total).toBe(1);
  });

  test("filters by priority string", async () => {
    const db = makeTempDb();
    seedTask(db, { priority: 1 }); // urgent
    seedTask(db, { priority: 2 }); // normal
    const req = makeRequest("GET", "/tasks", undefined, { priority: "urgent" });
    const res = handleListTasks(req, "dan", db);
    const body = await res.json() as { total: number };
    expect(body.total).toBe(1);
  });

  test("respects limit and offset", async () => {
    const db = makeTempDb();
    for (let i = 0; i < 5; i++) seedTask(db);
    const req = makeRequest("GET", "/tasks", undefined, { limit: "2", offset: "1" });
    const res = handleListTasks(req, "dan", db);
    const body = await res.json() as { tasks: unknown[]; total: number; limit: number; offset: number };
    expect(body.tasks.length).toBe(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/result — Submit result
// ---------------------------------------------------------------------------

describe("POST /tasks/:id/result — handleSubmitResult", () => {
  test("marks task as completed and returns 200", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { assigned_to: "dan", status: "claimed" });
    const req = makeRequest("POST", `/tasks/${taskId}/result`, {
      status: "completed",
      output: { ok: true },
    });
    const res = await handleSubmitResult(req, "dan", db, taskId);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("completed");

    const row = db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get(taskId);
    expect(row?.status).toBe("completed");
  });

  test("marks task as failed when status is 'failed'", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { assigned_to: "dan", status: "claimed" });
    const req = makeRequest("POST", `/tasks/${taskId}/result`, {
      status: "failed",
      error: "timeout",
    });
    const res = await handleSubmitResult(req, "dan", db, taskId);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("failed");
  });

  test("returns 403 when task is not assigned to the calling agent", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { assigned_to: "ocasia", status: "claimed" });
    const req = makeRequest("POST", `/tasks/${taskId}/result`, { status: "completed", output: null });
    const res = await handleSubmitResult(req, "rex", db, taskId);
    expect(res.status).toBe(403);
  });

  test("returns 409 when task is already completed", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { assigned_to: "dan", status: "completed" });
    const req = makeRequest("POST", `/tasks/${taskId}/result`, { status: "completed", output: null });
    const res = await handleSubmitResult(req, "dan", db, taskId);
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("ALREADY_TERMINAL");
  });

  test("returns 404 for a non-existent task", async () => {
    const db = makeTempDb();
    const req = makeRequest("POST", "/tasks/nope/result", { status: "completed", output: null });
    const res = await handleSubmitResult(req, "dan", db, "nope");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/heartbeat — Keep claim alive
// ---------------------------------------------------------------------------

describe("POST /tasks/:id/heartbeat — handleHeartbeat", () => {
  test("resets claim_expires_at and returns ok=true", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db, {
      assigned_to: "dan",
      status: "claimed",
      claim_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const req = makeRequest("POST", `/tasks/${taskId}/heartbeat`);
    const res = handleHeartbeat(req, "dan", db, taskId);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; claim_expires_at: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.claim_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("returns 409 when task is not assigned to the caller", () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { assigned_to: "ocasia", status: "claimed" });
    const req = makeRequest("POST", `/tasks/${taskId}/heartbeat`);
    const res = handleHeartbeat(req, "rex", db, taskId);
    expect(res.status).toBe(409);
  });

  test("returns 409 when task is in a terminal state", () => {
    const db = makeTempDb();
    const taskId = seedTask(db, { assigned_to: "dan", status: "completed" });
    const req = makeRequest("POST", `/tasks/${taskId}/heartbeat`);
    const res = handleHeartbeat(req, "dan", db, taskId);
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /tasks/:id/audit — Audit trail
// ---------------------------------------------------------------------------

describe("GET /tasks/:id/audit — handleGetAudit", () => {
  test("returns audit events for a task", async () => {
    const db = makeTempDb();
    const taskId = seedTask(db);

    // Manually insert audit entries
    const now = new Date().toISOString();
    db.prepare("INSERT INTO task_audit_log (task_id, event_type, agent_id, created_at) VALUES (?, ?, ?, ?)").run(taskId, "created", "dan", now);
    db.prepare("INSERT INTO task_audit_log (task_id, event_type, agent_id, created_at) VALUES (?, ?, ?, ?)").run(taskId, "claimed", "ocasia", now);

    const req = makeRequest("GET", `/tasks/${taskId}/audit`);
    const res = handleGetAudit(req, "dan", db, taskId);
    expect(res.status).toBe(200);
    const body = await res.json() as { task_id: string; events: { event_type: string }[] };
    expect(body.task_id).toBe(taskId);
    expect(body.events.length).toBe(2);
    expect(body.events[0]!.event_type).toBe("created");
  });

  test("returns 404 for a non-existent task", () => {
    const db = makeTempDb();
    const req = makeRequest("GET", "/tasks/ghost/audit");
    const res = handleGetAudit(req, "dan", db, "ghost");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /agents/:name/capabilities — Agent registration
// ---------------------------------------------------------------------------

describe("PUT /agents/:name/capabilities — handleUpdateCapabilities", () => {
  test("registers agent capabilities and returns 200 with expires_at", async () => {
    const db = makeTempDb();
    const req = makeRequest("PUT", "/agents/ocasia/capabilities", {
      capabilities: ["code", "bash", "browser"],
    });
    const res = await handleUpdateCapabilities(req, "ocasia", db, "ocasia");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      agent_id: string;
      capabilities: string[];
      expires_at: string;
    };
    expect(body.agent_id).toBe("ocasia");
    expect(body.capabilities).toEqual(["code", "bash", "browser"]);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("is idempotent — re-registering updates capabilities", async () => {
    const db = makeTempDb();
    const req1 = makeRequest("PUT", "/agents/dan/capabilities", { capabilities: ["read"] });
    await handleUpdateCapabilities(req1, "dan", db, "dan");

    const req2 = makeRequest("PUT", "/agents/dan/capabilities", { capabilities: ["read", "write"] });
    const res2 = await handleUpdateCapabilities(req2, "dan", db, "dan");
    const body = await res2.json() as { capabilities: string[] };
    expect(body.capabilities).toEqual(["read", "write"]);

    // Only one row in agents table
    const count = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM agents").get();
    expect(count?.count).toBe(1);
  });

  test("returns 403 when agent tries to update another agent's capabilities", async () => {
    const db = makeTempDb();
    const req = makeRequest("PUT", "/agents/rex/capabilities", { capabilities: ["code"] });
    const res = await handleUpdateCapabilities(req, "ocasia", db, "rex");
    expect(res.status).toBe(403);
  });

  test("returns 400 when capabilities field is not an array", async () => {
    const db = makeTempDb();
    const req = makeRequest("PUT", "/agents/dan/capabilities", { capabilities: "not-an-array" });
    const res = await handleUpdateCapabilities(req, "dan", db, "dan");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /agents — List agents
// ---------------------------------------------------------------------------

describe("GET /agents — handleListAgents", () => {
  test("returns all agents with computed active field", async () => {
    const db = makeTempDb();

    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const pastExpiry   = new Date(Date.now() - 60_000).toISOString();

    db.prepare(
      "INSERT INTO agents (agent_id, capabilities, registered_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run("ocasia", '["code"]', new Date().toISOString(), futureExpiry);

    db.prepare(
      "INSERT INTO agents (agent_id, capabilities, registered_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run("stale-agent", '[]', new Date().toISOString(), pastExpiry);

    const req = makeRequest("GET", "/agents");
    const res = handleListAgents(req, "dan", db);
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: { agent_id: string; active: boolean; capabilities: string[] }[] };

    expect(body.agents.length).toBe(2);

    const ocasia = body.agents.find((a) => a.agent_id === "ocasia")!;
    expect(ocasia.active).toBe(true);
    expect(ocasia.capabilities).toEqual(["code"]);

    const stale = body.agents.find((a) => a.agent_id === "stale-agent")!;
    expect(stale.active).toBe(false);
  });

  test("returns empty agents array when no agents registered", async () => {
    const db = makeTempDb();
    const req = makeRequest("GET", "/agents");
    const res = handleListAgents(req, "dan", db);
    const body = await res.json() as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });
});
