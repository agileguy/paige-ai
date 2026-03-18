/**
 * startup-recovery.ts — Stale task recovery on MCS server restart
 *
 * Called once during startup (after initDb). Finds all tasks that were
 * left in 'claimed' or 'in_progress' state with an expired claim TTL and
 * returns them to 'pending'. Also resets all agent current_load counters to 0
 * for a clean start, since in-memory load tracking doesn't survive restarts.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface StaleTaskRow {
  id: string;
  assigned_to: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recover stale tasks after a server restart.
 *
 * A task is considered stale if it is in 'claimed' or 'in_progress' status
 * AND its claim_expires_at is in the past (or NULL, which indicates a task
 * that was in_progress without a TTL gate and should also be reset).
 *
 * @param db - Initialized database connection
 * @returns  Number of tasks recovered (returned to pending)
 */
export function recoverStaleTasks(db: Database): number {
  // Find all tasks that were mid-flight when the server died
  const staleTasks = db
    .query<StaleTaskRow, []>(
      `SELECT id, assigned_to
       FROM tasks
       WHERE status IN ('claimed', 'in_progress')
         AND (claim_expires_at IS NULL OR claim_expires_at < datetime('now'))`
    )
    .all();

  const count = staleTasks.length;

  if (count > 0) {
    for (const task of staleTasks) {
      db.prepare(
        `UPDATE tasks
         SET status = 'pending',
             assigned_to = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(task.id);

      // Write recovery audit event
      db.prepare(
        `INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
         VALUES (?, 'expired', ?, 'released on startup recovery')`
      ).run(task.id, task.assigned_to ?? null);
    }
  }

  // Reset ALL agent load counters to 0 — in-memory counters are meaningless
  // after a restart since we don't know which work was actually in flight.
  db.exec(`UPDATE agents SET current_load = 0`);

  console.error(`[recovery] Released ${count} stale task(s) on startup`);
  return count;
}
