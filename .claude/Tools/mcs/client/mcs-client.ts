#!/usr/bin/env bun
/**
 * client/mcs-client.ts — CLI client for the Mesh Coordination Server (MCS)
 *
 * A standalone command-line tool for interacting with MCS from any machine
 * in the Tailscale mesh.
 *
 * Usage:
 *   bun run mcs-client.ts task submit --type test --payload '{"cmd":"uptime"}' --priority normal
 *   bun run mcs-client.ts task status <task-id>
 *   bun run mcs-client.ts task list [--status pending] [--limit 10]
 *   bun run mcs-client.ts task mine
 *   bun run mcs-client.ts task result <task-id> --status completed --output '{"data":"..."}'
 *   bun run mcs-client.ts agent register --caps camera,web-search,shell
 *   bun run mcs-client.ts agent list
 *   bun run mcs-client.ts mem get <ns> <key>
 *   bun run mcs-client.ts mem set <ns> <key> <value> [--ttl 300]
 *   bun run mcs-client.ts mem delete <ns> <key>
 *   bun run mcs-client.ts mem list <ns> [--prefix <prefix>] [--tag <tag>]
 *   bun run mcs-client.ts mem snapshot
 *   bun run mcs-client.ts health
 *
 * Configuration (in order of priority):
 *   1. Environment variables: MCS_URL, MCS_AGENT_ID, MCS_AGENT_SECRET
 *   2. ~/.claude/.env file: MCS_URL, MCS_KEY_PAISLEY, MCS_KEY_OCASIA, etc.
 *
 * Default MCS_URL: http://100.113.192.4:7700 (Mac Mini)
 * Default agent:   paisley
 */

import { getEnv } from "../utils/env.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MCS_URL = "http://100.113.192.4:7700";
const DEFAULT_AGENT = "paisley";

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parsed CLI structure:
 *   mcs-client.ts <resource> <action> [positional...] [--flag value...]
 */
interface ParsedArgs {
  resource: string;
  action: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // drop "bun" + script name

  const resource = args[0] ?? "";
  const action = args[1] ?? "";
  const rest = args.slice(2);

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const flagName = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[flagName] = next;
        i += 2;
      } else {
        flags[flagName] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { resource, action, positional, flags };
}

function flag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  return v;
}

function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

