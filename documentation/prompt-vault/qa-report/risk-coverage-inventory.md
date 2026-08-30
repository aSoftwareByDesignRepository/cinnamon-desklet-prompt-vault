# Prompt Vault — Risk & Coverage Inventory

**App:** `desklets/prompt-vault` (Cinnamon desklet `prompt-vault@alex` v1.9.1)  
**Date:** 2026-08-30  
**Environment:** Native Node + Python on the developer host — **no** `docker-compose.yml` in this repo (Docker note from the user’s broader Development tree does **not** apply here)  
**Auditor persona:** Momos (hostile QA / red-team)

## Purpose (verified against code, not README alone)

Local Linux Mint / Cinnamon **desklet** for storing reusable text prompts, searching/filtering them, copying to the clipboard (raw by default), and pasting via **Super+Ctrl+1–9** system shortcuts. Data lives as JSON under `~/.local/share/prompt-vault@alex/` (or a user-configured folder). **Single-user, local-only.** No HTTP API, no accounts, no tenancy.

## Actors & stakes

| Actor | Stakes if wrong |
|-------|-----------------|
| Desklet user | Lost prompts (quarantine + sample reseed; CLI/desklet race); wrong text pasted into another app; keyboard trap; unreadable UI on wallpaper |
| Same-machine other OS users | File modes 0700/0600 must keep vault private |
| Auditor / reviewer | README lies about “never lose state”, import flow, Favorites chip, mutation threshold |

## Auth / API surface

| Kind | Reality |
|------|---------|
| Multi-user auth | **None** |
| HTTP / REST / GraphQL | **None** |
| “Endpoints” in scope | Desklet UI actions, JSON load/save/import/export, CLI `prompt-vault-copy` / `hotkey` / `setup-shortcuts`, Cinnamon custom keybindings, clipboard, zenity file picker |
| Secrets | Prompt text itself is sensitive (API keys, personal content). Modes 0600/0700 matter |

OWASP API BOLA/IDOR (cross-user object access): **N/A** — no multi-user API. Residual threats mapped below.

## Critical invariants (code-derived)

1. **Copy raw by default:** one-click and hotkey copy put stored text on CLIPBOARD (and PRIMARY) unless `always_copy_raw === false` **and** `{{placeholders}}` exist.
2. **Hotkey slots 1–9 are unique** (first claim wins; later duplicates cleared).
3. **Corrupt `prompts.json` is quarantined**, never silently deleted; samples must **not** overwrite a recoverable vault (sibling JSON present).
4. **Missing `prompts.json` seeds samples only when no other `*.json` recoveries exist** (`shouldSeedSamples`).
5. **CLI hotkey copy must not drop prompts** added on disk during the copy (re-read + usage merge under shared lock).
6. **Duplicate prompt ids are uniquified on load/import** so delete-by-id cannot wipe two rows.
7. **Import rejects non-objects** (no Untitled junk from `null` rows); size/count caps enforced.
8. **Favorites sort first**; search is substring over title/category/tags/notes/content.
9. **Toolbar remount is destroy-and-recreate** (never reparent live buttons).
10. **Tab propagates in list view** (empty focus chain) — WCAG 2.1.2; traps only when a field chain exists.
11. **Keyboard grab** via `Main.pushModal` only while a field needs keys; copy releases grab.

## Apps / services in repo

| Module | Path | In scope |
|--------|------|----------|
| Domain core (GJS + Node) | `prompt-vault@alex/pv_core.js` | Yes |
| Desklet UI | `prompt-vault@alex/desklet.js` + `stylesheet.css` | Yes |
| Settings schema | `prompt-vault@alex/settings-schema.json` | Yes |
| CLI copy/paste | `bin/prompt-vault-copy` | Yes |
| Hotkey wrapper | `bin/prompt-vault-hotkey` | Yes |
| GSettings registrar | `bin/prompt-vault-setup-shortcuts` | Yes |
| Install | `install.sh` → `~/.local/bin` + desklet symlink | Yes |
| Other Development tree apps | `config_inc.php`, Nextcloud, etc. | **Out of scope** |

