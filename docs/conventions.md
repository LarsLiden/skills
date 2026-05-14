# Conventions

## Skill Names

- Must be **kebab-case**: lowercase letters, numbers, and hyphens only.
- Must start with a letter.
- The `name` field in `skill.yml` must exactly match the containing folder name.
- Choose descriptive names (e.g., `pr-summarizer`, `test-generator`, `code-reviewer`).

## Directory Layout

```
skills/
└── <skill-name>/
    ├── skill.yml          # Manifest — always required
    ├── README.md          # Usage docs — always required
    ├── main.py            # Primary entrypoint (or equivalent)
    ├── requirements.txt   # Python deps (if applicable)
    └── tests/
        └── test_skill.py
```

## Versioning

Follow [Semantic Versioning](https://semver.org/):

- `MAJOR` — breaking change to inputs/outputs/behaviour
- `MINOR` — new feature, backward-compatible
- `PATCH` — bug fix, backward-compatible

Start new skills at `0.1.0`.

## Language-Specific Conventions

### Python
- PEP 8 style.
- Use type hints (`def run(text: str) -> str:`).
- Tests with `pytest`; file names prefixed `test_`.

### JavaScript / TypeScript
- ESNext syntax; prefer `const`/`let`.
- Tests with `jest` or `vitest`; files suffixed `.test.ts` or `.spec.js`.

### Bash
- Shebang: `#!/usr/bin/env bash`
- Always include `set -euo pipefail`.

## Self-Containment

Each skill must be fully self-contained:

- Do **not** import from sibling skills.
- List all dependencies in `skill.yml` under `dependencies`.
- Include a `requirements.txt` or `package.json` for package dependencies.
