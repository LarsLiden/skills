---
name: fallback
description: Finds fallback behaviors that mask real bugs, reports which ones should be removed, and removes unjustified fallbacks while preserving visible error handling. Use for fallback cleanup, silent default detection, and bug-masking resilience code.
---

# Fallback Cleanup

Use this skill when code appears to hide real defects behind silent defaults, catch-all handlers, placeholder values, or "best effort" branches that keep execution moving while concealing the true failure. The outcome is a reviewed list of suspect fallback behaviors, a clear recommendation for which ones should be removed, and code changes that expose the real error path while keeping user-visible failures understandable.

## When to Use

- The task mentions fallback logic, silent defaults, swallowed errors, or code that "keeps working" when it should fail
- An agent added defensive behavior such as empty-string defaults, `|| []`, `|| {}`, broad `catch` blocks, or placeholder return values without a product requirement
- A bug appears to be hidden because the code silently substitutes dummy data or suppresses an exception
- You need to audit a repository for resilience code that may actually be masking defects
- Trigger phrases include `fallback`, `default value`, `silent failure`, `swallow error`, `mask bug`, and `best effort`

## When Not to Use

- The fallback is a documented product requirement, compatibility path, or offline/degraded-mode behavior
- The code is intentionally handling optional data where absence is expected and user-safe
- The task is only to add resilience, retries, or graceful degradation rather than remove bug-masking behavior
- You cannot determine whether the fallback is required and no domain expert or specification is available

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Repository or target area | Yes | The codebase, package, files, or feature area to inspect |
| Subdirectory or path filter | No | A specific subdirectory or glob pattern (e.g. `src/payments` or `src/**/*.ts`) to restrict the search scope; when omitted the entire repository is inspected |
| User concern or symptom | No | Error, behavior, or suspicion that suggests a fallback is masking a bug |
| Approval to modify code | No | Whether to only report findings or also remove approved fallbacks |
| UI expectations | No | Whether the application should surface resulting errors in a user-visible way |

## Workflow

### Step 1: Find candidate fallback behaviors

If the user supplied a **subdirectory or path filter**, restrict every search and all subsequent file reads, edits, and test runs to that path only. Do not inspect, report on, or modify code outside the specified scope. When no subdirectory is given, the full repository is in scope.

Search for patterns that commonly hide failures: broad exception handlers, default literals used after failed lookups, placeholder objects, empty collections returned on error, suppressed logs, feature flags used to skip broken paths, and comments such as `fallback`, `just in case`, or `avoid crash`.

Prioritize fallbacks that:
- change externally visible behavior after a failure
- turn invalid state into seemingly valid state
- discard error context
- make tests pass or UI render while the underlying operation is broken

### Step 2: Decide whether each fallback is justified

For each candidate, determine whether it is:
1. **Required** — explicitly supported behavior, safe optionality, or documented degraded mode
2. **Suspicious** — unclear intent and needs confirmation
3. **Bug-masking** — hides a failure that should instead surface to developers or users

Use nearby code, tests, documentation, issue context, and user requirements to justify the classification. Do not remove a fallback just because it exists.

### Step 3: Report the findings before changing behavior

Produce a concise list for the user that includes:
- file and code location
- the fallback behavior
- why it appears required, suspicious, or bug-masking
- the recommended action
- any expected user-facing impact if it is removed

If the request is audit-only, stop after reporting. If the request includes fixing the problem, use the report as the basis for the code changes.

### Step 4: Remove unjustified fallbacks carefully

Replace bug-masking fallbacks with behavior that preserves the real error signal. Prefer propagating the original exception, returning an explicit error state, or failing fast with context instead of substituting fake success values.

When the repository has a user interface, ensure the resulting error is visible to the user in an appropriate way instead of disappearing silently. Show a real error state, message, or recovery path rather than blank content or placeholder data.

### Step 5: Validate the resulting behavior

Run the existing tests, linters, and builds relevant to the changed area. Verify that:
- legitimate workflows still work
- previously hidden failures are now observable
- user-facing errors are understandable and not silently dropped
- no required degraded-mode behavior was removed by mistake

## Validation

- [ ] Candidate fallbacks were identified from code, not guessed abstractly
- [ ] Each candidate was classified as required, suspicious, or bug-masking with a stated reason
- [ ] The user received a clear list of recommended fallback removals before or alongside any code changes
- [ ] Removed fallbacks no longer substitute fake success values or swallow the original failure
- [ ] Any affected UI now shows an explicit error state or message when appropriate
- [ ] Relevant existing validation commands pass after the changes

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Removing a deliberate degraded mode | Check product requirements, docs, and tests before deleting fallback logic |
| Treating optional data as a bug | Distinguish expected absence from failure-triggered substitution |
| Replacing a silent fallback with a crash and no context | Preserve the original error details and add an explicit error path |
| Forgetting user-visible impact | If a UI exists, verify the failure is surfaced clearly instead of leaving empty or stale content |
| Reporting vague findings | Name the file, code path, fallback behavior, and recommended action for every finding |