## Workflow inventory (severity)

| Workflow | Critical risks | Coverage status |
|----------|----------------|-----------------|
| Load / quarantine / seed | Sample reseed after quarantine; corrupt move-aside | **Fixed** + unit (`shouldSeedSamples`, `countRecoverableVaultJson`); GJS path wired |
| Save / auto-backup | Optional auto-backup; CLI vs desklet writers | **Fixed** mkdir `prompts.json.lockdir` + CLI re-read; residual: lock timeout still saves |
| Hotkey copy + paste | Drop prompts; wrong slot; paste into focused window | Python: concurrent-add, lock serialize; paste tool mocks |
| Import merge/replace | Hostile JSON, duplicate ids, NUL path, size caps | Unit/integration + desklet `sanitizePromptList` |
| Copy / template fill | Raw vs fill; lastIndex regex leak | Strong unit/e2e |
| Filter / search / favorites | Stuck favorites; chip sync | Integration + mutation hardening |
| Toolbar resize | Reparent destroy | E2E lifecycle |
| Shortcuts install | Empty gsettings `@as []` parse | Prior fix in setup script (not re-broken this pass) |
| Edit dialog layout | list_height coupling | Unit/integration/e2e |

## Shared-state / concurrency candidates

- Desklet `_saveData` vs CLI `cmd_copy_slot` on the same `prompts.json` → **mkdir lockdir** (both sides) + CLI re-read before write  
- `mergeUsageFromDisk` on desklet save (usage from CLI; does **not** adopt disk-only new prompts)  
- Stale GJS `imports.pv_core` across `ReloadXlet` → `_ensureCore` deletes cache  
- Zenity import async callback after desklet destroy  

## External dependency failure modes

| Dependency | Failure |
|------------|---------|
| CLIPBOARD / PRIMARY | Copy fails → status error; no silent success |
| zenity | Fallback `import.json` then newest `*.json` |
| xdotool / python3-xlib / wtype / ydotool | Paste fails → notify; copy still done |
| notify-send | Title/body may leak prompt title to notifications (Low) |
| Gio / GLib file IO | Quarantine on corrupt; status on save fail |

## OWASP-style checklist (mapped to this stack)

| Item | Result |
|------|--------|
| BOLA/IDOR | N/A (single-user) |
| Broken auth | N/A |
| Mass assignment | Import sanitizes fields; reserved ids/`__proto__` blocked |
| Resource consumption | `STORE_LIMITS` 5 MiB / 500 prompts / content caps |
| Function-level auth | N/A |
| Business flow abuse | Hotkey spam increments useCount; no payment flow |
| SSRF | No user URL fetch |
| Misconfig | Debug: none in desklet; verbose GJS logs only |
| Injection | JSON parse only; no shell with prompt content; gsettings commands from installer |
| Inventory | CLI flags documented; no hidden HTTP |
| Session/CSRF | N/A |
| Schema validation | Soft sanitize + caps, not OpenAPI |

## Existing suite (this engagement)

| Suite | Result |
|-------|--------|
| Node unit + integration + e2e | **123 pass / 0 fail / 0 skip** |
| c8 on `pv_core.js` | **100% stmts/lines/fns, 94.14% branches** (gates: 95/95/85/95) |
| Stryker | **85.05%** (1018 killed, 17 timeout, 182 survived) — break threshold 85 |
| Python CLI | **17 pass** via `test/python/run_cli_tests.py` (`python3 -m pytest` **not installed** on this host) |

## UI / accessibility

- Automated axe-core: **not applicable** to Cinnamon `St` widgets (no DOM).  
- Contrast/focus: claimed in `stylesheet.css` comments; not re-measured with a meter this pass.  
- Keyboard: `shouldTrapTab` unit-tested; list Tab propagates.
