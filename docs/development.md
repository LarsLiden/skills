# Developing Skills

## Prerequisites

- Git
- Python 3.10+ (for Python-based skills and the CI validation script)
- `pytest` (`pip install pytest`)
- `jsonschema` and `pyyaml` (`pip install jsonschema pyyaml`)

## Creating a New Skill

Use the scaffolding script:

```bash
bash scripts/new-skill.sh my-skill-name
```

This copies `skill-template/` into `skills/my-skill-name/` and patches the name field in `skill.yml`.

## Running Tests Locally

Run tests for a single skill:

```bash
pytest skills/my-skill-name/tests/ -v
```

Run tests for all skills:

```bash
for d in skills/*/; do
  [ -d "${d}tests" ] && pytest "${d}tests/" -v
done
```

## Validating Manifests

```bash
python scripts/validate_manifests.py
```

This checks every `skills/*/skill.yml` against `schema/skill-schema.json` and also verifies that the `name` field matches the folder name.

## CI

The GitHub Actions workflow at `.github/workflows/ci.yml` runs on every push and pull request:

1. **validate-manifests** — runs `scripts/validate_manifests.py`
2. **test-skills** — discovers and runs `pytest` in every `skills/*/tests/` directory

Both jobs must pass before a PR can be merged.
