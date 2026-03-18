# MCS Task Submission Skill

## Overview

You are submitting a task to the MCS (Mesh Coordination Server) on behalf of a user or upstream task. Your job is to construct a well-formed task submission request and POST it to the MCS REST API.

## CRITICAL: Identity — You MUST Submit As Yourself

You are an agent. You MUST authenticate as YOUR OWN agent identity. NEVER submit tasks as `dan`, a human user, or any other agent.

**Before submitting ANY task, run this verification:**
```bash
echo "Submitting as: $MCS_AGENT_NAME"
```

If `$MCS_AGENT_NAME` is empty, unset, or shows `dan` — STOP. Do not proceed. Your shell environment is misconfigured.

**PROHIBITED:**
- Using credentials found in source code, config files, or .env files
- Using `X-Agent-ID: dan` or any human user ID
- Using JSON-RPC `message/send` — this is NOT the MCS REST API
- Hardcoding any agent name or secret
- Reading MCS server source code to find credentials

**REQUIRED:**
- Use ONLY `$MCS_AGENT_NAME` and `$MCS_AGENT_SECRET` from your shell environment
- These are set in your .bashrc or .zshenv and are unique to YOU

## Authentication — Environment Variables

Your credentials are available as environment variables. Use them directly in curl commands.

- **$MCS_URL** — MCS server base URL
- **$MCS_AGENT_NAME** — YOUR agent ID (must be your own name, e.g., `ocasia`, `rex`, `phil`, `molly`)
- **$MCS_AGENT_SECRET** — YOUR agent secret key

## curl Template

```bash
curl -s -X POST "$MCS_URL/tasks" \
  -H 'Content-Type: application/json' \
  -H "X-Agent-ID: $MCS_AGENT_NAME" \
  -H "X-Agent-Secret: $MCS_AGENT_SECRET" \
  -d '{
    "type": "TASK_TYPE_HERE",
    "payload": { ... },
    "caps_required": ["TASK_TYPE_HERE"],
    "priority": "normal",
    "routing_hint": "any"
  }'
```

## Request Body Schema

```json
{
  "type": "string (required) — the task type / skill capability to invoke",
  "payload": "object (required) — the task-specific data for the receiving agent",
  "caps_required": ["array of capability strings the receiving agent must have"],
  "priority": "urgent | normal | low (default: normal)",
  "routing_hint": "any | all | <agent-name> (default: any)",
  "claim_ttl_seconds": "number — max seconds for an agent to hold the claim",
  "max_retries": "number — retry attempts on failure (default: 3)"
}
```

## CRITICAL: Payload Structure

The `payload` object is the ONLY way to pass data to the receiving agent. If you submit an empty payload `{}`, the agent receives nothing and the task fails.

**PUT ALL FIELDS AT THE TOP LEVEL of the payload object.** Do NOT nest fields under `extra_payload` or any other wrapper — nested objects are silently dropped by the worker.

Only these TOP-LEVEL fields are forwarded to the agent (all others are silently dropped):
- `query` — the main question or request (string) **← MOST IMPORTANT**
- `sub_query` — additional detail or instructions (string)
- `context` — background context (string)
- `prompt` — long-form content or instructions (string, up to 8KB)
- `description` — task description (string)
- `payload_url` — URL to fetch large content from (string, HTTPS only)
- `repo` — repository URL (string)
- `branch` — git branch (string)
- `commit_sha` — git commit SHA (string)
- `task_type` — explicit task type override (string)
- `caps_required` — required capabilities (string array)
- `repo_path` — local filesystem path to a repository (string)
- `review_type` — type of review: quick, full, security (string)
- `focus_areas` — areas to focus on (string array)
- `depth` — quick or thorough (string)
- `research_topic` — topic category for research (string)
- `git_repo` — git repository URL (string)
- `target_branch` — target branch for review (string)
- `file_paths` — specific files to review (string array)
- `instructions` — additional instructions (string)

Every task MUST include at least `query` or `prompt` in the payload.

**CORRECT payload structure:**
```json
{"payload": {"query": "research question here", "depth": "thorough", "research_topic": "AI"}}
```

**WRONG — DO NOT DO THIS:**
```json
{"payload": {"extra_payload": {"query": "research question"}}}
```

## Available Task Types and Required Payload Fields

### `mcs-research` — web research
Required payload: `{"query": "the research question", "depth": "quick|thorough"}`
Optional: `sub_query`, `context`, `research_topic`
caps_required: `["mcs-research"]`

### `mcs-review` — code review
Required payload: `{"payload_url": "https://github.com/...diff_url"}` or `{"prompt": "code to review"}`
Optional: `repo`, `branch`, `commit_sha`, `review_type`, `focus_areas`, `git_repo`, `target_branch`
caps_required: `["mcs-review"]`

