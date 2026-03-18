/**
 * memory/store.test.ts — Unit tests for the MCS memory store
 *
 * Uses bun:test with an in-memory SQLite database.
 * Covers all store operations + permission rules + HTTP-layer constraints.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  upsertKey,
  getKey,
  deleteKey,
  listKeys,
  bulkWrite,
  getSnapshot,
} from "./store.ts";
import { canRead, canWrite, parseNamespace } from "./permissions.ts";

// ---------------------------------------------------------------------------
// Test DB setup — run the memory table schema on an in-memory SQLite DB
// ---------------------------------------------------------------------------

const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory (
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
`;

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(MEMORY_SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NS = "mesh";
const AGENT = "ocasia";

// ---------------------------------------------------------------------------
// upsertKey tests
// ---------------------------------------------------------------------------

describe("upsertKey", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });

  it("creates a new key with version=1", () => {
    const entry = upsertKey(db, NS, "hello", "world", AGENT);
    expect(entry.version).toBe(1);
    expect(entry.ns).toBe(NS);
    expect(entry.key).toBe("hello");
    expect(entry.value).toBe(JSON.stringify("world"));
    expect(entry.created_by).toBe(AGENT);
    expect(entry.updated_by).toBe(AGENT);
    expect(entry.deleted).toBe(0);
  });

  it("increments version on update of existing key", () => {
    upsertKey(db, NS, "counter", 1, AGENT);
    upsertKey(db, NS, "counter", 2, AGENT);
    const entry = upsertKey(db, NS, "counter", 3, AGENT);
    expect(entry.version).toBe(3);
    expect(entry.value).toBe(JSON.stringify(3));
  });

  it("sets expires_at when TTL is provided", () => {
    const entry = upsertKey(db, NS, "ttl-key", "val", AGENT, { ttl: 3600 });
    expect(entry.expires_at).not.toBeNull();
    expect(entry.ttl_seconds).toBe(3600);
    // expires_at should be in the future
    const expiry = new Date(entry.expires_at!).getTime();
    expect(expiry).toBeGreaterThan(Date.now());
  });

  it("clears expires_at when TTL is removed on update", () => {
    upsertKey(db, NS, "ttl-key", "val", AGENT, { ttl: 60 });
    const updated = upsertKey(db, NS, "ttl-key", "val2", AGENT); // no TTL
    expect(updated.expires_at).toBeNull();
    expect(updated.ttl_seconds).toBeNull();
  });

  it("stores tags as a JSON array string", () => {
    const entry = upsertKey(db, NS, "tagged", "data", AGENT, { tags: ["alpha", "beta"] });
    expect(entry.tags).toBe(JSON.stringify(["alpha", "beta"]));
  });

  it("re-inserts with version=1 after a key has been deleted", () => {
    upsertKey(db, NS, "revived", "old", AGENT);
    deleteKey(db, NS, "revived", AGENT);
    const entry = upsertKey(db, NS, "revived", "new", AGENT);
    expect(entry.version).toBe(1);
    expect(entry.value).toBe(JSON.stringify("new"));
  });

  it("stores complex JSON objects correctly", () => {
    const obj = { x: 1, y: [true, null, "str"] };
    const entry = upsertKey(db, NS, "obj", obj, AGENT);
    expect(entry.value).toBe(JSON.stringify(obj));
  });
});

// ---------------------------------------------------------------------------
// getKey tests
// ---------------------------------------------------------------------------

describe("getKey", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });

  it("returns null for a missing key", () => {
    expect(getKey(db, NS, "nonexistent")).toBeNull();
  });

  it("returns null for a deleted key", () => {
    upsertKey(db, NS, "bye", "val", AGENT);
    deleteKey(db, NS, "bye", AGENT);
    expect(getKey(db, NS, "bye")).toBeNull();
  });

  it("returns null for an expired key", () => {
    // Insert with -1 second TTL (already expired)
    db.exec(`
      INSERT INTO memory (ns, key, value, version, tags, created_by, updated_by,
                          created_at, updated_at, expires_at, deleted)
      VALUES ('${NS}', 'expired', '"v"', 1, '[]', 'agent', 'agent',
              datetime('now'), datetime('now'),
              datetime('now', '-1 seconds'), 0)
    `);
    expect(getKey(db, NS, "expired")).toBeNull();
  });

  it("returns a valid entry for an existing key", () => {
    upsertKey(db, NS, "valid", 42, AGENT);
    const entry = getKey(db, NS, "valid");
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe("42");
    expect(entry!.version).toBe(1);
  });

  it("returns entry with future expires_at as valid", () => {
    upsertKey(db, NS, "future", "ok", AGENT, { ttl: 9999 });
    const entry = getKey(db, NS, "future");
    expect(entry).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteKey tests
// ---------------------------------------------------------------------------

describe("deleteKey", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });

  it("tombstones a key by setting deleted=1", () => {
    upsertKey(db, NS, "to-delete", "val", AGENT);
    const result = deleteKey(db, NS, "to-delete", AGENT);
    expect(result).toBe(true);

    // Verify row is still in DB but marked deleted
    const row = db
      .query<{ deleted: number }, [string, string]>(
        "SELECT deleted FROM memory WHERE ns = ? AND key = ?"
      )
      .get(NS, "to-delete");
    expect(row?.deleted).toBe(1);
  });

  it("returns false for a non-existent key", () => {
    expect(deleteKey(db, NS, "ghost", AGENT)).toBe(false);
  });

  it("returns false for an already-deleted key", () => {
    upsertKey(db, NS, "dup-del", "v", AGENT);
    deleteKey(db, NS, "dup-del", AGENT);
    expect(deleteKey(db, NS, "dup-del", AGENT)).toBe(false);
  });

  it("sets updated_by to the deleting agent", () => {
    upsertKey(db, NS, "owned", "v", "rex");
    deleteKey(db, NS, "owned", "paisley");
    const row = db
      .query<{ updated_by: string }, [string, string]>(
        "SELECT updated_by FROM memory WHERE ns = ? AND key = ?"
      )
      .get(NS, "owned");
    expect(row?.updated_by).toBe("paisley");
  });
});

// ---------------------------------------------------------------------------
// listKeys tests
// ---------------------------------------------------------------------------

describe("listKeys", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
    upsertKey(db, NS, "apple", 1, AGENT);
    upsertKey(db, NS, "apricot", 2, AGENT);
    upsertKey(db, NS, "banana", 3, AGENT);
    upsertKey(db, NS, "cherry", 4, AGENT, { tags: ["fruit", "red"] });
    upsertKey(db, NS, "date", 5, AGENT, { tags: ["fruit"] });
  });

  it("returns only active (non-deleted, non-expired) keys", () => {
    deleteKey(db, NS, "cherry", AGENT);
    const keys = listKeys(db, NS);
    const names = keys.map((k) => k.key);
    expect(names).not.toContain("cherry");
    expect(names).toContain("apple");
  });

  it("filters by prefix", () => {
    const keys = listKeys(db, NS, { prefix: "ap" });
    const names = keys.map((k) => k.key);
    expect(names).toContain("apple");
    expect(names).toContain("apricot");
    expect(names).not.toContain("banana");
  });

  it("filters by tag", () => {
    const keys = listKeys(db, NS, { tag: "red" });
    const names = keys.map((k) => k.key);
    expect(names).toContain("cherry");
    expect(names).not.toContain("date");
    expect(names).not.toContain("apple");
  });

  it("respects limit", () => {
    const keys = listKeys(db, NS, { limit: 2 });
    expect(keys.length).toBe(2);
  });

  it("respects offset for pagination", () => {
    const page1 = listKeys(db, NS, { limit: 2, offset: 0 });
    const page2 = listKeys(db, NS, { limit: 2, offset: 2 });
    const p1Names = page1.map((k) => k.key);
    const p2Names = page2.map((k) => k.key);
    // Pages should not overlap
    expect(p1Names.some((n) => p2Names.includes(n))).toBe(false);
  });

  it("returns all keys when no options provided", () => {
    const keys = listKeys(db, NS);
    expect(keys.length).toBe(5);
  });

  it("does not return expired keys", () => {
    db.exec(`
      INSERT INTO memory (ns, key, value, version, tags, created_by, updated_by,
                          created_at, updated_at, expires_at, deleted)
      VALUES ('${NS}', 'expired-item', '"x"', 1, '[]', 'agent', 'agent',
              datetime('now'), datetime('now'), datetime('now', '-1 seconds'), 0)
    `);
    const keys = listKeys(db, NS);
    expect(keys.map((k) => k.key)).not.toContain("expired-item");
  });
});

// ---------------------------------------------------------------------------
// bulkWrite tests
// ---------------------------------------------------------------------------

describe("bulkWrite", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });

  it("writes multiple keys atomically and returns correct count", () => {
    const result = bulkWrite(db, NS, [
      { key: "k1", value: "v1" },
      { key: "k2", value: "v2" },
      { key: "k3", value: 99 },
    ], AGENT);

    expect(result.written).toBe(3);
    expect(getKey(db, NS, "k1")).not.toBeNull();
    expect(getKey(db, NS, "k2")).not.toBeNull();
    expect(getKey(db, NS, "k3")).not.toBeNull();
  });

  it("all entries share the same namespace", () => {
    bulkWrite(db, "agent:rex", [
      { key: "x", value: 1 },
      { key: "y", value: 2 },
    ], "rex");

    expect(getKey(db, "agent:rex", "x")).not.toBeNull();
    expect(getKey(db, "agent:rex", "y")).not.toBeNull();
    // Not in mesh namespace
    expect(getKey(db, NS, "x")).toBeNull();
  });

  it("supports TTL and tags per entry", () => {
    bulkWrite(db, NS, [
      { key: "bk-ttl", value: "hello", ttl: 3600, tags: ["a", "b"] },
    ], AGENT);

    const entry = getKey(db, NS, "bk-ttl");
    expect(entry).not.toBeNull();
    expect(entry!.ttl_seconds).toBe(3600);
    expect(entry!.tags).toBe(JSON.stringify(["a", "b"]));
  });

  it("returns written=0 for empty entries array", () => {
    const result = bulkWrite(db, NS, [], AGENT);
    expect(result.written).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSnapshot tests
// ---------------------------------------------------------------------------

describe("getSnapshot", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });

  it("returns a flat key:value object for the namespace", () => {
    upsertKey(db, NS, "foo", "bar", AGENT);
    upsertKey(db, NS, "num", 42, AGENT);

    const snap = getSnapshot(db, NS);
    expect(snap["foo"]).toBe("bar");
    expect(snap["num"]).toBe(42);
  });

  it("excludes deleted keys from snapshot", () => {
    upsertKey(db, NS, "active", "yes", AGENT);
    upsertKey(db, NS, "dead", "no", AGENT);
    deleteKey(db, NS, "dead", AGENT);

    const snap = getSnapshot(db, NS);
    expect(snap["active"]).toBe("yes");
    expect("dead" in snap).toBe(false);
  });

  it("excludes expired keys from snapshot", () => {
    upsertKey(db, NS, "alive", "ok", AGENT);
    db.exec(`
      INSERT INTO memory (ns, key, value, version, tags, created_by, updated_by,
                          created_at, updated_at, expires_at, deleted)
      VALUES ('${NS}', 'old', '"gone"', 1, '[]', 'agent', 'agent',
              datetime('now'), datetime('now'), datetime('now', '-1 seconds'), 0)
    `);

    const snap = getSnapshot(db, NS);
    expect("old" in snap).toBe(false);
    expect(snap["alive"]).toBe("ok");
  });

  it("returns empty object for empty namespace", () => {
    const snap = getSnapshot(db, "agent:nobody");
    expect(Object.keys(snap).length).toBe(0);
  });

  it("parses complex nested values correctly", () => {
    const val = { items: [1, 2, 3], nested: { ok: true } };
    upsertKey(db, NS, "complex", val, AGENT);
    const snap = getSnapshot(db, NS);
    expect(snap["complex"]).toEqual(val);
  });
});

// ---------------------------------------------------------------------------
// Permission tests
// ---------------------------------------------------------------------------

describe("permissions — parseNamespace", () => {
  it("parses 'mesh' correctly", () => {
    expect(parseNamespace("mesh")).toEqual({ type: "mesh" });
  });

  it("parses 'agent:ocasia' correctly", () => {
    expect(parseNamespace("agent:ocasia")).toEqual({ type: "agent", owner: "ocasia" });
  });

  it("parses 'private:rex' correctly", () => {
    expect(parseNamespace("private:rex")).toEqual({ type: "private", owner: "rex" });
  });

  it("parses unknown namespace as 'unknown'", () => {
    expect(parseNamespace("random")).toEqual({ type: "unknown" });
  });

  it("treats 'agent:' with no owner as unknown", () => {
    expect(parseNamespace("agent:")).toEqual({ type: "unknown" });
  });

  it("treats 'private:' with no owner as unknown", () => {
    expect(parseNamespace("private:")).toEqual({ type: "unknown" });
  });
});

describe("permissions — mesh namespace", () => {
  it("any agent can write to mesh", () => {
    expect(canWrite("mesh", "ocasia")).toBe(true);
    expect(canWrite("mesh", "rex")).toBe(true);
    expect(canWrite("mesh", "paisley")).toBe(true);
  });

  it("any agent can read from mesh", () => {
    expect(canRead("mesh", "ocasia")).toBe(true);
    expect(canRead("mesh", "molly")).toBe(true);
  });
});

describe("permissions — agent namespace", () => {
  it("only the owning agent can write to agent:ocasia", () => {
    expect(canWrite("agent:ocasia", "ocasia")).toBe(true);
    expect(canWrite("agent:ocasia", "rex")).toBe(false);
    expect(canWrite("agent:ocasia", "paisley")).toBe(false);
  });

  it("all agents can read from agent:ocasia", () => {
    expect(canRead("agent:ocasia", "ocasia")).toBe(true);
    expect(canRead("agent:ocasia", "rex")).toBe(true);
    expect(canRead("agent:ocasia", "molly")).toBe(true);
  });
});

describe("permissions — private namespace", () => {
  it("only the owning agent can write to private:rex", () => {
    expect(canWrite("private:rex", "rex")).toBe(true);
    expect(canWrite("private:rex", "ocasia")).toBe(false);
  });

  it("only the owning agent can read from private:rex", () => {
    expect(canRead("private:rex", "rex")).toBe(true);
    expect(canRead("private:rex", "paisley")).toBe(false);
    expect(canRead("private:rex", "ocasia")).toBe(false);
  });
});

describe("permissions — unknown namespace", () => {
  it("no agent can write to unknown namespace", () => {
    expect(canWrite("random-ns", "ocasia")).toBe(false);
  });

  it("no agent can read from unknown namespace", () => {
    expect(canRead("random-ns", "rex")).toBe(false);
  });
});
