/**
 * dispatch/fanout.ts — Fanout task completion tracking for MCS
 *
 * When a task with routing_hint="all" is dispatched, child tasks are created
 * for each capable agent. This module checks completion of sibling children
 * and marks the parent task as completed or failed accordingly.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Internal query types
// ---------------------------------------------------------------------------

interface FanoutChildRow {
  child_task_id: string;
  agent_id: string;
}

interface FanoutParentRow {
  parent_task_id: string;
}

interface ChildStatusRow {
  id: string;
  status: string;
  result_output: string | null;
  result_error: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * checkFanoutCompletion — Check if a fanout child's siblings are all done.
 *
 * If this task is a fanout child (appears in fanout_tasks.child_task_id),
 * this function examines all sibling children. If all are resolved
 * (completed or failed), it marks the parent task:
 *   - completed  — if ALL children completed
 *   - failed     — if ANY child failed
 *
 * The parent's result_output is set to the JSON-encoded aggregate of child
 * results: { [agent_id]: { status, output } }.
 *
 * If children are still in-flight, this is a no-op.
 *
 * @param db          - Active database connection
 * @param childTaskId - The child task that just submitted a result
 */
export function checkFanoutCompletion(db: Database, childTaskId: string): void {
  // 1. Check if this task is a fanout child
  const parentRow = db
    .query<FanoutParentRow, [string]>(
      `SELECT parent_task_id FROM fanout_tasks WHERE child_task_id = ?`
    )
    .get(childTaskId);

  if (!parentRow) {
    // Not a fanout child — nothing to do
    return;
  }

  const parentId = parentRow.parent_task_id;

  // 2. Fetch all sibling children for this parent
  const children = db
    .query<FanoutChildRow, [string]>(
      `SELECT child_task_id, agent_id FROM fanout_tasks WHERE parent_task_id = ?`
    )
    .all(parentId);

  if (children.length === 0) {
    // Shouldn't happen, but guard defensively
    console.error(`[fanout] No children found for parent ${parentId} — skipping`);
    return;
  }

  // 3. Fetch status of all children
  const childIds = children.map((c) => c.child_task_id);
  const placeholders = childIds.map(() => "?").join(", ");

  const childStatuses = db
    .query<ChildStatusRow, string[]>(
      `SELECT id, status, result_output, result_error
       FROM tasks
       WHERE id IN (${placeholders})`
    )
    .all(...childIds);

  // 4. Check if all children are in a terminal state
  const terminalStatuses = new Set(["completed", "failed"]);
  const allResolved = childStatuses.every((c) => terminalStatuses.has(c.status));

  if (!allResolved) {
    // Still waiting for some children — nothing to do yet
    return;
  }

  // 5. Aggregate results keyed by agent_id
  const childById = new Map(childStatuses.map((c) => [c.id, c]));
  const aggregate: Record<string, { status: string; output: unknown; error: string | null }> = {};

  for (const child of children) {
    const status = childById.get(child.child_task_id);
    if (status) {
      aggregate[child.agent_id] = {
        status: status.status,
        output: (() => {
          if (!status.result_output) return null;
          try {
            return JSON.parse(status.result_output);
          } catch {
            return status.result_output;
          }
        })(),
        error: status.result_error,
      };
    }
  }

  // 6. Determine parent outcome: any failure → parent fails
  const anyFailed = childStatuses.some((c) => c.status === "failed");
  const parentStatus = anyFailed ? "failed" : "completed";
  const now = new Date().toISOString();

  // 7. Mark parent task with aggregated result
  db.prepare(`
    UPDATE tasks
    SET status = ?,
        result_status = ?,
        result_output = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    parentStatus,
    parentStatus,
    JSON.stringify(aggregate),
    now,
    now,
    parentId
  );

  // 8. Write audit log entry
  db.prepare(`
    INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
    VALUES (?, ?, NULL, ?)
  `).run(
    parentId,
    parentStatus === "completed" ? "fanout_completed" : "fanout_failed",
    JSON.stringify({
      child_count: children.length,
      any_failed: anyFailed,
      agents: Object.keys(aggregate),
    })
  );

  console.error(
    `[fanout] Parent ${parentId} ${parentStatus} — ${children.length} children resolved`
  );
}
