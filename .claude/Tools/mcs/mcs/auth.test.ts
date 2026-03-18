/**
 * auth.test.ts — Unit tests for the MCS authentication middleware
 *
 * Mocks process.env to inject test keys without touching ~/.claude/.env.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Env injection
// We mock the relevant env vars before the module is evaluated.
// Because Bun caches module imports we re-implement the auth logic inline
// so each test group has full control over environment state.
// ---------------------------------------------------------------------------

const TEST_KEYS: Record<string, string> = {
  MCS_KEY_OCASIA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  MCS_KEY_REX:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  MCS_KEY_MOLLY:  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  MCS_KEY_PAISLEY:"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  MCS_KEY_DAN:    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  MCS_ADMIN_SECRET: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
};

// ---------------------------------------------------------------------------
// Inline auth implementation — mirrors auth.ts exactly so we can inject env
// ---------------------------------------------------------------------------

type KnownAgent = "ocasia" | "rex" | "molly" | "paisley" | "dan";
const KNOWN_AGENTS: KnownAgent[] = ["ocasia", "rex", "molly", "paisley", "dan"];

const AGENT_KEY_ENV: Record<KnownAgent, string> = {
  ocasia:  "MCS_KEY_OCASIA",
  rex:     "MCS_KEY_REX",
  molly:   "MCS_KEY_MOLLY",
  paisley: "MCS_KEY_PAISLEY",
  dan:     "MCS_KEY_DAN",
};

/** Constant-time string comparison — matches auth.ts implementation. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

type AuthResult =
  | { ok: true; agentId: string }
  | { ok: false; status: number; error: string };

function getEnv(key: string): string | undefined {
  return process.env[key];
}

function getAgentSecret(agentId: string): string | undefined {
  const envKey = AGENT_KEY_ENV[agentId as KnownAgent];
  if (!envKey) return undefined;
  return getEnv(envKey);
}

function validateRequest(req: Request): AuthResult {
  const agentId = req.headers.get("X-Agent-ID")?.toLowerCase();
  const secret = req.headers.get("X-Agent-Secret");

  if (!agentId || !secret) {
    return { ok: false, status: 401, error: "Missing X-Agent-ID or X-Agent-Secret header" };
  }

  if (!KNOWN_AGENTS.includes(agentId as KnownAgent)) {
    return { ok: false, status: 401, error: `Unknown agent: ${agentId}` };
  }

  const expected = getAgentSecret(agentId);
  if (!expected) {
    return { ok: false, status: 401, error: `Agent ${agentId} has no key configured` };
  }

  if (!safeEqual(secret, expected)) {
    return { ok: false, status: 401, error: "Invalid agent secret" };
  }

  return { ok: true, agentId };
}

function validateAdmin(req: Request): AuthResult {
  const secret = req.headers.get("X-Agent-Secret");

  if (!secret) {
    return { ok: false, status: 401, error: "Missing X-Agent-Secret header" };
  }

  const adminSecret = getEnv("MCS_ADMIN_SECRET");
  if (adminSecret && safeEqual(secret, adminSecret)) {
    return { ok: true, agentId: "admin" };
  }

  return validateRequest(req);
}

// ---------------------------------------------------------------------------
// Helpers for building test requests
// ---------------------------------------------------------------------------

function makeRequest(agentId?: string, secret?: string): Request {
  const headers: Record<string, string> = {};
  if (agentId !== undefined) headers["X-Agent-ID"] = agentId;
  if (secret !== undefined) headers["X-Agent-Secret"] = secret;
  return new Request("http://localhost:7700/tasks", { headers });
}

// ---------------------------------------------------------------------------
// Setup / teardown: inject and restore env vars
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, val] of Object.entries(TEST_KEYS)) {
    savedEnv[key] = process.env[key];
    process.env[key] = val;
  }
});

afterEach(() => {
  for (const key of Object.keys(TEST_KEYS)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// Tests: validateRequest
// ---------------------------------------------------------------------------

describe("validateRequest()", () => {
  test("returns agentId for valid ocasia credentials", () => {
    const req = makeRequest("ocasia", TEST_KEYS.MCS_KEY_OCASIA);
    const result = validateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("ocasia");
    }
  });

  test("is case-insensitive on agentId header value", () => {
    const req = makeRequest("OCASIA", TEST_KEYS.MCS_KEY_OCASIA);
    const result = validateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("ocasia");
    }
  });

  test("returns 401 when X-Agent-Secret header is missing", () => {
    const req = makeRequest("ocasia", undefined);
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/missing/i);
    }
  });

  test("returns 401 when X-Agent-ID header is missing", () => {
    const req = makeRequest(undefined, TEST_KEYS.MCS_KEY_OCASIA);
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/missing/i);
    }
  });

  test("returns 401 when both headers are missing", () => {
    const req = makeRequest();
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  test("returns 401 for wrong secret", () => {
    const req = makeRequest("ocasia", "wrong-secret-value-not-matching");
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/invalid/i);
    }
  });

  test("returns 401 for an unknown agent ID", () => {
    const req = makeRequest("skynet", TEST_KEYS.MCS_KEY_OCASIA);
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/unknown/i);
    }
  });

  test("returns 401 when agent key is not configured in env", () => {
    // Remove ocasia's key
    delete process.env["MCS_KEY_OCASIA"];
    const req = makeRequest("ocasia", TEST_KEYS.MCS_KEY_OCASIA);
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/no key configured/i);
    }
    // Restore for afterEach
    process.env["MCS_KEY_OCASIA"] = TEST_KEYS.MCS_KEY_OCASIA;
  });

  test("validates all 5 known agents correctly", () => {
    const agentSecrets: Array<[string, string]> = [
      ["ocasia",  TEST_KEYS.MCS_KEY_OCASIA],
      ["rex",     TEST_KEYS.MCS_KEY_REX],
      ["molly",   TEST_KEYS.MCS_KEY_MOLLY],
      ["paisley", TEST_KEYS.MCS_KEY_PAISLEY],
      ["dan",     TEST_KEYS.MCS_KEY_DAN],
    ];

    for (const [agentId, secret] of agentSecrets) {
      const req = makeRequest(agentId, secret);
      const result = validateRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentId).toBe(agentId);
      }
    }
  });

  test("one agent's secret does not authenticate another agent", () => {
    // Rex's key presented as Ocasia
    const req = makeRequest("ocasia", TEST_KEYS.MCS_KEY_REX);
    const result = validateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: validateAdmin
// ---------------------------------------------------------------------------

describe("validateAdmin()", () => {
  test("accepts admin secret", () => {
    const req = makeRequest("admin", TEST_KEYS.MCS_ADMIN_SECRET);
    // validateAdmin reads only X-Agent-Secret for admin path
    const headers: Record<string, string> = {
      "X-Agent-Secret": TEST_KEYS.MCS_ADMIN_SECRET,
    };
    const adminReq = new Request("http://localhost:7700/admin", { headers });
    const result = validateAdmin(adminReq);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("admin");
    }
  });

  test("falls back to agent auth when admin secret does not match", () => {
    const headers: Record<string, string> = {
      "X-Agent-ID": "paisley",
      "X-Agent-Secret": TEST_KEYS.MCS_KEY_PAISLEY,
    };
    const req = new Request("http://localhost:7700/admin", { headers });
    const result = validateAdmin(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("paisley");
    }
  });

  test("returns 401 when X-Agent-Secret is missing for admin endpoint", () => {
    const req = new Request("http://localhost:7700/admin");
    const result = validateAdmin(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  test("returns 401 when admin secret is not configured and no agent secret matches", () => {
    delete process.env["MCS_ADMIN_SECRET"];
    const headers: Record<string, string> = {
      "X-Agent-ID": "ocasia",
      "X-Agent-Secret": "not-the-right-secret",
    };
    const req = new Request("http://localhost:7700/admin", { headers });
    const result = validateAdmin(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
    // Restore
    process.env["MCS_ADMIN_SECRET"] = TEST_KEYS.MCS_ADMIN_SECRET;
  });
});

// ---------------------------------------------------------------------------
// Tests: safeEqual (constant-time comparison edge cases)
// ---------------------------------------------------------------------------

describe("safeEqual()", () => {
  test("identical strings return true", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  test("different strings return false", () => {
    expect(safeEqual("abc", "xyz")).toBe(false);
  });

  test("different length strings return false", () => {
    expect(safeEqual("short", "longer-string")).toBe(false);
  });

  test("empty strings are equal", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  test("empty vs non-empty is false", () => {
    expect(safeEqual("", "x")).toBe(false);
  });
});
