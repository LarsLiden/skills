# laliden_skills

A personal library of [Agent Skills](https://agentskills.io/specification) for software development — reusable instruction sets that teach coding agents how to perform specialised tasks.

## What is an Agent Skill?

An Agent Skill is a directory containing a `SKILL.md` file with:
- **YAML frontmatter** — `name` and `description` (used by agents for discovery)
- **Markdown body** — step-by-step instructions the agent follows when activated

Skills are framework-agnostic and work with any tool that supports the open Agent Skills specification (Claude Code, Copilot, Cursor, Kiro, and others).

## Repository Structure

```
laliden_skills/
├── skills/                  # One subdirectory per skill
│   └── <skill-name>/
│       ├── SKILL.md         # Frontmatter + agent instructions (required)
│       ├── scripts/         # Optional: executable scripts
│       ├── references/      # Optional: supporting docs
│       └── assets/          # Optional: templates and data files
├── skill-template/
│   └── SKILL.md             # Starter template for new skills
├── scripts/
│   ├── new-skill.sh         # Scaffold a new skill
│   └── validate_manifests.py # Validate SKILL.md files
└── docs/                    # Shared documentation
```

## Skills

| Skill | Description |
|-------|-------------|
| [create-skill](skills/create-skill/SKILL.md) | Scaffolds a new Agent Skill in this repository |
| [fallback](skills/fallback/SKILL.md) | Finds and removes fallback behaviors that mask real bugs while preserving visible error handling |

## Adding a Skill

```bash
bash scripts/new-skill.sh my-skill-name
# Edit skills/my-skill-name/SKILL.md
python scripts/validate_manifests.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to add and maintain skills
- [docs/development.md](docs/development.md) — local dev and validation guide
- [docs/conventions.md](docs/conventions.md) — naming and structure rules
- [Agent Skills Specification](https://agentskills.io/specification)
