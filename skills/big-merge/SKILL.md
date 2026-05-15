---
name: big-merge
description: Performs large branch reconciliation by applying mainline PRs one at a time with conflict checkpoints, required user decisions for functionality/UI conflicts, and manual-test approval gates. Use for big_merge, giant merge, cherry-pick merge recovery, and heavily diverged branches.
---

# Big Merge

Use this skill when a long-lived branch has diverged significantly from `main` and overlapping features make a single giant merge too risky. The outcome is a controlled reconciliation where `main` PRs are applied one by one, functionality/UI conflicts are explicitly presented for user choice before each merge, and each completed merge is manually validated before continuing.

## When to Use

- The branch has diverged far from `main` and a direct merge would create widespread conflicts
- The user asks for staged reconciliation by PR instead of one large all-at-once merge
- Overlapping features or UI changes require explicit product decisions during integration
- The user wants a pause for manual testing after each merged PR
- Trigger phrases include `big_merge`, `big merge`, `giant merge`, `merge main PRs one at a time`, and `cherry-pick PRs`

## When Not to Use

- The branch can be safely rebased or merged in one pass without meaningful overlap risk
- The user wants fully automated conflict handling with no decision checkpoints
- There is no clear list of main PRs/commits to apply in sequence
- The request is only to report conflicts, not to perform integration steps

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Target branch | Yes | The diverged branch that must receive changes from `main` |
| Main PR sequence | Yes | Ordered list of `main` PRs (or equivalent commit references) to apply one by one |
| Conflict decision source | Yes | Person/team authorized to choose between conflicting functionality or UI behaviors |
| Test scope | No | What manual or automated checks should run after each merge |
| Stop conditions | No | Conditions that should pause or abort progression (failed test, unresolved conflict, unclear requirement) |

## Workflow

### Step 1: Prepare and order the integration queue

Confirm the target branch, gather the exact ordered list of `main` PRs to apply, and state the sequence before changing code. Ensure each item has a resolvable commit reference and that the next action is always a single-PR integration step.

### Step 2: Apply one PR and detect meaningful conflicts

For the current PR in the queue, apply it to the target branch. Identify whether conflicts are only mechanical/textual or whether they create a behavior choice in:

- functionality (business logic, data flow, API behavior, validations)
- user interface (layout, interaction pattern, labels, states, navigation)

### Step 3: Require user choice for functionality/UI conflicts before merge

If any functionality or UI conflict requires choosing one behavior over another, pause and present each decision clearly to the user:

- where the conflict is
- option A vs option B behavior
- tradeoff or impact of each option
- exact decision needed

Do not finalize the merge for that PR until the user chooses for all such conflicts.

If there is no functionality/UI behavior conflict (only straightforward merge resolution), proceed without asking.

### Step 4: Finalize the merge for the current PR

After required choices are provided (or none are needed), complete the merge for that PR and ensure the branch is in a consistent, buildable state.

### Step 5: Offer manual test gate before continuing

After each merged PR, explicitly offer the user a manual testing window and wait for approval to continue.

- If user approves, continue to the next PR in sequence
- If user reports issues, stop progression and address them before continuing
- If user declines to continue, stop and summarize current progress

Repeat Steps 2–5 until all queued `main` PRs are merged.

## Validation

- [ ] The ordered list of main PRs was confirmed before integration started
- [ ] Each PR was applied individually (not batched into one giant merge)
- [ ] Every functionality/UI conflict was presented to the user before finalizing that PR merge
- [ ] No user prompt was required when no functionality/UI behavior conflict existed
- [ ] A manual testing opportunity was offered after each merged PR
- [ ] Progress moved to the next PR only after user approval

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Merging multiple PRs at once | Enforce a strict one-PR-at-a-time queue and checkpoint after each merge |
| Treating mechanical conflicts as product decisions | Only escalate conflicts that change behavior, functionality, or UI outcomes |
| Making behavior decisions without user approval | Pause and request explicit user choice before finalizing that PR merge |
| Skipping manual testing checkpoints | Always ask for post-merge manual test approval before the next PR |
| Losing track of completed vs pending PRs | Maintain and share a clear progress list after each PR merge |
