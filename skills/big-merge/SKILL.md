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
- There is no clear list of main PRs/commits to apply in sequence and it cannot be derived from GitHub history
- The request is only to report conflicts, not to perform integration steps

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Current branch (target) | Yes | The currently checked-out diverged branch that must receive changes from `main` |
| Main PR sequence | No | If not provided, derive an ordered list from GitHub history (merged PRs/commits into `main`) and confirm the proposed queue with the user before applying anything |
| Conflict decision source | Yes | Person/team authorized to choose between conflicting functionality or UI behaviors |
| Test scope | No | What manual or automated checks should run after each merge |
| Stop conditions | No | Conditions that should pause or abort progression (failed test, unresolved conflict, unclear requirement) |

## Outputs

| Output | Description |
|--------|-------------|
| `BRANCH_CHANGES.md` | Pre-merge inventory of all functionality added on the current branch since it diverged from `main`. Created in Step 1 and used as a reference throughout the merge. |
| `MERGE_LOG.md` | Living document updated after each PR merge. Tracks queue progress, per-PR status, conflict decisions made, and manual test notes. |

## Workflow

### Step 1: Document current branch changes

Before modifying any code, **fetch the latest remote state** so that all comparisons use the most recent `origin/main`, not a potentially stale local `main` branch:

```
git fetch origin main
```

Then create a `BRANCH_CHANGES.md` file in the repository root that catalogs everything the current branch has added or changed since diverging from `main`. This file serves as a reference during every subsequent conflict decision and helps prevent accidental loss of branch-specific functionality.

The document must include:

1. **Branch name and divergence point** — the branch name and the common ancestor commit with `origin/main` (use `git merge-base HEAD origin/main`)
2. **Commit / PR summary** — for each commit or PR merged into the branch since divergence, list the title, author, date, and a one-line functional summary
3. **Grouped feature inventory** — organize the changes into categories: new features, bug fixes, UI changes, refactors, and other
4. **Hotspot files** — list files with the most modifications on the branch, as these are the most likely sources of merge conflicts

Present the completed `BRANCH_CHANGES.md` to the user for review and confirmation before proceeding. This ensures both agent and user share the same understanding of what the branch contains.

### Step 2: Prepare and order the integration queue

Confirm you are on the intended target branch (use the currently active branch). If you did not already fetch in Step 1, run `git fetch origin main` now to ensure you are comparing against the latest remote `main`, not a stale local copy. Gather the exact ordered list of `origin/main` PRs to apply, or derive it from GitHub history if the user did not provide one, then present the proposed sequence for confirmation before changing code. Ensure each item has a resolvable commit reference and that the next action is always a single-PR integration step.

Also create an initial `MERGE_LOG.md` file in the repository root with the full PR queue listed as pending. This file will be updated after each PR merge to track progress, decisions, and test results.

### Step 3: Create a sub-branch and apply one PR

Before applying the current PR, create an isolation branch from the target branch. If the target branch is `new` and the current PR is "A", create a branch named `new-A` (or `<target>-<PR-identifier>`). All conflict resolution and merge work for this PR happens on the sub-branch, keeping the target branch untouched until the merge is validated.

On the sub-branch, apply the current PR. Identify whether conflicts are only mechanical/textual or whether they create a behavior choice in:

- functionality (business logic, data flow, API behavior, validations)
- user interface (layout, interaction pattern, labels, states, navigation)

### Step 4: Require user choice for functionality/UI conflicts before merge

If any functionality or UI conflict requires choosing one behavior over another, pause and present each decision clearly to the user:

- what the current PR is intended to achieve (its functional purpose)
- where the conflict is
- option A vs option B behavior
- tradeoff or impact of each option
- exact decision needed

Cross-reference `BRANCH_CHANGES.md` to explain which branch-specific feature is affected by the conflict and what could be lost or altered by each option.

Do not finalize the merge for that PR until the user chooses for all such conflicts.

If there is no functionality/UI behavior conflict (only straightforward merge resolution), proceed without asking.

### Step 5: Finalize and merge the sub-branch back into the target

After required choices are provided (or none are needed), complete the merge on the sub-branch and ensure it is in a consistent, buildable state.

Once the sub-branch is confirmed working, merge it back into the target branch. This should be a clean fast-forward or trivial merge since the sub-branch was created from the target. After merging, delete the sub-branch to keep the workspace clean.

If something went wrong during conflict resolution on the sub-branch, simply delete it and recreate a fresh sub-branch from the target to try again — the target branch remains untouched until this step succeeds.

### Step 6: Update merge log and offer manual test gate

After each merged PR:

1. **Update `MERGE_LOG.md`** with:
   - The PR's status (applied / skipped / blocked)
   - Any conflict decisions made in Step 4, including the options presented and the user's choice with rationale
   - Test results or notes from manual testing

2. **Offer a manual testing window** and wait for approval to continue:
   - If user approves, continue to the next PR in sequence
   - If user reports issues, stop progression and address them before continuing
   - If user declines to continue, stop and summarize current progress

Repeat Steps 3–6 until all queued `main` PRs are merged.

## Validation

- [ ] A `BRANCH_CHANGES.md` was created and confirmed by the user before any merges began
- [ ] The ordered list of main PRs was confirmed before integration started
- [ ] A `MERGE_LOG.md` was created with the full queue and updated after each PR merge
- [ ] Each PR was applied individually (not batched into one giant merge)
- [ ] Each PR was integrated on an isolation sub-branch before being merged back into the target
- [ ] Every functionality/UI conflict was presented to the user before finalizing that PR merge
- [ ] Conflict decisions referenced `BRANCH_CHANGES.md` to clarify what branch functionality was at stake
- [ ] No user prompt was required when no functionality/UI behavior conflict existed
- [ ] A manual testing opportunity was offered after each merged PR
- [ ] Progress moved to the next PR only after user approval

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Starting merges without understanding what the branch contains | Always complete Step 1 (`BRANCH_CHANGES.md`) and get user confirmation before touching code |
| Merging multiple PRs at once | Enforce a strict one-PR-at-a-time queue and checkpoint after each merge |
| Treating mechanical conflicts as product decisions | Only escalate conflicts that change behavior, functionality, or UI outcomes |
| Making behavior decisions without user approval | Pause and request explicit user choice before finalizing that PR merge |
| Skipping manual testing checkpoints | Always ask for post-merge manual test approval before the next PR |
| Losing track of completed vs pending PRs | Update `MERGE_LOG.md` after every PR merge with status, decisions, and test notes |
| Losing context across sessions or team handoffs | Keep `MERGE_LOG.md` committed so progress and decisions survive interruptions |
| Stacking sub-branches instead of merging back first | Always merge the current sub-branch back into the target and delete it before creating the next one; stacking removes the isolation benefit |
| Resolving conflicts directly on the target branch | Always use a sub-branch so the target stays clean and bad merges can be discarded without affecting it |
| Comparing against a stale local `main` instead of `origin/main` | Always run `git fetch origin main` before any comparison and use `origin/main` (not the local `main` branch) for merge-base, commit listing, and PR derivation |
