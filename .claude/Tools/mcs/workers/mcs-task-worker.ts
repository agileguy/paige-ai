#!/usr/bin/env bun
/**
 * mcs-task-worker.ts — MCS Native Polling Channel for OpenClaw Agents
 *
 * Polls MCS-A2A for assigned tasks and triggers isolated OpenClaw sessions
 * for each task via the /hooks/agent endpoint. Replaces the unreliable
 * webhook-push mechanism.
 *
 * Usage: bun run mcs-task-worker.ts
 *
 * Required env vars (from ~/.claude/.env or process env):
 *   MCS_AGENT_NAME      - Agent name (ocasia, rex, phil)
 *   MCS_URL             - MCS server URL (default: http://100.113.192.4:7700)
 *   OPENCLAW_HOOK_TOKEN - OpenClaw hooks.token from openclaw.json
 *   OPENCLAW_GATEWAY_URL - OpenClaw gateway URL (default: http://127.0.0.1:18789)
 *   MCS_KEY_<UPPERCASE_AGENT_NAME> - Agent secret key
 *
 * Optional env vars:
 *   MCS_WORKER_HEALTH_PORT    - Health check HTTP port (default: 7800)
 *   MCS_ALLOWED_PAYLOAD_DOMAINS - Comma-separated domain allowlist for payload_url
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, statSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const WORKER_VERSION = "1.9.3";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
	try {
		const content = readFileSync(path, "utf-8");
		const env: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			const val = trimmed.slice(eq + 1).trim();
			env[key] = val.replace(/^['"]|['"]$/g, "");
		}
		return env;
	} catch {
		return {};
	}
}

const ENV_FILE_PATH = join(homedir(), ".claude", ".env");
const envFile = loadEnvFile(ENV_FILE_PATH);
const getEnv = (key: string): string => process.env[key] ?? envFile[key] ?? "";

const MCS_AGENT_NAME = getEnv("MCS_AGENT_NAME");
const MCS_URL = getEnv("MCS_URL") || "http://100.113.192.4:7700";
const OPENCLAW_HOOK_TOKEN = getEnv("OPENCLAW_HOOK_TOKEN");
const OPENCLAW_GATEWAY_URL = getEnv("OPENCLAW_GATEWAY_URL") || "http://127.0.0.1:18789";
const MCS_SECRET = getEnv(`MCS_KEY_${MCS_AGENT_NAME.toUpperCase()}`);
const HEALTH_PORT = parseInt(getEnv("MCS_WORKER_HEALTH_PORT") || "7800", 10);

// Model override for hook sessions — use agent's configured primary model instead of gateway default.
// Format: "provider/model" e.g. "ollama/qwen3.5:397b:cloud" or "ollama/glm-5:cloud".
// If not set, OpenClaw uses the first gateway model (usually gemini-2.5-flash).
const OPENCLAW_HOOK_MODEL = getEnv("OPENCLAW_HOOK_MODEL");
const OPENCLAW_FALLBACK_MODEL = getEnv("OPENCLAW_FALLBACK_MODEL") || "google-gemini/gemini-2.5-flash";

// Configurable domain allowlist for payload_url
const ALLOWED_PAYLOAD_DOMAINS_RAW = getEnv("MCS_ALLOWED_PAYLOAD_DOMAINS");
const ALLOWED_PAYLOAD_DOMAINS: string[] = ALLOWED_PAYLOAD_DOMAINS_RAW
	? ALLOWED_PAYLOAD_DOMAINS_RAW.split(",").map((d) => d.trim()).filter(Boolean)
	: ["github.com", "raw.githubusercontent.com", "api.github.com", "gist.github.com"];

// ---------------------------------------------------------------------------
// Secret redaction logger
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
	/X-Agent-Secret:\s*\S+/gi,
	/MCS_KEY_\w+=\S+/g,
	/OPENCLAW_HOOK_TOKEN=\S+/g,
	/"X-Agent-Secret"\s*:\s*"[^"]+"/gi,
];

function redact(message: string): string {
	let result = message;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, (m) => {
			// Keep the key name but replace the value
			const eqIdx = m.indexOf(":");
			const eqIdx2 = m.indexOf("=");
			if (eqIdx !== -1) return m.slice(0, eqIdx + 1) + " [REDACTED]";
			if (eqIdx2 !== -1) return m.slice(0, eqIdx2 + 1) + "[REDACTED]";
			return "[REDACTED]";
		});
	}
	return result;
}

const log = {
	info: (message: string, ...args: unknown[]) => {
		const msg = args.length ? `${message} ${args.map(String).join(" ")}` : message;
		console.log(`[${new Date().toISOString()}] [INFO] [mcs-worker] ${redact(msg)}`);
	},
	warn: (message: string, ...args: unknown[]) => {
		const msg = args.length ? `${message} ${args.map(String).join(" ")}` : message;
		console.warn(`[${new Date().toISOString()}] [WARN] [mcs-worker] ${redact(msg)}`);
	},
	error: (message: string, ...args: unknown[]) => {
		const msg = args.length ? `${message} ${args.map(String).join(" ")}` : message;
		console.error(`[${new Date().toISOString()}] [ERROR] [mcs-worker] ${redact(msg)}`);
	},
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!MCS_AGENT_NAME) {
	log.error("FATAL: MCS_AGENT_NAME not set");
	process.exit(1);
}
if (!MCS_SECRET) {
	log.error(`FATAL: MCS_KEY_${MCS_AGENT_NAME.toUpperCase()} not set`);
	process.exit(1);
}
if (!OPENCLAW_HOOK_TOKEN) {
	log.error("FATAL: OPENCLAW_HOOK_TOKEN not set");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Issue 7: .env file security enforcement
// ---------------------------------------------------------------------------

function enforceEnvFileSecurity(): void {
	try {
		if (!existsSync(ENV_FILE_PATH)) return;
		const stats = statSync(ENV_FILE_PATH);
		// mode & 0o777 gives permissions; 0o600 = owner read/write only
		const perms = stats.mode & 0o777;
		if (perms !== 0o600) {
			chmodSync(ENV_FILE_PATH, 0o600);
			log.warn(`Fixed .env file permissions from ${perms.toString(8)} to 600`);
		}
	} catch (err) {
		log.warn(`Could not enforce .env file permissions: ${(err as Error).message}`);
	}
}

enforceEnvFileSecurity();

log.info(`Starting for agent: ${MCS_AGENT_NAME}`);
log.info(`MCS URL: ${MCS_URL}`);
log.info(`OpenClaw gateway: ${OPENCLAW_GATEWAY_URL}`);
log.info(`Health check port: ${HEALTH_PORT}`);
log.info(`Allowed payload domains: ${ALLOWED_PAYLOAD_DOMAINS.join(", ")}`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const TASK_CHECK_INTERVAL_MS = 10_000;
const TASK_MAX_WAIT_MS = 550_000; // 9.2 minutes (default)
const TASK_MAX_WAIT_EXTENDED_MS = 1_800_000; // 30 minutes (for research/review)
const HOOK_TIMEOUT_SECONDS = 540;
const HOOK_TIMEOUT_EXTENDED_SECONDS = 1740; // 29 minutes

// Task types that need extended timeouts
const EXTENDED_TIMEOUT_TYPES = new Set(["mcs-research", "mcs-review", "mcs-art", "mcs-slideshow-summary"]);
const LOCK_FILE_PATH = join(homedir(), ".claude", "mcs-worker-running.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McsTask {
	id: string;
	type: string;
	status: string;
	priority: number | string;
	payload: Record<string, unknown>;
	assigned_to: string | null;
	claim_expires_at: string | null;
}

interface LockEntry {
	id: string;
	startedAt: string;
	taskType?: string;
}

// ---------------------------------------------------------------------------
// Issue 2: Persistent disk-backed task lock
// ---------------------------------------------------------------------------

function loadLockFile(): LockEntry[] {
	try {
		if (!existsSync(LOCK_FILE_PATH)) return [];
		const content = readFileSync(LOCK_FILE_PATH, "utf-8");
		const entries: LockEntry[] = [];
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const entry = JSON.parse(trimmed) as LockEntry;
				entries.push(entry);
			} catch {
				// skip malformed lines
			}
		}
		return entries;
	} catch {
		return [];
	}
}

function saveLockFile(entries: LockEntry[]): void {
	try {
		const content = entries.map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(LOCK_FILE_PATH, content ? content + "\n" : "", "utf-8");
	} catch (err) {
		log.error(`Failed to save lock file: ${(err as Error).message}`);
	}
}

function pruneStaleEntries(entries: LockEntry[]): LockEntry[] {
	const now = Date.now();
	return entries.filter((e) => {
		const baseType = e.taskType?.split(",")[0]?.trim() ?? "";
		const maxWait = EXTENDED_TIMEOUT_TYPES.has(baseType) ? TASK_MAX_WAIT_EXTENDED_MS : TASK_MAX_WAIT_MS;
		return new Date(e.startedAt).getTime() > now - maxWait;
	});
}

function isAlreadyRunning(taskId: string): boolean {
	const entries = pruneStaleEntries(loadLockFile());
	return entries.some((e) => e.id === taskId);
}

function markRunning(taskId: string, taskType?: string): void {
	const entries = pruneStaleEntries(loadLockFile());
	if (!entries.some((e) => e.id === taskId)) {
		entries.push({ id: taskId, startedAt: new Date().toISOString(), taskType });
		saveLockFile(entries);
	}
}

function markComplete(taskId: string): void {
	const entries = pruneStaleEntries(loadLockFile());
	saveLockFile(entries.filter((e) => e.id !== taskId));
}

// Get currently running task IDs from lock file
function getRunningTaskIds(): string[] {
	return pruneStaleEntries(loadLockFile()).map((e) => e.id);
}

// Recently completed tasks — prevents re-processing after result submission
const recentlyCompleted = new Map<string, number>(); // taskId → completedAt timestamp
const RECENTLY_COMPLETED_TTL_MS = 300_000; // 5 minutes

function markRecentlyCompleted(taskId: string): void {
	recentlyCompleted.set(taskId, Date.now());
	// Prune old entries
	for (const [id, ts] of recentlyCompleted) {
		if (Date.now() - ts > RECENTLY_COMPLETED_TTL_MS) {
			recentlyCompleted.delete(id);
		}
	}
}

function isRecentlyCompleted(taskId: string): boolean {
	const ts = recentlyCompleted.get(taskId);
	if (!ts) return false;
	if (Date.now() - ts > RECENTLY_COMPLETED_TTL_MS) {
		recentlyCompleted.delete(taskId);
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Issue 6: Exponential backoff
// ---------------------------------------------------------------------------

const BACKOFF_SCHEDULE_MS = [30_000, 30_000, 60_000, 120_000, 300_000];
let consecutivePollFailures = 0;

function getNextPollDelay(): number {
	const idx = Math.min(consecutivePollFailures, BACKOFF_SCHEDULE_MS.length - 1);
	return BACKOFF_SCHEDULE_MS[idx];
}

function recordPollSuccess(): void {
	if (consecutivePollFailures > 0) {
		log.info(`Poll recovered after ${consecutivePollFailures} failure(s)`);
		consecutivePollFailures = 0;
	}
}

function recordPollFailure(): void {
	consecutivePollFailures++;
	const nextDelay = getNextPollDelay();
	log.warn(`Poll failure #${consecutivePollFailures}. Next retry in ${nextDelay / 1000}s`);
}

// ---------------------------------------------------------------------------
// Issue 4: Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
const startedAt = new Date().toISOString();
let lastPollAt: string | null = null;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info(`Received ${signal} — initiating graceful shutdown`);

	// Fail all in-flight tasks
	const runningIds = getRunningTaskIds();
	if (runningIds.length > 0) {
		log.info(`Submitting failed for ${runningIds.length} in-flight task(s): ${runningIds.join(", ")}`);
		await Promise.allSettled(
			runningIds.map((id) =>
				submitResult(id, "failed", `Worker shutdown due to ${signal}`),
			),
		);
	}

	// Clear lock file
	try {
		saveLockFile([]);
	} catch {
		// ignore
	}

	log.info("Shutdown complete");

	// Force exit after 30s if still running
	const forceTimer = setTimeout(() => {
		log.error("Force exiting after 30s shutdown timeout");
		process.exit(1);
	}, 30_000);
	if (forceTimer.unref) forceTimer.unref();

	process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });

// ---------------------------------------------------------------------------
// Issue 12: Priority sorting
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = {
	urgent: 3,
	normal: 2,
	low: 1,
};

function taskPriorityScore(task: McsTask): number {
	const p = task.priority;
	if (typeof p === "number") return p;
	if (typeof p === "string") {
		const lower = p.toLowerCase();
		return PRIORITY_ORDER[lower] ?? 0;
	}
	return 0;
}

function sortByPriority(tasks: McsTask[]): McsTask[] {
	return [...tasks].sort((a, b) => taskPriorityScore(b) - taskPriorityScore(a));
}

// ---------------------------------------------------------------------------
// Issue 1: Prompt injection protection
// ---------------------------------------------------------------------------

const SAFE_PAYLOAD_FIELDS = new Set([
	"pr_url",
	"payload_url",
	"caps_required",
	"task_type",
	"description",
	"repo",
	"repo_path",
	"branch",
	"commit_sha",
	"prompt",
	"sub_query",
	"query",
	"context",
	"review_type",
	"focus_areas",
	"depth",
	"research_topic",
	"git_repo",
	"target_branch",
	"file_paths",
	"instructions",
	"concept",
	"type",
	"format",
	"data",
	"aspect_ratio",
	"product",
	"target_market",
	"price_range",
	"guarantee_preference",
	"content",
	"angle_preference",
	"payload_file",
]);

const INJECTION_PATTERNS: RegExp[] = [
	/`/g,
	/^(IGNORE|SYSTEM:|IMPORTANT:|---)/gim,
	/ignore\s+(all|previous|above)/gi,
];

// Fields that carry substantial content — use higher truncation limit (32KB)
const LONG_CONTENT_FIELDS = new Set(["prompt", "query", "sub_query", "context", "description", "instructions", "concept", "content", "product"]);

function sanitizePayloadString(value: string, fieldName?: string): string {
	let result = value;
	for (const pattern of INJECTION_PATTERNS) {
		result = result.replace(pattern, "[REDACTED]");
	}
	const limit = fieldName && LONG_CONTENT_FIELDS.has(fieldName) ? 32_000 : 2_000;
	if (result.length > limit) {
		result = result.slice(0, limit) + "...[TRUNCATED]";
	}
	return result;
}

/**
 * Extract text content from an A2A message object.
 * Handles { role, parts: [{ kind: "text", text: "..." }, ...] } structure.
 */
