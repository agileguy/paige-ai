/**
 * routes/watches.ts — Watch subscription CRUD endpoints for MCS
 *
 * POST   /memory/watch          — Create a watch subscription
 * GET    /memory/watches        — List caller's active watches
 * DELETE /memory/watch/:id      — Remove a watch
 */

import type { Database } from "bun:sqlite";
import type { Watch } from "../types.ts";

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

/**
 * Generate a simple UUID-like identifier.
 * Uses crypto.randomUUID() when available (Bun >= 1.x), with a manual fallback.
 */
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: 32 random hex chars grouped as 8-4-4-4-12
  const hex = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${hex()}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex()}${hex().slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// POST /memory/watch — Create a watch subscription
// ---------------------------------------------------------------------------

/**
 * handleCreateWatch
 *
 * Body: {
 *   ns:          string   (required) — namespace to watch
 *   prefix:      string   (optional, default "") — key prefix filter
 *   notify_url:  string   (required) — POST target for change events
 *   ttl_seconds: number   (optional, default 3600)
 * }
 *
 * Returns 201: { watch_id, ns, prefix, notify_url, expires_at }
 */
export async function handleCreateWatch(
  req: Request,
  agentId: string,
  db: Database
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", "BAD_REQUEST", 400);
  }

  const ns = body.ns;
  const prefix = typeof body.prefix === "string" ? body.prefix : "";
  const notify_url = body.notify_url;
  const ttl_seconds =
    typeof body.ttl_seconds === "number" ? body.ttl_seconds : 3600;

  if (typeof ns !== "string" || !ns.trim()) {
    return jsonError("Missing required field: ns", "BAD_REQUEST", 400);
  }
  if (typeof notify_url !== "string" || !notify_url.trim()) {
    return jsonError("Missing required field: notify_url", "BAD_REQUEST", 400);
  }
  if (typeof ttl_seconds !== "number" || ttl_seconds <= 0) {
    return jsonError(
      "ttl_seconds must be a positive number",
      "BAD_REQUEST",
      400
    );
  }

  const watch_id = generateId();

  // Compute expires_at as ISO datetime string
  const expiresAt = new Date(Date.now() + ttl_seconds * 1000).toISOString();
  // SQLite datetime() format (without the trailing 'Z')
  const expiresAtSql = expiresAt.replace("T", " ").replace("Z", "");

  try {
    db.prepare(`
      INSERT INTO watches (watch_id, agent_id, ns, prefix, notify_url, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(watch_id, agentId, ns.trim(), prefix, notify_url.trim(), expiresAtSql);
  } catch (err) {
    console.error("[watches] Insert failed:", err);
    return jsonError("Failed to create watch", "INTERNAL_ERROR", 500);
  }

  return json(
    {
      watch_id,
      ns: ns.trim(),
      prefix,
      notify_url: notify_url.trim(),
      expires_at: expiresAtSql,
    },
    201
  );
}

// ---------------------------------------------------------------------------
// GET /memory/watches — List caller's active watches
// ---------------------------------------------------------------------------

/**
 * handleListWatches
 *
 * Returns all non-expired watches owned by the requesting agent.
 *
 * Returns 200: { watches: Watch[], count: number }
 */
export function handleListWatches(
  _req: Request,
  agentId: string,
  db: Database
): Response {
  const rows = db
    .prepare<Watch, [string]>(`
      SELECT watch_id, agent_id, ns, prefix, notify_url, created_at, expires_at
      FROM watches
      WHERE agent_id = ?
        AND expires_at > datetime('now')
      ORDER BY created_at ASC
    `)
    .all(agentId);

  return json({ watches: rows, count: rows.length });
}

// ---------------------------------------------------------------------------
// DELETE /memory/watch/:watch_id — Remove a watch
// ---------------------------------------------------------------------------

/**
 * handleDeleteWatch
 *
 * Verifies the watch belongs to the requesting agent, then deletes it.
 *
 * Returns 200: { ok: true, watch_id }
 * Returns 403: if the watch exists but belongs to a different agent
 * Returns 404: if the watch_id is not found
 */
export function handleDeleteWatch(
  _req: Request,
  agentId: string,
  db: Database,
  watchId: string
): Response {
  const watch = db
    .prepare<Pick<Watch, "agent_id">, [string]>(`
      SELECT agent_id FROM watches WHERE watch_id = ?
    `)
    .get(watchId);

  if (!watch) {
    return jsonError("Watch not found", "NOT_FOUND", 404);
  }

  if (watch.agent_id !== agentId) {
    return jsonError(
      "You do not own this watch",
      "FORBIDDEN",
      403
    );
  }

  db.prepare("DELETE FROM watches WHERE watch_id = ?").run(watchId);

  return json({ ok: true, watch_id: watchId });
}
