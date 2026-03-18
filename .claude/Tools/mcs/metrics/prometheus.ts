/**
 * metrics/prometheus.ts — Prometheus text format metrics generation for MCS
 *
 * Generates the full Prometheus exposition format for all MCS metrics:
 *   - Task queue metrics (gauges + counters from audit log)
 *   - Memory metrics (per-namespace gauges + write counters)
 *   - Agent metrics (active count + per-agent load)
 *   - Server metrics (uptime, db size, HTTP request counters)
 *
 * Usage:
 *   import { generateMetrics, recordRequest } from "./metrics/prometheus.ts";
 *   generateMetrics(db)   → Prometheus text string
 *   recordRequest(method, path, status)  → increments in-memory HTTP counter
 */

import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import { join } from "path";

const MCS_DIR = join(process.env.HOME!, ".mcs");
const DB_PATH = join(MCS_DIR, "mcs.db");

// ---------------------------------------------------------------------------
// Process start time for uptime calculation
// ---------------------------------------------------------------------------

const PROCESS_START_MS = Date.now();

// ---------------------------------------------------------------------------
// In-memory HTTP request counter
// key: "METHOD path status_code"  value: count
// ---------------------------------------------------------------------------

const httpRequestCounts = new Map<string, number>();

/**
 * Increment the in-memory HTTP request counter.
 * Called by server.ts logRequest() after every request.
 */
export function recordRequest(method: string, path: string, status: number): void {
  // Normalise dynamic path segments to reduce cardinality.
  // e.g. /tasks/abc123 → /tasks/:id
  const normPath = normalizePath(path);
  const key = `${method.toUpperCase()} ${normPath} ${status}`;
  httpRequestCounts.set(key, (httpRequestCounts.get(key) ?? 0) + 1);
}

/**
 * Collapse dynamic segments in well-known route patterns to keep cardinality
 * manageable in the counter label set.
 */
function normalizePath(path: string): string {
  // /tasks/<uuid>/result  → /tasks/:id/result
  // /tasks/<uuid>/heartbeat → /tasks/:id/heartbeat
  // /tasks/<uuid>/audit  → /tasks/:id/audit
  // /tasks/<uuid>        → /tasks/:id
  // /agents/<name>/capabilities → /agents/:id/capabilities
  // /memory/<ns>/<key>   → /memory/:ns/:key
  // /memory/<ns>         → /memory/:ns
  // /memory/watch/<id>   → /memory/watch/:id
  return path
    .replace(/^\/tasks\/[^/]+(\/result|\/heartbeat|\/audit)?$/, (_, suffix) =>
      suffix ? `/tasks/:id${suffix}` : "/tasks/:id"
    )
    .replace(/^\/agents\/[^/]+\/capabilities$/, "/agents/:id/capabilities")
    .replace(/^\/memory\/[^/]+\/[^/]+$/, "/memory/:ns/:key")
    .replace(/^\/memory\/watch\/[^/]+$/, "/memory/watch/:id")
    .replace(/^\/memory\/[^/]+$/, "/memory/:ns");
}

// ---------------------------------------------------------------------------
// Prometheus text format helpers
// ---------------------------------------------------------------------------

function gauge(name: string, help: string, labels: Record<string, string>, value: number): string[] {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  const metric = labelStr ? `${name}{${labelStr}} ${value}` : `${name} ${value}`;
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, metric, ""];
}

function gaugeMulti(
  name: string,
  help: string,
  rows: Array<{ labels: Record<string, string>; value: number }>
): string[] {
  if (rows.length === 0) {
    return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ""];
  }
  const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const { labels, value } of rows) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(",");
    lines.push(labelStr ? `${name}{${labelStr}} ${value}` : `${name} ${value}`);
  }
  lines.push("");
  return lines;
}

function counterMulti(
  name: string,
  help: string,
  rows: Array<{ labels: Record<string, string>; value: number }>
): string[] {
  if (rows.length === 0) {
    return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, ""];
  }
  const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const { labels, value } of rows) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(",");
    lines.push(labelStr ? `${name}{${labelStr}} ${value}` : `${name} ${value}`);
  }
  lines.push("");
  return lines;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

interface CountRow {
  count: number;
}

interface LabelCountRow {
  label: string;
  count: number;
}