function extractMessageText(msg: unknown): string | null {
	if (!msg || typeof msg !== "object") return null;
	const parts = (msg as Record<string, unknown>).parts;
	if (!Array.isArray(parts)) return null;
	const texts: string[] = [];
	for (const part of parts) {
		if (part && typeof part === "object") {
			const p = part as Record<string, unknown>;
			// Support both { kind: "text", text } and { type: "text", text }
			if ((p.kind === "text" || p.type === "text") && typeof p.text === "string") {
				texts.push(p.text);
			}
		}
	}
	return texts.length > 0 ? texts.join("\n\n") : null;
}

function extractSafePayload(payload: Record<string, unknown>): Record<string, string> {
	const safe: Record<string, string> = {};

	// Flatten extra_payload: promote nested fields to top level so they pass
	// through the whitelist check.  Top-level fields take precedence over
	// extra_payload fields (no overwriting).
	if (payload.extra_payload && typeof payload.extra_payload === "object" && !Array.isArray(payload.extra_payload)) {
		const extra = payload.extra_payload as Record<string, unknown>;
		for (const [k, v] of Object.entries(extra)) {
			if (!(k in payload)) {
				(payload as Record<string, unknown>)[k] = v;
			}
		}
	}

	// Handle A2A message object: extract text content as "prompt" field
	if (payload.message && typeof payload.message === "object") {
		const messageText = extractMessageText(payload.message);
		if (messageText) {
			// Use higher truncation limit for message content (8KB vs 500 chars)
			let sanitized = messageText;
			for (const pattern of INJECTION_PATTERNS) {
				sanitized = sanitized.replace(pattern, "[REDACTED]");
			}
			if (sanitized.length > 8000) {
				sanitized = sanitized.slice(0, 8000) + "...[TRUNCATED]";
			}
			safe["prompt"] = sanitized;
		}
	}

	for (const [key, value] of Object.entries(payload)) {
		if (!SAFE_PAYLOAD_FIELDS.has(key)) continue;
		if (value === null || value === undefined) continue;

		if (typeof value === "string") {
			// Special handling for payload_url: SSRF check
			if (key === "payload_url") {
				const validated = validatePayloadUrl(value);
				if (validated) {
					safe[key] = sanitizePayloadString(validated, key);
				}
				// If invalid, skip the field silently
			} else {
				safe[key] = sanitizePayloadString(value, key);
			}
		} else if (typeof value === "number" || typeof value === "boolean") {
			safe[key] = String(value);
		} else if (Array.isArray(value)) {
			// Join primitive arrays, serialize complex arrays as JSON
			const allPrimitive = value.every(
				(v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
			);
			if (allPrimitive) {
				safe[key] = sanitizePayloadString(value.map(String).join(", "), key);
			} else {
				safe[key] = sanitizePayloadString(JSON.stringify(value), key);
			}
		} else if (typeof value === "object") {
			// Serialize nested objects as JSON so they pass through to agents
			safe[key] = sanitizePayloadString(JSON.stringify(value), key);
		}
	}
	return safe;
}

// ---------------------------------------------------------------------------
// Issue 11: SSRF prevention
// ---------------------------------------------------------------------------

const PRIVATE_IP_PATTERNS: RegExp[] = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^169\.254\./,
	/^::1$/,
	/^fc00:/i,
	/^fd[0-9a-f]{2}:/i,
	/^localhost$/i,
];

