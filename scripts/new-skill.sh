#!/usr/bin/env bash
# Usage: bash scripts/new-skill.sh <skill-name>
# Creates a new skill directory under skills/ from skill-template/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SKILL_NAME="${1:-}"

if [[ -z "${SKILL_NAME}" ]]; then
  echo "Usage: $0 <skill-name>"
  echo "  skill-name must be kebab-case (e.g. code-summarizer)"
  exit 1
fi

# Validate kebab-case
if ! [[ "${SKILL_NAME}" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "Error: skill name must be kebab-case (lowercase letters, numbers, hyphens)."
  exit 1
fi

TARGET_DIR="${REPO_ROOT}/skills/${SKILL_NAME}"

if [[ -d "${TARGET_DIR}" ]]; then
  echo "Error: '${TARGET_DIR}' already exists."
  exit 1
fi

echo "Creating skill '${SKILL_NAME}' in ${TARGET_DIR} ..."
cp -r "${REPO_ROOT}/skill-template" "${TARGET_DIR}"

# Update the name field in skill.yml
sed -i "s/^name: example-skill$/name: ${SKILL_NAME}/" "${TARGET_DIR}/skill.yml"

echo ""
echo "Done! Next steps:"
echo "  1. Edit skills/${SKILL_NAME}/skill.yml  — fill in description, version, inputs/outputs"
echo "  2. Edit skills/${SKILL_NAME}/README.md  — document usage and examples"
echo "  3. Implement skills/${SKILL_NAME}/main.py (or replace with your entrypoint)"
echo "  4. Write tests in skills/${SKILL_NAME}/tests/"
