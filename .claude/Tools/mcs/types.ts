/**
 * types.ts — Shared TypeScript types for the Mesh Coordination Server (MCS)
 *
 * All interfaces match the SQLite schema defined in db.ts.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum TaskStatus {
  Pending = "pending",
  Claimed = "claimed",
  InProgress = "in_progress",
  Completed = "completed",
  Failed = "failed",
}

export enum Priority {
  Urgent = 1,
  Normal = 2,
  Low = 3,
}

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  priority: Priority;
  payload: string; // JSON string
  caps_required: string; // JSON array string
  routing_hint: string; // agent_id | "any"
  created_by: string;
  assigned_to: string | null;
  max_retries: number;
  attempt: number;
  claim_ttl_seconds: number;
  claimed_at: string | null; // ISO datetime
  claim_expires_at: string | null; // ISO datetime
  retry_after: string | null; // ISO datetime
  idempotency_key: string | null;
  notify_url: string | null;
  result_status: string | null;
  result_output: string | null;
  result_error: string | null;
  created_at: string; // ISO datetime
  updated_at: string; // ISO datetime
  completed_at: string | null; // ISO datetime
  deleted_at: string | null; // ISO datetime
}

export interface Agent {
  agent_id: string;
  capabilities: string; // JSON array string
  notify_url: string | null;
  current_load: number;
  registered_at: string; // ISO datetime
  expires_at: string; // ISO datetime
}

export interface MemoryEntry {
  ns: string;
  key: string;
  value: string; // JSON string
  version: number;
  ttl_seconds: number | null;
  tags: string; // JSON array string
  created_by: string;
  updated_by: string;
  created_at: string; // ISO datetime
  updated_at: string; // ISO datetime
  expires_at: string | null; // ISO datetime
  deleted: number; // 0 | 1 (SQLite boolean)
}

export interface Watch {
  watch_id: string;
  agent_id: string;
  ns: string;
  prefix: string;
  notify_url: string;
  created_at: string; // ISO datetime
  expires_at: string; // ISO datetime
}

export interface AuditEvent {
  id?: number; // AUTOINCREMENT — omit on insert
  task_id: string;
  event_type: string; // "created" | "claimed" | "completed" | "failed" | "expired" | "retried"
  agent_id: string | null;
  detail: string | null; // JSON string for extra context
  created_at: string; // ISO datetime
}

export interface TaskDependency {
  task_id: string;
  depends_on: string;
}

export interface FanoutTask {
  parent_task_id: string;
  child_task_id: string;
  agent_id: string;
}

// ---------------------------------------------------------------------------
// Memory watch change event (sent to watch notify_url)
// ---------------------------------------------------------------------------

export interface MemoryChangeEvent {
  event: "memory_changed";
  ns: string;
  key: string;
  value: unknown;
  version: number;
  updated_by: string;
  timestamp: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Request / Response shapes (used by route handlers)
// ---------------------------------------------------------------------------

export interface AuthContext {
  agentId: string;
}

export interface ErrorResponse {
  error: string;
  code?: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptime_seconds: number;
  db_path: string;
}
