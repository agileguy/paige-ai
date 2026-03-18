#!/usr/bin/env bun
/**
 * client/agent-register.ts — Generic MCS agent registration script
 *
 * Registers an agent's capabilities with the Mesh Coordination Server,
 * writes online status to shared memory, and optionally runs a heartbeat
 * loop to re-register every 4 minutes (staying within the 5-min TTL).
 *
 * Usage:
 *   bun run agent-register.ts --agent <name> --caps <cap1,cap2,...> [--notify-url <url>] [--heartbeat]
 *
 * Environment:
 *   Loads MCS_KEY_<UPPERCASE_AGENT_NAME> from ~/.claude/.env
 */

import { getEnv } from "../utils/env.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCS_URL = process.env.MCS_URL || "http://100.113.192.4:7700";
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
const MEMORY_TTL_SECONDS = 300; // 5 minutes

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface Args {
  agent: string;
  caps: string[];
  notifyUrl: string | null;
  heartbeat: boolean;
}

function parseArgs(): Args {
  const argv = Bun.argv.slice(2); // strip bun + script path
  const args: Args = {
    agent: "",
    caps: [],
    notifyUrl: null,
    heartbeat: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--agent":
        args.agent = argv[++i] ?? "";
        break;
      case "--caps":
        args.caps = (argv[++i] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
        break;
      case "--notify-url":
        args.notifyUrl = argv[++i] ?? null;
        break;
      case "--heartbeat":
        args.heartbeat = true;
        break;
      default:
        // ignore unknown flags
    }
  }

  return args;
}

function validateArgs(args: Args): void {
  if (!args.agent) {
    console.error("[agent-register] ERROR: --agent <name> is required");
    process.exit(1);
  }
  if (args.caps.length === 0) {
    console.error("[agent-register] ERROR: --caps <cap1,cap2,...> is required and must be non-empty");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// MCS API calls
// ---------------------------------------------------------------------------

/**
 * PUT /agents/:name/capabilities
 */
async function registerCapabilities(
  agentName: string,
  agentSecret: string,
  caps: string[],
  notifyUrl: string | null
): Promise<boolean> {
  const url = `${MCS_URL}/agents/${agentName}/capabilities`;
  const body: Record<string, unknown> = { capabilities: caps };
  if (notifyUrl) body.notify_url = notifyUrl;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": agentName,
        "X-Agent-Secret": agentSecret,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[agent-register] PUT /agents/${agentName}/capabilities failed: ${res.status} ${text}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[agent-register] Network error registering capabilities: ${(err as Error).message}`);
    return false;
  }
}

/**
 * PUT /memory/mesh/<key> with a string value and TTL
 */
async function writeMemoryKey(
  agentName: string,
  agentSecret: string,
  key: string,
  value: string
): Promise<boolean> {
  const url = `${MCS_URL}/memory/mesh/${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": agentName,
        "X-Agent-Secret": agentSecret,
      },
      body: JSON.stringify({ value, ttl: MEMORY_TTL_SECONDS }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[agent-register] PUT /memory/mesh/${key} failed: ${res.status} ${text}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[agent-register] Network error writing memory key '${key}': ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core registration logic — called once per heartbeat cycle
// ---------------------------------------------------------------------------

async function register(
  agentName: string,
  agentSecret: string,
  caps: string[],
  notifyUrl: string | null
): Promise<void> {
  const timestamp = new Date().toISOString();

  // 1. Register capabilities
  const capsOk = await registerCapabilities(agentName, agentSecret, caps, notifyUrl);

  // 2. Write status and last_seen to shared memory
  const statusOk = await writeMemoryKey(
    agentName,
    agentSecret,
    `agent.${agentName}.status`,
    "online"
  );

  const lastSeenOk = await writeMemoryKey(
    agentName,
    agentSecret,
    `agent.${agentName}.last_seen`,
    timestamp
  );

  if (capsOk && statusOk && lastSeenOk) {
    console.log(`[agent-register] ${agentName} registered with MCS (caps: ${caps.join(", ")})`);
  } else {
    console.error(`[agent-register] ${agentName} partial failure during registration — will retry next cycle`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  validateArgs(args);

  const envKey = `MCS_KEY_${args.agent.toUpperCase()}`;
  const agentSecret = getEnv(envKey);

  if (!agentSecret) {
    console.error(
      `[agent-register] ERROR: Agent secret not found. Expected env var '${envKey}' in ~/.claude/.env or environment.`
    );
    process.exit(1);
  }

  // Initial registration
  await register(args.agent, agentSecret, args.caps, args.notifyUrl);

  if (!args.heartbeat) {
    // One-shot mode — exit after initial registration
    process.exit(0);
  }

  // Heartbeat loop — re-register every 4 minutes
  console.log(
    `[agent-register] Heartbeat mode active — re-registering every ${HEARTBEAT_INTERVAL_MS / 1000}s`
  );

  setInterval(async () => {
    await register(args.agent, agentSecret, args.caps, args.notifyUrl);
  }, HEARTBEAT_INTERVAL_MS);
}

main().catch((err) => {
  console.error(`[agent-register] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
