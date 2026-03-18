/**
 * notify/notifier.ts — HTTP POST notification helpers for MCS
 *
 * All functions are fire-and-forget. They never throw, never block the caller,
 * and always log success or failure to stderr for observability.
 */

// ---------------------------------------------------------------------------
// Internal shape for task assignment notifications
// ---------------------------------------------------------------------------

export interface TaskNotification {
  id: string;
  type: string;
  priority: number;
  payload: string; // JSON string
  assigned_to: string | null;
  claimed_at: string | null;
}

// ---------------------------------------------------------------------------
// Core fire-and-forget POST
// ---------------------------------------------------------------------------

/**
 * notifyUrl — Fire-and-forget POST to a URL with JSON payload.
 *
 * - 5 second timeout via AbortSignal.timeout()
 * - Logs success or failure but NEVER throws
 * - Returns void (caller does not await the result)
 */
export async function notifyUrl(url: string, payload: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(
        `[notify] POST ${url} returned HTTP ${res.status}`
      );
    } else {
      console.error(`[notify] POST ${url} OK (${res.status})`);
    }
  } catch (err) {
    // TimeoutError, NetworkError, DNS failure — all silently swallowed
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[notify] POST ${url} failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Task assignment notification
// ---------------------------------------------------------------------------

/**
 * notifyTaskAssigned — POST to agent's notify_url when a task is claimed.
 *
 * Called after dispatcher atomically claims a task. If notify_url is null,
 * this is a no-op.
 */
export async function notifyTaskAssigned(
  task: TaskNotification,
  agentId: string,
  agentNotifyUrl: string | null
): Promise<void> {
  if (!agentNotifyUrl) return;

  const payload = {
    event: "task_assigned",
    task_id: task.id,
    type: task.type,
    priority: task.priority,
    payload: (() => {
      try {
        return JSON.parse(task.payload);
      } catch {
        return task.payload;
      }
    })(),
    assigned_to: agentId,
    claimed_at: task.claimed_at ?? new Date().toISOString(),
  };

  // Fire and forget — do NOT await
  notifyUrl(agentNotifyUrl, payload).catch(() => {});
}

// ---------------------------------------------------------------------------
// Task result notification
// ---------------------------------------------------------------------------

/**
 * notifyTaskResult — POST to task's notify_url after a result is submitted.
 *
 * Called from the result handler route. If notify_url is null this is a no-op.
 */
export async function notifyTaskResult(
  taskId: string,
  status: string,
  result: unknown,
  taskNotifyUrl: string | null
): Promise<void> {
  if (!taskNotifyUrl) return;

  const event = status === "completed" ? "task_completed" : "task_failed";

  const payload = {
    event,
    task_id: taskId,
    status,
    result,
    completed_at: new Date().toISOString(),
  };

  // Fire and forget — do NOT await
  notifyUrl(taskNotifyUrl, payload).catch(() => {});
}
