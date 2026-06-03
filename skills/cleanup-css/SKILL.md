---
name: cleanup-css
description: Performs a deep analysis of a project's CSS to identify and consolidate duplication, extract repeated values (especially colors, spacing, fonts, and breakpoints) into custom properties or shared variables, and refactor styles so each rule has a single source of truth. Use when the user asks to clean up CSS, reduce duplicate styles, deduplicate selectors, extract design tokens, introduce CSS variables for colors, or remove places where the same value must be edited in multiple files.
---

# Cleanup CSS

This skill audits the CSS in a repository (or a specified subdirectory) for duplication, scattered constants, and rules that force a developer to make the same change in multiple places. It then refactors the styles so shared values live in a single location — typically as CSS custom properties (`--var`) or preprocessor variables — and so each visual concern is defined exactly once. The outcome is a leaner, more maintainable stylesheet that behaves identically to before, plus a clear report of what was consolidated and why.

## When to Use

- The user asks to clean up, refactor, deduplicate, or simplify CSS
- The user mentions `duplicate styles`, `repeated colors`, `magic numbers in CSS`, `design tokens`, `CSS variables`, `single source of truth`, or `DRY CSS`
- Color values, spacing, font sizes, or breakpoints are hard-coded in many files instead of being centralized
- The same selector or near-identical rule block is defined in more than one stylesheet
- A small visual change (e.g. brand color, base font size) currently requires edits in multiple locations
- Before introducing a design system or theme, to flatten existing duplication first

## When Not to Use

- The user only wants visual or design changes (new look, new layout) rather than structural cleanup
- The CSS is generated entirely by a framework or build step the agent cannot safely modify (e.g. compiled Tailwind output, minified vendor bundles)
- The scope is too ambiguous to determine which stylesheets are in use
- Third-party / vendored stylesheets that must remain byte-identical to their upstream source
- The user wants a report only and has not approved any changes — in that case, stop after Step 4

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Repository or subdirectory path | No | Absolute or repo-relative path to restrict the audit. Defaults to the entire repository root if omitted. |
| Variable strategy | No | Whether to use CSS custom properties (`--name`), a preprocessor (`$name` in Sass, `@name` in Less), or an existing token system. Defaults to matching whatever the codebase already uses; if none exists, prefer CSS custom properties. |
| Approval to refactor | No | Whether to apply changes or only report findings. Defaults to reporting first, then refactoring after confirmation. |

## Workflow

### Step 1: Determine the scan scope and stylesheet inventory

If the user specified a subdirectory, resolve it to an absolute path and confirm it exists. Otherwise, use the repository root. Then enumerate every stylesheet in scope: `.css`, `.scss`, `.sass`, `.less`, `.styl`, plus styles embedded in component files (`<style>` blocks in `.vue`, `.svelte`, `.astro`; `styled-components` / `emotion` template literals in `.ts`/`.tsx`/`.js`/`.jsx`; CSS Modules; `*.module.css`). Record the inventory so every later step stays within it.

Also detect what variable mechanism already exists in the project (CSS custom properties under `:root`, a Sass `_variables.scss` partial, a `tokens.ts` file, Tailwind config, etc.) so new constants follow the existing convention rather than introducing a competing one.

### Step 2: Identify duplication and scattered constants

Within the scope, look for the patterns below. Treat each as a candidate, not a confirmed change.

- **Duplicated literal values** — the same color (`#1f6feb`, `rgb(31,111,235)`, `hsl(...)`), spacing (`16px`, `1rem`), font size, font family, shadow, border-radius, transition duration, or z-index appearing in multiple files or rules
- **Equivalent values written differently** — e.g. `#fff` vs `#FFFFFF` vs `white` vs `rgb(255,255,255)`; `0.5rem` vs `8px` when the base font size makes them equal
- **Duplicate or near-duplicate rule blocks** — the same selector defined in two files, or two selectors with identical declaration bodies that could share a class, `@extend`, or mixin
- **Repeated declaration clusters** — the same group of declarations (e.g. a button reset, a visually-hidden helper, a flex-center pattern) re-implemented inline in many places
- **Hard-coded values that shadow existing tokens** — a raw color used where a `var(--color-...)` or `$brand` already exists
- **Media query duplication** — the same breakpoint (`768px`, `1024px`) repeated as a literal in many `@media` rules instead of a named breakpoint
- **Dead or overridden rules** — declarations that are always overridden later by higher-specificity rules (note: defer outright deletion to the `cleanup` skill; here, only flag them)

Use grep across the scope to count occurrences of each suspicious literal. A value that appears three or more times across two or more files is a strong candidate for extraction.

### Step 3: Classify each candidate

For each candidate, decide which bucket it belongs in:

1. **Extract to a shared constant** — the value is semantically meaningful (a brand color, the standard gutter, a primary breakpoint) and is repeated. Introduce or reuse a variable.
2. **Consolidate into a shared rule** — multiple selectors share an identical declaration body. Merge them via a grouped selector, a utility class, a Sass `%placeholder` / `@extend`, or a mixin.
3. **Leave as a one-off literal** — the value appears only once, or is intentionally local (e.g. a magic offset tuned for a single component) and giving it a name would not improve clarity.
4. **Flag for human decision** — values that *look* the same but may be intentionally different (e.g. two shades of gray that are almost identical), or duplication across a boundary the user may not want crossed (e.g. between a vendor theme and app styles).

Do not refactor categories 3 or 4 automatically. Surface them in the report.

