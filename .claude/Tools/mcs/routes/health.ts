import type { Database } from "bun:sqlite";
import { generateMetrics } from "../metrics/prometheus.ts";

const START_TIME = Date.now();
const VERSION = "1.0.0";

interface TaskStats {
  pending: number;
  claimed: number;
  in_progress: number;
  completed_24h: number;
  failed_24h: number;
}

interface MemoryStats {
  total_keys: number;
  active_keys: number;
  expired_keys: number;
  namespaces: string[];
}

interface HealthResponse {
  ok: boolean;
  version: string;
  uptime_seconds: number;
  db_path: string;
  task_stats: TaskStats;
  memory_stats: MemoryStats;
  active_agents: string[];
}

function queryTaskStats(db: Database): TaskStats {
  const stats: TaskStats = {
    pending: 0,
    claimed: 0,
    in_progress: 0,
    completed_24h: 0,
    failed_24h: 0,
  };

  try {
    // Current tasks by status
    const rows = db
      .query<{ status: string; count: number }, []>(
        `SELECT status, COUNT(*) as count
         FROM tasks
         WHERE status NOT IN ('completed', 'failed')
         GROUP BY status`
      )
      .all();

    for (const row of rows) {
      if (row.status === "pending") stats.pending = row.count;
      else if (row.status === "claimed") stats.claimed = row.count;
      else if (row.status === "in_progress") stats.in_progress = row.count;
    }

    // 24h completed/failed
    const completedRow = db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'completed'
           AND updated_at >= datetime('now', '-24 hours')`
      )
      .get();
    if (completedRow) stats.completed_24h = completedRow.count;

    const failedRow = db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'failed'
           AND updated_at >= datetime('now', '-24 hours')`
      )
      .get();
    if (failedRow) stats.failed_24h = failedRow.count;
  } catch {
    // Tables may not exist yet during startup
  }

  return stats;
}

function queryMemoryStats(db: Database): MemoryStats {
  const stats: MemoryStats = {
    total_keys: 0,
    active_keys: 0,
    expired_keys: 0,
    namespaces: [],
  };

  try {
    const totalRow = db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM memory WHERE deleted = 0`
      )
      .get();
    if (totalRow) stats.total_keys = totalRow.count;

    const activeRow = db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM memory
         WHERE deleted = 0
           AND (expires_at IS NULL OR expires_at > datetime('now'))`
      )
      .get();
    if (activeRow) stats.active_keys = activeRow.count;

    stats.expired_keys = stats.total_keys - stats.active_keys;

    const nsRows = db
      .query<{ ns: string }, []>(
        `SELECT DISTINCT ns FROM memory
         WHERE deleted = 0
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY ns`
      )
      .all();
    stats.namespaces = nsRows.map((r) => r.ns);
  } catch {
    // Tables may not exist yet during startup
  }

  return stats;
}

function queryActiveAgents(db: Database): string[] {
  try {
    const rows = db
      .query<{ agent_id: string }, []>(
        `SELECT agent_id FROM agents
         WHERE expires_at > datetime('now')
         ORDER BY agent_id`
      )
      .all();
    return rows.map((r) => r.agent_id);
  } catch {
    return [];
  }
}

function getDbPath(db: Database): string {
  try {
    // bun:sqlite Database has a .filename property
    return (db as unknown as { filename: string }).filename ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function handleHealth(db: Database): Response {
  const uptime_seconds = Math.floor((Date.now() - START_TIME) / 1000);

  const body: HealthResponse = {
    ok: true,
    version: VERSION,
    uptime_seconds,
    db_path: getDbPath(db),
    task_stats: queryTaskStats(db),
    memory_stats: queryMemoryStats(db),
    active_agents: queryActiveAgents(db),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function handleMetrics(db: Database): Response {
  const body = generateMetrics(db);
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
