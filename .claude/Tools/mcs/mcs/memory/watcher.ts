/**
 * memory/watcher.ts — Watch dispatch system for MCS
 *
 * After every memory write, dispatchWatchNotifications finds matching
 * active watch subscriptions and POSTs change events to their notify_url.
 * Notifications are retried up to 3 times with 5-second intervals on failure.
 * All notification work is asynchronous and does not block the write response.
 */

import type { Database } from "bun:sqlite";
import type { MemoryChangeEvent } from "../types.ts";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WatchRow {
  watch_id: string;
  agent_id: string;
  notify_url: string;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * notifyWithRetry — POST payload to url, retrying up to maxRetries times.
 *
 * Retries on:
 *   - Network / connection errors (fetch throws)
 *   - HTTP 5xx responses
 *   - Request timeout (5s)
 *
 * Returns true if a delivery succeeded, false after exhausting all attempts.
 */
export async function notifyWithRetry(
  url: string,
  payload: unknown,
  maxRetries: number = 3,
  intervalMs: number = 5000
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        console.error(
          `[watcher] POST ${url} OK (${res.status}) on attempt ${attempt}`
        );
        return true;
      }

      // 5xx — retryable server-side failure
      if (res.status >= 500) {
        console.error(
          `[watcher] POST ${url} HTTP ${res.status} on attempt ${attempt}/${maxRetries} — ${attempt < maxRetries ? "retrying" : "giving up"}`
        );
      } else {
        // 4xx — non-retryable client error; no point retrying
        console.error(
          `[watcher] POST ${url} HTTP ${res.status} (non-retryable) — dropping notification`
        );
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[watcher] POST ${url} failed on attempt ${attempt}/${maxRetries}: ${msg}${attempt < maxRetries ? " — retrying" : " — giving up"}`
      );
    }

    // Wait before next attempt (except after the final one)
    if (attempt < maxRetries) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Watch query
// ---------------------------------------------------------------------------

/**
 * findMatchingWatches — query active watches for a given namespace + key.
 *
 * Matches watches where:
 *   - ns matches exactly
 *   - prefix is '' (match all keys in ns) OR key starts with prefix
 *   - watch has not expired
 */
function findMatchingWatches(
  db: Database,
  ns: string,
  key: string
): WatchRow[] {
  const stmt = db.prepare<WatchRow, [string, string]>(`
    SELECT watch_id, agent_id, notify_url
    FROM watches
    WHERE ns = ?
      AND (prefix = '' OR ? LIKE prefix || '%')
      AND expires_at > datetime('now')
  `);
  return stmt.all(ns, key);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * dispatchWatchNotifications — fire-and-forget watch notification dispatch.
 *
 * Called after every successful memory write. Queries all matching active
 * watches, then sends change event notifications asynchronously with retry.
 *
 * Never throws. Never blocks the caller.
 */
export function dispatchWatchNotifications(
  db: Database,
  ns: string,
  key: string,
  value: unknown,
  version: number,
  updatedBy: string
): void {
  // Run asynchronously — do not block the write response
  (async () => {
    let watches: WatchRow[];
    try {
      watches = findMatchingWatches(db, ns, key);
    } catch (err) {
      console.error(`[watcher] Failed to query watches for ${ns}/${key}:`, err);
      return;
    }

    if (watches.length === 0) return;

    const event: MemoryChangeEvent = {
      event: "memory_changed",
      ns,
      key,
      value,
      version,
      updated_by: updatedBy,
      timestamp: new Date().toISOString(),
    };

    const promises = watches.map(async (watch) => {
      const ok = await notifyWithRetry(watch.notify_url, event);
      if (!ok) {
        console.error(
          `[watcher] Notification to ${watch.notify_url} for watch ${watch.watch_id} (agent: ${watch.agent_id}) dropped after max retries`
        );
      }
    });

    // Await all in parallel; individual failures are already logged inside notifyWithRetry
    await Promise.allSettled(promises);
  })().catch((err) => {
    console.error("[watcher] Unexpected error in dispatch:", err);
  });
}
