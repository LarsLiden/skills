---
name: document
description: Updates documentation in a repository to reflect recent code changes. Use when documentation (.md files) may be stale, after a code change, or when asked to update, refresh, or clean up docs. Removes outdated documentation that no longer applies.
---

# Document

This skill reviews all Markdown documentation files in a repository, updates them to reflect the current state of the code, and removes or archives any documentation that is no longer relevant.

## When to Use

- After code changes that may have made existing documentation stale
- When asked to "update the docs", "refresh documentation", or "clean up docs"
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
| Scope | No | Limit the review to a subdirectory or specific files (defaults to all `.md` files in the repo) |

## Workflow

### Step 1: Discover all Markdown files

Find every `.md` file in the repository:

```bash
find . -name "*.md" -not -path "./.git/*"
```

Build a list of files to review.

### Step 2: Understand the current codebase

Before editing any docs, read the current state of the code:

- Examine the directory structure and key source files
- Note public APIs, CLI commands, configuration options, and workflows that docs may reference
- Check the git log for recent commits to identify what has changed

### Step 3: Review each documentation file

For each `.md` file:

1. Read the file content
2. Identify sections that reference outdated code paths, removed features, renamed commands, or superseded workflows
3. Check that code examples still work as written
4. Note any files that are entirely obsolete (e.g., docs for a feature that no longer exists)

### Step 4: Update stale documentation

For each file with outdated content:

- Update command names, API signatures, configuration keys, and file paths to match the current codebase
- Revise prose that describes removed or changed behavior
- Fix broken relative links (links to files that have moved or been deleted)
- Preserve the existing tone, style, and structure of the document

### Step 5: Remove obsolete documentation

For files that are entirely obsolete:

- Confirm that no other file links to them (search for the filename across all `.md` files)
- Delete the file if it is safe to do so, or replace its content with a redirect note pointing to the current docs

### Step 6: Update navigation and index files

Check top-level files that list or link to other docs (e.g., `README.md`, `docs/index.md`, `SUMMARY.md`):

- Remove links to deleted files
- Add links to any newly created documentation if applicable
- Ensure the table of contents, if present, reflects the current set of files

### Step 7: Validate

- Run any documentation linters or link-checkers configured in the repository (e.g., `markdownlint`, `lychee`)
- Re-read changed files to confirm accuracy and consistency

## Validation

- [ ] All `.md` files have been reviewed
- [ ] No documentation references removed, renamed, or moved code paths
- [ ] All code examples in docs match the current codebase
- [ ] All internal links in Markdown files resolve correctly
- [ ] Obsolete documentation files have been deleted or redirected
- [ ] Index and navigation files (`README.md`, `SUMMARY.md`, etc.) reflect the current set of docs

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Deleting a file that is still linked elsewhere | Search for the filename across all `.md` files before deleting |
| Updating docs without reading the current code | Always inspect the source files first; never assume from the docs alone |
| Breaking the tone or style of existing docs | Preserve voice and formatting; only change factually incorrect content |
| Missing docs in nested subdirectories | Use a recursive glob (`**/*.md`) rather than checking only the root |
| Leaving broken anchors after edits | Check heading IDs if other docs use anchor links (`#section-name`) |