### `mcs-prompting` — prompt engineering review
Required payload: `{"prompt": "the prompt text to review"}`
Optional: `context`, `query`
caps_required: `["mcs-prompting"]`

### `mcs-pitch` — Hormozi-style offer creation
Required payload: `{"query": "description of product/service and target market"}`
Optional: `context`, `sub_query`
caps_required: `["mcs-pitch"]`

### `mcs-story` — narrative transformation
Required payload: `{"prompt": "the content to transform into a story"}`
Optional: `context`, `query`
caps_required: `["mcs-story"]`

## Routing Options

### routing_hint
- `any` (default) — first available agent with matching capabilities claims it
- `all` — fan out to ALL agents with matching capabilities (creates child tasks). Use `$MCS_URL/dispatch/fanout` instead of `$MCS_URL/tasks` for this.
- `<agent-name>` — route to a specific agent (e.g., `rex`, `phil`, `molly`)

### priority
- `urgent` (1) — processed before normal tasks
- `normal` (2) — default priority
- `low` (3) — processed after normal tasks

## Example: Submit a research task

```bash
curl -s -X POST "$MCS_URL/tasks" \
  -H 'Content-Type: application/json' \
  -H "X-Agent-ID: $MCS_AGENT_NAME" \
  -H "X-Agent-Secret: $MCS_AGENT_SECRET" \
  -d '{"type": "mcs-research", "payload": {"query": "best Indian restaurants in Edmonton", "depth": "thorough"}, "caps_required": ["mcs-research"], "priority": "normal", "routing_hint": "any"}'
```

## Example: Fanout to all agents

```bash
curl -s -X POST "$MCS_URL/dispatch/fanout" \
  -H 'Content-Type: application/json' \
  -H "X-Agent-ID: $MCS_AGENT_NAME" \
  -H "X-Agent-Secret: $MCS_AGENT_SECRET" \
  -d '{"type": "mcs-research", "payload": {"query": "AI agent orchestration best practices", "depth": "thorough"}, "caps_required": ["mcs-research"], "routing_hint": "all"}'
```

## Response Format

Successful submission returns HTTP 200 with:
```json
{
  "id": "uuid — the task ID for tracking",
  "status": "submitted",
  "type": "the task type",
  "priority": 2,
  "created_by": "your agent name",
  "created_at": "ISO timestamp"
}
```

## Checking Task Status

```bash
curl -s "$MCS_URL/tasks/{task-id}" \
  -H "X-Agent-ID: $MCS_AGENT_NAME" \
  -H "X-Agent-Secret: $MCS_AGENT_SECRET"
```

Status lifecycle: `submitted` → `working` → `completed` | `failed` | `canceled`

## Collecting Fanout Results

**CRITICAL: When using `routing_hint: "all"` (fanout), use the children endpoint to get ALL results.**

The fanout creates a parent task with child tasks for each agent. To retrieve all children and their output:

### Get all children (JSON with full output text)
```bash
curl -s "$MCS_URL/tasks/{parent-task-id}/children" \
  -H "X-Agent-ID: $MCS_AGENT_NAME" \
  -H "X-Agent-Secret: $MCS_AGENT_SECRET"
```

Returns:
```json
{
  "parent_id": "uuid",
  "children": [
    {
      "id": "child-uuid",
      "status": "completed",
      "assigned_to": "ocasia",
      "created_at": "ISO timestamp",
      "completed_at": "ISO timestamp",
      "output": "full text output from agent"
    }
  ],
  "count": 4
}
```

### Using mcs-client CLI
```bash
# JSON output with all children:
bun run ~/.claude/Tools/mcs/client/mcs-client.ts task children <parent-task-id>

# Formatted text output from all children:
bun run ~/.claude/Tools/mcs/client/mcs-client.ts task results <parent-task-id>
```

**DO NOT** use `task list --limit N` to find fanout children — it reads from `task:idx:all` which may not contain all children. The `/tasks/:id/children` endpoint reads from the authoritative `fanout:{parentTaskId}` Redis set, which is guaranteed to have ALL child task IDs.

## Task Payload

The incoming payload for this skill contains:
- `task_description`: string (required) — what work needs to be done
- `target_type`: string (optional) — explicit task type to use
- `target_agent`: string (optional) — specific agent to route to
- `fanout`: boolean (optional) — if true, fan out to all capable agents
- `priority`: string (optional) — urgent, normal, or low

When constructing the outgoing task, extract the key information from `task_description` and place it directly in the top-level `payload` fields (e.g., `query`, `prompt`, `depth`). Do NOT use `extra_payload`.

## Output Format

Return a JSON object matching the output_format specification. Do not include any text outside the JSON object.

