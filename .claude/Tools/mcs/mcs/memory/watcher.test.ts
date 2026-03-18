/**
 * memory/watcher.test.ts — Unit tests for dispatchWatchNotifications and vacuum
 *
 * Uses bun:test with in-memory SQLite.
 * Mocks global fetch for notification delivery tests.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { dispatchWatchNotifications, notifyWithRetry } from "./watcher.ts";
import { vacuumTick, startVacuum, stopVacuum } from "./vacuum.ts";

// ---------------------------------------------------------------------------
// In-memory DB setup — replicate the MCS schema
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memory (
      ns TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      ttl_seconds INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ns, key)
    );

    CREATE TABLE watches (
      watch_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      ns TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      notify_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_watches_ns_prefix ON watches(ns, prefix);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertWatch(
  db: Database,
  id: string,
  agentId: string,
  ns: string,
  prefix: string,
  notifyUrl: string,
  expired = false
): void {
  const expiresAt = expired
    ? "2000-01-01 00:00:00" // well in the past
    : "2099-01-01 00:00:00"; // well in the future
  db.prepare(`
    INSERT INTO watches (watch_id, agent_id, ns, prefix, notify_url, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, agentId, ns, prefix, notifyUrl, expiresAt);
}

function insertMemoryKey(
  db: Database,
  ns: string,
  key: string,
  value: string,
  opts: { deleted?: number; expires_at?: string; updated_at?: string } = {}
): void {
  db.prepare(`
    INSERT INTO memory (ns, key, value, version, created_by, updated_by, expires_at, deleted, updated_at)
    VALUES (?, ?, ?, 1, 'test', 'test', ?, ?, ?)
  `).run(
    ns,
    key,
    value,
    opts.expires_at ?? null,
    opts.deleted ?? 0,
    opts.updated_at ?? new Date().toISOString().replace("T", " ").replace("Z", "")
  );
}

// ---------------------------------------------------------------------------
// fetch mock utilities
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let fetchResponses: Array<{ ok: boolean; status: number } | Error> = [];

function mockFetch(): void {
  fetchCalls = [];
  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(init.body as string) : null;
    } catch {
      body = init?.body;
    }
    fetchCalls.push({ url: urlStr, body });

    const response = fetchResponses.shift();
    if (!response) {
      // Default: success
      return new Response("{}", { status: 200 });
    }
    if (response instanceof Error) throw response;
    return new Response(
      JSON.stringify({ ok: response.ok }),
      { status: response.status }
    );
  };
}

function restoreFetch(): void {
  // In bun:test there's no built-in restore; we just reset to a passthrough
  global.fetch = fetch;
}

// ---------------------------------------------------------------------------
// Tests: dispatchWatchNotifications
// ---------------------------------------------------------------------------

describe("dispatchWatchNotifications", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
    mockFetch();
  });

  afterEach(() => {
    db.close();
  });

  it("sends notification to a matching watch", async () => {
    insertWatch(db, "w1", "ocasia", "mesh", "", "http://localhost:9999/notify");

    dispatchWatchNotifications(db, "mesh", "agent.status", { online: true }, 1, "ocasia");

    // Give the async dispatch time to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://localhost:9999/notify");
    const body = fetchCalls[0]!.body as Record<string, unknown>;
    expect(body.event).toBe("memory_changed");
    expect(body.ns).toBe("mesh");
    expect(body.key).toBe("agent.status");
    expect(body.version).toBe(1);
    expect(body.updated_by).toBe("ocasia");
  });

  it("skips expired watches", async () => {
    insertWatch(db, "w1", "ocasia", "mesh", "", "http://localhost:9999/notify", true /* expired */);

    dispatchWatchNotifications(db, "mesh", "agent.status", {}, 1, "ocasia");

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(0);
  });

  it("matches watch by prefix", async () => {
    insertWatch(db, "w1", "ocasia", "mesh", "agent.", "http://localhost:9999/notify");

    dispatchWatchNotifications(db, "mesh", "agent.ocasia.status", "up", 2, "ocasia");

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]!.body as Record<string, unknown>;
    expect(body.key).toBe("agent.ocasia.status");
  });

  it("empty prefix matches all keys in namespace", async () => {
    insertWatch(db, "w1", "ocasia", "mesh", "", "http://localhost:9999/a");
    insertWatch(db, "w2", "rex",    "mesh", "", "http://localhost:9999/b");

    dispatchWatchNotifications(db, "mesh", "totally.different.key", 42, 1, "dan");

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(2);
    const urls = fetchCalls.map((c) => c.url).sort();
    expect(urls).toEqual([
      "http://localhost:9999/a",
      "http://localhost:9999/b",
    ]);
  });

  it("does not send for non-matching namespace", async () => {
    insertWatch(db, "w1", "ocasia", "other-ns", "", "http://localhost:9999/notify");

    dispatchWatchNotifications(db, "mesh", "some.key", {}, 1, "ocasia");

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(0);
  });

  it("does not send when prefix does not match key", async () => {
    insertWatch(db, "w1", "ocasia", "mesh", "agent.", "http://localhost:9999/notify");

    dispatchWatchNotifications(db, "mesh", "task.abc123", {}, 1, "ocasia");

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(0);
  });

  it("includes correct value and timestamp in payload", async () => {
    insertWatch(db, "w1", "ocasia", "ns", "", "http://localhost:9999/notify");
    const value = { nested: { data: true } };

    dispatchWatchNotifications(db, "ns", "mykey", value, 5, "paisley");

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]!.body as Record<string, unknown>;
    expect(body.value).toEqual(value);
    expect(body.version).toBe(5);
    expect(body.updated_by).toBe("paisley");
    expect(typeof body.timestamp).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: notifyWithRetry
// ---------------------------------------------------------------------------

describe("notifyWithRetry", () => {
  beforeEach(() => {
    mockFetch();
  });

  it("succeeds on the first try with no retries", async () => {
    fetchResponses.push({ ok: true, status: 200 });

    const result = await notifyWithRetry("http://localhost:9999/test", { foo: 1 }, 3, 0);

    expect(result).toBe(true);
    expect(fetchCalls).toHaveLength(1);
  });

  it("retries on 5xx failure and succeeds on second attempt", async () => {
    fetchResponses.push({ ok: false, status: 503 });
    fetchResponses.push({ ok: true,  status: 200 });

    const result = await notifyWithRetry("http://localhost:9999/test", { foo: 1 }, 3, 0);

    expect(result).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  it("retries on network error and succeeds on second attempt", async () => {
    fetchResponses.push(new Error("Connection refused"));
    fetchResponses.push({ ok: true, status: 200 });

    const result = await notifyWithRetry("http://localhost:9999/test", { foo: 1 }, 3, 0);

    expect(result).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  it("gives up after max retries and returns false", async () => {
    // All 3 attempts fail
    fetchResponses.push({ ok: false, status: 500 });
    fetchResponses.push({ ok: false, status: 500 });
    fetchResponses.push({ ok: false, status: 500 });

    const result = await notifyWithRetry("http://localhost:9999/test", { foo: 1 }, 3, 0);

    expect(result).toBe(false);
    expect(fetchCalls).toHaveLength(3);
  });

  it("does not retry on 4xx responses", async () => {
    fetchResponses.push({ ok: false, status: 404 });

    const result = await notifyWithRetry("http://localhost:9999/test", { foo: 1 }, 3, 0);

    expect(result).toBe(false);
    // Only 1 attempt — no retry for 4xx
    expect(fetchCalls).toHaveLength(1);
  });

  it("returns false after all network error attempts exhausted", async () => {
    fetchResponses.push(new Error("ECONNREFUSED"));
    fetchResponses.push(new Error("ECONNREFUSED"));
    fetchResponses.push(new Error("ECONNREFUSED"));

    const result = await notifyWithRetry("http://localhost:9999/test", {}, 3, 0);

    expect(result).toBe(false);
    expect(fetchCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: vacuumTick
// ---------------------------------------------------------------------------

describe("vacuumTick", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    stopVacuum();
  });

  it("purges tombstoned rows older than 24 hours", () => {
    // Insert a tombstone that's 25 hours old
    insertMemoryKey(db, "mesh", "old-key", '{}', {
      deleted: 1,
      updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
    });

    const result = vacuumTick(db);

    expect(result.tombstones).toBe(1);

    const row = db.prepare("SELECT * FROM memory WHERE ns='mesh' AND key='old-key'").get();
    expect(row).toBeNull();
  });

  it("does not purge tombstones younger than 24 hours", () => {
    // Insert a tombstone that's only 1 hour old
    insertMemoryKey(db, "mesh", "recent-key", '{}', {
      deleted: 1,
      updated_at: new Date(Date.now() - 1 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
    });

    const result = vacuumTick(db);

    expect(result.tombstones).toBe(0);

    const row = db.prepare("SELECT * FROM memory WHERE ns='mesh' AND key='recent-key'").get();
    expect(row).not.toBeNull();
  });

  it("marks expired keys as deleted (soft delete)", () => {
    insertMemoryKey(db, "mesh", "expired-key", '"value"', {
      expires_at: "2000-01-01 00:00:00", // well in the past
    });

    const result = vacuumTick(db);

    expect(result.expiredKeys).toBe(1);

    const row = db.prepare(
      "SELECT deleted FROM memory WHERE ns='mesh' AND key='expired-key'"
    ).get() as { deleted: number } | null;
    expect(row).not.toBeNull();
    expect(row!.deleted).toBe(1);
  });

  it("removes expired watches", () => {
    insertWatch(db, "w1", "ocasia", "mesh", "", "http://localhost:9999/notify", true /* expired */);

    const result = vacuumTick(db);

    expect(result.expiredWatches).toBe(1);

    const row = db.prepare("SELECT * FROM watches WHERE watch_id='w1'").get();
    expect(row).toBeNull();
  });

  it("leaves unexpired data alone", () => {
    // Valid key with no expiry
    insertMemoryKey(db, "mesh", "live-key", '"value"');

    // Valid watch (not expired)
    insertWatch(db, "w1", "ocasia", "mesh", "", "http://localhost:9999/notify", false);

    const result = vacuumTick(db);

    expect(result.tombstones).toBe(0);
    expect(result.expiredKeys).toBe(0);
    expect(result.expiredWatches).toBe(0);

    const key = db.prepare("SELECT * FROM memory WHERE ns='mesh' AND key='live-key'").get();
    expect(key).not.toBeNull();

    const watch = db.prepare("SELECT * FROM watches WHERE watch_id='w1'").get();
    expect(watch).not.toBeNull();
  });

  it("leaves recently-expired-key tombstone for later GC", () => {
    // Soft-deleted but only 1 hour ago — should NOT be hard-deleted yet
    insertMemoryKey(db, "mesh", "fresh-tombstone", '{}', {
      deleted: 1,
      updated_at: new Date(Date.now() - 1 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
    });

    const result = vacuumTick(db);

    // tombstone not purged — it's less than 24h old
    expect(result.tombstones).toBe(0);

    const row = db.prepare("SELECT deleted FROM memory WHERE ns='mesh' AND key='fresh-tombstone'").get() as { deleted: number } | null;
    expect(row).not.toBeNull();
    expect(row!.deleted).toBe(1);
  });

  it("handles empty database without error", () => {
    const result = vacuumTick(db);
    expect(result.tombstones).toBe(0);
    expect(result.expiredKeys).toBe(0);
    expect(result.expiredWatches).toBe(0);
  });

  it("processes multiple expired keys and watches in one tick", () => {
    insertMemoryKey(db, "ns1", "k1", '"v"', { expires_at: "2000-01-01 00:00:00" });
    insertMemoryKey(db, "ns1", "k2", '"v"', { expires_at: "2000-01-01 00:00:00" });
    insertWatch(db, "w1", "a1", "ns1", "", "http://a.com/n", true);
    insertWatch(db, "w2", "a2", "ns1", "", "http://b.com/n", true);

    const result = vacuumTick(db);

    expect(result.expiredKeys).toBe(2);
    expect(result.expiredWatches).toBe(2);
  });
});
