# Contributing to laliden_skills

Thank you for contributing! This guide explains how to add, modify, and maintain skills in this repository.

## Table of Contents

- [Repository Structure](#repository-structure)
- [Adding a New Skill](#adding-a-new-skill)
- [Skill Manifest (`skill.yml`)](#skill-manifest-skillyml)
- [Naming Conventions](#naming-conventions)
- [Testing Requirements](#testing-requirements)
- [Code Style](#code-style)
- [Submitting a Pull Request](#submitting-a-pull-request)

---

## Repository Structure

```
laliden_skills/
├── skills/                  # Each skill lives in its own subdirectory
│   └── <skill-name>/
│       ├── skill.yml        # Skill manifest (required)
│       ├── README.md        # Usage docs (required)
│       ├── main.py          # Entrypoint (or equivalent)
│       └── tests/           # Tests for this skill
├── skill-template/          # Copy this when creating a new skill
├── schema/
│   └── skill-schema.json    # JSON Schema for skill.yml validation
├── docs/                    # Shared documentation
├── scripts/                 # Utility scripts
└── .github/workflows/       # CI pipelines
```

---

## Adding a New Skill

1. **Scaffold from the template:**
   ```bash
   bash scripts/new-skill.sh my-skill-name
   ```
   This copies `skill-template/` into `skills/my-skill-name/`.

2. **Fill in `skill.yml`** — see [Skill Manifest](#skill-manifest-skillyml) below.

3. **Implement the skill** in your chosen language.

4. **Write tests** under `skills/my-skill-name/tests/`.

5. **Update `README.md`** in your skill directory with usage examples.

6. **Open a pull request** — the CI will validate your manifest and run tests.

---

## Skill Manifest (`skill.yml`)

Every skill **must** have a `skill.yml` at its root. The schema is defined in
[`schema/skill-schema.json`](schema/skill-schema.json).

Required fields:

| Field         | Description                                            |
|---------------|--------------------------------------------------------|
| `name`        | Unique kebab-case identifier (must match folder name)  |
| `description` | Short one-line description                             |
| `version`     | Semantic version (`MAJOR.MINOR.PATCH`)                 |
| `entrypoint`  | Relative path to the main executable/script            |

See [`skill-template/skill.yml`](skill-template/skill.yml) for a full example.

---

## Naming Conventions

- **Skill directory and `name` field**: `kebab-case`, lowercase, descriptive (e.g., `code-summarizer`, `pr-reviewer`)
- **Python files**: `snake_case`
- **JavaScript/TypeScript files**: `camelCase`
- **Test files**: prefixed with `test_` (Python) or suffixed with `.test.ts` / `.spec.js`

---

## Testing Requirements

- Every skill **must** have at least one test under its `tests/` directory.
- Tests must be runnable without external network access where possible.
- Python skills: use `pytest`. JavaScript/TypeScript: use `jest` or `vitest`.
- CI runs all tests on every pull request.

---

## Code Style

- **Python**: PEP 8. Use type hints where possible.
- **JavaScript/TypeScript**: Follow the existing style in the file; prefer `const`/`let`.
- **Shell scripts**: Use `#!/usr/bin/env bash`, `set -euo pipefail`.
- Keep each skill self-contained — do not import code from sibling skills.

---

## Submitting a Pull Request

1. Ensure all CI checks pass.
2. Fill in the PR template completely.
3. One skill addition/change per PR where practical.
4. Add a short description of what the skill does and why it's useful.
