/**
 * routes/memory.ts — Memory store HTTP endpoint handlers for MCS
 *
 * All handlers accept (req, agentId, db) and return Response.
 * Namespace and key are passed as additional string parameters.
 *
 * Endpoints:
 *   PUT    /memory/:ns/:key   — Write a key
 *   GET    /memory/:ns/:key   — Read a key
 *   DELETE /memory/:ns/:key   — Delete a key
 *   GET    /memory/:ns        — List keys in namespace
 *   POST   /memory/:ns        — Bulk write
 *   GET    /memory/snapshot   — Full mesh namespace dump
 */

import type { Database } from "bun:sqlite";
import type { MemoryEntry } from "../types.ts";
import {
  upsertKey,
  getKey,
  deleteKey,
  listKeys,
  bulkWrite,
  getSnapshot,
} from "../memory/store.ts";
import { canRead, canWrite } from "../memory/permissions.ts";
import { dispatchWatchNotifications } from "../memory/watcher.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum value size in bytes (1 MB) */
const MAX_VALUE_BYTES = 1_048_576;

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
 * Serialize a MemoryEntry for API responses.
 * Parses the stored JSON string value back into a native JS value.
 */
function serializeEntry(entry: MemoryEntry): Record<string, unknown> {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(entry.value);
  } catch {
    parsedValue = entry.value;
  }

  let parsedTags: string[];
  try {
    parsedTags = JSON.parse(entry.tags);
  } catch {
    parsedTags = [];
  }

  return {
    ns: entry.ns,
    key: entry.key,
    value: parsedValue,
    version: entry.version,
    ttl_seconds: entry.ttl_seconds,
    tags: parsedTags,
    created_by: entry.created_by,
    updated_by: entry.updated_by,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    expires_at: entry.expires_at,
  };
}

// ---------------------------------------------------------------------------
// PUT /memory/:ns/:key — Write a key
// ---------------------------------------------------------------------------

export async function handlePutKey(
  req: Request,
  agentId: string,
  db: Database,
  ns: string,
  key: string
): Promise<Response> {
  // Permission check
  if (!canWrite(ns, agentId)) {
    return jsonError(
      `Agent '${agentId}' does not have write access to namespace '${ns}'`,
      "FORBIDDEN",
      403
    );
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", "BAD_REQUEST", 400);
  }

  if (!("value" in body)) {
    return jsonError("Field 'value' is required", "BAD_REQUEST", 400);
  }

  const value = body.value;
  const ttl = typeof body.ttl === "number" ? Math.floor(body.ttl) : undefined;
  const tags = Array.isArray(body.tags)
    ? (body.tags as unknown[]).filter((t) => typeof t === "string") as string[]
    : undefined;

  // Validate value size
  const valueStr = JSON.stringify(value);
  if (valueStr.length > MAX_VALUE_BYTES) {
    return jsonError(
      `Value too large: ${valueStr.length} bytes (max ${MAX_VALUE_BYTES})`,
      "PAYLOAD_TOO_LARGE",
      413
    );
  }

  // Optimistic locking — If-Match header
  const ifMatch = req.headers.get("If-Match");
  if (ifMatch !== null) {
    const expectedVersion = parseInt(ifMatch, 10);
    if (!isNaN(expectedVersion)) {
      const current = getKey(db, ns, key);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        return jsonError(
          `Version mismatch: expected ${expectedVersion}, current is ${currentVersion}`,
          "PRECONDITION_FAILED",
          412
        );
      }
    }
  }

  // Perform upsert
  const entry = upsertKey(db, ns, key, value, agentId, { ttl, tags });

  // Dispatch watch notifications after successful write
  dispatchWatchNotifications(db, ns, key, value, entry.version, agentId);

  return json({
    ns: entry.ns,
    key: entry.key,
    version: entry.version,
    updated_at: entry.updated_at,
  });
}

// ---------------------------------------------------------------------------
// GET /memory/:ns/:key — Read a key
// ---------------------------------------------------------------------------

export function handleGetKey(
  _req: Request,
  agentId: string,
  db: Database,
  ns: string,
  key: string
): Response {
  if (!canRead(ns, agentId)) {
    return jsonError(
      `Agent '${agentId}' does not have read access to namespace '${ns}'`,
      "FORBIDDEN",
      403
    );
  }

  const entry = getKey(db, ns, key);
  if (!entry) {
    return jsonError(`Key '${key}' not found in namespace '${ns}'`, "NOT_FOUND", 404);
  }

  return json(serializeEntry(entry));
}

