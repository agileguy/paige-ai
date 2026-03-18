#!/usr/bin/env bun

/**
 * UploadFile - Upload non-image files to Ghost CMS
 *
 * Ghost's built-in media endpoint only supports images. This tool uses the
 * Ghost Admin API /files/upload/ endpoint to upload arbitrary files (HTML,
 * PDF, ZIP, etc.) and returns the Ghost-hosted URL.
 *
 * Usage:
 *   bun run UploadFile.ts <file1> [file2] [file3] ...
 *
 * Environment:
 *   Reads GHOST_URL and GHOST_ADMIN_API_KEY from ~/.claude/.env
 *
 * Output:
 *   filename.html: https://www.agileguy.ca/content/files/YYYY/MM/filename.html
 */

import * as jose from "jose";
import { readFile } from "node:fs/promises";
import { basename, resolve, extname } from "node:path";

// ============================================================================
// Configuration
// ============================================================================

const ENV_PATH = resolve(process.env.HOME!, ".claude/.env");

// MIME type mapping for common file types
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".md": "text/markdown",
  ".svg": "image/svg+xml",
};

// ============================================================================
// Environment Loading
// ============================================================================

async function loadEnvVar(key: string): Promise<string> {
  const content = await readFile(ENV_PATH, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(`${key}=`)) continue;
    const eqIndex = trimmed.indexOf("=");
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  throw new Error(`${key} not found in ${ENV_PATH}`);
}

// ============================================================================
// Ghost JWT Auth
// ============================================================================

async function generateGhostToken(adminKey: string): Promise<string> {
  const [id, secret] = adminKey.split(":");
  if (!id || !secret) {
    throw new Error("Invalid GHOST_ADMIN_API_KEY format. Expected id:secret");
  }

  const keyBuf = Buffer.from(secret, "hex");
  const secretKey = await jose.importJWK(
    { kty: "oct", k: Buffer.from(keyBuf).toString("base64url") },
    "HS256"
  );

  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: id, typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setAudience("/admin/")
    .sign(secretKey);
}

// ============================================================================
// File Upload
// ============================================================================

async function uploadFile(
  ghostUrl: string,
  token: string,
  filePath: string
): Promise<string> {
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";
  const fileContent = await readFile(filePath);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileContent], { type: mimeType }),
    fileName
  );

  const resp = await fetch(`${ghostUrl}/ghost/api/admin/files/upload/`, {
    method: "POST",
    headers: { Authorization: `Ghost ${token}` },
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upload failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { url?: string; files?: { url: string }[] };
  const url = data.url || data.files?.[0]?.url;
  if (!url) {
    throw new Error(`Upload succeeded but no URL in response: ${JSON.stringify(data)}`);
  }
  return url;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error("Usage: bun run UploadFile.ts <file1> [file2] ...");
    console.error("Uploads non-image files to Ghost CMS via Admin API.");
    process.exit(1);
  }

  // Load config
  const ghostUrl = await loadEnvVar("GHOST_URL");
  const adminKey = await loadEnvVar("GHOST_ADMIN_API_KEY");
  const token = await generateGhostToken(adminKey);

  // Upload each file
  let hasError = false;
  for (const filePath of files) {
    try {
      const url = await uploadFile(ghostUrl, token, filePath);
      console.log(`${basename(filePath)}: ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`ERROR ${basename(filePath)}: ${msg}`);
      hasError = true;
    }
  }

  if (hasError) process.exit(1);
}

main();
