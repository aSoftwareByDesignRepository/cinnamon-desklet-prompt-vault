#!/usr/bin/env bash
# Copyright (C) 2026 Alexander Mäule <alex@software-by-design.de>
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Install (or update) the Prompt Vault desklet and CLI helpers for the current user.
# Uses a symlink so edits in this repo are picked up after a Cinnamon reload.
set -euo pipefail

UUID="prompt-vault@alex"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${REPO_ROOT}/${UUID}"
DEST_DIR="${HOME}/.local/share/cinnamon/desklets"
DEST="${DEST_DIR}/${UUID}"
BIN_DIR="${HOME}/.local/bin"
INSTALL_SHORTCUTS=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--shortcuts]

  Installs the desklet (symlink) and CLI tools into ~/.local/bin.

  --shortcuts   Also register Super+Shift+1–9 Cinnamon custom shortcuts.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shortcuts) INSTALL_SHORTCUTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ ! -f "${SRC}/metadata.json" ]]; then
  echo "error: ${SRC}/metadata.json not found. Run this script from the repo." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}" "${BIN_DIR}"

# Replace any previous install (symlink or copied directory).
if [[ -L "${DEST}" || -e "${DEST}" ]]; then
  rm -rf "${DEST}"
fi
ln -s "${SRC}" "${DEST}"

for script in prompt-vault-copy prompt-vault-setup-shortcuts; do
  src="${REPO_ROOT}/bin/${script}"
  if [[ ! -f "${src}" ]]; then
    echo "error: missing ${src}" >&2
    exit 1
  fi
  chmod +x "${src}"
  ln -sf "${src}" "${BIN_DIR}/${script}"
done

echo "Installed Prompt Vault:"
echo "  Desklet: ${DEST} -> ${SRC}"
echo "  CLI:     ${BIN_DIR}/prompt-vault-copy"
echo "           ${BIN_DIR}/prompt-vault-setup-shortcuts"
echo
echo "Next:"
echo "  1. Right-click the desktop → 'Add Desklets' → Prompt Vault → Add."
echo "  2. Edit prompts → pick keyboard slot 1–9 → click Shortcuts (toolbar)."
echo "  3. Press Super+Shift+1–9 anywhere to copy that slot to the clipboard."
echo "  4. If the desklet does not appear, reload Cinnamon (Ctrl+Alt+Esc) or log out/in."

if [[ "${INSTALL_SHORTCUTS}" -eq 1 ]]; then
  echo
  "${BIN_DIR}/prompt-vault-setup-shortcuts"
fi
