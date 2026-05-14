---
name: document
description: Updates documentation in a repository or a user-specified subdirectory to reflect recent code changes. Use when documentation (.md files) may be stale, after a code change, or when asked to update, refresh, or clean up docs. Removes outdated documentation that no longer applies.
---

# Document

This skill reviews Markdown documentation files in a repository or in a user-specified subdirectory, updates them to reflect the current state of the code, and removes or archives any documentation that is no longer relevant.

## When to Use

- After code changes that may have made existing documentation stale
- When asked to "update the docs", "refresh documentation", or "clean up docs"
- When the user wants the update limited to a particular subdirectory instead of the entire repository
- When README files, guides, or reference docs reference outdated APIs, commands, or workflows
- When obsolete documentation files exist that no longer correspond to any feature or component

## When Not to Use

- When creating brand-new documentation for a feature that has no existing docs (use a dedicated authoring workflow instead)
- When only code changes are needed and documentation is already accurate
- When the user asks only about a specific documentation file — edit that file directly

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Repository path | Yes | Root of the repository to update |
| Subdirectory | No | A user-specified subdirectory to review instead of the entire repository |
| Scope | No | Additional limit within the chosen repository or subdirectory, such as a smaller set of files |

## Workflow

### Step 1: Determine the review root

Decide whether to work on:

- The entire repository, or
- A user-specified subdirectory

If a subdirectory is provided, treat it as the review root for the rest of the workflow and do not edit Markdown files outside that subtree unless the user explicitly asks for it.

### Step 2: Discover all Markdown files

Find every `.md` file under the chosen review root:

```bash
find <review_root> -name "*.md" -not -path "*/.git/*"
```

Substitute `<review_root>` with the repository root for a full-repository pass, or with the user-specified subdirectory for a scoped pass. Build a list of files to review.

### Step 3: Understand the current codebase

Before editing any docs, read the current state of the code:

- Examine the directory structure and key source files
- Note public APIs, CLI commands, configuration options, and workflows that docs may reference
- Check the git log for recent commits that affected the chosen review root to identify what has changed

### Step 4: Review each documentation file

For each `.md` file:

1. Read the file content
2. Identify sections that reference outdated code paths, removed features, renamed commands, or superseded workflows
3. Check that code examples still work as written
4. Note any files that are entirely obsolete (e.g., docs for a feature that no longer exists)

### Step 5: Update stale documentation

For each file with outdated content:

- Update command names, API signatures, configuration keys, and file paths to match the current codebase
- Revise prose that describes removed or changed behavior
- Fix broken relative links (links to files that have moved or been deleted)
- Preserve the existing tone, style, and structure of the document

### Step 6: Remove obsolete documentation

For files that are entirely obsolete:

- Confirm that no other file links to them (search for the filename across all `.md` files)
- Delete the file if it is safe to do so, or replace its content with a redirect note pointing to the current docs

### Step 7: Update navigation and index files

Check top-level files that list or link to other docs (e.g., `README.md`, `docs/index.md`, `SUMMARY.md`):

- Remove links to deleted files
- Add links to any newly created documentation if applicable
- Ensure the table of contents, if present, reflects the current set of files
- If working in a subdirectory, also update any higher-level navigation files outside that subdirectory only when they directly reference files you changed or removed

### Step 8: Validate

- Run any documentation linters or link-checkers configured in the repository (e.g., `markdownlint`, `lychee`)
- Re-read changed files to confirm accuracy and consistency
- Confirm that no edits were made outside the user-requested subdirectory, except for required navigation or index updates

## Validation

- [ ] All `.md` files in the selected repository scope or subdirectory have been reviewed
- [ ] No documentation references removed, renamed, or moved code paths
- [ ] All code examples in docs match the current codebase
- [ ] All internal links in Markdown files resolve correctly
- [ ] Obsolete documentation files have been deleted or redirected
- [ ] Index and navigation files (`README.md`, `SUMMARY.md`, etc.) reflect the current set of docs
- [ ] No files outside the requested subdirectory were changed unless they needed navigation updates

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Deleting a file that is still linked elsewhere | Search for the filename across all `.md` files before deleting |
| Updating docs without reading the current code | Always inspect the source files first; never assume from the docs alone |
| Editing files outside the user's requested subdirectory | Treat the requested subdirectory as the review root and only touch external files when navigation must be updated |
| Breaking the tone or style of existing docs | Preserve voice and formatting; only change factually incorrect content |
| Missing docs in nested subdirectories | Use a recursive search rooted at the selected review root, such as `find <review_root> -name "*.md"` |
| Leaving broken anchors after edits | Check heading IDs if other docs use anchor links (`#section-name`) |
