/**
 * memory/permissions.ts — Namespace permission checks for the MCS memory store
 *
 * Namespace permission matrix:
 *
 *   mesh           → All agents can READ and WRITE
 *   agent:<name>   → Only <name> can WRITE; ALL agents can READ
 *   private:<name> → Only <name> can READ and WRITE
 *
 * Any other namespace format is treated as DENY (both read and write).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NamespaceType = "mesh" | "agent" | "private" | "unknown";

export interface ParsedNamespace {
  type: NamespaceType;
  owner?: string; // Set for "agent" and "private" types
}

// ---------------------------------------------------------------------------
// parseNamespace
// ---------------------------------------------------------------------------

/**
 * Parse a namespace string into its type and optional owner.
 *
 * Examples:
 *   "mesh"          → { type: "mesh" }
 *   "agent:ocasia"  → { type: "agent", owner: "ocasia" }
 *   "private:rex"   → { type: "private", owner: "rex" }
 *   "random"        → { type: "unknown" }
 */
export function parseNamespace(ns: string): ParsedNamespace {
  if (ns === "mesh") {
    return { type: "mesh" };
  }

  if (ns.startsWith("agent:")) {
    const owner = ns.slice("agent:".length);
    if (owner.length > 0) {
      return { type: "agent", owner };
    }
    return { type: "unknown" };
  }

  if (ns.startsWith("private:")) {
    const owner = ns.slice("private:".length);
    if (owner.length > 0) {
      return { type: "private", owner };
    }
    return { type: "unknown" };
  }

  return { type: "unknown" };
}

// ---------------------------------------------------------------------------
// canWrite
// ---------------------------------------------------------------------------

/**
 * Determine if agentId has write access to the given namespace.
 *
 * - mesh           → any agent can write
 * - agent:<name>   → only <name> can write
 * - private:<name> → only <name> can write
 * - unknown        → nobody can write
 */
export function canWrite(ns: string, agentId: string): boolean {
  const parsed = parseNamespace(ns);

  switch (parsed.type) {
    case "mesh":
      return true;

    case "agent":
      return parsed.owner === agentId;

    case "private":
      return parsed.owner === agentId;

    case "unknown":
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// canRead
// ---------------------------------------------------------------------------

/**
 * Determine if agentId has read access to the given namespace.
 *
 * - mesh           → any agent can read
 * - agent:<name>   → any agent can read (published namespace)
 * - private:<name> → only <name> can read
 * - unknown        → nobody can read
 */
export function canRead(ns: string, agentId: string): boolean {
  const parsed = parseNamespace(ns);

  switch (parsed.type) {
    case "mesh":
      return true;

    case "agent":
      // Published namespace — all agents can read
      return true;

    case "private":
      return parsed.owner === agentId;

    case "unknown":
    default:
      return false;
  }
}
