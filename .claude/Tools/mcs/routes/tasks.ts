/**
 * routes/tasks.ts — Task CRUD endpoint handlers for MCS
 *
 * All handlers accept (req, agentId, db, ...params) and return Response.
 * Priority string → int mapping: urgent=1, normal=2, low=3.
 */

import type { Database } from "bun:sqlite";
import { TaskStatus, Priority } from "../types.ts";
import type { Task, AuditEvent } from "../types.ts";
import { scheduleRetry } from "../dispatch/retry-scheduler.ts";
import { checkFanoutCompletion } from "../dispatch/fanout.ts";
import { notifyTaskResult } from "../notify/notifier.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, code: string, status: number): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function priorityFromString(s: string): number {
  switch (s) {
    case "urgent": return Priority.Urgent;
    case "low":    return Priority.Low;
    default:       return Priority.Normal;
  }
}

function addAuditEntry(
  db: Database,
  taskId: string,
  eventType: string,
  agentId: string | null,
  detail: unknown = null
): void {
  const stmt = db.prepare(`
    INSERT INTO task_audit_log (task_id, event_type, agent_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    taskId,
    eventType,
    agentId,
    detail !== null ? JSON.stringify(detail) : null,
    new Date().toISOString()
  );
}

/** Parse caps_required from JSON string in a task row */
function parseCaps(raw: string | null): string[] {
  try {
    return JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
}


// ---------------------------------------------------------------------------
// POST /tasks — Create a new task
// ---------------------------------------------------------------------------

export async function handleCreateTask(
  req: Request,
  agentId: string,
  db: Database
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", "BAD_REQUEST", 400);
  }

  const type = body.type;
  if (!type || typeof type !== "string") {
    return jsonError("Field 'type' is required and must be a string", "BAD_REQUEST", 400);
  }

  if (body.payload === undefined) {
    return jsonError("Field 'payload' is required", "BAD_REQUEST", 400);
  }

  const priorityRaw = typeof body.priority === "string" ? body.priority : "normal";
  const priority = priorityFromString(priorityRaw);
  const capsRequired = Array.isArray(body.caps_required) ? body.caps_required : [];
  const routingHint = typeof body.routing_hint === "string" ? body.routing_hint : "any";
  const maxRetries = typeof body.max_retries === "number" ? body.max_retries : 3;
  const claimTtl = typeof body.claim_ttl_seconds === "number" ? body.claim_ttl_seconds : 300;
  const notifyUrl = typeof body.notify_url === "string" ? body.notify_url : null;
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
  const dependsOn = Array.isArray(body.depends_on) ? (body.depends_on as string[]) : [];

  // Idempotency check — return existing task if key already used
  if (idempotencyKey) {
    const existing = db
      .query<{ id: string; status: string; created_at: string }, [string]>(
        "SELECT id, status, created_at FROM tasks WHERE idempotency_key = ?"
      )
      .get(idempotencyKey);

    if (existing) {
      return json(
        {
          error: "Task with this idempotency_key already exists",
          code: "DUPLICATE_IDEMPOTENCY_KEY",
          task_id: existing.id,
          status: existing.status,
          created_at: existing.created_at,
        },
        409
      );
    }
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, type, status, priority, payload, caps_required, routing_hint,
      created_by, max_retries, claim_ttl_seconds, notify_url, idempotency_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertTask.run(
    taskId,
    type,
    TaskStatus.Pending,
    priority,
    JSON.stringify(body.payload),
    JSON.stringify(capsRequired),
    routingHint,
    agentId,
    maxRetries,
    claimTtl,
    notifyUrl,
    idempotencyKey,
    now,
    now
  );

  // Insert dependencies
  if (dependsOn.length > 0) {
    const insertDep = db.prepare(
      "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)"
    );
    for (const depId of dependsOn) {
      insertDep.run(taskId, depId);
    }
  }

  addAuditEntry(db, taskId, "created", agentId, { type, priority });

  return json({ task_id: taskId, status: TaskStatus.Pending, created_at: now }, 201);
}

// ---------------------------------------------------------------------------
// GET /tasks/:id — Get task by ID
// ---------------------------------------------------------------------------

export function handleGetTask(
  _req: Request,
  _agentId: string,
  db: Database,
  taskId: string
): Response {
  const row = db
    .query<Task, [string]>("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL")
    .get(taskId);

  if (!row) {
    return jsonError("Task not found", "NOT_FOUND", 404);
  }

  return json({
    ...row,
    caps_required: parseCaps(row.caps_required),
    payload: (() => { try { return JSON.parse(row.payload); } catch { return row.payload; } })(),
    result_output: (() => {
      if (!row.result_output) return null;
      try { return JSON.parse(row.result_output); } catch { return row.result_output; }
    })(),
  });
}

// ---------------------------------------------------------------------------
// GET /tasks/mine — Get tasks assigned to the calling agent
// ---------------------------------------------------------------------------

export function handleGetMyTasks(
  req: Request,
  agentId: string,
  db: Database
): Response {
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 200);

  let rows: Task[];

  if (statusFilter) {
    rows = db
      .query<Task, [string, string, number]>(
        "SELECT * FROM tasks WHERE assigned_to = ? AND status = ? AND deleted_at IS NULL ORDER BY priority ASC, created_at ASC LIMIT ?"
      )
      .all(agentId, statusFilter, limit);
  } else {
    rows = db
      .query<Task, [string, string, string, number]>(
        "SELECT * FROM tasks WHERE assigned_to = ? AND status IN (?, ?) AND deleted_at IS NULL ORDER BY priority ASC, created_at ASC LIMIT ?"
      )
      .all(agentId, TaskStatus.Claimed, TaskStatus.InProgress, limit);
  }

  const tasks = rows.map((r) => ({
    ...r,
    caps_required: parseCaps(r.caps_required),
    payload: (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })(),
  }));

  return json({ tasks, count: tasks.length });
}

// ---------------------------------------------------------------------------
// GET /tasks — List tasks with filters
// ---------------------------------------------------------------------------

export function handleListTasks(
  req: Request,
  _agentId: string,
  db: Database
): Response {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const assignedTo = url.searchParams.get("assigned_to");
  const createdBy = url.searchParams.get("created_by");
  const priority = url.searchParams.get("priority");
  const since = url.searchParams.get("since");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const conditions: string[] = ["deleted_at IS NULL"];
  const params: (string | number)[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (assignedTo) {
    conditions.push("assigned_to = ?");
    params.push(assignedTo);
  }
  if (createdBy) {
    conditions.push("created_by = ?");
    params.push(createdBy);
  }
  if (priority) {
    const pInt = priorityFromString(priority);
    conditions.push("priority = ?");
    params.push(pInt);
  }
  if (since) {
    conditions.push("created_at >= ?");
    params.push(since);
  }

  const where = conditions.join(" AND ");

  const countRow = db
    .query<{ total: number }, (string | number)[]>(
      `SELECT COUNT(*) as total FROM tasks WHERE ${where}`
    )
    .get(...params);

  const total = countRow?.total ?? 0;

  const rows = db
    .query<Task, (string | number)[]>(
      `SELECT * FROM tasks WHERE ${where} ORDER BY priority ASC, created_at ASC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const tasks = rows.map((r) => ({
    ...r,
    caps_required: parseCaps(r.caps_required),
    payload: (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })(),
  }));

  return json({ tasks, total, limit, offset });
}