function isPrivateIp(hostname: string): boolean {
	return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname));
}

function validatePayloadUrl(urlStr: string): string | null {
	try {
		const url = new URL(urlStr);
		if (url.protocol !== "https:") {
			log.warn(`Rejected payload_url with non-HTTPS protocol: ${url.protocol}`);
			return null;
		}
		const hostname = url.hostname;
		if (isPrivateIp(hostname)) {
			log.warn(`Rejected payload_url with private IP/hostname: ${hostname}`);
			return null;
		}
		if (!ALLOWED_PAYLOAD_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
			log.warn(`Rejected payload_url from non-allowlisted domain: ${hostname}`);
			return null;
		}
		return urlStr;
	} catch {
		log.warn(`Rejected malformed payload_url: ${urlStr.slice(0, 80)}`);
		return null;
	}
}

async function fetchPayloadUrl(urlStr: string): Promise<string | null> {
	const validated = validatePayloadUrl(urlStr);
	if (!validated) return null;
	try {
		const res = await fetch(validated, {
			signal: AbortSignal.timeout(30_000), // 30s for large payloads
			headers: { "Connection": "keep-alive" },
		});
		if (!res.ok) {
			log.warn(`payload_url fetch returned ${res.status}`);
			return null;
		}
		return await res.text(); // Full content — no cap (worker writes to local file)
	} catch (err) {
		log.warn(`payload_url fetch failed: ${(err as Error).message}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Payload file helpers — write downloaded payload to local file for OpenClaw
// ---------------------------------------------------------------------------

const PAYLOAD_DIR = "/tmp/mcs-payloads";
const MAX_PAYLOAD_CHARS = 10_000_000; // 10MB chars — no truncation for code review payloads

function writePayloadFile(taskId: string, content: string): string {
	if (!existsSync(PAYLOAD_DIR)) mkdirSync(PAYLOAD_DIR, { recursive: true });
	const filePath = join(PAYLOAD_DIR, `${taskId}.txt`);
	let finalContent = content;
	if (content.length > MAX_PAYLOAD_CHARS) {
		log.warn(`Payload ${content.length} chars exceeds ${MAX_PAYLOAD_CHARS} limit — truncating`);
		finalContent = content.slice(0, MAX_PAYLOAD_CHARS)
			+ `\n\n[TRUNCATED — showing first ${MAX_PAYLOAD_CHARS.toLocaleString()} of ${content.length.toLocaleString()} chars. Review the content above.]`;
	}
	writeFileSync(filePath, finalContent, "utf-8");
	log.info(`Wrote ${finalContent.length} chars payload to ${filePath}${content.length > MAX_PAYLOAD_CHARS ? ` (truncated from ${content.length})` : ""}`);
	return filePath;
}

function cleanupPayloadFile(taskId: string): void {
	try {
		unlinkSync(join(PAYLOAD_DIR, `${taskId}.txt`));
	} catch {
		// ignore — file may not exist
	}
}

// ---------------------------------------------------------------------------
// Task prompt construction (Issue 1: XML-style delimiters + sanitized payload)
// ---------------------------------------------------------------------------

function buildTaskPrompt(task: McsTask, payloadFilePath?: string): string {
	const taskType = task.type.split(",")[0].trim();
	const safePayload = extractSafePayload(task.payload);

	// Separate the prompt (long-form content) from short metadata fields
	const prompt = safePayload["prompt"];
	delete safePayload["prompt"];

	// If payload was downloaded to a local file, replace payload_url with payload_file
	const payloadFile = payloadFilePath;
	if (payloadFile) {
		delete safePayload["payload_url"];
		safePayload["payload_file"] = payloadFile;
	}

	const payloadLines = Object.entries(safePayload)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");

	let result = `<task_metadata>
Task ID: ${task.id}
Task Type: ${taskType}
Priority: ${task.priority}
Agent: ${MCS_AGENT_NAME}
</task_metadata>

<task_payload>
${payloadLines || "(no payload fields)"}
</task_payload>`;

	if (prompt) {
		result += `\n\n<task_prompt>\n${prompt}\n</task_prompt>`;
	}

	// If payload was localized to a file, tell the agent to read it from disk
	if (payloadFile) {
		result += `\n\n<payload_instructions>
The task payload has been downloaded to a local file on your filesystem. Read the full content from:
${payloadFile}

Use your file read capability to access this file. Do NOT use web_fetch — the content is already available locally. Read the entire file before starting your review.
</payload_instructions>`;
	}

	// Embed SKILL.md inline if available (avoids wasting a tool-call turn)
	const skillPath = join(homedir(), ".openclaw", "skills", taskType, "SKILL.md");
	let skillContent: string | null = null;
	try {
		if (existsSync(skillPath)) {
			skillContent = readFileSync(skillPath, "utf-8");
			if (skillContent.length > 100_000) {
				// Too large to embed — fall back to file read instruction
				log.warn(`SKILL.md for ${taskType} is ${skillContent.length} chars — too large to embed, agent will read from disk`);
				skillContent = null;
			}
		}
	} catch {
		// File not found or unreadable — fall back
	}

	if (skillContent) {
		result += `\n\n<skill_instructions>
${skillContent}
</skill_instructions>

<instructions>
This is an MCS task dispatched to you by the Mesh Coordination Server. The skill instructions above tell you exactly how to complete this task and format your output. Follow them precisely.

CRITICAL CONSTRAINTS — YOU MUST FOLLOW THESE:
- MAXIMUM 6 web search calls total (2 batches of 3). Do NOT make more than 6 web_search calls. If you exceed 6 searches, your context will overflow and the task will fail.
- After your 2nd batch of search results, STOP searching and IMMEDIATELY write your final output.
- Do NOT do additional rounds of searching — use what you have and write the result.
- Do NOT use web_fetch to load full pages — the search result snippets contain enough information.
- Your FINAL output must be the complete text response (research report, HTML, SVG art, etc.) — not a summary of what you did.

Begin executing the task now.
</instructions>`;
	} else {
		result += `\n\n<instructions>
This is an MCS task dispatched to you by the Mesh Coordination Server. Execute it according to your ${taskType} skill definition. The skill definition is at ~/.openclaw/skills/${taskType}/SKILL.md — read it for detailed instructions on how to complete this task and submit results back to MCS.

Begin executing the task now.
</instructions>`;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Issue 13: MCS API helpers with Connection: keep-alive
// ---------------------------------------------------------------------------

function mcsHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"X-Agent-ID": MCS_AGENT_NAME,
		"X-Agent-Secret": MCS_SECRET,
		"Connection": "keep-alive",
	};
}

async function fetchMyTasks(): Promise<McsTask[]> {
	try {
		const res = await fetch(`${MCS_URL}/tasks/mine`, {
			headers: mcsHeaders(),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			log.error(`GET /tasks/mine returned ${res.status}`);
			recordPollFailure();
			return [];
		}
		const data = (await res.json()) as { tasks: McsTask[] };
		recordPollSuccess();
		lastPollAt = new Date().toISOString();
		return data.tasks ?? [];
	} catch (err) {
		log.error(`fetchMyTasks error: ${(err as Error).message}`);
		recordPollFailure();
		return [];
	}
}

async function getTaskStatus(taskId: string): Promise<string | null> {
	try {
		const res = await fetch(`${MCS_URL}/tasks/${taskId}`, {
			headers: mcsHeaders(),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { status: string };
		return data.status;
	} catch {
		return null;
	}
}

async function sendHeartbeat(taskId: string): Promise<void> {
	try {
		await fetch(`${MCS_URL}/tasks/${taskId}/heartbeat`, {
			method: "POST",
			headers: mcsHeaders(),
			signal: AbortSignal.timeout(5_000),
		});
	} catch (err) {
		log.error(`heartbeat ${taskId} error: ${(err as Error).message}`);
	}
}

async function submitResult(
	taskId: string,
	status: "completed" | "failed",
	output: string,
): Promise<void> {
	try {
		const body = status === "completed" ? { status, output } : { status, error: output };

		const res = await fetch(`${MCS_URL}/tasks/${taskId}/result`, {
			method: "POST",
			headers: mcsHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});

		if (!res.ok) {
			const resBody = await res.text().catch(() => "");
			log.error(`submitResult ${taskId} rejected: HTTP ${res.status} — ${resBody}`);

			// If output validation failed (422), retry as failed with the rejection reason
			if (res.status === 422 && status === "completed") {
				log.warn(`Retrying ${taskId} as failed due to output validation rejection`);
				const retryBody = { status: "failed", error: `Output validation rejected: ${resBody}` };
				await fetch(`${MCS_URL}/tasks/${taskId}/result`, {
					method: "POST",
					headers: mcsHeaders(),
					body: JSON.stringify(retryBody),
					signal: AbortSignal.timeout(10_000),
				});
			}
			return;
		}

		log.info(`Submitted result for ${taskId}: ${status}`);
	} catch (err) {
		log.error(`submitResult ${taskId} error: ${(err as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// OpenClaw session file polling — extracts output and submits to MCS
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), ".openclaw", "agents", "main", "sessions");
const SESSIONS_JSON = join(SESSIONS_DIR, "sessions.json");
const SESSION_APPEAR_TIMEOUT_MS = 60_000;
const SESSION_IDLE_THRESHOLD_MS = 90_000;
const SESSION_POLL_INTERVAL_MS = 5_000;

/**
 * Find the JSONL session file for a given MCS task ID by reading sessions.json.
 * OpenClaw stores sessions keyed as "agent:main:mcs:{taskId}".
 */
function getSessionFilePath(taskId: string, attempt = 0): string | null {
	try {
		const content = readFileSync(SESSIONS_JSON, "utf-8");
		const data = JSON.parse(content) as Record<string, unknown>;
		const keySuffix = attempt > 0 ? `:r${attempt}` : "";
		const sessionKey = `agent:main:mcs:${taskId}${keySuffix}`;
		const entry = data[sessionKey];
		if (entry && typeof entry === "object" && "sessionId" in (entry as Record<string, unknown>)) {
			const sessionId = (entry as Record<string, unknown>).sessionId as string;
			return join(SESSIONS_DIR, `${sessionId}.jsonl`);
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Extract the last assistant message from an OpenClaw session JSONL file.
 * Each line is: { type, id, parentId, timestamp, message: { role, content } }
 * Content may be a string or an array of { type: "text", text: "..." } blocks.
 */
/**
 * Extract file paths written by tool calls in the session.
 * Looks for write_file / writeFile / file_write tool calls with a path argument.
 */
function extractWrittenFilePaths(lines: string[]): string[] {
	const paths: string[] = [];
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			const message = entry.message as Record<string, unknown> | undefined;
			if (!message || message.role !== "assistant") continue;

			const msgContent = message.content;
			if (!Array.isArray(msgContent)) continue;

			for (const block of msgContent) {
				if (!block || typeof block !== "object") continue;
				const b = block as Record<string, unknown>;
				// OpenClaw tool calls: { type: "toolCall", name: "write_file", input: { path, content } }
				if ((b.type === "toolCall" || b.type === "tool_use") &&
					typeof b.name === "string" &&
					/write|save|create/i.test(b.name) &&
					/file/i.test(b.name)) {
					const input = b.input as Record<string, unknown> | undefined;
					if (input && typeof input.path === "string") {
						paths.push(input.path);
					}
					// Also check for file_path (some tools use this)
					if (input && typeof input.file_path === "string") {
						paths.push(input.file_path);
					}
				}
			}
		} catch {
			// skip
		}
	}
	return paths;
}

/**
 * Read files written by the agent and combine them into output.
 * Only reads files that exist and are reasonable size (< 500KB).
 */
function readWrittenFiles(filePaths: string[]): string {
	const sections: string[] = [];
	for (const fp of filePaths) {
		try {
			if (!existsSync(fp)) continue;
			const stats = statSync(fp);
			if (stats.size > 500_000) continue; // skip files > 500KB
			const content = readFileSync(fp, "utf-8");
			if (content.length > 100) { // skip trivially small files
				const basename = fp.split("/").pop() ?? fp;
				sections.push(`--- ${basename} ---\n${content}`);
			}
		} catch {
			// skip unreadable files
		}
	}
	return sections.join("\n\n");
}

function extractSessionOutput(jsonlPath: string): string | null {
	try {
		const content = readFileSync(jsonlPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);

		// Walk backwards to find the last assistant message
		let lastAssistantText: string | null = null;
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]) as Record<string, unknown>;
				const message = entry.message as Record<string, unknown> | undefined;
				if (!message || message.role !== "assistant") continue;

				const msgContent = message.content;
				if (typeof msgContent === "string") { lastAssistantText = msgContent; break; }

				// Array of content blocks: [{ type: "text", text: "..." }, ...]
				if (Array.isArray(msgContent)) {
					const texts: string[] = [];
					for (const block of msgContent) {
						if (block && typeof block === "object") {
							const b = block as Record<string, unknown>;
							if (b.type === "text" && typeof b.text === "string") {
								texts.push(b.text);
							}
						}
					}
					if (texts.length > 0) { lastAssistantText = texts.join("\n\n"); break; }
				}
			} catch {
				// skip malformed lines
			}
		}

		// If the last assistant message is short (< 2KB), the agent likely wrote output
		// to files instead of returning it inline. Check for file write tool calls.
		if (!lastAssistantText || lastAssistantText.length < 2000) {
			const writtenPaths = extractWrittenFilePaths(lines);
			if (writtenPaths.length > 0) {
				log.info(`Session wrote ${writtenPaths.length} file(s): ${writtenPaths.join(", ")}`);
				const fileContents = readWrittenFiles(writtenPaths);
				if (fileContents.length > 0) {
					// Combine: file contents first, then the summary message
					const combined = lastAssistantText
						? `${fileContents}\n\n--- Agent Summary ---\n${lastAssistantText}`
						: fileContents;
					log.info(`Combined output from files: ${combined.length} chars (${writtenPaths.length} files + summary)`);
					return combined;
				}
			}
		}

		return lastAssistantText;
	} catch {
		return null;
	}
}

