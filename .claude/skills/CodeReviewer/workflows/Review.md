# Code Review Workflow

**Multi-perspective code review using 2 local agents (Gemini, Claude) + all available MCS agents with the `mcs-review` capability.**

## Input Types

This workflow supports three input types:

### 1. GitHub PR URL
```
User: "Review https://github.com/org/repo/pull/123"
```
→ Use `gh pr diff 123` to get the diff
→ Use `gh pr view 123` to get PR context

### 2. Local Repository Path
```
User: "Review the code in /path/to/repo"
```
→ Use `git diff` for unstaged changes
→ Use `git diff --staged` for staged changes
→ Use `git log -p -5` for recent commits

### 3. Specific Files
```
User: "Review src/api/auth.py"
```
→ Read the specified file(s)
→ Focus review on those files

---

## Workflow Steps

### Step 1: Gather Code Context

**For PR reviews:**
```bash
# Get PR diff
gh pr diff [PR_NUMBER] --repo [OWNER/REPO]

# Get PR metadata
gh pr view [PR_NUMBER] --repo [OWNER/REPO] --json title,body,files,commits
```

**For local repos:**
```bash
# Get all changes
cd [REPO_PATH]
git diff HEAD
git log --oneline -10
```

**For specific files:**
```bash
# Read the files directly
Read [FILE_PATH]
```

### Step 2: Launch All Review Agents in Parallel

**CRITICAL: Launch ALL agents in a SINGLE message for parallel execution (2 local Task calls + 1 MCS fanout Bash call).**

#### Agents 1-2: Gemini + Claude (Local Task tool)

```typescript
// Launch Gemini and Claude review agents in parallel
Task({
  subagent_type: "gemini-researcher",
  description: "Code review (Gemini perspective) [gemini-reviewer-1]",
  prompt: `You are a Principal Software Engineer performing a comprehensive code review.

## CODE TO REVIEW:
${CODE_DIFF_OR_CONTENT}

## REVIEW FOCUS:
Evaluate the code across these dimensions:

1. **CORRECTNESS**: Bugs, logic errors, race conditions, edge cases
2. **SECURITY**: Injection attacks, auth issues, data exposure, OWASP Top 10
3. **PERFORMANCE**: Optimization opportunities, N+1 queries, memory usage
4. **READABILITY**: Clean code, documentation, naming conventions
5. **BEST PRACTICES**: Design patterns, language idioms, DRY violations
6. **ERROR HANDLING**: Graceful failures, validation, edge cases

## OUTPUT FORMAT:

### Overall Assessment
[1-2 sentence summary of code quality]

### Critical Issues (Must Fix)
[Numbered list of blocking issues]

### Recommendations (Should Fix)
[Numbered list of improvements]

### Observations (Nice to Have)
[Minor suggestions]

### Security Checklist
- [ ] No hardcoded secrets
- [ ] Input validation at boundaries
- [ ] Proper auth/authz checks
- [ ] No SQL/command injection risks
- [ ] Sensitive data handled properly

For each issue, provide:
- **Location**: File and line number if possible
- **Issue**: Clear description
- **Suggestion**: Concrete fix with code example
- **Rationale**: Why this matters

Be thorough but prioritize actionable feedback.`
})

Task({
  subagent_type: "claude-researcher",
  description: "Code review (Claude perspective) [claude-reviewer-1]",
  prompt: `You are a Principal Software Engineer performing a comprehensive code review.

## CODE TO REVIEW:
${CODE_DIFF_OR_CONTENT}

## REVIEW FOCUS:
Evaluate the code across these dimensions:

1. **CORRECTNESS**: Bugs, logic errors, race conditions, edge cases
2. **SECURITY**: Injection attacks, auth issues, data exposure, OWASP Top 10
3. **PERFORMANCE**: Optimization opportunities, N+1 queries, memory usage
4. **READABILITY**: Clean code, documentation, naming conventions
5. **BEST PRACTICES**: Design patterns, language idioms, DRY violations
6. **ERROR HANDLING**: Graceful failures, validation, edge cases

## ADDITIONAL FOCUS:
- Architectural patterns and code organization
- Potential maintenance burden
- Test coverage implications
- Cross-cutting concerns (logging, monitoring, error tracking)

## OUTPUT FORMAT:

### Overall Assessment
[1-2 sentence summary of code quality]

### Critical Issues (Must Fix)
[Numbered list of blocking issues]

### Recommendations (Should Fix)
[Numbered list of improvements]

