/**
 * db.ts — SQLite database initialization and migration system for MCS
 *
 * Opens (or creates) ~/.mcs/mcs.db, enables WAL + foreign keys,
 * and runs schema migrations tracked by the schema_version table.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

const MCS_DIR = join(process.env.HOME!, ".mcs");
const DB_PATH = join(MCS_DIR, "mcs.db");

let _db: Database | null = null;

// ---------------------------------------------------------------------------
// Schema migrations
// Each entry is applied exactly once, identified by its version number.
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  description: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — all core tables",
    sql: `
      -- Tasks: the primary work queue
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

      -- Agents: registered mesh participants
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        capabilities TEXT NOT NULL DEFAULT '[]',
        notify_url TEXT,
        current_load INTEGER NOT NULL DEFAULT 0,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );

      -- Memory: shared KV store with namespacing
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

      -- Watches: agent subscriptions to memory namespace changes
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

      -- Task audit log: event history for all task state transitions
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

      -- Task dependencies: DAG edges for task ordering
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on)
      );
      CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);

      -- Fanout tasks: parent → child mapping for broadcast tasks
      CREATE TABLE fanout_tasks (
        parent_task_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (parent_task_id, agent_id)
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function runMigrations(db: Database): void {
  // Bootstrap the version tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const getVersion = db.query<{ version: number }, []>(
    "SELECT MAX(version) as version FROM schema_version"
  );
  const row = getVersion.get();
  const currentVersion = row?.version ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    console.error(`[db] Schema up to date (version ${currentVersion})`);
    return;
  }

  for (const migration of pending) {
    console.error(
      `[db] Applying migration v${migration.version}: ${migration.description}`
    );
    db.exec("BEGIN;");
    try {
      db.exec(migration.sql);
      db.exec(
        `INSERT INTO schema_version (version, description) VALUES (${migration.version}, ${JSON.stringify(migration.description)});`
      );
      db.exec("COMMIT;");
      console.error(`[db] Migration v${migration.version} applied`);
    } catch (err) {
      db.exec("ROLLBACK;");
      throw new Error(
        `Migration v${migration.version} failed: ${(err as Error).message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the database. Creates ~/.mcs/ if needed, opens the SQLite file,
 * enables WAL mode + foreign keys, and runs all pending migrations.
 *
 * Returns the Database instance (also stored as a module-level singleton).
 */
export function initDb(): Database {
  // Ensure the data directory exists
  mkdirSync(MCS_DIR, { recursive: true });

  const db = new Database(DB_PATH, { create: true });

  // Performance + correctness settings
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA cache_size = -8192;"); // 8 MB page cache
  db.exec("PRAGMA temp_store = MEMORY;");

  runMigrations(db);

  _db = db;
  console.error(`[db] Database ready at ${DB_PATH}`);
  return db;
}

/**
 * Return the already-initialized Database singleton.
 * Throws if initDb() has not been called first.
 */
export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return _db;
}

/** Exposed for tests and diagnostics. */
export { DB_PATH, MCS_DIR };
