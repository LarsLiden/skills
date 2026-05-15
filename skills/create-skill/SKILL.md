---
name: create-skill
description: Scaffolds a new Agent Skill in this repository. Use when creating a new skill, generating a SKILL.md file, or setting up a skill directory. Handles frontmatter, section structure, and spec compliance.
---

# Create Skill

This skill scaffolds a new Agent Skill that conforms to the [Agent Skills specification](https://agentskills.io/specification) and the conventions of this repository.

## When to Use

- Creating a new skill from scratch
- Generating a SKILL.md file with correct frontmatter
- Setting up a skill directory with optional subdirectories
- Checking compliance with the agentskills.io spec

## When Not to Use

- Modifying an existing skill (edit the SKILL.md directly instead)
- Adding supporting scripts or references to an existing skill

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Skill name | Yes | Lowercase, alphanumeric, hyphens only (e.g., `pr-summarizer`). Must match the directory name. |
| Description | Yes | What the skill does and when to use it (1–1024 characters, include trigger keywords). |
| Purpose | Yes | One paragraph describing the outcome. |
| Workflow steps | Recommended | Numbered steps the agent should follow. |

## Workflow

### Step 1: Validate the skill name

Ensure the name:
- Contains only lowercase letters, numbers, and hyphens
- Does not start or end with a hyphen
- Does not contain consecutive hyphens (`--`)
- Is between 1–64 characters long

### Step 2: Create the skill directory

```
skills/<skill-name>/
└── SKILL.md
```

Run the scaffolding script if available:

```bash
bash scripts/new-skill.sh <skill-name>
```

### Step 3: Write the SKILL.md frontmatter

The file must begin with YAML frontmatter:

```yaml
---
name: <skill-name>
description: <what it does and when to use it — 1–1024 characters>
---
```

Optional frontmatter fields:

```yaml
license: MIT
compatibility: Requires Python 3.10+
metadata:
  author: your-github-username
  version: "1.0"
```

### Step 4: Add body sections

Include these recommended sections in order:

1. **Purpose** — one paragraph, outcome-focused
2. **When to Use** — bullet list of triggers and scenarios
3. **When Not to Use** — explicit exclusions
4. **Inputs** — table of required and optional inputs
5. **Workflow** — numbered steps with concrete actions and checkpoints
6. **Validation** — observable success criteria as a checklist
7. **Common Pitfalls** — table of known problems and solutions

### Step 5: Add optional subdirectories (if needed)

```
skills/<skill-name>/
├── SKILL.md
├── scripts/       # Executable scripts the agent can run
├── references/    # Supporting documentation loaded on demand
└── assets/        # Templates, images, or data files
```

### Step 6: Validate the skill

Run the manifest validator:

```bash
python scripts/validate_manifests.py
```

Check manually that:
- `name` in frontmatter matches the directory name exactly
- `description` is non-empty and ≤ 1024 characters
- SKILL.md body is ≤ 500 lines
- All file references use relative paths
- No secrets, tokens, or internal URLs are included

### Step 7: Update README.md

Open `README.md` at the repository root and add a row for the new skill to the **Skills** table, keeping the rows sorted alphabetically by skill name:

```markdown
| [<skill-name>](skills/<skill-name>/SKILL.md) | <one-line description from frontmatter> |
```

If you are updating an existing skill whose description changed, update the corresponding row in the same table.

## Validation

- [ ] Skill directory exists at `skills/<skill-name>/`
- [ ] `SKILL.md` is present with valid YAML frontmatter
- [ ] `name` field matches directory name exactly
- [ ] `description` is present, non-empty, and ≤ 1024 characters
- [ ] Body contains Purpose, When to Use, Workflow, and Validation sections
- [ ] `python scripts/validate_manifests.py` reports `OK`
- [ ] `README.md` Skills table has been updated with the new or changed skill

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Name contains uppercase or spaces | Use only lowercase letters, numbers, and hyphens: `my-skill` not `My Skill` |
| `name` doesn't match directory | Rename directory or update frontmatter to match |
| Description is vague | Include what it does AND when to use it, with trigger keywords |
| Missing Workflow section | Always include numbered steps with concrete actions |
| Missing Validation section | Add observable success criteria so the agent can self-check |
| SKILL.md exceeds 500 lines | Move long reference material to `references/` subdirectory |
| Hardcoded paths or environment assumptions | Document requirements in `compatibility` frontmatter field |

## References

- [Agent Skills Specification](https://agentskills.io/specification)
- [skill-template/SKILL.md](../../skill-template/SKILL.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
