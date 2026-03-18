#!/usr/bin/env bun
/**
 * server.ts — Mesh Coordination Server (MCS) main entry point
 *
 * Bun.serve() on port 7700 (or MCS_PORT env var).
 * Dispatches requests to route handlers, enforces auth on all routes
 * except GET /health and GET /metrics, and applies per-agent rate limiting.
 *
 * Usage: bun run ~/.claude/Tools/mcs/server.ts
 */

import { initDb, getDb } from "./db.ts";
import { validateRequest } from "./auth.ts";
import { handleHealth, handleMetrics } from "./routes/health.ts";
import { recordRequest } from "./metrics/prometheus.ts";
import {
  handleCreateTask,
  handleGetTask,
  handleGetMyTasks,
  handleListTasks,
  handleSubmitResult,
  handleHeartbeat,
  handleGetAudit,
} from "./routes/tasks.ts";
import { handleUpdateCapabilities, handleListAgents } from "./routes/agents.ts";
import {
  handlePutKey,
  handleGetKey,
  handleDeleteKey,
  handleListKeys,
  handleBulkWrite,
  handleSnapshot,
} from "./routes/memory.ts";
import { handleCreateWatch, handleListWatches, handleDeleteWatch } from "./routes/watches.ts";
import { startDispatcher, stopDispatcher } from "./dispatch/dispatcher.ts";
import { startClaimWatchdog, stopClaimWatchdog } from "./dispatch/claim-watchdog.ts";
import { recoverStaleTasks } from "./dispatch/startup-recovery.ts";
import { startVacuum, stopVacuum } from "./memory/vacuum.ts";
import type { ErrorResponse } from "./types.ts";

const VERSION = "1.0.0";
const PORT = Number(process.env.MCS_PORT ?? 7700);

