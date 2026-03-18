/**
 * memory/store.ts — Core KV operations for the MCS shared memory store
 *
 * Values are always stored as JSON strings in the `value` column.
 * Tags are stored as a JSON array string in the `tags` column.
 * TTL is stored as an integer seconds value; expires_at is computed at write time.
 */

import type { Database } from "bun:sqlite";
import type { MemoryEntry } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertOptions {
  ttl?: number;        // seconds
  tags?: string[];
}

export interface ListOptions {
  prefix?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface BulkEntry {
  key: string;
  value: unknown;
  ttl?: number;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// upsertKey — Insert or update a key in the memory store
// ---------------------------------------------------------------------------

/**
 * Insert or update a key in the memory store.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE for atomic upsert (no TOCTOU race).
 * Tombstoned rows (deleted=1) sharing the same PK are overwritten.
 *
 * - If key doesn't exist: insert with version=1
 * - If key exists: increment version, update value/updatedBy/updatedAt, clear deleted flag
 * - If ttl provided: set expires_at = now + ttl seconds
 * - If tags provided: store as JSON array string
 */
export function upsertKey(
  db: Database,
  ns: string,
  key: string,
  value: unknown,
  agentId: string,
  options: UpsertOptions = {}
): MemoryEntry {
  const valueStr = JSON.stringify(value);
  const tagsStr = JSON.stringify(options.tags ?? []);
  const now = new Date().toISOString();
  const ttlSeconds = options.ttl ?? null;

  if (ttlSeconds !== null) {
    db.prepare(`
      INSERT INTO memory (ns, key, value, version, ttl_seconds, tags,
                          created_by, updated_by, created_at, updated_at,
                          expires_at, deleted)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?,
              datetime('now', '+' || ? || ' seconds'), 0)
      ON CONFLICT (ns, key) DO UPDATE SET
        value = excluded.value,
        version = version + 1,
        ttl_seconds = excluded.ttl_seconds,
        tags = excluded.tags,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        expires_at = datetime('now', '+' || excluded.ttl_seconds || ' seconds'),
        deleted = 0
    `).run(ns, key, valueStr, ttlSeconds, tagsStr, agentId, agentId, now, now, ttlSeconds);
  } else {
    db.prepare(`
      INSERT INTO memory (ns, key, value, version, ttl_seconds, tags,
                          created_by, updated_by, created_at, updated_at,
                          expires_at, deleted)
      VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT (ns, key) DO UPDATE SET
        value = excluded.value,
        version = version + 1,
        ttl_seconds = NULL,
        tags = excluded.tags,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        expires_at = NULL,
        deleted = 0
    `).run(ns, key, valueStr, tagsStr, agentId, agentId, now, now);
  }

  return getKey(db, ns, key)!;
}

// ---------------------------------------------------------------------------
// getKey — Retrieve a key, respecting deleted + expiry
// ---------------------------------------------------------------------------

/**
 * Get a key from the store.
 * Returns null if the key does not exist, is deleted, or is expired.
 */
export function getKey(db: Database, ns: string, key: string): MemoryEntry | null {
  const row = db
    .query<MemoryEntry, [string, string]>(
      `SELECT * FROM memory
       WHERE ns = ? AND key = ? AND deleted = 0
         AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .get(ns, key);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// deleteKey — Soft-delete (tombstone) a key
// ---------------------------------------------------------------------------

/**
 * Soft-delete a key by setting deleted=1.
 * Returns true if the key existed and was deleted, false if not found.
 */
export function deleteKey(db: Database, ns: string, key: string, agentId: string): boolean {
  const existing = getKey(db, ns, key);
  if (!existing) return false;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE memory
    SET deleted = 1, updated_by = ?, updated_at = ?
    WHERE ns = ? AND key = ?
  `).run(agentId, now, ns, key);

  return true;
}

// ---------------------------------------------------------------------------
// listKeys — List active keys in a namespace with optional filtering
// ---------------------------------------------------------------------------

/**
 * List non-deleted, non-expired keys in a namespace.
 * Supports prefix filter, tag filter, and pagination.
 */
export function listKeys(db: Database, ns: string, options: ListOptions = {}): MemoryEntry[] {
  const { prefix, tag, limit = 50, offset = 0 } = options;

  const conditions: string[] = [
    "ns = ?",
    "deleted = 0",
    "(expires_at IS NULL OR expires_at > datetime('now'))",
  ];
  const params: (string | number)[] = [ns];

  if (prefix) {
    conditions.push("key LIKE ?");
    params.push(`${prefix}%`);
  }

  if (tag) {
    // Tags are stored as JSON arrays; use json_each for reliable membership check
    conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)");
    params.push(tag);
  }

  const where = conditions.join(" AND ");
  params.push(limit, offset);

  return db
    .query<MemoryEntry, (string | number)[]>(
      `SELECT * FROM memory WHERE ${where} ORDER BY key ASC LIMIT ? OFFSET ?`
    )
    .all(...params);
}

// ---------------------------------------------------------------------------
// bulkWrite — Write multiple keys in a single transaction
// ---------------------------------------------------------------------------

/**
 * Write multiple keys atomically inside a single transaction.
 * Returns the count of keys written.
 */
export function bulkWrite(
  db: Database,
  ns: string,
  entries: BulkEntry[],
  agentId: string
): { written: number } {
  db.exec("BEGIN;");
  try {
    for (const entry of entries) {
      upsertKey(db, ns, entry.key, entry.value, agentId, {
        ttl: entry.ttl,
        tags: entry.tags,
      });
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return { written: entries.length };
}

// ---------------------------------------------------------------------------
// getSnapshot — Flat key:value dump of an entire namespace
// ---------------------------------------------------------------------------

/**
 * Return all non-deleted, non-expired keys as a flat { key: parsedValue } object.
 */
export function getSnapshot(db: Database, ns: string): Record<string, unknown> {
  const rows = db
    .query<{ key: string; value: string }, [string]>(
      `SELECT key, value FROM memory
       WHERE ns = ? AND deleted = 0
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY key ASC`
    )
    .all(ns);

  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }

  return result;
}