interface AgentLoadRow {
  agent_id: string;
  current_load: number;
}

interface NsCountRow {
  ns: string;
  count: number;
}

interface NsAgentCountRow {
  ns: string;
  agent: string;
  count: number;
}

function safeGet<T>(db: Database, query: string): T | null {
  try {
    return db.query<T, []>(query).get() ?? null;
  } catch {
    return null;
  }
}

function safeAll<T>(db: Database, query: string): T[] {
  try {
    return db.query<T, []>(query).all();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Metric section builders
// ---------------------------------------------------------------------------

function taskQueueMetrics(db: Database): string[] {
  const lines: string[] = [];

  // --- mcs_tasks_total{status} — current tasks by status (gauge) ---
  const statusRows = safeAll<{ status: string; count: number }>(
    db,
    `SELECT status, COUNT(*) as count FROM tasks GROUP BY status`
  );
  const statusMap: Record<string, number> = {};
  for (const r of statusRows) statusMap[r.status] = r.count;

  lines.push(
    ...gaugeMulti("mcs_tasks_total", "Current tasks by status", [
      { labels: { status: "pending" }, value: statusMap["pending"] ?? 0 },
      { labels: { status: "claimed" }, value: statusMap["claimed"] ?? 0 },
      { labels: { status: "in_progress" }, value: statusMap["in_progress"] ?? 0 },
      { labels: { status: "completed" }, value: statusMap["completed"] ?? 0 },
      { labels: { status: "failed" }, value: statusMap["failed"] ?? 0 },
    ])
  );

  // --- mcs_tasks_submitted_total{agent} — from audit log event_type="created" (counter) ---
  const submittedRows = safeAll<LabelCountRow>(
    db,
    `SELECT agent_id as label, COUNT(*) as count
     FROM task_audit_log
     WHERE event_type = 'created' AND agent_id IS NOT NULL
     GROUP BY agent_id`
  );
  lines.push(
    ...counterMulti(
      "mcs_tasks_submitted_total",
      "Total tasks submitted per agent",
      submittedRows.map((r) => ({ labels: { agent: r.label }, value: r.count }))
    )
  );

  // --- mcs_tasks_completed_total{agent,result} — from audit log (counter) ---
  const completedRows = safeAll<{ agent: string; result: string; count: number }>(
    db,
    `SELECT agent_id as agent, event_type as result, COUNT(*) as count
     FROM task_audit_log
     WHERE event_type IN ('completed', 'failed') AND agent_id IS NOT NULL
     GROUP BY agent_id, event_type`
  );
  lines.push(
    ...counterMulti(
      "mcs_tasks_completed_total",
      "Total tasks completed or failed per agent",
      completedRows.map((r) => ({ labels: { agent: r.agent, result: r.result }, value: r.count }))
    )
  );

  // --- mcs_task_retries_total{task_type} — from audit log event_type="retried" (counter) ---
  const retryRows = safeAll<{ task_type: string; count: number }>(
    db,
    `SELECT t.type as task_type, COUNT(*) as count
     FROM task_audit_log al
     JOIN tasks t ON t.id = al.task_id
     WHERE al.event_type = 'retried'
     GROUP BY t.type`
  );
  lines.push(
    ...counterMulti(
      "mcs_task_retries_total",
      "Total task retries per task type",
      retryRows.map((r) => ({ labels: { task_type: r.task_type }, value: r.count }))
    )
  );

  return lines;
}

function memoryMetrics(db: Database): string[] {
  const lines: string[] = [];

  // --- mcs_memory_keys_total{ns} — active non-expired non-deleted keys per namespace (gauge) ---
  const nsKeyRows = safeAll<NsCountRow>(
    db,
    `SELECT ns, COUNT(*) as count
     FROM memory
     WHERE deleted = 0
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     GROUP BY ns
     ORDER BY ns`
  );
  lines.push(
    ...gaugeMulti(
      "mcs_memory_keys_total",
      "Active memory keys per namespace",
      nsKeyRows.map((r) => ({ labels: { ns: r.ns }, value: r.count }))
    )
  );

  // --- mcs_memory_writes_total{ns,agent} — count distinct version bumps (counter) ---
  // version > 1 means the key was updated at least once; total writes = sum of (version - 1) + initial writes
  // Approximate: count all rows per ns/agent as "write events" (each row = at least 1 write)
  // More accurate: sum of version column per ns/agent (version 1 = 1 write, version 5 = 5 writes)
  const writeRows = safeAll<NsAgentCountRow>(
    db,
    `SELECT ns, updated_by as agent, SUM(version) as count
     FROM memory
     WHERE deleted = 0
     GROUP BY ns, updated_by
     ORDER BY ns, updated_by`
  );
  lines.push(
    ...counterMulti(
      "mcs_memory_writes_total",
      "Total memory write operations per namespace and agent",
      writeRows.map((r) => ({ labels: { ns: r.ns, agent: r.agent }, value: r.count }))
    )
  );

  // --- mcs_memory_watches_active — non-expired watches (gauge) ---
  const watchRow = safeGet<CountRow>(
    db,
    `SELECT COUNT(*) as count FROM watches WHERE expires_at > datetime('now')`
  );
  lines.push(
    ...gauge(
      "mcs_memory_watches_active",
      "Number of active non-expired memory watches",
      {},
      watchRow?.count ?? 0
    )
  );

  return lines;
}

function agentMetrics(db: Database): string[] {
  const lines: string[] = [];

  // --- mcs_agents_active — agents with expires_at > now (gauge) ---
  const activeRow = safeGet<CountRow>(
    db,
    `SELECT COUNT(*) as count FROM agents WHERE expires_at > datetime('now')`
  );
  lines.push(
    ...gauge(
      "mcs_agents_active",
      "Number of currently active registered agents",
      {},
      activeRow?.count ?? 0
    )
  );

  // --- mcs_agent_load{agent} — current_load per active agent (gauge) ---
  const loadRows = safeAll<AgentLoadRow>(
    db,
    `SELECT agent_id, current_load FROM agents WHERE expires_at > datetime('now') ORDER BY agent_id`
  );
  lines.push(
    ...gaugeMulti(
      "mcs_agent_load",
      "Current task load per active agent",
      loadRows.map((r) => ({ labels: { agent: r.agent_id }, value: r.current_load }))
    )
  );

  return lines;
}

function serverMetrics(db: Database): string[] {
  const lines: string[] = [];

  // --- mcs_uptime_seconds (gauge) ---
  const uptimeSeconds = Math.floor((Date.now() - PROCESS_START_MS) / 1000);
  lines.push(
    ...gauge("mcs_uptime_seconds", "Server uptime in seconds", {}, uptimeSeconds)
  );

  // --- mcs_db_size_bytes (gauge) ---
  let dbSizeBytes = 0;
  try {
    const stat = statSync(DB_PATH);
    dbSizeBytes = stat.size;
  } catch {
    // DB may not exist yet
  }
  lines.push(
    ...gauge("mcs_db_size_bytes", "SQLite database file size in bytes", {}, dbSizeBytes)
  );

  // --- mcs_http_requests_total{method,path,status} (counter) ---
  const httpRows: Array<{ labels: Record<string, string>; value: number }> = [];
  for (const [key, count] of httpRequestCounts.entries()) {
    const parts = key.split(" ");
    if (parts.length !== 3) continue;
    const [method, path, statusStr] = parts as [string, string, string];
    httpRows.push({ labels: { method, path, status: statusStr }, value: count });
  }
  // Sort for deterministic output
  httpRows.sort((a, b) => {
    const aKey = `${a.labels["method"]} ${a.labels["path"]} ${a.labels["status"]}`;
    const bKey = `${b.labels["method"]} ${b.labels["path"]} ${b.labels["status"]}`;
    return aKey.localeCompare(bKey);
  });
  lines.push(
    ...counterMulti(
      "mcs_http_requests_total",
      "Total HTTP requests by method, path, and status",
      httpRows
    )
  );

  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete Prometheus text exposition format string.
 * Includes all MCS metrics across task queue, memory, agents, and server.
 */
export function generateMetrics(db: Database): string {
  const sections: string[][] = [
    taskQueueMetrics(db),
    memoryMetrics(db),
    agentMetrics(db),
    serverMetrics(db),
  ];

  // Flatten all sections and join with newlines
  const allLines: string[] = [];
  for (const section of sections) {
    allLines.push(...section);
  }

  return allLines.join("\n");
}
