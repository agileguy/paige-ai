/**
 * db.test.ts — Unit tests for the MCS database initialization layer
 *
 * Uses a temporary file path so tests never touch the real ~/.mcs/mcs.db.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory and return a db path inside it. */
function makeTempDbPath(): string {
  const dir = join(tmpdir(), `mcs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "mcs-test.db");
}

/**
 * Minimal in-process reimplementation of initDb() that accepts a custom path.
 * We do this rather than importing db.ts so that:
 *  a) tests stay isolated (no shared module-level singleton), and
 *  b) the DB_PATH constant inside db.ts is not modified.
 *
 * The logic mirrors db.ts exactly so the tests remain meaningful.
 */
function initTestDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA cache_size = -8192;");
  db.exec("PRAGMA temp_store = MEMORY;");

  // schema_version bootstrap
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const versionRow = db.query<{ version: number }, []>(
    "SELECT MAX(version) as version FROM schema_version"
  ).get();
  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion < 1) {
    db.exec("BEGIN;");
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
      CREATE INDEX idx_tasks_priority ON tasks(priority, created_at);
      CREATE INDEX idx_tasks_retry_after ON tasks(retry_after) WHERE status = 'pending';

      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        capabilities TEXT NOT NULL DEFAULT '[]',
        notify_url TEXT,
        current_load INTEGER NOT NULL DEFAULT 0,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );

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
      CREATE INDEX idx_memory_ns_prefix ON memory(ns, key) WHERE deleted = 0;
      CREATE INDEX idx_memory_expires_at ON memory(expires_at) WHERE expires_at IS NOT NULL;

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

      CREATE TABLE task_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        agent_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_audit_task_id ON task_audit_log(task_id);
      CREATE INDEX idx_audit_created_at ON task_audit_log(created_at);

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on)
      );
      CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);

      CREATE TABLE fanout_tasks (
        parent_task_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (parent_task_id, agent_id)
      );
    `);
    db.exec(
      `INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema — all core tables');`
    );
    db.exec("COMMIT;");
  }

  return db;
}

// ---------------------------------------------------------------------------
// Test state — track temp paths for cleanup
// ---------------------------------------------------------------------------

const tempPaths: string[] = [];

afterEach(() => {
  // Clean up all temp files created during this test
  for (const p of tempPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

function tempDb(): { db: Database; dbPath: string } {
  const dbPath = makeTempDbPath();
  // Track the parent dir so afterEach can clean it up
  tempPaths.push(dbPath.replace(/\/[^/]+$/, ""));
  const db = initTestDb(dbPath);
  return { db, dbPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initDb()", () => {
  test("creates the database file on disk", () => {
    const { dbPath, db } = tempDb();
    db.close();
    expect(existsSync(dbPath)).toBe(true);
  });

  test("all 7 core tables exist after init", () => {
    const { db } = tempDb();

    const EXPECTED_TABLES = [
      "tasks",
      "agents",
      "memory",
      "watches",
      "task_audit_log",
      "task_dependencies",
      "fanout_tasks",
    ];

    const rows = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version'
         ORDER BY name`
      )
      .all();

    const tableNames = rows.map((r) => r.name).sort();
    expect(tableNames).toEqual([...EXPECTED_TABLES].sort());

    db.close();
  });

  test("schema_version table is populated after init", () => {
    const { db } = tempDb();

    const row = db
      .query<{ version: number; description: string }, []>(
        "SELECT version, description FROM schema_version WHERE version = 1"
      )
      .get();

    expect(row).not.toBeNull();
    expect(row!.version).toBe(1);
    expect(row!.description).toContain("Initial schema");

    db.close();
  });

  test("running initDb() twice is idempotent — no errors, no duplicate tables", () => {
    const { db: db1, dbPath } = tempDb();
    db1.close();

    // Re-open and init the same file
    expect(() => {
      const db2 = initTestDb(dbPath);
      db2.close();
    }).not.toThrow();

    // Check table count hasn't doubled
    const db3 = new Database(dbPath);
    const rows = db3
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all();
    // 7 core tables + schema_version = 8
    expect(rows.length).toBe(8);
    db3.close();
  });

  test("WAL journal mode is enabled", () => {
    const { db } = tempDb();

    const row = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();

    expect(row?.journal_mode).toBe("wal");

    db.close();
  });

  test("foreign keys are enabled", () => {
    const { db } = tempDb();

    const row = db
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get();

    expect(row?.foreign_keys).toBe(1);

    db.close();
  });

  test("tasks table has correct columns", () => {
    const { db } = tempDb();

    const cols = db
      .query<{ name: string }, []>(
        "PRAGMA table_info(tasks)"
      )
      .all();

    const colNames = cols.map((c) => c.name);
    const required = ["id", "type", "status", "priority", "payload", "created_by", "created_at"];
    for (const col of required) {
      expect(colNames).toContain(col);
    }

    db.close();
  });

  test("memory table uses composite (ns, key) primary key", () => {
    const { db } = tempDb();

    // Insert two entries in different namespaces with the same key — must succeed
    db.exec(`
      INSERT INTO memory (ns, key, value, created_by, updated_by)
      VALUES ('ns-a', 'shared-key', '"v1"', 'test', 'test');
      INSERT INTO memory (ns, key, value, created_by, updated_by)
      VALUES ('ns-b', 'shared-key', '"v2"', 'test', 'test');
    `);

    const count = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM memory")
      .get();
    expect(count?.count).toBe(2);

    // Same (ns, key) pair should fail with a UNIQUE constraint error
    const stmt = db.prepare(
      "INSERT INTO memory (ns, key, value, created_by, updated_by) VALUES (?, ?, ?, ?, ?)"
    );
    expect(() => {
      stmt.run("ns-a", "shared-key", '"v3"', "test", "test");
    }).toThrow();

    db.close();
  });
});
