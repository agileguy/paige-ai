---
name: ProjectManager
description: Orchestrate parallel engineers through SRD implementation phases with code review loops and CI validation. USE WHEN user wants to implement an SRD, execute a multi-phase project plan, or coordinate parallel development with reviews.
---

# ProjectManager Skill

Orchestrate parallel engineers to implement an SRD phase by phase with automated code review and CI validation.

## Workflow

```
For each phase in SRD:
  1. Create feature branch
  2. Launch 2 parallel engineers
  3. Create PR
  4. Launch parallel reviewers (Claude + Gemini)
  5. Engineer fixes issues
  6. Re-review loop until approved
  7. Wait for CI to pass
  8. Merge PR
  9. Version & documentation update
  10. Compact and continue
```

## Usage

When the user wants to implement an SRD, follow this workflow:

### Step 1: Parse the SRD

Read the SRD and extract phases:
```
Read the SRD at {path}
Identify all phases in the Implementation Checklist
Create a tracking structure for progress
```

### Step 2: Execute Each Phase

For each phase, execute the following sequence:

#### 2.1 Create Branch
```bash
git checkout main && git pull origin main
git checkout -b phase-{N}-{phase-name-slug}
```

#### 2.2 Launch Parallel Engineers

Launch 2 engineers simultaneously using Task tool with `subagent_type="engineer"`:

**Engineer 1 prompt:**
```
Implement Phase {N}: {phase_name} - Part A

Repository: {repo_path}
Branch: phase-{N}-{slug}

## Requirements (First Half)
{first_half_of_phase_tasks}

## Instructions
1. Read existing code to understand patterns
2. Implement requirements following conventions
3. Write unit tests
4. Commit changes with descriptive messages
5. Do NOT create PR or push yet
```

**Engineer 2 prompt:**
```
Implement Phase {N}: {phase_name} - Part B

Repository: {repo_path}
Branch: phase-{N}-{slug}

## Requirements (Second Half)
{second_half_of_phase_tasks}

## Instructions
1. Read existing code to understand patterns
2. Implement requirements following conventions
3. Write unit tests
4. Commit changes with descriptive messages
5. Do NOT create PR or push yet
```

#### 2.3 Create PR
```bash
git push origin phase-{N}-{slug}
gh pr create --title "Phase {N}: {phase_name}" --body "## Summary
{phase_description}

## Changes
{list_changes}

## Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass"
```

#### 2.4 Code Review via /CodeReviewer Skill

Use the **CodeReviewer** skill to run a multi-perspective code review. This automatically launches local agents (Claude + Gemini) AND fans out to all MCS agents with `mcs-review` capability — providing broader coverage than manual reviewer launches.

```
Invoke the /CodeReviewer skill:
  /review PR #{pr_number} — Phase {N}: {phase_name}
```

The CodeReviewer skill handles:
- Parallel local agents (Claude researcher + Gemini researcher)
- MCS fanout to all agents with `mcs-review` capability (Ocasia, Rex, Phil, etc.)
- Synthesis of all review results into a consolidated report
- APPROVED or CHANGES_REQUESTED verdict with specific file:line issues

**Important:** Wait for the CodeReviewer to return its consolidated verdict before proceeding to Step 2.5.

#### 2.5 Fix Issues Loop

If either reviewer returns CHANGES_REQUESTED:

```
max_iterations = 3
while issues_exist and iteration < max_iterations:
    1. Launch engineer to fix issues
    2. Push fixes
    3. Re-run both reviewers
    4. Check if approved
    iteration++
```

**Fix Engineer prompt:**
```
Address code review feedback for PR #{pr_number}

## Issues to Fix
{combined_review_issues}

Instructions:
1. Fix all MUST FIX issues
2. Address SHOULD FIX where appropriate
3. Commit: "Address review feedback"
4. Push to branch
```

#### 2.6 Wait for CI

```bash
# Check CI status
gh pr checks {pr_number} --watch

# If CI fails, launch engineer to fix
```

**CI Fix Engineer prompt (if needed):**
```
Fix failing CI for PR #{pr_number}

Failing checks:
{failed_checks}

1. Identify root cause
2. Fix issues
3. Commit and push
```

#### 2.7 Merge PR

```bash
gh pr merge {pr_number} --squash --delete-branch
git checkout main
git pull origin main
```

#### 2.8 Version & Documentation Update

After merge, update version and documentation:

**Version Increment:**
```bash
# Detect version file type and increment patch version
# For package.json:
npm version patch --no-git-tag-version

# For pyproject.toml:
# Update version = "X.Y.Z" to version = "X.Y.(Z+1)"

# For VERSION file:
# Increment the patch number
```

**Documentation Updates:**

Launch an engineer to update documentation:

**Documentation Engineer prompt:**
```
Update documentation for Phase {N}: {phase_name}

Repository: {repo_path}
Branch: main (post-merge)

## Tasks
1. Update CHANGELOG.md with phase summary
   - Add entry under "## [Unreleased]" or create new version section
   - List key changes, features, and fixes from this phase

2. Update README.md if needed
   - Add new features/capabilities introduced
   - Update usage examples if API changed
   - Update installation instructions if dependencies changed

3. Update any affected documentation files
   - API docs if endpoints changed
   - Configuration docs if options changed
   - Architecture docs if structure changed

4. Commit: "docs: update documentation for phase {N}"
5. Push to main

## Guidelines
- Keep changelog entries concise but informative
- Use conventional commit style for categorization
- Only update docs that are actually affected by this phase
```

#### 2.9 Compact and Continue

After each phase:
1. Run `/compact` to free context
2. Log phase completion
3. Proceed to next phase

## State File

Track progress in `.claude/project-manager-state.json`:

```json
{
  "srd_path": "docs/SRD-feature.md",
  "repo_path": "/path/to/repo",
  "total_phases": 8,
  "current_phase": 1,
  "completed_phases": [],
  "status": "in_progress",
  "version_file": "package.json",
  "initial_version": "1.0.0",
  "current_version": "1.0.3"
}
```

## Example Invocation

```
User: Implement the SRD at penny/docs/SRD-daily-trading-system.md

ProjectManager:
1. Reads SRD, identifies 8 phases
2. Creates branch: phase-1-data-models
3. Launches 2 engineers in parallel
4. Creates PR #45
5. Launches Claude + Gemini reviewers
6. Engineer fixes 3 issues
7. Re-review: approved
8. CI passes
9. Merges PR
10. Increments version (1.0.0 → 1.0.1)
11. Updates CHANGELOG.md and docs
12. Compacts, continues to Phase 2...
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| max_review_iterations | 3 | Max fix cycles |
| parallel_engineers | 2 | Engineers per phase |
| auto_merge | true | Merge when ready |
| version_increment | true | Increment version after each phase |
| update_changelog | true | Update CHANGELOG.md after each phase |
| update_docs | true | Update affected documentation |
| compact_after_phase | true | Compact after each |

## Error Recovery

- **CI Failure**: Fix up to 3 times, then pause
- **Review Deadlock**: Escalate after 3 iterations
- **Merge Conflict**: Engineer resolves manually
- **Interruption**: Resume from state file
