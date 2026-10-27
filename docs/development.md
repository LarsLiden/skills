# Developing Skills

## Prerequisites

- Git
- Python 3.10+ (for the validation script)
- `pyyaml` — `pip install pyyaml`

## Creating a New Skill

Use the scaffolding script:

```bash
bash scripts/new-skill.sh my-skill-name
```

This creates `skills/my-skill-name/SKILL.md` from `skill-template/SKILL.md` with the `name` field already set.

## Validating SKILL.md Files

```bash
python scripts/validate_manifests.py
```

This checks every `skills/*/SKILL.md`:
- `name` is present, kebab-case, ≤ 64 chars, matches the folder name
- `description` is present and ≤ 1024 characters
- Body is ≤ 500 lines

## CI

The GitHub Actions workflow at `.github/workflows/ci.yml` runs on pushes and pull
requests targeting `main`, executing `scripts/validate_manifests.py` against all
skills. It must pass before a PR can be merged.

## Copilot Desktop Extensions

Extensions live separately under `extensions/`, not `skills/`, and do not use
`SKILL.md` or `gh skill install`. See the
[Telegram bridge README](../extensions/telegram-bridge/README.md) for installation
and its [development guide](../extensions/telegram-bridge/DEVELOPMENT.md) for tests.
The path-scoped `.github/workflows/telegram-bridge.yml` checks JavaScript syntax
and runs isolated Node tests on Windows. Credentials and runtime artifacts are
never test prerequisites and must not be published.

## Optional Subdirectories

A skill directory can include:

| Subdirectory | Purpose |
|---|---|
| `scripts/` | Executable scripts the agent can run as part of the workflow |
| `references/` | Supplementary documentation loaded on demand |
| `assets/` | Templates, images, or data files referenced by the skill |

These are optional — a skill with only a `SKILL.md` is perfectly valid.