### Step 4: Report findings before refactoring

Present a concise, structured report with:

- A table of repeated literals: value, number of occurrences, files where it appears, proposed variable name, proposed location
- A list of duplicate or near-duplicate rule blocks with file:line ranges and the proposed consolidation
- A list of items flagged for human decision, with the question the user needs to answer
- The proposed home for new variables (e.g. `:root` block in `styles/tokens.css`, or extending the existing `_variables.scss`)
- Proposed names for new variables, following the project's existing naming convention (kebab-case for CSS custom properties, the prevailing prefix scheme for Sass/Less, semantic names like `--color-brand-primary` over literal names like `--blue-7` when the value has a clear role)

If the user requested audit-only mode, stop here. Otherwise, proceed after the user confirms, or after presenting the report if the user already approved refactoring.

### Step 5: Introduce or extend the shared constants file

Add the new variables in the location chosen in Step 4, following the project's existing convention:

- For CSS custom properties, define them on `:root` (or the existing token scope) in the project's tokens / variables stylesheet, creating that file only if none exists
- For Sass / Less / Stylus, add them to the existing variables partial; import it where needed if it is not already global
- Group related variables (colors, spacing, typography, breakpoints, shadows, radii, z-index, motion) under clearly labeled comment sections
- Choose semantic names (`--color-text-muted`, `--space-gutter`, `--breakpoint-tablet`) over purely descriptive ones whenever the value has a known role

### Step 6: Replace duplicated literals with references to the shared constants

For each value being extracted, replace every occurrence in the scope with a reference to the new variable (`var(--color-brand-primary)`, `$brand-primary`, `@brand-primary`, etc.). Make the smallest edit possible — change only the value, not the surrounding rule structure.

When the replacement is inside a context where the variable is not yet visible (e.g. a CSS Module that does not import the tokens file, a `<style scoped>` block in a single-file component), add the minimum import / inclusion needed for the variable to resolve.

### Step 7: Consolidate duplicate rule blocks

For each consolidation chosen in Step 3:

- Merge identical declaration bodies behind a single selector list (`.a, .b { ... }`), a shared utility class, a Sass `@extend` / `%placeholder`, or a mixin — whichever matches the project's style
- Preserve cascade order and specificity. If the original rules sat at different points in the stylesheet such that order mattered, verify the merged rule still wins / loses against the same neighbors
- Do not change the visible result. If two rule blocks differ by even a single declaration, do not merge them silently — surface the diff in the report instead and let the user decide

### Step 8: Validate that the rendered styles are unchanged

After each batch of changes, confirm:

- The build / bundler succeeds (`npm run build`, `vite build`, `next build`, `webpack`, the Sass compiler, etc., as applicable to the project)
- Any existing CSS linters pass (`stylelint`, `prettier --check`, project-configured rules) with no new warnings
- The existing test suite passes, including any visual regression / snapshot tests
- Spot-check the pages / components touched: open them (or their stories / fixtures) and confirm the visual result is identical to before the refactor
- Search the scope one more time for the original literal values; any remaining instances should be intentional and noted in the report

### Step 9: Summarize what changed

Produce a final summary listing:

- Variables introduced, with their values and where they now live
- Files updated, with the count of literal-to-variable substitutions per file
- Rule blocks consolidated, with before / after locations
- Items flagged for human decision that were left untouched, so the user can follow up

## Validation

- [ ] The scan scope and stylesheet inventory were confirmed before any analysis
- [ ] The project's existing variable mechanism (CSS custom properties, Sass partial, token file, etc.) was detected and reused — no competing system was introduced
- [ ] Every repeated literal acted on appears at least twice in the codebase and has a clearly semantic name
- [ ] The user received a structured report before any refactor was applied
- [ ] Only category 1 and 2 candidates were refactored automatically; categories 3 and 4 were flagged, not changed
- [ ] Each consolidated rule block produces byte-equivalent declarations to the originals (no silent declaration changes)
- [ ] Cascade order and specificity were preserved for every merged or moved rule
- [ ] Build, CSS linter, and test suite pass after the changes
- [ ] A summary of variables introduced, files updated, and items flagged for human review was produced

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Merging two rule blocks that look identical but differ in one declaration | Diff the full declaration bodies, not just selectors; never merge silently — flag and ask |
| Extracting a literal that is intentionally local (a one-off offset tuned for a single component) | Require at least two occurrences across at least two contexts before extracting; otherwise leave it inline |
| Picking names like `--blue-7` for values with a clear semantic role | Prefer semantic names (`--color-brand-primary`, `--space-gutter`) so the variable survives a palette change |
| Introducing a new variable system in a project that already has one | Detect existing tokens / variable files first and add to them; do not create `tokens.css` next to an existing `_variables.scss` |
| Breaking the cascade by reordering rules during consolidation | Keep merged rules at a position where their specificity and source order still produce the same winners; verify with a visual spot-check |
| Replacing `#fff` with `var(--color-white)` inside a context that has not imported the tokens file | Add the minimum import / `@use` / `<link>` needed; otherwise the variable resolves to its fallback or to `unset` |
| Treating near-duplicate colors (`#1f6feb` vs `#1e6fea`) as the same value | Do not auto-merge perceptually close but non-identical values; flag them for the user to confirm whether they should unify |
| Deleting rules that look overridden | This skill consolidates, it does not delete dead rules. Flag them and defer to the `cleanup` skill |
| Modifying compiled or vendored CSS | Operate on source stylesheets only; never edit build output or third-party bundles |
