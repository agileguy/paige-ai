#!/usr/bin/env bun
/**
 * upload-payload.ts — Upload a file to the mcs-payloads GitHub repo
 * and return the raw URL for use in MCS task payloads.
 *
 * Usage:
 *   bun run upload-payload.ts <file-path> [--name <custom-name>]
 *
 * Returns the raw GitHub URL to stdout.
 *
 * Example:
 *   URL=$(bun run upload-payload.ts /tmp/rally-cli-source.txt --name rally-cli)
 *   # URL = https://raw.githubusercontent.com/agileguy/mcs-payloads/main/payloads/2026-03-01-rally-cli.txt
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { basename, join, extname } from "path";

const REPO_DIR = join(process.env.HOME ?? "/Users/de895996", "repos", "mcs-payloads");
const PAYLOADS_DIR = join(REPO_DIR, "payloads");
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/agileguy/mcs-payloads/main/payloads";

function usage() {
  console.error("Usage: bun run upload-payload.ts <file-path> [--name <custom-name>]");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  let filePath = "";
  let customName = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      customName = args[++i];
    } else if (!filePath) {
      filePath = args[i];
    }
  }

  if (!filePath || !existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  if (!existsSync(REPO_DIR)) {
    console.error(`Error: mcs-payloads repo not found at ${REPO_DIR}`);
    console.error("Clone it: gh repo clone agileguy/mcs-payloads ~/repos/mcs-payloads");
    process.exit(1);
  }

  // Generate filename: YYYY-MM-DD-<name>.<ext>
  const date = new Date().toISOString().slice(0, 10);
  const ext = extname(filePath) || ".txt";
  const name = customName || basename(filePath, ext);
  const destName = `${date}-${name}${ext}`;
  const destPath = join(PAYLOADS_DIR, destName);

  // Copy file to payloads dir
  copyFileSync(filePath, destPath);

  // Git add, commit, push
  try {
    execSync(`cd "${REPO_DIR}" && git add "payloads/${destName}" && git commit -m "Add payload: ${destName}" && git push origin main`, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    // If commit fails (no changes), that's fine
    if (!err.stderr?.includes("nothing to commit")) {
      console.error(`Git error: ${err.stderr || err.message}`);
      process.exit(1);
    }
  }

  const rawUrl = `${GITHUB_RAW_BASE}/${destName}`;
  console.log(rawUrl);
}

main();
