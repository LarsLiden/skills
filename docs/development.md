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

The GitHub Actions workflow at `.github/workflows/ci.yml` runs on every push and pull request, executing `scripts/validate_manifests.py` against all skills. It must pass before a PR can be merged.

## Optional Subdirectories

A skill directory can include:

| Subdirectory | Purpose |
|---|---|
| `scripts/` | Executable scripts the agent can run as part of the workflow |
| `references/` | Supplementary documentation loaded on demand |
| `assets/` | Templates, images, or data files referenced by the skill |

These are optional — a skill with only a `SKILL.md` is perfectly valid.