// ---------------------------------------------------------------------------
// Per-agent rate limiter — 60 requests per minute sliding window
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function checkRateLimit(agentId: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let entry = rateLimitMap.get(agentId);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(agentId, entry);
  }

  // Evict timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  if (entry.timestamps.length >= RATE_LIMIT_MAX) {
    // Oldest timestamp + window = when the earliest slot frees up
    const oldestTs = entry.timestamps[0]!;
    const retryAfterMs = oldestTs + RATE_LIMIT_WINDOW_MS - now;
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  entry.timestamps.push(now);
  return { allowed: true, retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------
// Request logger
// ---------------------------------------------------------------------------

function logRequest(
  method: string,
  pathname: string,
  agentId: string,
  status: number,
  durationMs: number
): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  console.log(`[${hh}:${mm}:${ss}] ${method} ${pathname} ${agentId} ${status} ${durationMs}ms`);
  recordRequest(method, pathname, status);
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function jsonError(message: string, code: string, status: number): Response {
  const body: ErrorResponse = { error: message, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return jsonError("Not found", "NOT_FOUND", 404);
}

function methodNotAllowed(): Response {
  return jsonError("Method not allowed", "METHOD_NOT_ALLOWED", 405);
}

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

function stubRoute(): Response {
  return new Response(
    JSON.stringify({ error: "Not implemented yet", code: "NOT_IMPLEMENTED" } satisfies ErrorResponse),
    { status: 501, headers: { "Content-Type": "application/json" } }
  );
}

async function dispatch(req: Request, agentId: string): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const db = getDb();

  // -------------------------------------------------------------------------
  // Task routes  — /tasks/*
  // -------------------------------------------------------------------------
  if (pathname === "/tasks") {
    if (req.method === "POST") return handleCreateTask(req, agentId, db);
    if (req.method === "GET")  return handleListTasks(req, agentId, db);
    return methodNotAllowed();
  }

  if (pathname === "/tasks/mine") {
    if (req.method === "GET") return handleGetMyTasks(req, agentId, db);
    return methodNotAllowed();
  }

  if (pathname.startsWith("/tasks/")) {
    const rest = pathname.slice("/tasks/".length); // e.g. "abc123" or "abc123/result"

    // POST /tasks/:id/result
    if (rest.endsWith("/result") && req.method === "POST") {
      const taskId = rest.slice(0, rest.lastIndexOf("/result"));
      return handleSubmitResult(req, agentId, db, taskId);
    }

    // POST /tasks/:id/heartbeat
    if (rest.endsWith("/heartbeat") && req.method === "POST") {
      const taskId = rest.slice(0, rest.lastIndexOf("/heartbeat"));
      return handleHeartbeat(req, agentId, db, taskId);
    }

    // GET /tasks/:id/audit
    if (rest.endsWith("/audit") && req.method === "GET") {
      const taskId = rest.slice(0, rest.lastIndexOf("/audit"));
      return handleGetAudit(req, agentId, db, taskId);
    }

    // GET /tasks/:id
    const taskId = rest.split("/")[0];
    if (taskId && !rest.includes("/")) {
      if (req.method === "GET") return handleGetTask(req, agentId, db, taskId);
      return methodNotAllowed();
    }

    return notFound();
  }

  // -------------------------------------------------------------------------
  // Agent routes — /agents/*
  // -------------------------------------------------------------------------
  if (pathname === "/agents") {
    if (req.method === "GET") return handleListAgents(req, agentId, db);
    return methodNotAllowed();
  }

  if (pathname.startsWith("/agents/")) {
    const agentPath = pathname.slice("/agents/".length);

    // PUT /agents/:name/capabilities
    if (agentPath.endsWith("/capabilities") && req.method === "PUT") {
      const agentName = agentPath.slice(0, agentPath.lastIndexOf("/capabilities"));
      return handleUpdateCapabilities(req, agentId, db, agentName);
    }

    return notFound();
  }

  // -------------------------------------------------------------------------
  // Memory routes — /memory/*
  //
  // Route priority order (most-specific first):
  //   GET  /memory/snapshot         → full mesh dump
  //   PUT  /memory/:ns/:key         → write key
  //   GET  /memory/:ns/:key         → read key
  //   DEL  /memory/:ns/:key         → delete key
  //   GET  /memory/:ns              → list keys
  //   POST /memory/:ns              → bulk write
  // -------------------------------------------------------------------------
  if (pathname.startsWith("/memory")) {
    const memRest = pathname.slice("/memory".length); // "" | "/" | "/snapshot" | "/watch" | "/watches" | "/:ns" | "/:ns/:key"

    // GET /memory/snapshot — must be checked before /:ns routing
    if (memRest === "/snapshot" && req.method === "GET") {
      return handleSnapshot(req, agentId, db);
    }

    // POST /memory/watch — create a watch subscription
    if (memRest === "/watch" && req.method === "POST") {
      return handleCreateWatch(req, agentId, db);
    }

    // GET /memory/watches — list caller's active watches
    if (memRest === "/watches" && req.method === "GET") {
      return handleListWatches(req, agentId, db);
    }

    // DELETE /memory/watch/:watch_id — remove a watch
    if (memRest.startsWith("/watch/") && req.method === "DELETE") {
      const watchId = memRest.slice("/watch/".length);
      if (watchId && !watchId.includes("/")) {
        return handleDeleteWatch(req, agentId, db, watchId);
      }
      return notFound();
    }

    // Strip leading slash and split path segments
    const segments = memRest.startsWith("/")
      ? memRest.slice(1).split("/").filter(Boolean)
      : memRest.split("/").filter(Boolean);

    if (segments.length === 0) {
      return notFound();
    }

    const ns = segments[0]!;

    if (segments.length === 1) {
      // /memory/:ns
      if (req.method === "GET")  return handleListKeys(req, agentId, db, ns);
      if (req.method === "POST") return handleBulkWrite(req, agentId, db, ns);
      return methodNotAllowed();
    }

    if (segments.length === 2) {
      // /memory/:ns/:key
      const key = segments[1]!;
      if (req.method === "PUT")    return handlePutKey(req, agentId, db, ns, key);
      if (req.method === "GET")    return handleGetKey(req, agentId, db, ns, key);
      if (req.method === "DELETE") return handleDeleteKey(req, agentId, db, ns, key);
      return methodNotAllowed();
    }

    return notFound();
  }

  // -------------------------------------------------------------------------
  // Dispatch routes — /dispatch/*  (fanout, broadcast)
  // -------------------------------------------------------------------------
  if (pathname === "/dispatch/fanout") {
    if (req.method === "POST") return stubRoute();
    return methodNotAllowed();
  }

  if (pathname === "/dispatch/broadcast") {
    if (req.method === "POST") return stubRoute();
    return methodNotAllowed();
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Main server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req: Request): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const { pathname } = url;

    // ------------------------------------------------------------------
    // Public routes — no auth, no rate limiting
    // ------------------------------------------------------------------
    if (req.method === "GET" && pathname === "/health") {
      const db = getDb();
      const res = handleHealth(db);
      logRequest(req.method, pathname, "public", res.status, Date.now() - start);
      return res;
    }

    // /metrics is intentionally kept public (unauthenticated) so Prometheus
    // can scrape without needing auth headers. Metrics expose aggregate counts
    // (request rates, task counts, agent load) — no secrets or PII.
    if (req.method === "GET" && pathname === "/metrics") {
      const db = getDb();
      const res = handleMetrics(db);
      logRequest(req.method, pathname, "public", res.status, Date.now() - start);
      return res;
    }

    // ------------------------------------------------------------------
    // Auth — all other routes require valid agent credentials
    // ------------------------------------------------------------------
    const authResult = validateRequest(req);
    if (!authResult.ok) {
      logRequest(req.method, pathname, "anon", 401, Date.now() - start);
      return authResult.response;
    }

    const { agentId } = authResult;

    // ------------------------------------------------------------------
    // Per-agent rate limiting
    // ------------------------------------------------------------------
    const rl = checkRateLimit(agentId);
    if (!rl.allowed) {
      const res = new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          code: "RATE_LIMITED",
          retry_after_seconds: rl.retryAfterSeconds,
        } satisfies ErrorResponse & { retry_after_seconds: number }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(rl.retryAfterSeconds),
          },
        }
      );
      logRequest(req.method, pathname, agentId, 429, Date.now() - start);
      return res;
    }

    // ------------------------------------------------------------------
    // Dispatch to route handler
    // ------------------------------------------------------------------
    let res: Response;
    try {
      res = await dispatch(req, agentId);
    } catch (err) {
      console.error(`[ERROR] ${req.method} ${pathname}:`, err);
      res = jsonError("Internal server error", "INTERNAL_ERROR", 500);
    }

    logRequest(req.method, pathname, agentId, res.status, Date.now() - start);
    return res;
  },

  error(err: Error): Response {
    console.error("[FATAL]", err);
    return jsonError("Internal server error", "INTERNAL_ERROR", 500);
  },
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

initDb();
const _db = getDb();
recoverStaleTasks(_db);
startDispatcher(_db);
startClaimWatchdog(_db);
startVacuum(_db);

// Graceful shutdown
function gracefulShutdown() {
  console.log("[mcs] Shutting down...");
  stopDispatcher();
  stopClaimWatchdog();
  stopVacuum();
  _db.close();
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

console.log(`MCS v${VERSION} listening on :${server.port}`);