### Observations (Nice to Have)
[Minor suggestions]

### Architectural Notes
[Any structural or design pattern observations]

For each issue, provide:
- **Location**: File and line number if possible
- **Issue**: Clear description
- **Suggestion**: Concrete fix with code example
- **Rationale**: Why this matters

Be thorough but prioritize actionable feedback.`
})
```

#### Agents 3+: All MCS Agents with `mcs-review` Capability (via MCS Task Queue)

**In the SAME message as the Task calls above**, also launch a Bash call to submit a fanout code review task to MCS.

MCS discovers all registered agents with the `mcs-review` capability, creates a child task for each, pushes notifications, and they post results back independently. The number of MCS reviewers is dynamic — it depends on how many agents are currently registered with the capability.

**Payload Delivery: GitHub mcs-payloads repo (for large codebases)**

Large code reviews (>100KB) exceed shell ARG_MAX limits when passed inline via `--payload`. Use the `mcs-payloads` GitHub repo as shared storage:

```bash
# Step 1: Upload code to mcs-payloads repo (returns raw GitHub URL)
PAYLOAD_URL=$(bun run ~/.claude/Tools/mcs/client/upload-payload.ts /tmp/code-review-payload.txt --name <repo-name>)

# Step 2: Create payload JSON file with the URL reference (avoids ARG_MAX)
jq -n \
  --arg url "$PAYLOAD_URL" \
  --arg prompt "You are a Principal Software Engineer performing a comprehensive code review. Fetch the code from the payload_url. Review for correctness, security (OWASP Top 10), performance, and best practices. CRITICAL OUTPUT FORMAT REQUIREMENT: Your response MUST use markdown ## headers. Structure your output EXACTLY like this: ## Overall Assessment (1-2 sentence summary), ## Critical Issues (Must Fix) (numbered list with ### sub-headers per issue, each with **Location**, **Issue**, **Suggestion** with code, **Rationale**), ## Recommendations (Should Fix) (same format), ## Observations (numbered list), ## Security Checklist (markdown table with Check, Status, Notes columns). Your output will be REJECTED if it does not contain at least one ## header. Be thorough and direct." \
  '{prompt: $prompt, payload_url: $url}' > /tmp/mcs-review-payload.json
```

MCS agents have `gh` CLI authenticated and can fetch payloads via:
- `curl` (public repo — no auth needed)
- `gh api` (private repos — token-based auth)

**Submit fanout task to ALL capable agents (preferred):**

```bash
# Fanout to ALL agents with mcs-review capability
# MCS creates a parent task + one child per capable agent
bun run ~/.claude/Tools/mcs/client/mcs-client.ts task submit \
  --type mcs-review \
  --route all \
  --caps mcs-review \
  --priority normal \
  --payload-file /tmp/mcs-review-payload.json 2>&1
```

The fanout returns a **parent task ID**. Poll the parent — it resolves when all children complete.

**For small payloads (<100KB):** Inline `--payload` still works fine:
```bash
bun run ~/.claude/Tools/mcs/client/mcs-client.ts task submit \
  --type mcs-review --route all --caps mcs-review --priority normal \
  --payload '{"prompt":"Review this function...","code":"def foo(): pass"}'
```

**Collecting Results:**

Poll for task completion (each task returns an ID on submission):

```bash
# Check task status (repeat until completed/failed)
bun run ~/.claude/Tools/mcs/client/mcs-client.ts task status <task-id>

# The result is in the task's output field when status=completed
```

**mcs-payloads repo:** `github.com/agileguy/mcs-payloads` (public)
**Local clone:** `~/repos/mcs-payloads`
**Upload tool:** `~/.claude/Tools/mcs/client/upload-payload.ts`

**MCS CLI reference:** `bun run ~/.claude/Tools/mcs/client/mcs-client.ts`
**MCS URL:** `http://localhost:7701` (via LaunchAgent tunnel `com.pai.mcs-tunnel`) — set `MCS_URL` in `~/.claude/.env`

### Step 3: Wait for ALL Agents to Complete

**CRITICAL: Do NOT synthesize until ALL agents have returned results.**

