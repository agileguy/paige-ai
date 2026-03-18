/**
 * notify/notifier.test.ts — Unit tests for the MCS notifier module
 *
 * Tests cover:
 *   - notifyUrl: correct POST payload, timeout handling, network error handling
 *   - notifyTaskAssigned: correct payload shape, no-op when url is null
 *   - notifyTaskResult: correct payload shape for completed and failed
 *   - notifyPermanentFailure: correct Telegram message format
 *   - checkFanoutCompletion: marks parent complete / failed correctly
 *
 * Uses Bun's built-in test runner and mocks global fetch.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { notifyUrl, notifyTaskAssigned, notifyTaskResult, type TaskNotification } from "./notifier.ts";
import { notifyPermanentFailure } from "./telegram.ts";
import { checkFanoutCompletion } from "../dispatch/fanout.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture sent fetch calls */
interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeMockFetch(
  responseStatus = 200,
  shouldThrow?: Error
): { mock: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];

  const mock = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    if (shouldThrow) throw shouldThrow;

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (init?.headers && typeof init.headers === "object") {
      Object.assign(headers, init.headers);
    }

    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }

    captured.push({ url, method: init?.method ?? "GET", body, headers });

    return new Response(responseStatus === 200 ? "ok" : "error", {
      status: responseStatus,
    });
  };

  return { mock: mock as typeof fetch, captured };
}

