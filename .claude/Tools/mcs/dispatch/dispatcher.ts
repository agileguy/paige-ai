/**
 * dispatcher.ts — Main dispatch loop for MCS
 *
 * Runs as a setInterval inside the server process. Every 5 seconds, it queries
 * pending tasks (priority ASC, created_at ASC), checks dependencies, finds
 * eligible agents by capability, and atomically claims tasks.
 *
 * Phase 3 additions:
 *   - Fanout: routing_hint="all" creates child tasks for every capable agent
 *   - Notify: calls agent's notify_url after successful claim (fire-and-forget)
 */

import type { Database } from "bun:sqlite";
import { findBestAgent, isCapable, type ScoredAgent } from "./capability-matcher.ts";
import { notifyTaskAssigned } from "../notify/notifier.ts";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingTask {
  id: string;
  type: string;
  priority: number;
  payload: string; // JSON string
  caps_required: string; // JSON array string
  routing_hint: string;
  claim_ttl_seconds: number;
  attempt: number;
  retry_after: string | null;
  notify_url: string | null;
  max_retries: number;
  created_by: string;
}

interface ActiveAgent {
  agent_id: string;
  capabilities: string; // JSON array string
  current_load: number;
  registered_at: string;
  notify_url: string | null;
}

interface DependencyRow {
  depends_on: string;
}

