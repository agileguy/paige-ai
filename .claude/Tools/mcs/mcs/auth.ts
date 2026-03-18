/**
 * auth.ts — Authentication middleware for MCS
 *
 * Validates requests via X-Agent-Secret + X-Agent-ID headers.
 * Agent keys are loaded from ~/.claude/.env on startup.
 * Admin endpoints additionally accept MCS_ADMIN_SECRET.
 */

import type { AuthContext, ErrorResponse } from "./types.ts";
import { getEnv } from "./utils/env.ts";

// ---------------------------------------------------------------------------
// Known agents and their secrets
// ---------------------------------------------------------------------------

export const KNOWN_AGENTS = ["ocasia", "rex", "molly", "paisley", "phil", "dan"] as const;
export type KnownAgent = (typeof KNOWN_AGENTS)[number];

const AGENT_KEY_ENV: Record<KnownAgent, string> = {
  ocasia: "MCS_KEY_OCASIA",
  rex: "MCS_KEY_REX",
  molly: "MCS_KEY_MOLLY",
  paisley: "MCS_KEY_PAISLEY",
  phil: "MCS_KEY_PHIL",
  dan: "MCS_KEY_DAN",
};

/**
 * Resolve the secret for a given agent ID at call time (not cached at module
 * load) so the server can be started before keys are set and pick them up on
 * restart without a code change.
 */
function getAgentSecret(agentId: string): string | undefined {
  const envKey = AGENT_KEY_ENV[agentId as KnownAgent];
  if (!envKey) return undefined;
  return getEnv(envKey);
}

function getAdminSecret(): string | undefined {
  return getEnv("MCS_ADMIN_SECRET");
}

// ---------------------------------------------------------------------------
// Constant-time string comparison (timing-safe)
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AuthResult =
  | { ok: true; agentId: string }
  | { ok: false; response: Response };

/**
 * Validate an incoming request.
 *
 * Reads X-Agent-ID and X-Agent-Secret headers. Returns the authenticated
 * agent context on success, or a 401 Response on failure.
 */
export function validateRequest(req: Request): AuthResult {
  const agentId = req.headers.get("X-Agent-ID")?.toLowerCase();
  const secret = req.headers.get("X-Agent-Secret");

  if (!agentId || !secret) {
    return unauthorized("Missing X-Agent-ID or X-Agent-Secret header");
  }

  if (!KNOWN_AGENTS.includes(agentId as KnownAgent)) {
    return unauthorized(`Unknown agent: ${agentId}`);
  }

  const expected = getAgentSecret(agentId);
  if (!expected) {
    return unauthorized(`Agent ${agentId} has no key configured`);
  }

  if (!safeEqual(secret, expected)) {
    return unauthorized("Invalid agent secret");
  }

  return { ok: true, agentId };
}

/**
 * Validate an admin request.
 *
 * Uses MCS_ADMIN_SECRET. Falls back to agent auth if admin secret matches an
 * agent (for bootstrapping). Returns 401 on failure.
 */
export function validateAdmin(req: Request): AuthResult {
  const secret = req.headers.get("X-Agent-Secret");

  if (!secret) {
    return unauthorized("Missing X-Agent-Secret header");
  }

  const adminSecret = getAdminSecret();
  if (adminSecret && safeEqual(secret, adminSecret)) {
    return { ok: true, agentId: "admin" };
  }

  // Fall through to per-agent auth for admin callers that use their own key
  return validateRequest(req);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unauthorized(message: string): { ok: false; response: Response } {
  const body: ErrorResponse = { error: message, code: "UNAUTHORIZED" };
  return {
    ok: false,
    response: new Response(JSON.stringify(body), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  };
}