/** Create a minimal in-memory SQLite DB with the MCS schema (tasks + fanout_tasks + task_audit_log). */
function makeTestDb(): Database {
  const db = new Database(":memory:");
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

    CREATE TABLE fanout_tasks (
      parent_task_id TEXT NOT NULL,
      child_task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (parent_task_id, agent_id)
    );

    CREATE TABLE task_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/** Insert a task row into the test DB. */
function insertTask(
  db: Database,
  id: string,
  status: string,
  options: { result_output?: string | null; result_error?: string | null } = {}
): void {
  db.prepare(`
    INSERT INTO tasks (id, type, status, payload, created_by, result_output, result_error)
    VALUES (?, 'test', ?, '{}', 'test-agent', ?, ?)
  `).run(id, status, options.result_output ?? null, options.result_error ?? null);
}

/** Insert a fanout relationship. */
function insertFanout(db: Database, parentId: string, childId: string, agentId: string): void {
  db.prepare(
    `INSERT INTO fanout_tasks (parent_task_id, child_task_id, agent_id) VALUES (?, ?, ?)`
  ).run(parentId, childId, agentId);
}

// ---------------------------------------------------------------------------
// Tests: notifyUrl
// ---------------------------------------------------------------------------

describe("notifyUrl", () => {
  test("sends POST with correct JSON payload", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await notifyUrl("http://test.example/hook", { event: "test", value: 42 });
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.url).toBe("http://test.example/hook");
    expect(captured[0]!.body).toEqual({ event: "test", value: 42 });
  });

  test("sends Content-Type application/json header", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await notifyUrl("http://test.example/hook", { x: 1 });
    } finally {
      globalThis.fetch = original;
    }

    // Header key may be in any case depending on how mock captures it
    const ctHeader =
      captured[0]!.headers["Content-Type"] ??
      captured[0]!.headers["content-type"];
    expect(ctHeader).toBe("application/json");
  });

  test("handles timeout gracefully without throwing", async () => {
    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    const { mock } = makeMockFetch(200, timeoutError);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      // Must not throw
      await expect(notifyUrl("http://test.example/hook", {})).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("handles network error gracefully without throwing", async () => {
    const networkError = new TypeError("fetch failed");
    const { mock } = makeMockFetch(200, networkError);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await expect(notifyUrl("http://bad-host.example/hook", {})).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("handles non-2xx responses without throwing", async () => {
    const { mock } = makeMockFetch(503);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await expect(notifyUrl("http://test.example/hook", {})).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: notifyTaskAssigned
// ---------------------------------------------------------------------------

describe("notifyTaskAssigned", () => {
  test("sends correct payload shape", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    const task: TaskNotification = {
      id: "task-abc",
      type: "weather_check",
      priority: 1,
      payload: JSON.stringify({ city: "Edinburgh" }),
      assigned_to: "ocasia",
      claimed_at: "2026-02-28T10:00:00.000Z",
    };

    try {
      await notifyTaskAssigned(task, "ocasia", "http://agent.example/notify");
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as Record<string, unknown>;
    expect(body.event).toBe("task_assigned");
    expect(body.task_id).toBe("task-abc");
    expect(body.type).toBe("weather_check");
    expect(body.priority).toBe(1);
    expect(body.assigned_to).toBe("ocasia");
    expect(body.claimed_at).toBe("2026-02-28T10:00:00.000Z");
    // payload should be parsed from JSON
    expect(body.payload).toEqual({ city: "Edinburgh" });
  });

  test("is a no-op when notify_url is null", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    const task: TaskNotification = {
      id: "task-noop",
      type: "test",
      priority: 2,
      payload: "{}",
      assigned_to: null,
      claimed_at: null,
    };

    try {
      await notifyTaskAssigned(task, "agent-x", null);
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: notifyTaskResult
// ---------------------------------------------------------------------------

describe("notifyTaskResult", () => {
  test("sends task_completed event with correct payload", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await notifyTaskResult("task-xyz", "completed", { answer: 42 }, "http://caller.example/webhook");
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as Record<string, unknown>;
    expect(body.event).toBe("task_completed");
    expect(body.task_id).toBe("task-xyz");
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ answer: 42 });
    expect(typeof body.completed_at).toBe("string");
  });

  test("sends task_failed event when status is failed", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await notifyTaskResult("task-fail", "failed", null, "http://caller.example/webhook");
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as Record<string, unknown>;
    expect(body.event).toBe("task_failed");
    expect(body.task_id).toBe("task-fail");
    expect(body.status).toBe("failed");
  });

  test("is a no-op when notify_url is null", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await notifyTaskResult("task-noop", "completed", null, null);
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: notifyPermanentFailure (Telegram)
// ---------------------------------------------------------------------------

describe("notifyPermanentFailure", () => {
  test("sends Telegram message with correct format", async () => {
    const { mock, captured } = makeMockFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await notifyPermanentFailure(
        "task-dead",
        "code_review",
        "paisley",
        3,
        3,
        "connection timeout"
      );
    } finally {
      globalThis.fetch = original;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain("api.telegram.org");
    expect(captured[0]!.url).toContain("sendMessage");
    expect(captured[0]!.method).toBe("POST");

    const body = captured[0]!.body as Record<string, unknown>;
    expect(typeof body.text).toBe("string");
    const text = body.text as string;
    expect(text).toContain("permanently failed");
    expect(text).toContain("code_review");
    expect(text).toContain("task-dead");
    expect(text).toContain("paisley");
    expect(text).toContain("3/3");
    expect(text).toContain("connection timeout");
    expect(text).toContain("🏴󠁧󠁢󠁳󠁣󠁴󠁿");
  });

  test("does not throw when Telegram is unreachable", async () => {
    const netError = new TypeError("fetch failed");
    const { mock } = makeMockFetch(200, netError);
    const original = globalThis.fetch;
    globalThis.fetch = mock;

    try {
      await expect(
        notifyPermanentFailure("t1", "test", "agent", 1, 1, "err")
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: checkFanoutCompletion
// ---------------------------------------------------------------------------

describe("checkFanoutCompletion", () => {
  test("is a no-op when task is not a fanout child", () => {
    const db = makeTestDb();
    insertTask(db, "parent-1", "in_progress");
    insertTask(db, "solo-task", "completed");

    // Should not throw, should not modify parent
    checkFanoutCompletion(db, "solo-task");

    const parent = db.query<{ status: string }, [string]>(
      "SELECT status FROM tasks WHERE id = ?"
    ).get("parent-1");
    expect(parent?.status).toBe("in_progress");
  });

  test("marks parent completed when all children complete", () => {
    const db = makeTestDb();
    insertTask(db, "parent-all-ok", "in_progress");
    insertTask(db, "child-1", "completed", { result_output: JSON.stringify({ ok: true }) });
    insertTask(db, "child-2", "completed", { result_output: JSON.stringify({ ok: true }) });

    insertFanout(db, "parent-all-ok", "child-1", "ocasia");
    insertFanout(db, "parent-all-ok", "child-2", "rex");

    checkFanoutCompletion(db, "child-1");

    const parent = db.query<{ status: string; result_output: string }, [string]>(
      "SELECT status, result_output FROM tasks WHERE id = ?"
    ).get("parent-all-ok");

    expect(parent?.status).toBe("completed");
    const result = JSON.parse(parent?.result_output ?? "{}");
    expect(result).toHaveProperty("ocasia");
    expect(result).toHaveProperty("rex");
  });

  test("marks parent failed when any child fails", () => {
    const db = makeTestDb();
    insertTask(db, "parent-partial-fail", "in_progress");
    insertTask(db, "child-ok", "completed", { result_output: JSON.stringify({ ok: true }) });
    insertTask(db, "child-fail", "failed", { result_error: "something broke" });

    insertFanout(db, "parent-partial-fail", "child-ok", "ocasia");
    insertFanout(db, "parent-partial-fail", "child-fail", "rex");

    checkFanoutCompletion(db, "child-fail");

    const parent = db.query<{ status: string }, [string]>(
      "SELECT status FROM tasks WHERE id = ?"
    ).get("parent-partial-fail");

    expect(parent?.status).toBe("failed");
  });

  test("does not mark parent complete when siblings are still in-flight", () => {
    const db = makeTestDb();
    insertTask(db, "parent-wait", "in_progress");
    insertTask(db, "child-done", "completed");
    insertTask(db, "child-still-running", "claimed");

    insertFanout(db, "parent-wait", "child-done", "ocasia");
    insertFanout(db, "parent-wait", "child-still-running", "rex");

    checkFanoutCompletion(db, "child-done");

    const parent = db.query<{ status: string }, [string]>(
      "SELECT status FROM tasks WHERE id = ?"
    ).get("parent-wait");

    // Parent should still be in_progress
    expect(parent?.status).toBe("in_progress");
  });

  test("writes audit log entry on fanout completion", () => {
    const db = makeTestDb();
    insertTask(db, "parent-audit", "in_progress");
    insertTask(db, "child-audit-1", "completed");
    insertTask(db, "child-audit-2", "completed");

    insertFanout(db, "parent-audit", "child-audit-1", "molly");
    insertFanout(db, "parent-audit", "child-audit-2", "rex");

    checkFanoutCompletion(db, "child-audit-2");

    const auditEvents = db.query<{ event_type: string }, [string]>(
      "SELECT event_type FROM task_audit_log WHERE task_id = ?"
    ).all("parent-audit");

    expect(auditEvents.length).toBeGreaterThan(0);
    const eventTypes = auditEvents.map((e) => e.event_type);
    expect(eventTypes).toContain("fanout_completed");
  });

  test("aggregate result includes all agent outputs", () => {
    const db = makeTestDb();
    insertTask(db, "parent-agg", "in_progress");
    insertTask(db, "child-agg-1", "completed", { result_output: JSON.stringify({ score: 10 }) });
    insertTask(db, "child-agg-2", "completed", { result_output: JSON.stringify({ score: 20 }) });
    insertTask(db, "child-agg-3", "completed", { result_output: JSON.stringify({ score: 30 }) });

    insertFanout(db, "parent-agg", "child-agg-1", "agent-a");
    insertFanout(db, "parent-agg", "child-agg-2", "agent-b");
    insertFanout(db, "parent-agg", "child-agg-3", "agent-c");

    checkFanoutCompletion(db, "child-agg-1");

    const parent = db.query<{ result_output: string }, [string]>(
      "SELECT result_output FROM tasks WHERE id = ?"
    ).get("parent-agg");

    const agg = JSON.parse(parent?.result_output ?? "{}");
    expect(agg["agent-a"]?.output?.score).toBe(10);
    expect(agg["agent-b"]?.output?.score).toBe(20);
    expect(agg["agent-c"]?.output?.score).toBe(30);
  });
});
