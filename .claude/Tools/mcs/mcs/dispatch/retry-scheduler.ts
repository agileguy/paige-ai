/**
 * retry-scheduler.ts — Retry logic with exponential backoff for MCS
 *
 * Called by the result handler when a task result is submitted with
 * status="failed". This is NOT a background loop — it's a synchronous
 * function that either schedules a retry or permanently fails the task.
 *
 * Backoff formula: min(10 * 2^(attempt - 1), 600) seconds
 *   attempt=1 →  10s
 *   attempt=2 →  20s
 *   attempt=3 →  40s
 *   attempt=4 →  80s
 *   attempt=5 → 160s
 *   attempt=6 → 320s
 *   attempt=7 → 600s (capped)
 */

import type { Database } from "bun:sqlite";
import { notifyPermanentFailure } from "../notify/telegram.ts";

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface RetryResult {
  retried: boolean;
  reason?: string;
  delay_seconds?: number;
  retry_after?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate exponential backoff delay in seconds.
 * Base: 10s, multiplier: 2^(attempt-1), cap: 600s (10 min).
 */
export function calcBackoffSeconds(attempt: number): number {
  return Math.min(10 * Math.pow(2, attempt - 1), 600);
}

/**
 * Add `seconds` to now and return an ISO 8601 datetime string.
 */
function isoFuture(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedule a retry for a failed task, or permanently fail it if max_retries
 * has been reached.
 *
 * @param db           - Active database connection
 * @param taskId       - The task to retry
 * @param attempt      - The attempt number that just failed (1-based)
 * @param maxRetries   - Maximum number of allowed retries
 * @param agentId      - The agent that was assigned the task (for load decrement + audit)
 * @param taskType     - The task type string (for Telegram alert on permanent failure)
 * @param createdBy    - The agent that created the task (for Telegram alert)
 * @param lastError    - The error message from the last failure (for Telegram alert)
 *
 * @returns RetryResult indicating whether a retry was scheduled
 */
export function scheduleRetry(
  db: Database,
  taskId: string,
  attempt: number,
  maxRetries: number,
  agentId: string,
  taskType: string = "unknown",
  createdBy: string = "unknown",
  lastError: string = ""
): RetryResult {
  if (attempt >= maxRetries) {
    // Permanently failed — no more retries
    db.prepare(
      `UPDATE tasks
       SET status = 'failed',
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(taskId);

    // Decrement agent load
    db.prepare(
      `UPDATE agents
       SET current_load = MAX(current_load - 1, 0)
       WHERE agent_id = ?`
    ).run(agentId);

    // Audit log
    db.prepare(
      `INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
       VALUES (?, 'permanently_failed', ?, ?)`
    ).run(
      taskId,
      agentId,
      JSON.stringify({ attempt, reason: "max_retries_exceeded" })
    );

    console.error(
      `[retry] Task ${taskId} permanently failed after ${attempt} attempt(s) (max: ${maxRetries})`
    );

    // Fire-and-forget Telegram alert to AI Mesh group
    notifyPermanentFailure(
      taskId,
      taskType,
      createdBy,
      attempt,
      maxRetries,
      lastError || "max_retries_exceeded"
    ).catch(() => {});

    return { retried: false, reason: "max_retries_exceeded" };
  }

  // Calculate backoff window
  const delaySec = calcBackoffSeconds(attempt);
  const retryAfter = isoFuture(delaySec);

  // Return task to pending with retry_after gate
  db.prepare(
    `UPDATE tasks
     SET status = 'pending',
         assigned_to = NULL,
         claimed_at = NULL,
         claim_expires_at = NULL,
         retry_after = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(retryAfter, taskId);

  // Decrement agent load
  db.prepare(
    `UPDATE agents
     SET current_load = MAX(current_load - 1, 0)
     WHERE agent_id = ?`
  ).run(agentId);

  // Audit log
  db.prepare(
    `INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
     VALUES (?, 'retried', ?, ?)`
  ).run(
    taskId,
    agentId,
    JSON.stringify({ attempt, delay_seconds: delaySec, retry_after: retryAfter })
  );

  console.error(
    `[retry] Task ${taskId} scheduled for retry in ${delaySec}s (attempt ${attempt}/${maxRetries})`
  );

  return {
    retried: true,
    delay_seconds: delaySec,
    retry_after: retryAfter,
  };
}
