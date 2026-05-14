---
name: cleanup
description: Scans a repository (or a specified subdirectory) for dead code and unused tests, then removes them. Use when cleaning up unreachable functions, unused variables, obsolete test files, or any code that is no longer referenced anywhere in the codebase.
---

# Cleanup

This skill scans a repository or a user-specified subdirectory for dead code and tests that are no longer used, then safely removes them. The outcome is a leaner codebase with no unreachable functions, unused imports, obsolete helpers, or test files that exercise code that no longer exists, along with a clear summary of everything that was removed and why.

## When to Use

- The user asks to remove dead code, unused code, or unreachable code
- The user asks to clean up unused tests, obsolete test helpers, or test files for deleted features
- The user mentions `dead code`, `unused function`, `unreferenced`, `orphaned`, or `cleanup`
- After a large refactor or feature deletion where leftover code was not removed
- Before a release or code review to reduce noise in the diff

## When Not to Use

- The code is part of a public API, exported symbol, or documented extension point that consumers outside this repository may call
- The symbol is referenced only at runtime through reflection, dynamic dispatch, or string-based lookup that static analysis cannot trace
- The user only wants a report without any deletions
- The scope is too ambiguous to determine safely what is or is not used

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Repository or subdirectory path | No | Absolute or repo-relative path to restrict the scan. Defaults to the entire repository root if omitted. |
| Approval to delete | No | Whether to delete identified dead code or only report it. Defaults to reporting first, then deleting after confirmation. |

## Workflow

### Step 1: Determine the scan scope

If the user specified a subdirectory, resolve it to an absolute path and confirm it exists. If no subdirectory was given, use the repository root. Record the scope so every subsequent step stays within it.

### Step 2: Identify candidate dead code

Within the scope, search for code that appears to have no live callers or references:

- Functions, methods, and classes that are defined but never called within the codebase (accounting for exports and public APIs)
- Variables and constants that are assigned but never read
- Imports or `require` statements that are never used
- Entire files or modules that are never imported or executed
- Feature flags or conditional branches that are permanently disabled
- Test files or test cases that target functions, classes, or modules that no longer exist

Use available language-specific tools where possible (e.g., `eslint --rule no-unused-vars`, `pyflakes`, `go vet`, `tsc --noUnusedLocals`, `cargo check`) to surface candidates automatically. Supplement with `grep`-based cross-reference searches for symbols not caught by static tools.

### Step 3: Classify each candidate

For each candidate, determine whether it is:

1. **Confirmed dead** — no references exist anywhere in the codebase or its test suite
2. **Potentially live** — may be called at runtime (reflection, dynamic import, plugin system, CLI entry point) even though no static reference is found
3. **Intentionally kept** — marked with a comment such as `// exported`, `# public API`, or similar; part of a documented interface

Do not remove candidates classified as potentially live or intentionally kept. Flag them for the user instead.

### Step 4: Report findings before deleting

Present a concise list that includes:

- File path and line range of each dead item
- What the item is (function, variable, import, test, etc.)
- Why it is considered dead (no callers found, module never imported, etc.)
- Recommended action (delete or flag for manual review)

If the user requested audit-only mode, stop here. Otherwise, proceed after the user confirms or after presenting the list if the user already approved deletion.

### Step 5: Delete confirmed dead code

Remove each confirmed dead item. Prefer deleting the smallest unit possible:

- Remove a single unused import line rather than the whole file if the rest of the file is live
- Remove a single dead function rather than the whole module if other functions in the module are used
- Delete an entire file only when every symbol in it is dead

After deletions, check that no remaining code now has a broken import or reference caused by the removal, and fix any such breakage immediately.

### Step 6: Validate that the codebase still works

Run the existing test suite, linter, and build relevant to the affected area. Confirm:

- All tests that were live before the cleanup still pass
- The build succeeds with no new errors
- No remaining import or reference points to a deleted symbol

## Validation

- [ ] The scan scope (directory or full repo) was confirmed before searching
- [ ] All candidates were identified from actual code references, not guessed
- [ ] Each candidate was classified as confirmed dead, potentially live, or intentionally kept
- [ ] The user received a clear list of findings before any deletions
- [ ] Only confirmed dead code was deleted; potentially live and intentional items were flagged
- [ ] Broken imports or references introduced by deletions were fixed immediately
- [ ] Existing tests, linter, and build pass after the changes

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Deleting a dynamically referenced symbol | Check for reflection, `eval`, string-based dispatch, and plugin registries before classifying as dead |
| Deleting a public API used by external consumers | Verify the symbol is not exported or documented before removing it |
| Removing a test that validates behavior through a different code path | Confirm the tested behavior itself is gone, not just the direct symbol reference |
| Missing cross-file references | Search the full scope (not just the file) for every symbol before marking it dead |
| Breaking imports after deletion | After each deletion, grep for any remaining references to the removed name and fix them |
| Deleting too broadly | Remove the smallest dead unit; never delete an entire file unless every symbol in it is dead |
