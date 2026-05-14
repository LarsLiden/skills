#!/usr/bin/env bash
# Usage: bash scripts/new-skill.sh <skill-name>
# Creates a new skill directory under skills/ from skill-template/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SKILL_NAME="${1:-}"

if [[ -z "${SKILL_NAME}" ]]; then
  echo "Usage: $0 <skill-name>"
  echo "  skill-name must be kebab-case (e.g. pr-summarizer)"
  exit 1
fi

# Validate: lowercase letters, numbers, hyphens; no leading/trailing/consecutive hyphens
if ! [[ "${SKILL_NAME}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$ ]]; then
  echo "Error: skill name must be kebab-case (lowercase letters, numbers, hyphens; cannot start/end with a hyphen)."
  exit 1
fi
if [[ "${SKILL_NAME}" == *"--"* ]]; then
  echo "Error: skill name cannot contain consecutive hyphens."
  exit 1
fi
if [[ ${#SKILL_NAME} -gt 64 ]]; then
  echo "Error: skill name must be 64 characters or fewer."
  exit 1
fi

TARGET_DIR="${REPO_ROOT}/skills/${SKILL_NAME}"

if [[ -d "${TARGET_DIR}" ]]; then
  echo "Error: '${TARGET_DIR}' already exists."
  exit 1
fi

echo "Creating skill '${SKILL_NAME}' in ${TARGET_DIR} ..."
mkdir -p "${TARGET_DIR}"

# Copy template SKILL.md and substitute placeholder name
TEMPLATE="${REPO_ROOT}/skill-template/SKILL.md"
DEST="${TARGET_DIR}/SKILL.md"

if [[ "$(uname)" == "Darwin" ]]; then
  sed "s/^name: skill-name$/name: ${SKILL_NAME}/" "${TEMPLATE}" > "${DEST}"
else
  sed "s/^name: skill-name$/name: ${SKILL_NAME}/" "${TEMPLATE}" > "${DEST}"
fi

echo ""
echo "Done! Next steps:"
echo "  1. Edit skills/${SKILL_NAME}/SKILL.md"
echo "     - Update 'description' in the YAML frontmatter"
echo "     - Fill in Purpose, When to Use, Workflow, and Validation sections"
echo "  2. (Optional) Add scripts/, references/, or assets/ subdirectories"
echo "  3. Run: python scripts/validate_manifests.py"