/**
 * Check if the last entry in the session JSONL is a tool_result, meaning
 * the LLM is still generating a response. This prevents premature idle detection
 * when the LLM takes 30+ seconds to process a large context after a tool call.
 */
function isSessionAwaitingLlmResponse(jsonlPath: string): boolean {
	try {
		const content = readFileSync(jsonlPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		if (lines.length === 0) return false;

		// Check the last non-empty line
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]) as Record<string, unknown>;
				const message = entry.message as Record<string, unknown> | undefined;
				if (!message) continue;
				if (entry.type !== "message") continue; // skip session/config entries

				const role = message.role as string;

				// OpenClaw uses "toolResult" role (not "tool") for tool results
				if (role === "toolResult" || role === "tool") return true;

				// Also check if the last assistant message has toolCall blocks
				// (meaning agent sent a tool call and is waiting for the result)
				if (role === "assistant") {
					const msgContent = message.content;
					if (Array.isArray(msgContent)) {
						// Empty content array means the LLM started but hasn't produced anything yet
						if (msgContent.length === 0) return true;
						for (const block of msgContent) {
							if (block && typeof block === "object") {
								const b = block as Record<string, unknown>;
								if (b.type === "toolCall" || b.type === "tool_use") return true;
							}
						}
					}
				}

				// Last entry is user or plain assistant text — not awaiting
				return false;
			} catch {
				continue;
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Wait for the OpenClaw session to appear and complete, then extract output
 * and submit it back to MCS. This replaces the old waitForTaskCompletion()
 * which polled MCS (a circular wait — nothing was submitting results).
 */
async function waitForSessionAndSubmit(taskId: string, taskType?: string, _retryCount = 0): Promise<void> {
	const extended = taskType ? EXTENDED_TIMEOUT_TYPES.has(taskType.split(",")[0].trim()) : false;
	const maxWait = extended ? TASK_MAX_WAIT_EXTENDED_MS : TASK_MAX_WAIT_MS;
	const deadline = Date.now() + maxWait;

	log.info(`Waiting for OpenClaw session output for task ${taskId} (timeout: ${maxWait / 1000}s${_retryCount > 0 ? `, retry #${_retryCount}` : ""})`);

	// Phase 1: Wait for session file to appear in sessions.json
	// Use the task deadline (not a short separate timeout) because OpenClaw
	// processes sessions sequentially — queued sessions may take minutes to start.
	let jsonlPath: string | null = null;

	while (Date.now() < deadline) {
		if (shuttingDown) return;
		jsonlPath = getSessionFilePath(taskId, _retryCount);
		if (jsonlPath && existsSync(jsonlPath)) break;
		jsonlPath = null;
		await sleep(SESSION_POLL_INTERVAL_MS);
	}

	if (!jsonlPath) {
		log.error(`Session file never appeared for task ${taskId}`);
		await submitResult(taskId, "failed", "OpenClaw session file not found — session may not have started");
		return;
	}

	log.info(`Session file found for task ${taskId}: ${jsonlPath}`);

	// Phase 2: Wait for session to complete (file stops changing)
	let lastMtime = 0;
	let idleSince = 0;
	let heartbeatCount = 0;
	let loggedCompletedWarning = false;

	while (Date.now() < deadline) {
		if (shuttingDown) return;

		heartbeatCount++;

		// Check MCS status every 6th iteration (~30s) to detect cancellation,
		// but do NOT skip extraction for completed/failed — always extract output first.
		// The old behavior skipped extraction when MCS resolved the task (e.g. parent fanout
		// completing, claim watchdog), causing output loss on agents like Ocasia.
		if (heartbeatCount % 6 === 0) {
			const status = await getTaskStatus(taskId);
			if (status === "canceled") {
				log.info(`Task ${taskId} was canceled — skipping session extraction`);
				markRecentlyCompleted(taskId);
				return;
			}
			// For completed/failed: continue extracting — we may still have output to submit
			if ((status === "completed" || status === "failed") && !loggedCompletedWarning) {
				log.info(`Task ${taskId} already ${status} in MCS — will still extract and attempt submission`);
				loggedCompletedWarning = true;
			}
		}

		// Send heartbeat to keep claim alive
		await sendHeartbeat(taskId);

		try {
			const stats = statSync(jsonlPath);
			const mtime = stats.mtimeMs;

			if (mtime !== lastMtime) {
				// File is still being written
				lastMtime = mtime;
				idleSince = Date.now();
			} else if (idleSince > 0 && Date.now() - idleSince >= SESSION_IDLE_THRESHOLD_MS) {
				// File hasn't changed for the idle threshold — but check if the LLM is still processing
				if (isSessionAwaitingLlmResponse(jsonlPath)) {
					// Last entry is a tool_result — LLM is generating a response, not idle
					const llmWaitCap = extended ? SESSION_IDLE_THRESHOLD_MS * 5 : SESSION_IDLE_THRESHOLD_MS * 3;
					if (Date.now() - idleSince < llmWaitCap) {
						// Allow up to 5x (extended) or 3x (normal) idle threshold for LLM generation
						await sleep(SESSION_POLL_INTERVAL_MS);
						continue;
					}
					log.warn(`Session still awaiting LLM response after ${Math.round((Date.now() - idleSince) / 1000)}s — forcing extraction`);
				}
				log.info(`Session file idle for ${Math.round((Date.now() - idleSince) / 1000)}s — extracting output for task ${taskId}`);
				break;
			}
		} catch {
			// File may have been deleted or moved
			log.warn(`Could not stat session file for task ${taskId}`);
		}

		await sleep(SESSION_POLL_INTERVAL_MS);
	}

	if (Date.now() >= deadline) {
		log.error(`Task ${taskId} timed out waiting for session to complete`);
		await submitResult(taskId, "failed", `Session did not complete within ${maxWait / 1000}s`);
		return;
	}

	// Phase 3: Extract output and submit
	const output = extractSessionOutput(jsonlPath);
	if (output) {
		log.info(`Extracted ${output.length} chars of output for task ${taskId}`);
		await submitResult(taskId, "completed", output);
		markRecentlyCompleted(taskId);
	} else {
		log.error(`No assistant output found in session for task ${taskId}${_retryCount > 0 ? ` (retry #${_retryCount})` : ""}`);
		// Signal caller to retry if this is a model stall (no output at all)
		if (_retryCount === 0) {
			throw new SessionRetryError(`No assistant output — model stall detected for task ${taskId}`);
		}
		await submitResult(taskId, "failed", "Session completed but no assistant output found after retry");
		markRecentlyCompleted(taskId);
	}
}

/** Thrown when a session produces no output and should be retried */
class SessionRetryError extends Error {
	constructor(msg: string) { super(msg); this.name = "SessionRetryError"; }
}

// ---------------------------------------------------------------------------
// OpenClaw hook invocation
// ---------------------------------------------------------------------------

async function invokeOpenClawSession(task: McsTask, payloadFilePath?: string, attempt = 0): Promise<void> {
	const sessionKey = attempt > 0 ? `mcs:${task.id}:r${attempt}` : `mcs:${task.id}`;
	const prompt = buildTaskPrompt(task, payloadFilePath);
	const taskType = task.type.split(",")[0].trim();
	const extended = EXTENDED_TIMEOUT_TYPES.has(taskType);
	const hookTimeout = extended ? HOOK_TIMEOUT_EXTENDED_SECONDS : HOOK_TIMEOUT_SECONDS;

	// On retry, use fallback model (Gemini) instead of primary (Qwen) to avoid repeated stalls
	const model = attempt > 0 ? OPENCLAW_FALLBACK_MODEL : (OPENCLAW_HOOK_MODEL || undefined);
	log.info(`Invoking OpenClaw session for task ${task.id} (${taskType}, timeout: ${hookTimeout}s, model: ${model || "gateway-default"}, prompt: ${prompt.length} chars${attempt > 0 ? `, retry #${attempt} using fallback model` : ""})`);

	const res = await fetch(`${OPENCLAW_GATEWAY_URL}/hooks/agent`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-openclaw-token": OPENCLAW_HOOK_TOKEN,
			"Connection": "keep-alive",
		},
		body: JSON.stringify({
			message: prompt,
			name: `mcs-${taskType}`,
			sessionKey,
			wakeMode: "now",
			deliver: false,
			timeoutSeconds: hookTimeout,
			...(model ? { model } : {}),
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (res.status !== 202) {
		const body = await res.text();
		throw new Error(`OpenClaw /hooks/agent returned ${res.status}: ${body}`);
	}

	log.info(`OpenClaw session started for ${task.id}`);
}

// ---------------------------------------------------------------------------
// Wait for task completion via MCS polling
// ---------------------------------------------------------------------------

async function waitForTaskCompletion(taskId: string, taskType?: string): Promise<void> {
	const extended = taskType ? EXTENDED_TIMEOUT_TYPES.has(taskType.split(",")[0].trim()) : false;
	const maxWait = extended ? TASK_MAX_WAIT_EXTENDED_MS : TASK_MAX_WAIT_MS;
	const deadline = Date.now() + maxWait;
	if (extended) {
		log.info(`Using extended timeout (${maxWait / 1000}s) for ${taskType} task ${taskId}`);
	}

	while (Date.now() < deadline) {
		if (shuttingDown) {
			log.info(`Shutdown detected while waiting for task ${taskId} — aborting wait`);
			return;
		}

		await sleep(TASK_CHECK_INTERVAL_MS);

		const status = await getTaskStatus(taskId);
		if (!status) {
			log.warn(`Task ${taskId} not found during wait — may have been canceled`);
			return;
		}

		if (status === "completed" || status === "failed" || status === "canceled") {
			log.info(`Task ${taskId} reached terminal state: ${status}`);
			return;
		}

		// Send keepalive heartbeat
		await sendHeartbeat(taskId);
	}

	// Timeout — submit a failure result
	log.error(`Task ${taskId} timed out after ${maxWait}ms`);
	await submitResult(taskId, "failed", `Worker timeout: task did not complete within ${maxWait / 1000}s`);
}

// ---------------------------------------------------------------------------
// Core task processing (Issue 2: persistent lock)
// ---------------------------------------------------------------------------

async function processTask(task: McsTask): Promise<void> {
	if (isAlreadyRunning(task.id)) return;
	if (isRecentlyCompleted(task.id)) return;
	// Only process tasks in "working" state (assigned to us)
	if (task.status !== "working") return;

	markRunning(task.id, task.type);
	log.info(`Processing task ${task.id} (type: ${task.type})`);

	try {
		// Send immediate heartbeat to extend claim TTL
		await sendHeartbeat(task.id);

		// Download payload_url to local file (bypasses OpenClaw web_fetch limits)
		let payloadFilePath: string | undefined;
		if (task.payload?.payload_url && typeof task.payload.payload_url === "string") {
			const content = await fetchPayloadUrl(task.payload.payload_url);
			if (content) {
				payloadFilePath = writePayloadFile(task.id, content);
				log.info(`Downloaded payload_url (${content.length} chars) to ${payloadFilePath}`);
			} else {
				log.warn(`Failed to download payload_url for task ${task.id} — agent will try web_fetch`);
			}
		}

		// Start periodic heartbeat
		const heartbeatTimer = setInterval(() => sendHeartbeat(task.id), HEARTBEAT_INTERVAL_MS);

		try {
			// Invoke OpenClaw isolated session
			await invokeOpenClawSession(task, payloadFilePath);

			// Poll session file for completion, extract output, submit to MCS
			await waitForSessionAndSubmit(task.id, task.type, 0);
		} catch (retryErr) {
			if (retryErr instanceof SessionRetryError) {
				// Model stall detected — retry with a fresh session (unique session key)
				log.info(`Retrying task ${task.id} with fresh OpenClaw session after model stall`);
				await invokeOpenClawSession(task, payloadFilePath, 1);
				await waitForSessionAndSubmit(task.id, task.type, 1);
			} else {
				throw retryErr;
			}
		} finally {
			clearInterval(heartbeatTimer);
		}
	} catch (err) {
		log.error(`Task ${task.id} failed: ${(err as Error).message}`);
		await submitResult(task.id, "failed", (err as Error).message);
	} finally {
		cleanupPayloadFile(task.id);
		markComplete(task.id);
	}
}

// ---------------------------------------------------------------------------
// Issue 9: Health check endpoint
// ---------------------------------------------------------------------------

const healthServer = Bun.serve({
	port: HEALTH_PORT,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/health" && req.method === "GET") {
			const runningIds = getRunningTaskIds();
			const uptimeSeconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
			const ok = !shuttingDown && consecutivePollFailures < BACKOFF_SCHEDULE_MS.length;

			return new Response(
				JSON.stringify({
					ok,
					agent: MCS_AGENT_NAME,
					running_tasks: runningIds.length,
					running_task_ids: runningIds,
					last_poll_at: lastPollAt,
					consecutive_poll_failures: consecutivePollFailures,
					uptime_seconds: uptimeSeconds,
					worker_version: WORKER_VERSION,
				}),
				{
					status: ok ? 200 : 503,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		return new Response("Not Found", { status: 404 });
	},
	error(err) {
		log.error(`Health server error: ${err.message}`);
		return new Response("Internal Server Error", { status: 500 });
	},
});

log.info(`Health check server listening on port ${healthServer.port}`);

// ---------------------------------------------------------------------------
// Adaptive poll loop (Issues 4, 6, 12)
// ---------------------------------------------------------------------------

async function pollAndProcess(): Promise<void> {
	if (shuttingDown) return;

	try {
		const tasks = await fetchMyTasks();

		// Filter to only "working" tasks not already being processed
		const actionable = tasks.filter((t) => t.status === "working" && !isAlreadyRunning(t.id));

		if (actionable.length > 0) {
			log.info(`Found ${actionable.length} actionable task(s) for ${MCS_AGENT_NAME}`);
		} else if (tasks.length > 0) {
			log.info(`${tasks.length} task(s) assigned but none actionable (statuses: ${tasks.map((t) => t.status).join(", ")})`);
		}

		// Sort by priority before processing
		const sorted = sortByPriority(actionable);

		// Check shuttingDown mid-loop before processing
		if (shuttingDown) return;

		for (const task of sorted) {
			if (shuttingDown) break;
			// Fire-and-forget — process tasks concurrently
			processTask(task).catch((err) => {
				log.error(`Unhandled error in processTask: ${(err as Error).message}`);
			});
		}
	} catch (err) {
		log.error(`Poll error: ${(err as Error).message}`);
		recordPollFailure();
	}
}

async function runPollLoop(): Promise<void> {
	log.info(`Poll loop started (base interval: ${POLL_INTERVAL_MS}ms)`);

	while (!shuttingDown) {
		await pollAndProcess();
		const delay = getNextPollDelay();
		await sleep(delay);
	}

	log.info("Poll loop exited");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runPollLoop().catch((err) => {
	log.error(`Fatal: ${(err as Error).message}`);
	process.exit(1);
});
