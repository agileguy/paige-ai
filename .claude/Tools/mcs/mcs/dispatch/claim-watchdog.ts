/**
 * claim-watchdog.ts — Expired claim detector for MCS
 *
 * Runs as a setInterval every 30 seconds. Finds tasks whose claim TTL has
 * expired and returns them to 'pending' so the dispatcher can re-assign them.
 * Decrements the agent's current_load counter and writes an audit log entry.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ExpiredClaimRow {
  id: string;
  assigned_to: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _interval: ReturnType<typeof setInterval> | null = null;
const WATCHDOG_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Core watchdog tick
// ---------------------------------------------------------------------------

export function claimWatchdogTick(db: Database): number {
  const expired = db
    .query<ExpiredClaimRow, []>(
      `SELECT id, assigned_to
       FROM tasks
       WHERE status = 'claimed'
         AND claim_expires_at < datetime('now')
         AND assigned_to IS NOT NULL`
    )
    .all();

  if (expired.length === 0) return 0;

  for (const task of expired) {
    const prevAgent = task.assigned_to;

    try {
      // Release claim: return task to pending, clear assignment fields
      db.prepare(
        `UPDATE tasks
         SET status = 'pending',
             assigned_to = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(task.id);

      // Decrement agent load (floor at 0 to guard against drift)
      db.prepare(
        `UPDATE agents
         SET current_load = MAX(current_load - 1, 0)
         WHERE agent_id = ?`
      ).run(prevAgent);

      // Audit log
      db.prepare(
        `INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
         VALUES (?, 'expired', ?, 'claim TTL expired')`
      ).run(task.id, prevAgent);

      console.error(
        `[watchdog] Task ${task.id} claim expired for ${prevAgent}, returned to pending`
      );
    } catch (err) {
      console.error(`[watchdog] Error releasing expired claim for task ${task.id}:`, err);
    }
  }

  return expired.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the claim watchdog. Runs every 30 seconds.
 * Safe to call multiple times — only one interval will run at a time.
 */
export function startClaimWatchdog(db: Database): void {
  if (_interval !== null) {
    console.error("[watchdog] Claim watchdog already running");
    return;
  }

  console.error("[watchdog] Claim watchdog started (interval: 30s)");
  _interval = setInterval(() => {
    try {
      claimWatchdogTick(db);
    } catch (err) {
      console.error("[watchdog] Uncaught error in watchdog tick:", err);
    }
  }, WATCHDOG_INTERVAL_MS);
}

/**
 * Stop the claim watchdog. Used in tests and graceful shutdown.
 */
export function stopClaimWatchdog(): void {
  if (_interval !== null) {
    clearInterval(_interval);
    _interval = null;
    console.error("[watchdog] Claim watchdog stopped");
  }
}
