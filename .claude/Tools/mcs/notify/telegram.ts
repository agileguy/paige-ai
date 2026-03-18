/**
 * notify/telegram.ts — Telegram notification helpers for MCS
 *
 * Used to alert the AI Mesh group when tasks permanently fail.
 * All functions are fire-and-forget — they never throw.
 */

import { getEnv } from "../utils/env.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAISLEY_BOT_TOKEN = getEnv("PAISLEY_BOT_TOKEN") ?? "";
const MESH_GROUP_CHAT_ID = getEnv("MESH_GROUP_CHAT_ID") ?? "-5229443138";
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${PAISLEY_BOT_TOKEN}`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to a Telegram chat. Fire-and-forget, never throws.
 */
async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage failed HTTP ${res.status}: ${body}`);
    } else {
      console.error(`[telegram] sendMessage OK to chat ${chatId}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] sendMessage error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * notifyPermanentFailure — Send alert to AI Mesh group when a task permanently fails.
 *
 * Posts to the AI Mesh Telegram group using the Paisley bot. Fire-and-forget.
 *
 * Message format:
 *   ⚠️ Task permanently failed
 *   Type: {taskType}
 *   ID: {taskId}
 *   Created by: {createdBy}
 *   Attempts: {attempt}/{maxRetries}
 *   Error: {lastError}
 *   🏴󠁧󠁢󠁳󠁣󠁴󠁿
 */
export async function notifyPermanentFailure(
  taskId: string,
  taskType: string,
  createdBy: string,
  attempt: number,
  maxRetries: number,
  lastError: string
): Promise<void> {
  const message = [
    "⚠️ Task permanently failed",
    `Type: \`${taskType}\``,
    `ID: \`${taskId}\``,
    `Created by: \`${createdBy}\``,
    `Attempts: ${attempt}/${maxRetries}`,
    `Error: ${lastError}`,
    "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  ].join("\n");

  // Fire and forget — do NOT await at call site
  sendTelegramMessage(MESH_GROUP_CHAT_ID, message).catch(() => {});
}