interface DepStatusRow {
  status: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _interval: ReturnType<typeof setInterval> | null = null;
const DISPATCH_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Fanout handler
// ---------------------------------------------------------------------------

/**
 * handleFanout — Fan a task out to ALL capable active agents.
 *
 * For each capable agent:
 *   1. Creates a child task with routing_hint=<agent_id>
 *   2. Inserts a row into fanout_tasks
 *   3. Notifies the agent's notify_url if configured (fire-and-forget)
 *
 * Marks the parent task as in_progress (waiting for children).
 * Writes an audit log entry with the fan-out details.
 *
 * If no capable agents are found, the parent remains pending.
 */
function handleFanout(
  db: Database,
  task: PendingTask,
  activeAgents: ScoredAgent[],
  agentNotifyUrls: Map<string, string | null>,
  requiredCaps: string[]
): void {
  // Find ALL capable agents (not just the best one)
  const capableAgents = activeAgents.filter((a) =>
    isCapable(a.capabilities, requiredCaps)
  );

  if (capableAgents.length === 0) {
    // No agents can handle this task — leave pending
    return;
  }

  const now = new Date().toISOString();
  const childIds: string[] = [];
  const agentIds: string[] = [];

  try {
    db.exec("BEGIN EXCLUSIVE;");

    // Double-check parent is still pending
    const parentRow = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM tasks WHERE id = ? AND status = 'pending'"
      )
      .get(task.id);

    if (!parentRow) {
      db.exec("ROLLBACK;");
      return; // Already picked up by another process
    }

    for (const agent of capableAgents) {
      const childId = crypto.randomUUID();
      childIds.push(childId);
      agentIds.push(agent.agent_id);

      // Create child task targeted at specific agent
      db.prepare(`
        INSERT INTO tasks (
          id, type, status, priority, payload, caps_required, routing_hint,
          created_by, max_retries, claim_ttl_seconds, notify_url,
          created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        childId,
        task.type,
        task.priority,
        task.payload,
        task.caps_required,
        agent.agent_id, // route to specific agent
        task.created_by,
        task.max_retries,
        task.claim_ttl_seconds,
        now,
        now
      );

      // Record in fanout_tasks table
      db.prepare(`
        INSERT INTO fanout_tasks (parent_task_id, child_task_id, agent_id)
        VALUES (?, ?, ?)
      `).run(task.id, childId, agent.agent_id);
    }

    // Mark parent as in_progress (waiting for children to complete)
    db.prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          updated_at = ?
      WHERE id = ?
    `).run(now, task.id);

    // Audit log for fanout event
    db.prepare(`
      INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
      VALUES (?, 'fanout', NULL, ?)
    `).run(
      task.id,
      JSON.stringify({
        child_count: capableAgents.length,
        agents: agentIds,
        child_ids: childIds,
      })
    );

    db.exec("COMMIT;");

    console.error(
      `[dispatch] Task ${task.id} fanned out to ${capableAgents.length} agents: [${agentIds.join(", ")}]`
    );

    // Fire-and-forget notifications to each agent after commit
    for (let i = 0; i < capableAgents.length; i++) {
      const agent = capableAgents[i]!;
      const childId = childIds[i]!;
      const agentNotifyUrl = agentNotifyUrls.get(agent.agent_id) ?? null;

      if (agentNotifyUrl) {
        notifyTaskAssigned(
          {
            id: childId,
            type: task.type,
            priority: task.priority,
            payload: task.payload,
            assigned_to: agent.agent_id,
            claimed_at: now,
          },
          agent.agent_id,
          agentNotifyUrl
        ).catch(() => {});
      }
    }
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback errors
    }
    console.error(`[dispatch] Error during fanout for task ${task.id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Core dispatch tick
// ---------------------------------------------------------------------------

function dispatchTick(db: Database): void {
  // 1. Query pending tasks — priority ASC (urgent=1 first), created_at ASC
  const pendingTasks = db
    .query<PendingTask, []>(
      `SELECT id, type, priority, payload, caps_required, routing_hint,
              claim_ttl_seconds, attempt, retry_after, notify_url, max_retries, created_by
       FROM tasks
       WHERE status = 'pending'
         AND (retry_after IS NULL OR retry_after <= datetime('now'))
       ORDER BY priority ASC, created_at ASC
       LIMIT 100`
    )
    .all();

  if (pendingTasks.length === 0) return;

  // 2. Query active agents (not expired) and parse capabilities once
  const rawAgents = db
    .query<ActiveAgent, []>(
      `SELECT agent_id, capabilities, current_load, registered_at, notify_url
       FROM agents
       WHERE expires_at > datetime('now')`
    )
    .all();

  // Parse each agent's capabilities JSON once up-front for the entire tick
  const activeAgents: ScoredAgent[] = rawAgents.map((a) => {
    let caps: string[] = [];
    try {
      const parsed = JSON.parse(a.capabilities);
      if (Array.isArray(parsed)) caps = parsed as string[];
    } catch {
      // malformed JSON — treat as no capabilities
    }
    return {
      agent_id: a.agent_id,
      capabilities: caps,
      current_load: a.current_load,
      registered_at: a.registered_at,
    };
  });

  // Build a map of agent_id → notify_url for post-claim notifications
  const agentNotifyUrls = new Map<string, string | null>(
    rawAgents.map((a) => [a.agent_id, a.notify_url])
  );

  for (const task of pendingTasks) {
    // ------------------------------------------------------------------
    // 3. Check task dependencies
    // ------------------------------------------------------------------
    const deps = db
      .query<DependencyRow, [string]>(
        `SELECT depends_on FROM task_dependencies WHERE task_id = ?`
      )
      .all(task.id);

    if (deps.length > 0) {
      let skipTask = false;
      let depFailed = false;

      for (const dep of deps) {
        const depRow = db
          .query<DepStatusRow, [string]>(
            `SELECT status FROM tasks WHERE id = ?`
          )
          .get(dep.depends_on);

        if (!depRow) {
          // Dependency task doesn't exist — treat as not ready
          skipTask = true;
          break;
        }

        if (depRow.status === "failed") {
          depFailed = true;
          break;
        }

        if (depRow.status !== "completed") {
          skipTask = true;
        }
      }

      if (depFailed) {
        // Mark this task as failed due to dependency failure
        db.prepare(`
          UPDATE tasks
          SET status = 'failed',
              result_error = 'dependency_failed',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(task.id);
        db.prepare(`
          INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
          VALUES (?, 'failed', NULL, '{"reason":"dependency_failed"}')
        `).run(task.id);
        console.error(`[dispatch] Task ${task.id} failed due to dependency failure`);
        continue;
      }

      if (skipTask) {
        // Dependencies not ready yet — skip for now
        continue;
      }
    }

    // ------------------------------------------------------------------
    // 4. Parse task's required capabilities
    // ------------------------------------------------------------------
    const routingHint = task.routing_hint ?? "any";