- All agents work in parallel (2 local + N MCS)
- Typical completion: 30-90 seconds (Task agents), 60-300 seconds (MCS/OpenClaw agents)
- **Poll MCS parent task status every 30-45 seconds** — the parent resolves when all child tasks reach a terminal state (`completed` or `failed`)
- **Wait for Task tool background agents** to complete (you'll be notified automatically)
- If an MCS agent's claim expires and gets retried, keep waiting — MCS handles retry automatically
- Only after ALL agents have a terminal result (completed or failed) should you proceed to Step 4
- If an agent fails (e.g., could not fetch payload), include that in the report but still wait for the others

### Step 4: Synthesize Reviews

Combine all agent reviews into a unified report:

```markdown
## Code Review Summary

### Consensus Issues (3+ Reviewers Agree)
[Issues identified by 3 or more reviewers - HIGHEST PRIORITY]

### Strong Agreement (2 Reviewers Agree)
[Issues identified by exactly 2 reviewers - HIGH PRIORITY]

### Individual Findings

#### Gemini
[Unique insights from Gemini review]

#### Claude
[Unique insights from Claude review]

#### [MCS Agent Name]
[Unique insights from each MCS agent that responded — create one section per agent]

### Prioritized Action Items

#### Critical (Must Fix Before Merge)
1. [Issue] - [Location] - [Rationale] - [Flagged by: Agent1, Agent2, ...]

#### High Priority (Should Fix)
1. [Issue] - [Location] - [Rationale] - [Flagged by: Agent1]

#### Medium Priority (Recommended)
1. [Issue] - [Location] - [Rationale]

#### Low Priority (Consider)
1. [Issue] - [Location] - [Rationale]

### Security Assessment
- Overall Risk Level: [LOW/MEDIUM/HIGH]
- [Security-specific findings]

### Review Metrics
- Reviewers: [N] responded / [T] total (2 local + [M] MCS)
- Agent Names: [List all agents that responded]
- Consensus Rate: [X]% issues agreed upon by 2+ reviewers
- Critical Issues: [N]
- Total Recommendations: [N]
```

---

## Enforced Review Rules

### ALWAYS CHECK FOR:

1. **AI Attribution Violations**
   - Flag any `Co-Authored-By: Claude` or similar
   - Flag any `Generated with Claude Code` footers
   - Flag any AI/LLM references in comments

2. **Repository-Specific Rules**
   - `github.gwd.broadcom.net/*` → No AI references, use de895996 identity
   - `github.com/appneta/*` → No AI references, use dan-elliott-appneta identity

3. **Security Violations**
   - Hardcoded secrets or API keys
   - SQL/command injection vulnerabilities
   - Missing input validation
   - Improper auth/authz
   - Sensitive data logging

4. **Code Quality Issues**
   - Over-engineering or premature abstraction
   - Missing error handling
   - N+1 query patterns
   - Memory leaks or resource cleanup
   - Missing tests for critical paths

---

## Example Execution

**User:** "Review https://github.com/agileguy/penny/pull/1"

**Workflow:**
1. ✅ Fetch PR diff: `gh pr diff 1 --repo agileguy/penny`
2. ✅ Fetch PR context: `gh pr view 1 --repo agileguy/penny --json title,body,files`
3. ✅ Launch all agents in parallel (ONE message: 2 local Task calls + 1 MCS fanout Bash call)
4. ✅ Wait for ALL agents to complete (local + all MCS children)
5. ✅ Synthesize all reviews into unified report
6. ✅ Highlight consensus issues (3+ reviewers = highest confidence)
7. ✅ Provide prioritized action items with reviewer attribution
8. ✅ Return using mandatory response format

**Result:** Comprehensive code review from 2 local + N MCS independent perspectives. Agent count scales automatically with registered MCS agents.

---

## Output Format

Use the mandatory PAI response format:

```
SUMMARY: [Code review completed for X]
ANALYSIS: [Key findings from all reviewers]
ACTIONS: [Launched parallel local + MCS reviewers]
RESULTS: [Synthesized review with prioritized recommendations]
STATUS: [Review complete, N critical issues, M recommendations]
CAPTURE: [Code review for [target] - N issues found]
NEXT: [Address critical issues, then recommendations]
STORY EXPLANATION:
1. [Gathered code context from PR/repo/files]
2. [Launched parallel review agents (2 local + N MCS via capability fanout)]
3. [Each agent analyzed code independently from different perspectives]
4. [Waited for ALL agents to complete before synthesizing]
5. [Identified consensus issues flagged by multiple reviewers]
6. [Synthesized findings into unified prioritized report]
7. [Attributed each finding to its source reviewers]
8. [Delivered comprehensive multi-perspective review]
COMPLETED: Code review complete with N issues from [T] independent reviewers.
```
