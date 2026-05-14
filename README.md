# laliden_skills

A personal skill library for software development — each skill is a self-contained, reusable unit that can be invoked as a tool or step in automated workflows.

## Repository Structure

```
laliden_skills/
├── skills/              # One subdirectory per skill
│   └── <skill-name>/
│       ├── skill.yml    # Manifest (name, version, inputs/outputs)
│       ├── README.md    # Usage docs
│       └── tests/       # Skill tests
├── skill-template/      # Starter template — copy to create a new skill
├── schema/
│   └── skill-schema.json  # JSON Schema for skill.yml validation
├── docs/                # Shared documentation
├── scripts/             # Utility scripts (scaffolding, validation)
└── .github/workflows/   # CI pipelines
```

## Adding a Skill

```bash
bash scripts/new-skill.sh my-skill-name
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to add and maintain skills
- [docs/development.md](docs/development.md) — local dev and testing guide
- [docs/conventions.md](docs/conventions.md) — naming and code-style rules
