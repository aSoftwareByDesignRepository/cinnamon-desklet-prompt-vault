# Prompt Vault — Cinnamon desklet

A small, fast desktop widget for **Linux Mint / Cinnamon** to store the prompts
you reuse, find them instantly, and copy them to the clipboard with one click.

![type: Cinnamon desklet](https://img.shields.io/badge/Cinnamon-desklet-blue)

## Features

- **Store prompts** with a title, category, tags, optional notes, and the text.
- **Search** across title, category, tags, notes and text as you type.
- **Filter** by category or by **Favorites** with one click.
- **Copy** to the clipboard by clicking a prompt (or the copy button). A green
  flash and a status line confirm it.
- **Always copy raw** (default) — prompts are copied exactly as stored. Turn off
  *Always copy raw text* in settings if you want `{{placeholder}}` fill-in before copy.
- **Usage stats** — prompts remember how often and how recently they were copied,
  and can be sorted by "most copied" or "recently used".
- **Global keyboard shortcuts** — assign each prompt to slot 1–9, install shortcuts once,
  then press **Super+Ctrl+1** … **Super+Ctrl+9** to **paste** that prompt
  into whatever field is focused (also copied to the clipboard; raw text, no `{{placeholder}}` fill).
- **Favorites, duplicate, edit, delete** — edit opens a proper dialog; optional
  template fill stays inline when *Always copy raw* is off, with optional delete
  confirmation.
- **Backup & restore** — export a timestamped JSON file; import via a file picker
  (zenity) or, if zenity is missing, `import.json` then the newest `*.json` in the
  data folder. A rolling auto-backup is written on each change **when that
  setting is on**. Auto-backup is optional; it is not a substitute for Export.
- **Portable** — point the data folder at a synced location (Dropbox, Nextcloud,
  a git repo, a USB stick) to take your prompts anywhere.

## Typing in a desklet (how focus works)

Desklets live on the desktop layer, which normally never receives the keyboard.
Prompt Vault takes a proper compositor input grab for the **search box** and
optional **template fill** forms (only when *Always copy raw* is off). **Add/edit**
opens a Cinnamon modal dialog (same mechanism as system confirmations) with its
own focus and scroll handling. The footer actions (**Add prompt**, Shortcuts,
Export, Import, Data folder) are a stable chrome strip — they are never
reparented during resize, so they cannot vanish.

- Typing, selection (drag or double-click), and the cursor all go to the field
  you clicked — never to a background window.
- **Esc** closes the form / clears the search and hands the keyboard back.
- **Click anywhere outside the desklet** to immediately release the keyboard.
- After you copy a prompt, the grab is released automatically.

### Keyboard shortcuts (inside a field)

| Shortcut | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move to the next / previous field (edit dialog and template fill). In the list search box, Tab is not trapped so focus can leave the desklet. |
| `Ctrl+A` | Select all |
| `Ctrl+C` / `Ctrl+X` | Copy / cut selection |
| `Ctrl+V` / `Shift+Insert` | Paste from clipboard |
| `Ctrl+Enter` | Save (add/edit form) |
| Middle-click | Paste primary selection (X11) |
| Right-click | Copy / Paste context menu |
| `Esc` | Cancel the form / clear search |

### Global copy shortcuts (system-wide)

1. Run `./install.sh` (installs CLI helpers into `~/.local/bin`).
2. In Prompt Vault, **Edit** a prompt → **Keyboard shortcut** → pick slot **1–9**.
3. Click **Shortcuts** in the toolbar (or right-click → **Install keyboard shortcuts**).
4. **Click into a text field**, then press **Super+Ctrl+1** … **Super+Ctrl+9** to paste that slot.

| Shortcut | Action |
| --- | --- |
| `Super+Ctrl+1` … `Super+Ctrl+9` | Paste prompt assigned to that slot |

Uses **Super+Ctrl** (not Super+Shift) to avoid conflicts with Cinnamon/Mint shortcuts
such as Super+1–9 app switching. Auto-paste on X11 uses **python3-xlib** (usually
already installed); **xdotool** is optional. On Wayland install **wtype** or **ydotool**.
Re-run **Shortcuts** after every `./install.sh` update.

Change bindings in **Settings → Keyboard → Custom Shortcuts** (entries named
*Prompt Vault: Slot N*). Re-run **Shortcuts** after changing the data folder in
desklet settings so commands point at the right `prompts.json`.

CLI (optional):

```bash
prompt-vault-copy --list          # show slot assignments
prompt-vault-copy --slot 3 --paste   # copy + auto-paste slot 3
./install.sh --shortcuts          # install desklet + register shortcuts
```

## Accessibility & design

- Self-contained high-contrast surface that stays legible on any wallpaper
  (text and UI controls meet WCAG 2.1 AA contrast on the panel background).
- Keyboard-operable data entry with always-visible 2px focus rings; every
  control has an accessible name and a hover tooltip.
- Status is never communicated by color alone — an icon and text carry the
  meaning too.
- Adjustable width and list height for different screens.

## Install

```bash
./install.sh
```

Then right-click the desktop → **Add Desklets** → **Prompt Vault** → **Add**.
If it doesn't show up immediately, reload Cinnamon with `Ctrl+Alt+Esc`.

## Data & storage

By default everything lives in:

```
~/.local/share/prompt-vault@alex/
├── prompts.json              # your prompts (chmod 600)
├── prompts.auto-backup.json  # rolling backup, refreshed on each change
└── prompts-backup-YYYY-MM-DD_HHMMSS.json   # manual exports
```

The directory is created `0700` and data files `0600` so other users on the
machine cannot read your prompts. You can change the folder in the desklet
settings (a leading `~` is expanded to your home directory).

### Importing

Click **Import (merge)** or **Import (replace all)** and pick a JSON file (zenity
file picker). If zenity is not installed, the desklet looks for `import.json` in
the data folder, then the newest `*.json` there. Accepted shapes:

```json
{ "version": 1, "prompts": [ { "title": "...", "content": "...", "category": "...", "tags": ["a","b"] } ] }
```

…or simply a top-level array of prompt objects. Unknown/invalid fields are
sanitized; non-object rows are skipped. Duplicate ids in a file are uniquified
(first keeps the id, later rows get a new id).

If `prompts.json` is unreadable it is **moved aside** (never silently deleted)
and the desklet shows an empty list — it does **not** write sample prompts over
a recoverable vault. If `prompts.json` is missing but other JSON files remain
in the folder (auto-backup, corrupt copy, export), samples are **not** seeded;
use Import to restore. Samples are only written on a truly empty first run.

## Data model

```jsonc
{
  "id": "uuid",
  "title": "string",
  "category": "string",
  "content": "string",
  "tags": ["string"],
  "notes": "string",
  "favorite": false,
  "hotkeySlot": 0,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastUsedAt": "ISO-8601 | null",
  "useCount": 0
}
```

## Tests

Domain logic lives in `prompt-vault@alex/pv_core.js` (shared by the desklet and Node).

```bash
npm install
npm run test:coverage    # unit + integration, coverage gates on pv_core.js
npm run test:python      # CLI slot/file helpers
npm run test:mutation    # Stryker on pv_core.js (break threshold 85)
```

## Uninstall

```bash
rm ~/.local/share/cinnamon/desklets/prompt-vault@alex
```

Your data in `~/.local/share/prompt-vault@alex/` is left untouched.

## License

Copyright © 2026 [Alexander Mäule](https://software-by-design.de).

Prompt Vault is free software: you can redistribute it and/or modify it under the
terms of the [GNU Affero General Public License v3.0 or later](LICENSE).

## Author

**Alexander Mäule** — [software-by-design.de](https://software-by-design.de) · [alex@software-by-design.de](mailto:alex@software-by-design.de) · [LinkedIn](https://www.linkedin.com/in/alexander-m%C3%A4ule-7788a7a/)
