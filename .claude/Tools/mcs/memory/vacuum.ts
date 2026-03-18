/**
 * memory/vacuum.ts — Background cleanup job for MCS
 *
 * Runs every 60 seconds to:
 *   1. Hard-delete tombstoned memory rows older than 24 hours
 *   2. Soft-delete (mark deleted=1) expired memory keys
 *   3. Remove expired watch subscriptions
 *
 * The two-phase GC (soft-delete → tombstone → hard-delete) ensures that
 * watcher queries never see stale rows and consumers of the store can observe
 * a deleted-but-not-yet-purged tombstone during the 24-hour grace window.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Vacuum result shape
// ---------------------------------------------------------------------------

export interface VacuumResult {
  tombstones: number;
  expiredKeys: number;
  expiredWatches: number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

const VACUUM_INTERVAL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Core tick — exposed for unit testing
// ---------------------------------------------------------------------------

/**
 * vacuumTick — run a single vacuum pass against the database.
 *
 * Step 1: Hard-delete tombstoned rows that are at least 24 hours old.
 * Step 2: Soft-delete expired non-deleted keys (sets deleted=1 so the
 *         watcher and store treat them as gone, but the GC picks them up
 *         in a future tick after the 24h grace period).
 * Step 3: Hard-delete watch subscriptions whose expires_at has passed.
 *
 * Returns counts of affected rows for logging.
 */
export function vacuumTick(db: Database): VacuumResult {
  // Step 1 — purge tombstones older than 24 hours
  const tombstoneResult = db
    .prepare(`
      DELETE FROM memory
      WHERE deleted = 1
        AND updated_at < datetime('now', '-24 hours')
    `)
    .run();

  // Step 2 — soft-delete expired live keys
  const expiredResult = db
    .prepare(`
      UPDATE memory
      SET deleted = 1,
          updated_at = datetime('now')
      WHERE expires_at IS NOT NULL
        AND expires_at < datetime('now')
        AND deleted = 0
    `)
    .run();

  // Step 3 — hard-delete expired watches
  const watchResult = db
    .prepare(`
      DELETE FROM watches
      WHERE expires_at < datetime('now')
    `)
    .run();

  return {
    tombstones: tombstoneResult.changes,
    expiredKeys: expiredResult.changes,
    expiredWatches: watchResult.changes,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * startVacuum — kick off the background vacuum interval.
 *
 * Idempotent: calling startVacuum() a second time without calling stopVacuum()
 * first is a no-op (the existing interval is kept running).
 */
export function startVacuum(db: Database): void {
  if (_intervalHandle !== null) {
    console.error("[vacuum] Already running — ignoring duplicate start");
    return;
  }

  _intervalHandle = setInterval(() => {
    try {
      const result = vacuumTick(db);
      console.error(
        `[vacuum] Purged ${result.tombstones} tombstones, ` +
          `${result.expiredKeys} expired keys, ` +
          `${result.expiredWatches} expired watches`
      );
    } catch (err) {
      console.error("[vacuum] Error during vacuum tick:", err);
    }
  }, VACUUM_INTERVAL_MS);

  // Prevent the interval from keeping the process alive if nothing else is running
  if (typeof _intervalHandle === "object" && _intervalHandle !== null && "unref" in _intervalHandle) {
    (_intervalHandle as NodeJS.Timeout).unref();
  }

  console.error("[vacuum] Started (interval: 60s)");
}

/**
 * stopVacuum — cancel the background vacuum interval.
 *
 * Idempotent: safe to call even if vacuum was never started.
 */
export function stopVacuum(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    console.error("[vacuum] Stopped");
  }
}
