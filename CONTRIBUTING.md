# Contributing to laliden_skills

Thank you for contributing! This guide explains how to add and maintain skills in this repository.

Skills follow the open [Agent Skills specification](https://agentskills.io/specification): each skill is a directory containing a `SKILL.md` file with YAML frontmatter and Markdown instructions that agents follow when activated.

## Table of Contents

- [Repository Structure](#repository-structure)
- [Adding a New Skill](#adding-a-new-skill)
- [SKILL.md Format](#skillmd-format)
- [Naming Conventions](#naming-conventions)
- [Submitting a Pull Request](#submitting-a-pull-request)

---

## Repository Structure

```
laliden_skills/
├── skills/                  # Each skill lives in its own subdirectory
│   └── <skill-name>/
│       ├── SKILL.md         # Required: frontmatter + agent instructions
│       ├── scripts/         # Optional: executable scripts the agent can run
│       ├── references/      # Optional: supporting docs loaded on demand
│       └── assets/          # Optional: templates, images, data files
├── skill-template/
│   └── SKILL.md             # Starter template for new skills
├── scripts/
│   ├── new-skill.sh         # Scaffolding script
│   └── validate_manifests.py # SKILL.md validation script
├── docs/                    # Shared documentation
└── .github/workflows/       # CI pipelines
```

---

## Adding a New Skill

1. **Scaffold from the template:**
   ```bash
   bash scripts/new-skill.sh my-skill-name
   ```
   This creates `skills/my-skill-name/SKILL.md` from `skill-template/SKILL.md`.

2. **Edit `SKILL.md`:**
   - Update `description` in the YAML frontmatter — make it specific and include trigger keywords.
   - Fill in all recommended body sections (see [SKILL.md Format](#skillmd-format)).

3. **Add optional supporting files** in `scripts/`, `references/`, or `assets/` if needed.

4. **Validate locally:**
   ```bash
   python scripts/validate_manifests.py
   ```

5. **Open a pull request** — CI will validate all `SKILL.md` files automatically.

---

## SKILL.md Format

Every skill **must** have a `SKILL.md` at its root with valid YAML frontmatter.

### Required frontmatter fields

```yaml
---
name: my-skill-name
description: What the skill does and when to use it. Include trigger keywords.
---
```

| Field | Rules |
|-------|-------|
| `name` | Lowercase letters, numbers, hyphens only. 1–64 characters. Must match the folder name. |
| `description` | 1–1024 characters. Clearly describes what the skill does *and* when to use it. |

### Optional frontmatter fields

```yaml
license: MIT
compatibility: Requires Python 3.10+
metadata:
  author: your-github-username
  version: "1.0"
```

### Recommended body sections

1. **Purpose** — one paragraph, outcome-focused
2. **When to Use** — bullet list of triggers and scenarios
3. **When Not to Use** — explicit exclusions
4. **Inputs** — table of required/optional inputs
5. **Workflow** — numbered steps with concrete, actionable instructions
6. **Validation** — observable success criteria (checklist)
7. **Common Pitfalls** — table of known problems and solutions

Keep `SKILL.md` to **500 lines or fewer**. Move long reference material to a `references/` subdirectory.

---

## Naming Conventions

- **Skill directory and `name` field**: `kebab-case` — lowercase letters, numbers, hyphens.
- Cannot start or end with a hyphen, or contain consecutive hyphens (`--`).
- Choose descriptive, action-oriented names (e.g., `generate-release-notes`, `pr-reviewer`, `code-summarizer`).
- The `name` field in frontmatter must **exactly match** the folder name.

---

## Submitting a Pull Request

1. Ensure `python scripts/validate_manifests.py` passes locally.
2. Fill in the PR template completely.
3. One skill addition/change per PR where practical.