// ---------------------------------------------------------------------------
// POST /tasks/:id/result — Submit result for an assigned task
// ---------------------------------------------------------------------------

export async function handleSubmitResult(
  req: Request,
  agentId: string,
  db: Database,
  taskId: string
): Promise<Response> {
  const task = db
    .query<Task, [string]>("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL")
    .get(taskId);

  if (!task) {
    return jsonError("Task not found", "NOT_FOUND", 404);
  }

  if (task.assigned_to !== agentId) {
    return jsonError("Task is not assigned to you", "FORBIDDEN", 403);
  }

  if (task.status === TaskStatus.Completed || task.status === TaskStatus.Failed) {
    return jsonError(
      `Task is already ${task.status}`,
      "ALREADY_TERMINAL",
      409
    );
  }

  if (task.status !== TaskStatus.Claimed && task.status !== TaskStatus.InProgress) {
    return jsonError(
      `Task must be in claimed or in_progress state to submit a result, current: ${task.status}`,
      "INVALID_STATE",
      409
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", "BAD_REQUEST", 400);
  }

  const resultStatus = body.status;
  if (resultStatus !== "completed" && resultStatus !== "failed") {
    return jsonError(
      "Field 'status' must be 'completed' or 'failed'",
      "BAD_REQUEST",
      400
    );
  }

  const output = body.output !== undefined ? JSON.stringify(body.output) : null;
  const error = typeof body.error === "string" ? body.error : null;
  const now = new Date().toISOString();

  // Atomic: wrap task update, audit, and load decrement in a transaction
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          result_status = ?,
          result_output = ?,
          result_error = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(resultStatus, resultStatus, output, error, now, now, taskId);

    addAuditEntry(db, taskId, resultStatus === "completed" ? "completed" : "failed", agentId, {
      result_status: resultStatus,
      has_error: !!error,
    });

    // Only decrement load for completed tasks; failed tasks are handled by scheduleRetry
    if (resultStatus === "completed") {
      db.prepare(
        `UPDATE agents SET current_load = MAX(current_load - 1, 0) WHERE agent_id = ?`
      ).run(agentId);
    }

    db.exec("COMMIT;");
  } catch (txErr) {
    try { db.exec("ROLLBACK;"); } catch { /* ignore rollback errors */ }
    throw txErr;
  }

  // Handle retry scheduling for failed tasks
  let retryScheduled = false;
  if (resultStatus === "failed") {
    const retryResult = scheduleRetry(
      db,
      taskId,
      task.attempt,
      task.max_retries,
      agentId,
      task.type,
      task.created_by,
      error ?? "unknown error"
    );
    retryScheduled = retryResult.retried;
  }

  // Fire-and-forget notify to task's notify_url
  let notifyDispatched = false;
  if (task.notify_url) {
    const resultOutput = body.output !== undefined ? body.output : null;
    notifyTaskResult(taskId, resultStatus, resultOutput, task.notify_url).catch(() => {});
    notifyDispatched = true;
  }

  // Check if this task is a fanout child and update parent if all siblings done
  try {
    checkFanoutCompletion(db, taskId);
  } catch (fanoutErr) {
    // Non-fatal — log but don't fail the response
    console.error(`[tasks] checkFanoutCompletion error for ${taskId}:`, fanoutErr);
  }

  return json({
    task_id: taskId,
    status: resultStatus,
    notify_dispatched: notifyDispatched,
    retry_scheduled: retryScheduled,
  });
}

