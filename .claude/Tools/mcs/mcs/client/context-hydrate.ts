#!/usr/bin/env bun
/**
 * client/context-hydrate.ts — MCS startup context loader
 *
 * Loads shared mesh context from MCS on agent startup:
 *   - Full mesh memory namespace snapshot
 *   - All registered agent statuses
 *
 * Usage:
 *   bun run context-hydrate.ts --agent <name>
 *
 * Outputs JSON to stdout (suitable for piping into agent context systems).
 * Human-readable summary is written to stderr.
 *
 * Environment:
 *   Loads MCS_KEY_<UPPERCASE_AGENT_NAME> from ~/.claude/.env
 */

import { getEnv } from "../utils/env.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCS_URL = "http://100.113.192.4:7700";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { agent: string } {
  const argv = Bun.argv.slice(2);
  let agent = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") {
      agent = argv[++i] ?? "";
    }
  }

  if (!agent) {
    console.error("[hydrate] ERROR: --agent <name> is required");
    process.exit(1);
  }

  return { agent };
}

// ---------------------------------------------------------------------------
// MCS API calls
// ---------------------------------------------------------------------------

interface AgentRow {
  agent_id: string;
  capabilities: string[] | unknown;
  notify_url: string | null;
  current_load: number;
  registered_at: string;
  expires_at: string;
  active: boolean;
}

interface AgentListResponse {
  agents: AgentRow[];
}

interface SnapshotEntry {
  ns: string;
  key: string;
  value: unknown;
  version: number;
  updated_at: string;
  expires_at: string | null;
}

interface SnapshotResponse {
  ns: string;
  entries: SnapshotEntry[];
  count: number;
  snapshot_at: string;
}

async function fetchAgents(
  agentName: string,
  agentSecret: string
): Promise<AgentRow[]> {
  const res = await fetch(`${MCS_URL}/agents`, {
    headers: {
      "X-Agent-ID": agentName,
      "X-Agent-Secret": agentSecret,
    },
  });

  if (!res.ok) {
    throw new Error(`GET /agents failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as AgentListResponse;
  return data.agents ?? [];
}

async function fetchSnapshot(
  agentName: string,
  agentSecret: string
): Promise<SnapshotResponse> {
  const res = await fetch(`${MCS_URL}/memory/snapshot`, {
    headers: {
      "X-Agent-ID": agentName,
      "X-Agent-Secret": agentSecret,
    },
  });

  if (!res.ok) {
    throw new Error(`GET /memory/snapshot failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as SnapshotResponse;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { agent: agentName } = parseArgs();

  const envKey = `MCS_KEY_${agentName.toUpperCase()}`;
  const agentSecret = getEnv(envKey);

  if (!agentSecret) {
    console.error(
      `[hydrate] ERROR: Agent secret not found. Expected env var '${envKey}' in ~/.claude/.env or environment.`
    );
    process.exit(1);
  }

  const loadedAt = new Date().toISOString();

  // Fetch agents and snapshot in parallel
  let agents: AgentRow[] = [];
  let snapshot: SnapshotResponse = { ns: "mesh", entries: [], count: 0, snapshot_at: loadedAt };

  try {
    [agents, snapshot] = await Promise.all([
      fetchAgents(agentName, agentSecret),
      fetchSnapshot(agentName, agentSecret),
    ]);
  } catch (err) {
    console.error(`[hydrate] ERROR: Failed to load mesh context: ${(err as Error).message}`);
    process.exit(1);
  }

  // Compute active agents
  const now = new Date().toISOString();
  const activeAgents = agents
    .filter((a) => a.active || a.expires_at > now)
    .map((a) => a.agent_id);

  // Find the most recently updated mesh key
  const lastUpdated = snapshot.entries.reduce((latest, entry) => {
    return entry.updated_at > latest ? entry.updated_at : latest;
  }, loadedAt);

  // Print human-readable summary to stderr (keeps stdout clean JSON)
  const agentList = activeAgents.length > 0 ? activeAgents.join(", ") : "(none)";
  console.error(`[hydrate] Mesh context loaded:`);
  console.error(`[hydrate]   Active agents: ${agentList}`);
  console.error(`[hydrate]   Mesh keys: ${snapshot.count}`);
  console.error(`[hydrate]   Last updated: ${lastUpdated}`);

  // Build memory map for easy lookup: key -> value
  const memoryMap: Record<string, unknown> = {};
  for (const entry of snapshot.entries) {
    memoryMap[entry.key] = entry.value;
  }

  // Output JSON to stdout
  const output = {
    agents,
    memory: memoryMap,
    loaded_at: loadedAt,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((err) => {
  console.error(`[hydrate] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