interface RequestOpts {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

async function mcsRequest(
  path: string,
  agentId: string,
  agentSecret: string,
  mcsUrl: string,
  opts: RequestOpts = {}
): Promise<{ status: number; body: unknown }> {
  const { method = "GET", body, query } = opts;

  let url = `${mcsUrl.replace(/\/$/, "")}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    "X-Agent-ID": agentId,
    "X-Agent-Secret": agentSecret,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let parsed: unknown;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    parsed = await res.json();
  } else {
    parsed = await res.text();
  }

  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function print(data: unknown): void {
  if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function die(message: string, exitCode = 1): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

function exitOnError(status: number, body: unknown): void {
  if (status >= 400) {
    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error: string }).error
        : JSON.stringify(body);
    die(`HTTP ${status}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Resolve agent credentials
// ---------------------------------------------------------------------------

function resolveCredentials(flags: Record<string, string | boolean>): {
  mcsUrl: string;
  agentId: string;
  agentSecret: string;
} {
  const mcsUrl = flag(flags, "url") ?? getEnv("MCS_URL") ?? DEFAULT_MCS_URL;
  const agentId = (flag(flags, "agent") ?? getEnv("MCS_AGENT_ID") ?? DEFAULT_AGENT).toLowerCase();

  // Secret: try MCS_AGENT_SECRET first, then MCS_KEY_<AGENT> from env file
  const agentSecret =
    flag(flags, "secret") ??
    getEnv("MCS_AGENT_SECRET") ??
    getEnv(`MCS_KEY_${agentId.toUpperCase()}`);

  if (!agentSecret) {
    die(
      `No secret found for agent "${agentId}". ` +
        `Set MCS_AGENT_SECRET or MCS_KEY_${agentId.toUpperCase()} in ~/.claude/.env`
    );
  }

  return { mcsUrl, agentId, agentSecret: agentSecret! };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdTask(
  action: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  creds: { mcsUrl: string; agentId: string; agentSecret: string }
): Promise<void> {
  const { mcsUrl, agentId, agentSecret } = creds;

  switch (action) {
    case "submit": {
      // mcs-client.ts task submit --type <type> --payload '{}' [--priority normal] [--caps cap1,cap2]
      const type = flag(flags, "type");
      if (!type) die("--type is required for task submit");

      // Support --payload-file to read payload from a file (avoids ARG_MAX limits)
      const payloadFile = flag(flags, "payload-file");
      const payloadStr = payloadFile
        ? (() => { try { return require("fs").readFileSync(payloadFile, "utf-8"); } catch (e: any) { die(`Cannot read --payload-file: ${e.message}`); return "{}"; } })()
        : (flag(flags, "payload") ?? "{}");
      let payload: unknown;
      try {
        payload = JSON.parse(payloadStr);
      } catch {
        die(`--payload is not valid JSON: ${payloadStr?.slice(0, 200)}`);
      }

      const priorityStr = flag(flags, "priority") ?? "normal";
      const priorityMap: Record<string, number> = { urgent: 1, normal: 2, low: 3 };
      const priority = priorityMap[priorityStr];
      if (priority === undefined) die(`--priority must be one of: urgent, normal, low`);

      const capsStr = flag(flags, "caps");
      const caps_required = capsStr ? capsStr.split(",").map((s) => s.trim()) : [];

      const routing_hint = flag(flags, "route") ?? "any";
      const idempotency_key = flag(flags, "idempotency-key");
      const notify_url = flag(flags, "notify-url");
      const max_retries = flag(flags, "max-retries");

      const claim_ttl = flag(flags, "claim-ttl");

      const reqBody: Record<string, unknown> = { type, payload, priority, caps_required, routing_hint };
      if (idempotency_key) reqBody["idempotency_key"] = idempotency_key;
      if (notify_url) reqBody["notify_url"] = notify_url;
      if (max_retries) reqBody["max_retries"] = Number(max_retries);
      if (claim_ttl) reqBody["claim_ttl_seconds"] = Number(claim_ttl);

      const { status, body } = await mcsRequest("/tasks", agentId, agentSecret, mcsUrl, {
        method: "POST",
        body: reqBody,
      });
      exitOnError(status, body);
      print(body);
      break;
    }

    case "status": {
      // mcs-client.ts task status <task-id>
      const taskId = positional[0];
      if (!taskId) die("task status requires a task ID");
      const { status, body } = await mcsRequest(`/tasks/${taskId}`, agentId, agentSecret, mcsUrl);
      exitOnError(status, body);
      print(body);
      break;
    }

    case "list": {
      // mcs-client.ts task list [--status pending] [--limit 10] [--type <type>]
      const query: Record<string, string | number | undefined> = {};
      const filterStatus = flag(flags, "status");
      const filterType = flag(flags, "type");
      const limit = flag(flags, "limit");
      if (filterStatus) query["status"] = filterStatus;
      if (filterType) query["type"] = filterType;
      if (limit) query["limit"] = Number(limit);

      const { status, body } = await mcsRequest("/tasks", agentId, agentSecret, mcsUrl, { query });
      exitOnError(status, body);
      print(body);
      break;
    }

    case "mine": {
      // mcs-client.ts task mine
      const { status, body } = await mcsRequest("/tasks/mine", agentId, agentSecret, mcsUrl);
      exitOnError(status, body);
      print(body);
      break;
    }

    case "result": {
      // mcs-client.ts task result <task-id> --status completed --output '{"data":"..."}'
      const taskId = positional[0];
      if (!taskId) die("task result requires a task ID");

      const resultStatus = flag(flags, "status");
      if (!resultStatus) die('--status is required (e.g. --status completed)');

      const outputStr = flag(flags, "output");
      const errorStr = flag(flags, "error");

      let output: unknown = undefined;
      if (outputStr) {
        try {
          output = JSON.parse(outputStr);
        } catch {
          output = outputStr; // Allow plain string output
        }
      }

      const reqBody: Record<string, unknown> = { status: resultStatus };
      if (output !== undefined) reqBody["output"] = output;
      if (errorStr) reqBody["error"] = errorStr;

      const { status, body } = await mcsRequest(
        `/tasks/${taskId}/result`,
        agentId,
        agentSecret,
        mcsUrl,
        { method: "POST", body: reqBody }
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "heartbeat": {
      // mcs-client.ts task heartbeat <task-id>
      const taskId = positional[0];
      if (!taskId) die("task heartbeat requires a task ID");
      const { status, body } = await mcsRequest(
        `/tasks/${taskId}/heartbeat`,
        agentId,
        agentSecret,
        mcsUrl,
        { method: "POST" }
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "audit": {
      // mcs-client.ts task audit <task-id>
      const taskId = positional[0];
      if (!taskId) die("task audit requires a task ID");
      const { status, body } = await mcsRequest(
        `/tasks/${taskId}/audit`,
        agentId,
        agentSecret,
        mcsUrl
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    default:
      die(`Unknown task action: "${action}". Try: submit, status, list, mine, result, heartbeat, audit`);
  }
}

async function cmdAgent(
  action: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  creds: { mcsUrl: string; agentId: string; agentSecret: string }
): Promise<void> {
  const { mcsUrl, agentId, agentSecret } = creds;

  switch (action) {
    case "register": {
      // mcs-client.ts agent register --caps camera,web-search,shell [--ttl 3600] [--notify-url http://...]
      const capsStr = flag(flags, "caps") ?? "";
      const capabilities = capsStr ? capsStr.split(",").map((s) => s.trim()) : [];
      const ttl = Number(flag(flags, "ttl") ?? 3600);
      const notify_url = flag(flags, "notify-url");

      const reqBody: Record<string, unknown> = { capabilities, ttl_seconds: ttl };
      if (notify_url) reqBody["notify_url"] = notify_url;

      const { status, body } = await mcsRequest(
        `/agents/${agentId}/capabilities`,
        agentId,
        agentSecret,
        mcsUrl,
        { method: "PUT", body: reqBody }
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "list": {
      // mcs-client.ts agent list
      const { status, body } = await mcsRequest("/agents", agentId, agentSecret, mcsUrl);
      exitOnError(status, body);
      print(body);
      break;
    }

    default:
      die(`Unknown agent action: "${action}". Try: register, list`);
  }
}

async function cmdMem(
  action: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  creds: { mcsUrl: string; agentId: string; agentSecret: string }
): Promise<void> {
  const { mcsUrl, agentId, agentSecret } = creds;

  switch (action) {
    case "get": {
      // mcs-client.ts mem get <ns> <key>
      const ns = positional[0];
      const key = positional[1];
      if (!ns || !key) die("mem get requires <ns> and <key>");

      const { status, body } = await mcsRequest(
        `/memory/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
        agentId,
        agentSecret,
        mcsUrl
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "set": {
      // mcs-client.ts mem set <ns> <key> <value> [--ttl 300] [--tags tag1,tag2]
      const ns = positional[0];
      const key = positional[1];
      const rawValue = positional[2];
      if (!ns || !key || rawValue === undefined) die("mem set requires <ns> <key> <value>");

      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue; // Treat as plain string
      }

      const ttl = flag(flags, "ttl");
      const tagsStr = flag(flags, "tags");
      const tags = tagsStr ? tagsStr.split(",").map((s) => s.trim()) : undefined;

      const reqBody: Record<string, unknown> = { value };
      if (ttl) reqBody["ttl_seconds"] = Number(ttl);
      if (tags) reqBody["tags"] = tags;

      const { status, body } = await mcsRequest(
        `/memory/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
        agentId,
        agentSecret,
        mcsUrl,
        { method: "PUT", body: reqBody }
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "delete": {
      // mcs-client.ts mem delete <ns> <key>
      const ns = positional[0];
      const key = positional[1];
      if (!ns || !key) die("mem delete requires <ns> and <key>");

      const { status, body } = await mcsRequest(
        `/memory/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
        agentId,
        agentSecret,
        mcsUrl,
        { method: "DELETE" }
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "list": {
      // mcs-client.ts mem list <ns> [--prefix <prefix>] [--tag <tag>] [--limit 50]
      const ns = positional[0];
      if (!ns) die("mem list requires <ns>");

      const query: Record<string, string | number | undefined> = {};
      const prefix = flag(flags, "prefix");
      const tag = flag(flags, "tag");
      const limit = flag(flags, "limit");
      if (prefix) query["prefix"] = prefix;
      if (tag) query["tag"] = tag;
      if (limit) query["limit"] = Number(limit);

      const { status, body } = await mcsRequest(
        `/memory/${encodeURIComponent(ns)}`,
        agentId,
        agentSecret,
        mcsUrl,
        { query }
      );
      exitOnError(status, body);
      print(body);
      break;
    }

    case "snapshot": {
      // mcs-client.ts mem snapshot
      const { status, body } = await mcsRequest("/memory/snapshot", agentId, agentSecret, mcsUrl);
      exitOnError(status, body);
      print(body);
      break;
    }

    default:
      die(`Unknown mem action: "${action}". Try: get, set, delete, list, snapshot`);
  }
}

async function cmdHealth(
  flags: Record<string, string | boolean>
): Promise<void> {
  const mcsUrl = flag(flags, "url") ?? getEnv("MCS_URL") ?? DEFAULT_MCS_URL;

  const res = await fetch(`${mcsUrl.replace(/\/$/, "")}/health`);
  let body: unknown;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  if (res.status >= 400) {
    die(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  print(body);
}

async function cmdMetrics(
  flags: Record<string, string | boolean>
): Promise<void> {
  const mcsUrl = flag(flags, "url") ?? getEnv("MCS_URL") ?? DEFAULT_MCS_URL;
  const res = await fetch(`${mcsUrl.replace(/\/$/, "")}/metrics`);
  const text = await res.text();
  if (res.status >= 400) {
    die(`HTTP ${res.status}: ${text}`);
  }
  console.log(text);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
MCS Client — Mesh Coordination Server CLI

Usage:
  mcs-client.ts <resource> <action> [args...] [flags...]

Resources and Actions:

  task
    submit      --type <type> --payload '<json>' | --payload-file <path>
                [--priority urgent|normal|low] [--caps cap1,cap2]
                [--claim-ttl <seconds>] (default: 300)
                [--route <agent>] [--max-retries <n>]
                [--idempotency-key <key>] [--notify-url <url>]
    status      <task-id>
    list        [--status pending|claimed|in_progress|completed|failed]
                [--type <type>] [--limit <n>]
    mine
    result      <task-id> --status completed|failed [--output '<json>'] [--error '<msg>']
    heartbeat   <task-id>
    audit       <task-id>

  agent
    register    [--caps cap1,cap2] [--ttl <seconds>] [--notify-url <url>]
    list

  mem
    get         <ns> <key>
    set         <ns> <key> <value> [--ttl <seconds>] [--tags tag1,tag2]
    delete      <ns> <key>
    list        <ns> [--prefix <prefix>] [--tag <tag>] [--limit <n>]
    snapshot

  health
  metrics

Global Flags:
  --url <url>       MCS base URL (default: http://100.113.192.4:7700)
  --agent <id>      Agent ID to authenticate as (default: paisley)
  --secret <key>    Agent secret (default: read from ~/.claude/.env)

Environment Variables:
  MCS_URL           MCS base URL
  MCS_AGENT_ID      Agent ID
  MCS_AGENT_SECRET  Agent secret (overrides MCS_KEY_<AGENT>)
  MCS_KEY_PAISLEY   Paisley agent secret (from ~/.claude/.env)
  MCS_KEY_OCASIA    Ocasia agent secret
  MCS_KEY_REX       Rex agent secret
  MCS_KEY_MOLLY     Molly agent secret
  MCS_KEY_DAN       Dan agent secret

Examples:
  bun run mcs-client.ts task submit --type shell --payload '{"cmd":"uptime"}'
  bun run mcs-client.ts task list --status pending
  bun run mcs-client.ts task status abc123
  bun run mcs-client.ts agent register --caps shell,web-search --ttl 7200
  bun run mcs-client.ts mem set shared config '{"debug":true}' --ttl 3600
  bun run mcs-client.ts mem get shared config
  bun run mcs-client.ts mem list shared --prefix config
  bun run mcs-client.ts health
  bun run mcs-client.ts metrics
`.trim());
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.resource || parsed.resource === "--help" || parsed.resource === "-h") {
    printUsage();
    process.exit(0);
  }

  if (boolFlag(parsed.flags, "help") || boolFlag(parsed.flags, "h")) {
    printUsage();
    process.exit(0);
  }

  // health and metrics don't require auth headers (public endpoints)
  if (parsed.resource === "health") {
    await cmdHealth(parsed.flags);
    return;
  }

  if (parsed.resource === "metrics") {
    await cmdMetrics(parsed.flags);
    return;
  }

  if (!parsed.action) {
    console.error(`Error: no action specified for resource "${parsed.resource}"`);
    printUsage();
    process.exit(1);
  }

  // All other commands need credentials
  const creds = resolveCredentials(parsed.flags);

  switch (parsed.resource) {
    case "task":
      await cmdTask(parsed.action, parsed.positional, parsed.flags, creds);
      break;

    case "agent":
      await cmdAgent(parsed.action, parsed.positional, parsed.flags, creds);
      break;

    case "mem":
      await cmdMem(parsed.action, parsed.positional, parsed.flags, creds);
      break;

    default:
      die(
        `Unknown resource: "${parsed.resource}". Try: task, agent, mem, health, metrics`
      );
  }
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
