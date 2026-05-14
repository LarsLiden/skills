# Conventions

## Skill Names

- Must be **kebab-case**: lowercase letters, numbers, and hyphens only.
- Must start with a letter; cannot end with a hyphen; no consecutive hyphens (`--`).
- Maximum 64 characters.
- The `name` field in frontmatter must **exactly match** the containing folder name.
- Choose descriptive, action-oriented names:
  - ✅ `generate-release-notes`, `pr-reviewer`, `code-summarizer`
  - ❌ `MySkill`, `my_skill`, `-skill`, `skill--v2`

## SKILL.md Body

- Keep to **500 lines or fewer**. Move long reference material to `references/`.
- Use active-voice, agent-directed language in Workflow steps.
- Workflow steps should be concrete and unambiguous — the agent must be able to follow them without guessing.
- Always include a **Validation** section with observable success criteria.

## Frontmatter

- `name` and `description` are the only required fields.
- `description` should answer: *what does it do?* and *when should I use it?* Include trigger keywords.
- Optional: `license`, `compatibility`, `metadata` (author, version, tags).

## Self-Containment

Each skill must work independently:
- Reference supporting files using **relative paths** within the skill directory.
- Do **not** reference files in sibling skills.
- Document any external tool or system requirements in the `compatibility` frontmatter field.

## File and Directory Names

- Script files in `scripts/`: `kebab-case` with the appropriate extension (e.g., `run-check.sh`, `summarize.py`).
- Reference docs in `references/`: descriptive names in kebab-case (e.g., `api-reference.md`).
