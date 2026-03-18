/**
 * routes/agents.ts — Agent capability registration and listing for MCS
 *
 * PUT /agents/:name/capabilities — Upsert agent capabilities + notify_url
 * GET /agents                    — List all agents with computed active field
 */

import type { Database } from "bun:sqlite";
import type { Agent } from "../types.ts";

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

// ---------------------------------------------------------------------------
// PUT /agents/:name/capabilities — Upsert agent capabilities
// ---------------------------------------------------------------------------

export async function handleUpdateCapabilities(
  req: Request,
  agentId: string,
  db: Database,
  agentName: string
): Promise<Response> {
  // Agents can only update their own capabilities
  if (agentName !== agentId) {
    return jsonError(
      `You can only update your own capabilities (you are '${agentId}', requested '${agentName}')`,
      "FORBIDDEN",
      403
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", "BAD_REQUEST", 400);
  }

  if (!Array.isArray(body.capabilities)) {
    return jsonError("Field 'capabilities' is required and must be an array", "BAD_REQUEST", 400);
  }

  // Validate each capability is a non-empty string (max 100 chars)
  const capabilities = body.capabilities as unknown[];
  if (!capabilities.every((c) => typeof c === "string" && c.length > 0 && c.length <= 100)) {
    return jsonError("Each capability must be a non-empty string (max 100 chars)", "BAD_REQUEST", 400);
  }

  const notifyUrl = typeof body.notify_url === "string" ? body.notify_url : null;

  const now = new Date();
  const registeredAt = now.toISOString();
  // Allow body.ttl_seconds to override the default 5-minute TTL (clamped 60s-3600s)
  const ttlSeconds = typeof body.ttl_seconds === "number"
    ? Math.min(Math.max(body.ttl_seconds, 60), 3600)
    : 300;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  db.prepare(`
    INSERT INTO agents (agent_id, capabilities, notify_url, registered_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (agent_id) DO UPDATE SET
      capabilities = excluded.capabilities,
      notify_url   = excluded.notify_url,
      registered_at = excluded.registered_at,
      expires_at   = excluded.expires_at
  `).run(
    agentId,
    JSON.stringify(capabilities),
    notifyUrl,
    registeredAt,
    expiresAt
  );

  return json({ agent_id: agentId, capabilities, expires_at: expiresAt });
}

// ---------------------------------------------------------------------------
// GET /agents — List all agents with computed active field
// ---------------------------------------------------------------------------

export function handleListAgents(
  _req: Request,
  _agentId: string,
  db: Database
): Response {
  const rows = db
    .query<Agent, []>("SELECT * FROM agents ORDER BY agent_id ASC")
    .all();

  const now = new Date().toISOString();

  const agents = rows.map((a) => ({
    ...a,
    capabilities: (() => {
      try { return JSON.parse(a.capabilities); } catch { return []; }
    })(),
    active: a.expires_at > now,
  }));

  return json({ agents });
}