    let requiredCaps: string[] = [];
    try {
      const parsed = JSON.parse(task.caps_required);
      if (Array.isArray(parsed)) requiredCaps = parsed as string[];
    } catch {
      // malformed JSON — treat as no requirements
    }

    // ------------------------------------------------------------------
    // 4a. Fanout: routing_hint="all" — broadcast to ALL capable agents
    // ------------------------------------------------------------------
    if (routingHint === "all") {
      handleFanout(db, task, activeAgents, agentNotifyUrls, requiredCaps);
      continue;
    }

    // ------------------------------------------------------------------
    // 4b. Normal dispatch: find best eligible agent via capability-matcher
    // ------------------------------------------------------------------
    const agent = findBestAgent(activeAgents, requiredCaps, routingHint);

    if (agent === null) {
      // No capable agent available — leave pending
      continue;
    }

    // ------------------------------------------------------------------
    // 5. Atomic claim via EXCLUSIVE transaction
    // ------------------------------------------------------------------
    let claimedAt: string | null = null;

    try {
      db.exec("BEGIN EXCLUSIVE;");

      // Update the task — only if it is still pending (guards against concurrent dispatchers)
      const updateTask = db.prepare(
        `UPDATE tasks
         SET status = 'claimed',
             assigned_to = ?,
             claimed_at = datetime('now'),
             claim_expires_at = datetime('now', '+' || ? || ' seconds'),
             attempt = attempt + 1,
             updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      );

      const result = updateTask.run(agent.agent_id, task.claim_ttl_seconds, task.id);

      if (result.changes === 0) {
        // Another dispatcher (or process) got there first
        db.exec("ROLLBACK;");
        continue;
      }

      // Fetch claimed_at for the notification payload
      const claimedRow = db
        .query<{ claimed_at: string }, [string]>(
          "SELECT claimed_at FROM tasks WHERE id = ?"
        )
        .get(task.id);
      claimedAt = claimedRow?.claimed_at ?? new Date().toISOString();

      // Increment agent load
      db.prepare(
        `UPDATE agents SET current_load = current_load + 1 WHERE agent_id = ?`
      ).run(agent.agent_id);

      // Write audit log
      db.prepare(
        `INSERT INTO task_audit_log (task_id, event_type, agent_id, detail)
         VALUES (?, 'claimed', ?, NULL)`
      ).run(task.id, agent.agent_id);

      db.exec("COMMIT;");

      console.error(`[dispatch] Task ${task.id} claimed by ${agent.agent_id}`);

      // ------------------------------------------------------------------
      // 6. Fire-and-forget notify to agent's notify_url (after COMMIT)
      // ------------------------------------------------------------------
      const agentNotifyUrl = agentNotifyUrls.get(agent.agent_id) ?? null;
      if (agentNotifyUrl) {
        notifyTaskAssigned(
          {
            id: task.id,
            type: task.type,
            priority: task.priority,
            payload: task.payload,
            assigned_to: agent.agent_id,
            claimed_at: claimedAt,
          },
          agent.agent_id,
          agentNotifyUrl
        ).catch(() => {});
      }
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback errors
      }
      console.error(`[dispatch] Error claiming task ${task.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the dispatch loop. Runs every 5 seconds inside the server process.
 * Safe to call multiple times — only one interval will be active at a time.
 */
export function startDispatcher(db: Database): void {
  if (_interval !== null) {
    console.error("[dispatch] Dispatcher already running");
    return;
  }

  console.error("[dispatch] Dispatcher started (interval: 5s)");
  _interval = setInterval(() => {
    try {
      dispatchTick(db);
    } catch (err) {
      console.error("[dispatch] Uncaught error in dispatch tick:", err);
    }
  }, DISPATCH_INTERVAL_MS);
}

/**
 * Stop the dispatch loop. Used in tests and graceful shutdown.
 */
export function stopDispatcher(): void {
  if (_interval !== null) {
    clearInterval(_interval);
    _interval = null;
    console.error("[dispatch] Dispatcher stopped");
  }
}

/** Exposed for testing the tick directly without needing to wait for setInterval. */
export { dispatchTick };