// ---------------------------------------------------------------------------
// DELETE /memory/:ns/:key — Delete a key
// ---------------------------------------------------------------------------

export function handleDeleteKey(
  _req: Request,
  agentId: string,
  db: Database,
  ns: string,
  key: string
): Response {
  if (!canWrite(ns, agentId)) {
    return jsonError(
      `Agent '${agentId}' does not have write access to namespace '${ns}'`,
      "FORBIDDEN",
      403
    );
  }

  const deleted = deleteKey(db, ns, key, agentId);
  if (!deleted) {
    return jsonError(`Key '${key}' not found in namespace '${ns}'`, "NOT_FOUND", 404);
  }

  return json({ ok: true, ns, key });
}

// ---------------------------------------------------------------------------
// GET /memory/:ns — List keys in namespace
// ---------------------------------------------------------------------------

export function handleListKeys(
  req: Request,
  agentId: string,
  db: Database,
  ns: string
): Response {
  if (!canRead(ns, agentId)) {
    return jsonError(
      `Agent '${agentId}' does not have read access to namespace '${ns}'`,
      "FORBIDDEN",
      403
    );
  }

  const url = new URL(req.url);
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const entries = listKeys(db, ns, { prefix, tag, limit, offset });

  return json({
    keys: entries.map(serializeEntry),
    count: entries.length,
    limit,
    offset,
  });
}

// ---------------------------------------------------------------------------
// POST /memory/:ns — Bulk write
// ---------------------------------------------------------------------------

export async function handleBulkWrite(
  req: Request,
  agentId: string,
  db: Database,
  ns: string
): Promise<Response> {
  if (!canWrite(ns, agentId)) {
    return jsonError(
      `Agent '${agentId}' does not have write access to namespace '${ns}'`,
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

  if (!Array.isArray(body.entries)) {
    return jsonError("Field 'entries' must be an array", "BAD_REQUEST", 400);
  }

  const entries = body.entries as unknown[];

  // Enforce bulk write entry limit
  const MAX_BULK_ENTRIES = 500;
  if (entries.length > MAX_BULK_ENTRIES) {
    return jsonError(
      `Too many entries: ${entries.length} (max ${MAX_BULK_ENTRIES})`,
      "PAYLOAD_TOO_LARGE",
      413
    );
  }

  // Validate each entry
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") {
      return jsonError(`entries[${i}] must be an object`, "BAD_REQUEST", 400);
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.key !== "string" || e.key.length === 0) {
      return jsonError(`entries[${i}].key must be a non-empty string`, "BAD_REQUEST", 400);
    }

    if (!("value" in e)) {
      return jsonError(`entries[${i}].value is required`, "BAD_REQUEST", 400);
    }

    const valueStr = JSON.stringify(e.value);
    if (valueStr.length > MAX_VALUE_BYTES) {
      return jsonError(
        `entries[${i}].value too large: ${valueStr.length} bytes (max ${MAX_VALUE_BYTES})`,
        "PAYLOAD_TOO_LARGE",
        413
      );
    }
  }

  const bulkEntries = (entries as Record<string, unknown>[]).map((e) => ({
    key: e.key as string,
    value: e.value,
    ttl: typeof e.ttl === "number" ? Math.floor(e.ttl) : undefined,
    tags: Array.isArray(e.tags)
      ? (e.tags as unknown[]).filter((t) => typeof t === "string") as string[]
      : undefined,
  }));

  const result = bulkWrite(db, ns, bulkEntries, agentId);

  // Dispatch watch notifications for each written entry
  for (const entry of bulkEntries) {
    const stored = getKey(db, ns, entry.key);
    if (stored) {
      dispatchWatchNotifications(db, ns, entry.key, entry.value, stored.version, agentId);
    }
  }

  return json({ written: result.written });
}

// ---------------------------------------------------------------------------
// GET /memory/snapshot — Full mesh namespace dump
// ---------------------------------------------------------------------------

export function handleSnapshot(
  _req: Request,
  _agentId: string,
  db: Database
): Response {
  const snapshot = getSnapshot(db, "mesh");
  return json(snapshot);
}
