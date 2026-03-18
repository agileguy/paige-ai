/**
 * capability-matcher.test.ts — Unit tests for Phase 2 capability routing
 *
 * Covers isCapable, scoreAgent, and findBestAgent.
 */

import { describe, test, expect } from "bun:test";
import { isCapable, scoreAgent, findBestAgent, type ScoredAgent } from "./capability-matcher.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ScoredAgent for test purposes.
 */
function makeAgent(
  agent_id: string,
  capabilities: string[],
  current_load = 0,
  registered_at = "2024-01-01 00:00:00"
): ScoredAgent {
  return { agent_id, capabilities, current_load, registered_at };
}

// ---------------------------------------------------------------------------
// isCapable
// ---------------------------------------------------------------------------

describe("isCapable", () => {
  // Test 1: agent has required cap (subset match)
  test("agent with [camera, web-search] meets [camera] → true", () => {
    expect(isCapable(["camera", "web-search"], ["camera"])).toBe(true);
  });

  // Test 2: agent is missing a required cap
  test("agent with [web-search] does NOT meet [camera] → false", () => {
    expect(isCapable(["web-search"], ["camera"])).toBe(false);
  });

  // Test 3: empty caps_required matches any agent
  test("empty required caps always returns true", () => {
    expect(isCapable([], [])).toBe(true);
    expect(isCapable(["anything"], [])).toBe(true);
  });

  // Test 4: empty agent caps fails non-empty requirement
  test("empty agent caps cannot satisfy any requirement", () => {
    expect(isCapable([], ["camera"])).toBe(false);
    expect(isCapable([], ["a", "b", "c"])).toBe(false);
  });

  // Test 5: exact match (agent has exactly the required caps)
  test("agent has exactly the required caps → true", () => {
    expect(isCapable(["coding", "bash"], ["coding", "bash"])).toBe(true);
  });

  // Test 6: agent has superset of required caps
  test("agent has superset of required caps → true", () => {
    expect(isCapable(["coding", "bash", "web-search"], ["coding"])).toBe(true);
  });

  // Test 7: missing one of multiple required caps
  test("missing one cap from multi-cap requirement → false", () => {
    expect(isCapable(["coding"], ["coding", "bash"])).toBe(false);
  });

  // Test 8: order independence — required order doesn't matter
  test("cap matching is order-independent", () => {
    expect(isCapable(["bash", "coding"], ["coding", "bash"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scoreAgent
// ---------------------------------------------------------------------------

describe("scoreAgent", () => {
  // Test 9: incapable agent returns Infinity
  test("incapable agent returns Infinity", () => {
    const agent = makeAgent("a", ["web-search"]);
    expect(scoreAgent(agent, ["camera"])).toBe(Infinity);
  });

  // Test 10: agent with zero load scores lower than agent with high load
  test("lower load = lower score", () => {
    const idle = makeAgent("idle", ["coding"], 0);
    const busy = makeAgent("busy", ["coding"], 5);

    const idleScore = scoreAgent(idle, ["coding"]);
    const busyScore = scoreAgent(busy, ["coding"]);

    expect(idleScore).toBeLessThan(busyScore);
  });

  // Test 11: fewer excess capabilities = lower score (tighter fit preferred)
  test("fewer excess capabilities = lower score", () => {
    const tightFit = makeAgent("tight", ["coding"], 0);
    const looseFit = makeAgent("loose", ["coding", "bash", "web-search", "camera"], 0);

    const tightScore = scoreAgent(tightFit, ["coding"]);
    const looseScore = scoreAgent(looseFit, ["coding"]);

    expect(tightScore).toBeLessThan(looseScore);
  });

  // Test 12: no excess caps when agent matches exactly (excess = 0)
  test("exact capability match has zero excess", () => {
    const exact = makeAgent("exact", ["coding", "bash"], 0);
    // Score = (0 * 10) + 0 - freshness = tiny negative from freshness
    const score = scoreAgent(exact, ["coding", "bash"]);
    // Should be very close to 0 (just a small negative freshness bonus)
    expect(score).toBeLessThan(1);
    expect(score).not.toBe(Infinity);
  });

  // Test 13: load dominates excess caps (10 per load unit vs 1 per excess)
  test("load penalty (×10) dominates excess cap penalty (×1)", () => {
    // 1 unit of load (score += 10) should outweigh 5 excess caps (score += 5)
    const heavyLoad = makeAgent("heavy", ["coding"], 1); // load 1
    const manyExcess = makeAgent("excess", ["coding", "a", "b", "c", "d", "e"], 0); // 5 excess

    const heavyScore = scoreAgent(heavyLoad, ["coding"]);
    const excessScore = scoreAgent(manyExcess, ["coding"]);

    // heavy: 10 + 0 = 10
    // excess: 0 + 5 = 5
    expect(heavyScore).toBeGreaterThan(excessScore);
  });
});

// ---------------------------------------------------------------------------
// findBestAgent
// ---------------------------------------------------------------------------

describe("findBestAgent", () => {
  // Test 14: routing_hint "all" always returns null
  test('routing_hint "all" returns null', () => {
    const agents = [makeAgent("a", ["coding"])];
    expect(findBestAgent(agents, ["coding"], "all")).toBeNull();
  });

  // Test 15: no capable agents returns null
  test("no capable agents returns null", () => {
    const agents = [makeAgent("a", ["web-search"])];
    expect(findBestAgent(agents, ["camera"], "any")).toBeNull();
  });

  // Test 16: empty agent list returns null
  test("empty agent list returns null", () => {
    expect(findBestAgent([], ["coding"], "any")).toBeNull();
  });

  // Test 17: routing_hint specific agent — only that agent considered
  test("routing_hint specific agent ID limits consideration to that agent", () => {
    const agents = [
      makeAgent("ocasia", ["coding", "web-search"], 0),
      makeAgent("rex", ["coding"], 5), // high load
    ];
    // Even though ocasia has lower load, routing_hint = "rex" should pick rex
    const result = findBestAgent(agents, ["coding"], "rex");
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("rex");
  });

  // Test 18: routing_hint specific agent — returns null if that agent is incapable
  test("routing_hint specific agent returns null if agent lacks required caps", () => {
    const agents = [
      makeAgent("ocasia", ["coding"], 0),
      makeAgent("rex", ["web-search"], 0),
    ];
    const result = findBestAgent(agents, ["coding"], "rex");
    expect(result).toBeNull();
  });

  // Test 19: selects lowest-scored (best) agent
  test("selects the agent with the lowest score", () => {
    const agents = [
      makeAgent("busy", ["coding"], 5),
      makeAgent("idle", ["coding"], 0),
    ];
    const result = findBestAgent(agents, ["coding"], "any");
    expect(result!.agent_id).toBe("idle");
  });

  // Test 20: among 3 agents, picks the one with the best score
  test("among 3 agents picks the one with best (lowest) score", () => {
    const agents = [
      makeAgent("heavy", ["coding", "bash", "web-search"], 3), // load:30 + excess:2 = 32
      makeAgent("medium", ["coding", "bash"], 1),              // load:10 + excess:1 = 11
      makeAgent("light", ["coding"], 0),                        // load:0 + excess:0 = ~0
    ];
    const result = findBestAgent(agents, ["coding"], "any");
    expect(result!.agent_id).toBe("light");
  });

  // Test 21: routing_hint "any" with a single capable agent returns that agent
  test('routing_hint "any" with single capable agent returns it', () => {
    const agents = [makeAgent("solo", ["camera"])];
    const result = findBestAgent(agents, ["camera"], "any");
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("solo");
  });

  // Test 22: tie on load — prefers agent with fewer excess capabilities
  test("when load is tied, prefers agent with fewer excess caps", () => {
    const agents = [
      makeAgent("minimal", ["coding"], 0),               // excess: 0
      makeAgent("overqualified", ["coding", "bash", "camera", "web-search"], 0), // excess: 3
    ];
    const result = findBestAgent(agents, ["coding"], "any");
    expect(result!.agent_id).toBe("minimal");
  });

  // Test 23: routing_hint non-existent agent returns null
  test("routing_hint for non-existent agent returns null", () => {
    const agents = [makeAgent("ocasia", ["coding"], 0)];
    const result = findBestAgent(agents, [], "molly");
    expect(result).toBeNull();
  });

  // Test 24: empty requiredCaps matches any agent (most capable gets picked)
  test("empty required caps — any agent qualifies", () => {
    const agents = [
      makeAgent("a", ["coding"], 2),
      makeAgent("b", ["web-search"], 0),
    ];
    const result = findBestAgent(agents, [], "any");
    // Both capable — 'b' has lower load, wins
    expect(result!.agent_id).toBe("b");
  });
});
