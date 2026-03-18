/**
 * utils/env.ts — Shared environment loading for MCS
 *
 * Parses ~/.claude/.env (KEY=VALUE format, ignores comments/blanks).
 * All MCS modules should import from here instead of duplicating the loader.
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Core env parser
// ---------------------------------------------------------------------------

export function loadEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      // Strip optional surrounding quotes from value
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    // File may not exist; fall through to process.env
  }
  return env;
}

// ---------------------------------------------------------------------------
// Singleton: load ~/.claude/.env once at import time
// ---------------------------------------------------------------------------

const ENV_FILE = join(process.env.HOME ?? "/root", ".claude", ".env");
const FILE_ENV = loadEnvFile(ENV_FILE);

/**
 * Get an environment variable, checking process.env first, then ~/.claude/.env.
 */
export function getEnv(key: string): string | undefined {
  return process.env[key] ?? FILE_ENV[key];
}
