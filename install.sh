#!/usr/bin/env bash
#
# Install (or update) the Prompt Vault desklet for the current user.
# Uses a symlink so edits in this repo are picked up after a Cinnamon reload.
set -euo pipefail

UUID="prompt-vault@alex"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${UUID}"
DEST_DIR="${HOME}/.local/share/cinnamon/desklets"
DEST="${DEST_DIR}/${UUID}"

if [[ ! -f "${SRC}/metadata.json" ]]; then
  echo "error: ${SRC}/metadata.json not found. Run this script from the repo." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

# Replace any previous install (symlink or copied directory).
if [[ -L "${DEST}" || -e "${DEST}" ]]; then
  rm -rf "${DEST}"
fi
ln -s "${SRC}" "${DEST}"

echo "Installed Prompt Vault:"
echo "  ${DEST} -> ${SRC}"
echo
echo "Next:"
echo "  1. Right-click the desktop → 'Add Desklets' → Prompt Vault → Add."
echo "  2. If it does not appear, reload Cinnamon (Ctrl+Alt+Esc) or log out/in."
