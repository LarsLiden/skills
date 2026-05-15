---
name: reccomended-refactors
description: Analyzes a code repository (or subdirectory) to identify refactoring opportunities that simplify architecture, reduce complexity, and lower bug risk. Use when asked to review code structure, suggest refactors, find over-engineered patterns, or produce a refactor report.
---

# Recommended Refactors

This skill examines a code repository or subdirectory and identifies concrete opportunities for refactoring. Code that grows piecemeal often becomes unnecessarily complex; this skill takes a step back to evaluate the overall architecture and surfaces improvements that would simplify the codebase, reduce duplication, and make it less prone to bugs. Each opportunity is documented in its own Markdown file inside a `/reccomended_refactors` directory so the user can review and prioritize them independently.

## When to Use

- User asks to "identify refactoring opportunities" or "review the codebase for refactors"
- User asks to "simplify" or "clean up" the architecture of a project
- User asks whether any code can be consolidated, deduplicated, or restructured
- User wants a written report of technical debt or design improvements
- A codebase has grown organically without an upfront design plan

## When Not to Use

- The user only wants a single specific change made — apply it directly instead
- The user asks for a code review focused on correctness or security (use a code-review skill instead)
- The repository is a third-party dependency or read-only — document findings but do not write output files there

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Repository path or subdirectory | Yes | Absolute or relative path to the code to analyze |
| Language / framework hints | No | If the user specifies a language or framework, focus analysis there |
| Scope limit | No | Maximum number of refactor proposals to produce (default: no limit) |

## Workflow

### Step 1: Understand the target scope

Read the directory tree of the provided path (up to two levels deep). Note the languages, frameworks, major modules, and overall structure. If the project has a README, CONTRIBUTING guide, or architecture document, read those first to understand the intended design.

### Step 2: Identify refactoring opportunities

Analyze the code for common improvement patterns, including but not limited to:

- **Duplicated logic** — identical or near-identical code blocks that could be extracted into a shared function or module
- **God objects / large modules** — files or classes that do too many things and should be split by responsibility
- **Deep nesting / complex control flow** — conditionals or loops that could be flattened with early returns, guard clauses, or helper functions
- **Inconsistent abstractions** — mixing low-level and high-level concerns in the same place; leaky abstractions
- **Poor separation of concerns** — business logic mixed with I/O, UI, or framework code
- **Unnecessary coupling** — components that depend on each other's internals and could be decoupled through interfaces or events
- **Repeated configuration or magic values** — hard-coded strings or numbers scattered throughout the code that should be constants or configuration
- **Overly generic or overly specific naming** — functions or variables named so broadly (or so narrowly) that they obscure intent
- **Missing or redundant layers** — an extra abstraction layer with no clear benefit, or a missing layer causing repeated boilerplate
- **Inefficient data structures** — collections or lookups that could be simplified with a more appropriate type

For each opportunity found, note: the file(s) and line range involved, the current pattern, the proposed change, and why it helps.

### Step 3: Create the output directory

Create the directory `reccomended_refactors/` at the root of the analyzed path (or at the repository root if a subdirectory was analyzed).

```
reccomended_refactors/
├── 01-<short-title>.md
├── 02-<short-title>.md
└── ...
```

Use a numeric prefix to allow easy ordering and prioritization.

### Step 4: Write one Markdown file per opportunity

For each refactoring opportunity, create a file named `NN-<kebab-case-title>.md` (e.g., `01-extract-duplicate-validation.md`). Each file must contain the following sections:

```markdown
# <Refactor Title>

## Summary
One or two sentences describing the proposed change.

## Why This Refactor Is Proposed
Explain the current problem: what makes the existing code hard to maintain,
understand, or extend. Reference specific files and line numbers where relevant.

## Benefits
- Benefit 1 (e.g., eliminates duplication across X files)
- Benefit 2 (e.g., reduces cyclomatic complexity of function Y)
- Benefit 3 (e.g., makes unit testing easier by isolating concerns)

## Scope
| Attribute | Value |
|-----------|-------|
| Effort estimate | Small / Medium / Large |
| Files affected | List of files or directories |
| Risk | Low / Medium / High — brief rationale |
| Breaking change? | Yes / No — explain if yes |

## Suggested Approach
Step-by-step outline of how to carry out the refactor. Do not write the full
implementation — describe the approach so the developer can execute it.
```

### Step 5: Produce a summary index

Create `reccomended_refactors/README.md` listing all proposals in a table:

```markdown
# Recommended Refactors

| # | Title | Effort | Risk | Files Affected |
|---|-------|--------|------|----------------|
| 01 | ... | Small | Low | src/utils.js |
```

### Step 6: Report to the user

Summarize how many proposals were written, where the output files are, and highlight the two or three highest-value opportunities. Invite the user to choose which ones they would like to act on.

## Validation

- [ ] `reccomended_refactors/` directory exists at the expected path
- [ ] At least one numbered `.md` file is present in the directory
- [ ] Each proposal file contains Summary, Why, Benefits, Scope, and Suggested Approach sections
- [ ] `reccomended_refactors/README.md` index lists all proposals
- [ ] No proposal file modifies or deletes any source file — this skill is read/write only to the output directory
- [ ] Proposals reference actual files and line numbers from the analyzed codebase, not hypothetical examples

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Proposing too many trivial refactors | Focus on changes with clear architectural benefit; skip pure style fixes unless they meaningfully reduce complexity |
| Vague "this code is messy" proposals | Every proposal must name specific files, functions, or patterns and explain a concrete improvement |
| Overwriting source files | This skill only creates files in `reccomended_refactors/`; never modify the analyzed code |
| Missing scope information | Always include effort, risk, and whether the change is breaking — the user needs this to prioritize |
| Duplicating the same proposal | Consolidate overlapping observations into a single file with multiple sub-points |
| Analyzing generated or vendored code | Skip `node_modules`, `vendor`, `dist`, `.git`, and other non-authored directories |