// ---------------------------------------------------------------------------
// POST /tasks/:id/heartbeat — Keep claim alive
// ---------------------------------------------------------------------------

export function handleHeartbeat(
  _req: Request,
  agentId: string,
  db: Database,
  taskId: string
): Response {
  const task = db
    .query<Task, [string]>("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL")
    .get(taskId);

  if (!task) {
    return jsonError("Task not found", "NOT_FOUND", 404);
  }

  if (task.assigned_to !== agentId) {
    return jsonError("Task is not assigned to you", "CONFLICT", 409);
  }

  if (task.status !== TaskStatus.Claimed && task.status !== TaskStatus.InProgress) {
    return jsonError(
      `Task must be in claimed or in_progress state, current: ${task.status}`,
      "INVALID_STATE",
      409
    );
  }

  const now = new Date();
  const newExpiry = new Date(now.getTime() + task.claim_ttl_seconds * 1000).toISOString();
  const nowIso = now.toISOString();

  db.prepare(`
    UPDATE tasks SET claim_expires_at = ?, updated_at = ? WHERE id = ?
  `).run(newExpiry, nowIso, taskId);

  addAuditEntry(db, taskId, "heartbeat", agentId, { claim_expires_at: newExpiry });

  return json({ ok: true, claim_expires_at: newExpiry });
}

// ---------------------------------------------------------------------------
// GET /tasks/:id/audit — Get audit trail for a task
// ---------------------------------------------------------------------------

export function handleGetAudit(
  _req: Request,
  _agentId: string,
  db: Database,
  taskId: string
): Response {
  const taskExists = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM tasks WHERE id = ? AND deleted_at IS NULL"
    )
    .get(taskId);

  if (!taskExists) {
    return jsonError("Task not found", "NOT_FOUND", 404);
  }

  const events = db
    .query<AuditEvent, [string]>(
      "SELECT * FROM task_audit_log WHERE task_id = ? ORDER BY created_at ASC"
    )
    .all(taskId);

  return json({ task_id: taskId, events });
}
