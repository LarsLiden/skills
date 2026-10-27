# laliden_skills

A personal library of [Agent Skills](https://agentskills.io/specification) for software development — reusable instruction sets that teach coding agents how to perform specialised tasks.

The repository also contains separately installable Copilot desktop extensions.
For phone notifications and two-way agent messaging, see the
[Telegram bridge installation and setup guide](extensions/telegram-bridge/README.md).

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
├── extensions/              # Copilot desktop extensions (not Agent Skills)
│   └── telegram-bridge/
│       ├── README.md        # Installation, pairing, usage and troubleshooting
│       └── extension.mjs    # Copilot runtime entrypoint
├── scripts/
│   ├── new-skill.sh         # Scaffold a new skill
│   └── validate_manifests.py # Validate SKILL.md files
└── docs/                    # Shared documentation
```

## Skills

| Skill | Description |
|-------|-------------|
| [big-merge](skills/big-merge/SKILL.md) | Performs large branch reconciliation by applying mainline PRs one at a time with conflict checkpoints and manual-test approval gates |
| [cleanup](skills/cleanup/SKILL.md) | Scans for dead code and unused tests, then removes them |
| [cleanup-css](skills/cleanup-css/SKILL.md) | Deep-dives the project's CSS to consolidate duplicate styles and extract repeated values (colors, spacing, breakpoints) into shared variables |
| [conflict-monitor](skills/conflict-monitor/SKILL.md) | Runs daily to detect potential feature-level conflicts between your work and teammates' changes in open PRs and main |
| [create-skill](skills/create-skill/SKILL.md) | Scaffolds a new Agent Skill in this repository |
| [document](skills/document/SKILL.md) | Updates documentation to reflect recent code changes |
| [fallback](skills/fallback/SKILL.md) | Finds and removes fallback behaviors that mask real bugs while preserving visible error handling |
| [reccomended-refactors](skills/reccomended-refactors/SKILL.md) | Analyzes a repository for refactoring opportunities and produces a prioritized report |
| [statusreport](skills/statusreport/SKILL.md) | Produces a read-only work-status table with descriptions, original conversation estimates beside remaining agent-time estimates or Done, and an honest remaining total |

## Using Skills in Another Repository

Install any skill from this library into your own repository with the GitHub CLI:

```bash
gh skill install LarsLiden/skills cleanup --scope user
gh skill install LarsLiden/skills conflict-monitor --scope user
gh skill install LarsLiden/skills document --scope user
gh skill install LarsLiden/skills fallback --scope user
gh skill install LarsLiden/skills statusreport --agent github-copilot --scope user
```

The first argument is the repository in `OWNER/REPO` format and the second is the skill name. To install every skill from this repository interactively, omit the skill name:

```bash
gh skill install LarsLiden/skills --scope user
```

With `--scope user`, skills are installed in the selected agent's user-level directory and are available across projects on that computer. For GitHub Copilot, this is `~/.copilot/skills/<skill-name>/`. Run the install command on each computer; publishing a skill here does not automatically synchronize installations. Without `--scope user`, GitHub Copilot uses the repository's `.agents/skills/<skill-name>/` directory. Once installed, compatible agents discover skills when they load their configuration; start a new session if an existing session has not refreshed its skill list.

## Adding a Skill

```bash
bash scripts/new-skill.sh my-skill-name
# Edit skills/my-skill-name/SKILL.md
python scripts/validate_manifests.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## Copilot Desktop Extensions

| Extension | Description |
|-----------|-------------|
| [telegram-bridge](extensions/telegram-bridge/README.md) | Windows phone notifications, exact question answers, first/final agent replies and per-session Telegram topics |

Extensions do **not** use `gh skill install`. In Copilot desktop, ask:

```text
Install this Copilot canvas extension at user scope:
https://github.com/LarsLiden/skills/tree/main/extensions/telegram-bridge
```

Follow the extension's README to create a dedicated bot and pair your phone.
Use one bot per simultaneously active computer, and never copy or commit its
local `artifacts` directory. User-scope installations apply across projects on
that computer, but are not automatically synchronized to other computers.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to add and maintain skills
- [docs/development.md](docs/development.md) — local dev and validation guide
- [docs/conventions.md](docs/conventions.md) — naming and structure rules
- [Agent Skills Specification](https://agentskills.io/specification)
