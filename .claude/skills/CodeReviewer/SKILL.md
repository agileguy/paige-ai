---
name: CodeReviewer
description: Parallel code review using local agents (Gemini, Claude) + all available MCS agents with mcs-review capability. USE WHEN user says "review code", "review this PR", "code review", "review my changes", OR wants feedback on code quality, security, or best practices.
---

# CodeReviewer

Multi-perspective code review using 2 local agents (Gemini, Claude) + all available MCS agents that have the `mcs-review` capability.

## Workflow Routing

**When executing a workflow, do BOTH of these:**

1. **Call the notification script** (for observability tracking):
   ```bash
   ~/.claude/Tools/SkillWorkflowNotification Review CodeReviewer
   ```

2. **Output the text notification** (for user visibility):
   ```
   Running the **Review** workflow from the **CodeReviewer** skill...
   ```

| Workflow | Trigger | File |
|----------|---------|------|
| **Review** | "review code", "review PR", "code review" | `workflows/Review.md` |

## Examples

**Example 1: Review a GitHub PR**
```
User: "Review this PR: https://github.com/org/repo/pull/123"
→ Invokes Review workflow
→ Fetches PR diff using gh CLI
→ Launches parallel agents (Gemini + Claude + all MCS agents with mcs-review cap)
→ Each agent reviews independently
→ Synthesizes into comprehensive review report
```

**Example 2: Review local changes**
```
User: "Review the code in /path/to/repo"
→ Invokes Review workflow
→ Reads staged/unstaged changes or recent commits
→ Launches parallel agents (local + MCS)
→ Provides security, performance, and best practices feedback
```

**Example 3: Review specific files**
```
User: "Review src/api/auth.py for security issues"
→ Invokes Review workflow
→ Focuses on security aspects
→ 4 parallel agents analyze from different perspectives
→ Consolidated security assessment
```

## Review Dimensions

Each reviewer agent evaluates code across these dimensions:

| Dimension | Focus Areas |
|-----------|-------------|
| **Correctness** | Bugs, logic errors, race conditions, edge cases |
| **Security** | Injection attacks, auth issues, data exposure, OWASP Top 10 |
| **Performance** | Optimization opportunities, memory usage, algorithmic complexity |
| **Readability** | Clean code, documentation, naming, structure |
| **Best Practices** | Design patterns, idioms, language conventions |
| **Error Handling** | Graceful failures, validation, edge cases |

## Enforced Review Rules

### From CLAUDE.md (Always Enforced)

1. **NO AI ATTRIBUTION** - Never suggest adding AI/Claude attribution to commits or PRs
2. **Broadcom Repos** - No AI references in github.gwd.broadcom.net repos
3. **AppNeta Repos** - No AI references in github.com/appneta repos
4. **Git Identity** - Use correct identity per repo (de895996 for Broadcom, dan-elliott-appneta for AppNeta)

### Code Quality Standards

1. **Avoid over-engineering** - Flag unnecessary abstractions or premature optimization
2. **Security first** - Prioritize OWASP Top 10, injection prevention, auth issues
3. **Test coverage** - Note missing tests for critical paths
4. **Error handling** - Validate at system boundaries, handle edge cases
5. **Performance** - Flag N+1 queries, memory leaks, blocking operations

## Agent Configuration

### Local Agents (Task tool — run in Paisley's process)

| Agent | Model | Strengths |
|-------|-------|-----------|
| **gemini-researcher** | Gemini (Google) | Broad context, cross-file analysis, alternative perspectives |
| **claude-researcher** | Claude (Anthropic) | Deep code analysis, security patterns, architectural insights |

### MCS Agents (OpenClaw — run on remote hosts via MCS task queue)

MCS agents are **not hardcoded**. Any agent that registers the `mcs-review` capability can receive review tasks. The dispatcher uses capability-based routing to fan out tasks to all capable agents automatically.

Currently registered agents with `mcs-review` capability may include Ocasia, Rex, Phil, Molly, or any future agents — the skill does not need to know which specific agents are available.

Each OpenClaw agent uses its own configured LLM model (not Claude). They run on their respective hosts and process tasks independently.

All agents (local + MCS) receive the same code context and review independently, then results are synthesized for comprehensive coverage.

### OpenClaw Agent Distribution

OpenClaw agents receive code review tasks via the **MCS (Mesh Coordination Server)** task queue using **capability-based fanout**:

```bash
# Fanout to ALL agents with mcs-review capability (preferred):
bun run ~/.claude/Tools/mcs/client/mcs-client.ts task submit \
  --type mcs-review --route all --caps mcs-review --payload-file /tmp/review-payload.json
```

MCS discovers all agents with the `mcs-review` capability, creates a child task for each, pushes notifications, and they post results back. Paisley polls the parent task for completion — it resolves when all children complete.
