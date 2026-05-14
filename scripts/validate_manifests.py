#!/usr/bin/env python3
"""
Validates all SKILL.md files under skills/ against the Agent Skills specification.
  - Required frontmatter: name (kebab-case, matches folder), description (1-1024 chars)
  - SKILL.md body must be 500 lines or fewer

Run from the repository root: python scripts/validate_manifests.py
"""

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("Missing dependency: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

SKILLS_DIR = Path("skills")
NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")
MAX_DESCRIPTION_CHARS = 1024
MAX_BODY_LINES = 500


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Return (frontmatter_dict, body_text) or raise ValueError."""
    if not text.startswith("---"):
        raise ValueError("SKILL.md must start with '---' YAML frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError("Could not find closing '---' for frontmatter")
    fm = yaml.safe_load(parts[1]) or {}
    body = parts[2]
    return fm, body


def validate_skill(skill_md: Path) -> list[str]:
    errors = []
    folder_name = skill_md.parent.name
    text = skill_md.read_text(encoding="utf-8")

    try:
        fm, body = parse_frontmatter(text)
    except (ValueError, yaml.YAMLError) as e:
        return [f"Frontmatter parse error: {e}"]

    # name
    name = fm.get("name", "")
    if not name:
        errors.append("'name' field is missing or empty")
    elif not NAME_RE.match(name):
        errors.append(
            f"'name' must be lowercase letters, numbers, and hyphens only (got {name!r})"
        )
    elif name.endswith("-") or "--" in name:
        errors.append(f"'name' cannot end with a hyphen or contain consecutive hyphens (got {name!r})")
    elif len(name) > 64:
        errors.append(f"'name' must be 64 characters or fewer (got {len(name)})")
    elif name != folder_name:
        errors.append(
            f"'name' field ({name!r}) must match folder name ({folder_name!r})"
        )

    # description
    description = fm.get("description", "")
    if not description:
        errors.append("'description' field is missing or empty")
    elif len(str(description)) > MAX_DESCRIPTION_CHARS:
        errors.append(
            f"'description' must be {MAX_DESCRIPTION_CHARS} characters or fewer "
            f"(got {len(str(description))})"
        )

    # body length
    body_lines = body.count("\n")
    if body_lines > MAX_BODY_LINES:
        errors.append(
            f"SKILL.md body exceeds {MAX_BODY_LINES} lines ({body_lines} lines); "
            "move detailed content to a references/ subdirectory"
        )

    return errors


def main():
    manifests = sorted(SKILLS_DIR.glob("*/SKILL.md"))

    if not manifests:
        print("No SKILL.md files found — skipping validation.")
        return

    all_passed = True
    for skill_md in manifests:
        errors = validate_skill(skill_md)
        if errors:
            all_passed = False
            print(f"FAIL  {skill_md}")
            for err in errors:
                print(f"      - {err}")
        else:
            print(f"OK    {skill_md}")

    if not all_passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
