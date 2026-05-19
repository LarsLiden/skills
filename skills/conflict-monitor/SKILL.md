---
name: conflict-monitor
description: Runs on a daily schedule to detect potential feature-level conflicts between your work and teammates' changes in open PRs and recent main-branch commits. Use when you want early warning about overlapping work, conflicting features, or colliding changes before they become merge conflicts.
---

# Conflict Monitor

This skill runs once per day (or on demand) and scans open pull requests and recent commits to the main branch to identify changes by teammates that may conflict with your current work. It produces a concise daily digest highlighting potential feature-level overlaps, file-level collisions, and semantic conflicts so you can coordinate with your team before problems arise.

## When to Use

- As a scheduled daily check to stay informed about teammates' work
- When you want to detect overlapping feature work before it turns into merge conflicts
- When the user asks to "monitor conflicts", "check for overlapping work", or "watch for collisions"
- Before starting a large feature to see if anyone else is working in the same area
- After returning from time away to catch up on what changed

## When Not to Use

- When you need to resolve an existing merge conflict (use `big-merge` instead)
- When you only want a code review of your own PR
- When the repository has no other active contributors

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Your branch or PR | Yes | The branch name or PR number representing your current work. Used to determine which files and features to compare against. |
| Repository | Yes | The repository to monitor (defaults to the current repository). |
| Lookback period | No | How far back to scan main-branch commits. Defaults to 1 day for scheduled runs. |
| Team members | No | GitHub usernames to monitor. Defaults to all contributors with activity in the lookback period. |

## Workflow

### Step 1: Identify your active work

Determine the user's current working context:

1. If a branch or PR was provided, use it directly.
2. Otherwise, detect the currently checked-out branch.
3. Collect the set of files you have modified compared to the main branch (`git diff --name-only main...HEAD`).
4. Identify the features and modules your changes touch by examining directory structure, changed function signatures, modified API endpoints, altered configuration keys, and updated database schemas.

### Step 2: Gather teammates' recent changes

Collect two categories of external changes:

**Open PRs:**
- List all open pull requests in the repository (excluding your own).
- For each PR, retrieve the list of changed files and the PR description.

**Recent main-branch commits:**
- List commits to the main branch within the lookback period (default: last 24 hours).
- For each commit, retrieve the list of changed files and the commit message.

### Step 3: Detect file-level overlaps

Compare your changed files against each teammate's changed files:

- **Direct overlap** — the same file is modified in both your branch and a teammate's PR or main-branch commit.
- **Adjacent overlap** — different files in the same module or directory are modified, suggesting work in the same area.
- **Dependency overlap** — a file you depend on (imported, required, or referenced) was modified by a teammate.

Record each overlap with the teammate, their PR or commit, and the specific files involved.

### Step 4: Detect feature-level conflicts

Beyond file overlaps, look for semantic conflicts:

- **API changes** — a teammate modified the signature, return type, or behavior of a function or endpoint that your code calls or extends.
- **Schema changes** — a teammate altered a database migration, configuration schema, or data model that your code relies on.
- **Shared state** — a teammate modified shared constants, environment variables, feature flags, or global configuration that your code reads or writes.
- **Competing features** — based on PR titles, descriptions, and commit messages, identify work that targets the same user-facing feature or business requirement, even if different files are involved.

Use PR descriptions and commit messages to understand intent. Flag cases where two changes aim to solve the same problem differently.

### Step 5: Assess conflict severity

Classify each detected conflict:

| Severity | Criteria |
|----------|----------|
| 🔴 High | Same file modified with overlapping line ranges, or incompatible API/schema changes |
| 🟡 Medium | Same file modified in non-overlapping sections, or same module with related changes |
| 🟢 Low | Adjacent directory work or loosely related feature overlap |

### Step 6: Produce the daily digest

Generate a concise report structured as follows:

```
## Conflict Monitor — <date>

### Your Active Work
- Branch: `<branch-name>`
- Files changed: <count>
- Key areas: <list of modules/features touched>

### 🔴 High-Severity Conflicts
For each:
- **Who**: @teammate — PR #123 "PR title" (or commit abc1234)
- **What**: Description of the overlap
- **Files**: List of conflicting files
- **Recommendation**: Suggested action (coordinate, rebase, review)

### 🟡 Medium-Severity Conflicts
(same format)

### 🟢 Low-Severity Conflicts
(same format)

### No Conflicts Detected
(if applicable — list areas checked to confirm coverage)
```

If no conflicts are found, state that explicitly and list the areas that were checked.

### Step 7: Suggest next steps

For each conflict, provide an actionable recommendation:

- **High**: "Coordinate with @teammate immediately — you are both modifying `<file>`. Consider pairing or rebasing before your changes diverge further."
- **Medium**: "Review PR #123 to understand @teammate's approach in `<module>`. Your changes may need adjustment after their PR merges."
- **Low**: "Be aware that @teammate is working in `<area>`. No immediate action needed, but monitor for changes that may affect your work."

## Validation

- [ ] The user's active branch and changed files were correctly identified
- [ ] All open PRs (excluding the user's own) were retrieved and analyzed
- [ ] Recent main-branch commits within the lookback period were retrieved
- [ ] File-level overlaps were detected for direct, adjacent, and dependency conflicts
- [ ] Feature-level conflicts were identified using PR descriptions and commit messages
- [ ] Each conflict was assigned a severity level (high, medium, or low)
- [ ] A structured daily digest was produced with clear, actionable recommendations
- [ ] The report explicitly states when no conflicts were found

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Missing PRs from forks or external contributors | Include PRs from all sources, not just the upstream repository |
| Ignoring renamed or moved files | Track renames (`git diff --diff-filter=R`) so a renamed file is matched against its original path |
| Over-reporting low-severity noise | Keep low-severity items brief and collapsible; lead with high and medium items |
| Missing semantic conflicts in different files | Look beyond file names — check imports, function calls, and shared constants across boundaries |
| Stale PR data | Always fetch the latest PR file lists; do not rely on cached data |
| Not accounting for the user's own merged PRs | Exclude the user's own commits and PRs from the "teammate changes" list |
