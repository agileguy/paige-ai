/**
 * capability-matcher.ts — Capability matching and agent scoring for MCS dispatcher
 *
 * Extracted from dispatcher.ts (Phase 1B) and extended with scoring logic for
 * Phase 2 capability routing. This module is pure (no DB dependencies) and
 * fully unit-testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed, scoreable agent record — capabilities already decoded from JSON.
 */
export interface ScoredAgent {
  agent_id: string;
  capabilities: string[];
  current_load: number;
  registered_at: string; // ISO datetime string from SQLite
}

// ---------------------------------------------------------------------------
// isCapable
// ---------------------------------------------------------------------------

/**
 * Returns true if the agent's capabilities include ALL of the required caps.
 *
 * Empty requiredCaps means "no requirement" — any agent qualifies.
 * Empty agentCaps with non-empty requiredCaps means "cannot handle" → false.
 */
export function isCapable(agentCaps: string[], requiredCaps: string[]): boolean {
  if (requiredCaps.length === 0) return true;
  if (agentCaps.length === 0) return false;

  const capSet = new Set(agentCaps);
  return requiredCaps.every((cap) => capSet.has(cap));
}

// ---------------------------------------------------------------------------
// scoreAgent
// ---------------------------------------------------------------------------

/**
 * Scores an agent for a given task's required capabilities.
 *
 * Lower score = better match. Scoring criteria (in priority order):
 *   1. current_load × 10  — primary factor (lower load preferred)
 *   2. excess capabilities  — number of agent caps NOT required by task (fewer excess = tighter fit)
 *   3. registration recency — newer agents get slight preference for tie-breaking
 *      (implemented as a sub-unit fraction: 1 / (date_numeric + 1))
 *
 * Returns Infinity if the agent cannot handle the task (capability mismatch).
 */
export function scoreAgent(agent: ScoredAgent, requiredCaps: string[]): number {
  if (!isCapable(agent.capabilities, requiredCaps)) return Infinity;

  // Component 1: load penalty (dominant factor)
  const loadScore = agent.current_load * 10;

  // Component 2: excess capabilities (agent has more caps than needed)
  const requiredSet = new Set(requiredCaps);
  const excessCaps = agent.capabilities.filter((cap) => !requiredSet.has(cap)).length;

  // Component 3: freshness bonus — newer registration = lower sub-score
  // Convert ISO datetime to epoch ms; more recent = larger number = we want to PREFER these,
  // so we invert: subtract a tiny fraction from the score for newer agents.
  // Use 1 / (epochMs + 1) so the range is (0, very small] — acts purely as tie-breaker.
  const epochMs = new Date(agent.registered_at).getTime();
  const freshnessBonus = isNaN(epochMs) ? 0 : 1 / (epochMs + 1);

  return loadScore + excessCaps - freshnessBonus;
}

// ---------------------------------------------------------------------------
// findBestAgent
// ---------------------------------------------------------------------------

/**
 * Given a list of active agents and task requirements, returns the best-matching agent.
 *
 * Routing hint semantics:
 *   - "any"          → all agents are scored; best (lowest score) is returned
 *   - "all"          → fanout mode; returns null (fanout handled by caller)
 *   - <agent_id>     → only that specific agent is considered
 *
 * Returns null if:
 *   - routingHint is "all"
 *   - no capable agent exists in the candidate pool
 */
export function findBestAgent(
  agents: ScoredAgent[],
  requiredCaps: string[],
  routingHint: string
): ScoredAgent | null {
  // "all" means fanout — caller handles it
  if (routingHint === "all") return null;

  // Narrow candidate pool for a specific agent
  const candidates =
    routingHint === "any"
      ? agents
      : agents.filter((a) => a.agent_id === routingHint);

  // Score all candidates
  let best: ScoredAgent | null = null;
  let bestScore = Infinity;

  for (const agent of candidates) {
    const score = scoreAgent(agent, requiredCaps);
    if (score < bestScore) {
      bestScore = score;
      best = agent;
    }
  }

  return best;
}
