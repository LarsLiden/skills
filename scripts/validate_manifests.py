#!/usr/bin/env python3
"""
Validates all skill.yml files against schema/skill-schema.json.
Run from the repository root: python scripts/validate_manifests.py
"""

import json
import sys
from pathlib import Path

import yaml
import jsonschema

SCHEMA_PATH = Path("schema/skill-schema.json")
SKILLS_DIR = Path("skills")


def load_schema() -> dict:
    with SCHEMA_PATH.open() as f:
        return json.load(f)


def validate_manifest(manifest_path: Path, schema: dict) -> list[str]:
    with manifest_path.open() as f:
        data = yaml.safe_load(f)

    errors = []
    try:
        jsonschema.validate(instance=data, schema=schema)
    except jsonschema.ValidationError as e:
        errors.append(str(e.message))

    # Extra check: skill name must match its folder name
    folder_name = manifest_path.parent.name
    skill_name = data.get("name", "")
    if skill_name != folder_name:
        errors.append(
            f"skill 'name' field ({skill_name!r}) must match folder name ({folder_name!r})"
        )

    return errors


def main():
    schema = load_schema()
    manifests = sorted(SKILLS_DIR.glob("*/skill.yml"))

    if not manifests:
        print("No skill manifests found — skipping validation.")
        return

    all_passed = True
    for manifest_path in manifests:
        errors = validate_manifest(manifest_path, schema)
        if errors:
            all_passed = False
            print(f"FAIL  {manifest_path}")
            for err in errors:
                print(f"      - {err}")
        else:
            print(f"OK    {manifest_path}")

    if not all_passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
