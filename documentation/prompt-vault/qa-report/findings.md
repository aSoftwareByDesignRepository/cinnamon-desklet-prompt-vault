# Prompt Vault QA Findings

**Product:** Prompt Vault Cinnamon desklet (`prompt-vault@alex` **1.9.1**)  
**Audit date:** 2026-08-30 (UTC)  
**Auditor:** Momos (hostile QA / red-team)  
**Environment:** Native Node + Python on the developer host — **no** Docker Compose for this app  
**Live vault checked after reload:** 22 prompts, 290000 bytes, mode `0600` (untouched)

---

## Executive Summary

**Not “never lose a prompt” bulletproof, but the worst data-loss holes found in this pass are fixed and regression-tested.** This is a single-user local desklet — there is no multi-user API, so classic BOLA/IDOR does not apply. What *does* apply is: corrupt-file recovery, CLI vs desklet writers on one JSON file, hostile import JSON, and keyboard accessibility.

| Severity | Open | Fixed this engagement |
|----------|------|------------------------|
| Critical | 0 | 0 (no cross-user data access class) |
| High | 1 residual | 3 fixed (sample reseed; CLI clobber; duplicate-id wipe) |
| Medium | 2 | 3 fixed (non-object import junk; README lies; tags `__proto__` map) |
| Low | 2 | 1 fixed (doc Favorites ★ / mutation threshold text) |

**Fit for a real client or auditor today?**  
**Conditional yes for personal / local use** after installing **1.9.1** and reloading the desklet. **No** if someone still quotes the old README line that a save can *never* lose previous state — auto-backup is optional, and if the shared lock cannot be acquired the desklet still saves (“saving anyway”). Mutation score clears the project gate (**85.05% ≥ 85**) but **182 survivors** remain (many equivalent `>`/`>=` / trim mutants) — treat that as unfinished sharpness, not proof of perfection.

Worst thing found this pass (now fixed): after a corrupt quarantine, a missing `prompts.json` **reseeded sample prompts** even when `prompts.auto-backup.json` / `prompts.corrupt-*.json` still sat in the folder — teaching the user the wrong vault was “the” vault.

---

## High

### [HIGH] [FIXED] Missing `prompts.json` reseeds samples over a recoverable vault

**What is wrong (in plain words):**  
If `prompts.json` was moved aside as corrupt (or deleted) but backup/corrupt JSON files still existed in the data folder, the next load wrote **tutorial sample prompts** into a new `prompts.json`. The real data was still on disk, but the UI looked like a fresh install.

**Where exactly:**  
- File: `prompt-vault@alex/desklet.js` — `_loadData` (seed branch)  
- File: `prompt-vault@alex/pv_core.js` — `shouldSeedSamples`, `countRecoverableVaultJson`  
- Workflow: corrupt load → quarantine → reload / Cinnamon restart

**How to reproduce it (copy-paste steps):**  
1. Before the fix, conceptually: empty/remove only `prompts.json` while leaving `prompts.auto-backup.json` in `~/.local/share/prompt-vault@alex/`, then reload the desklet → samples appeared.  
2. Unit proof (fails if seeding policy is wrong):
   ```bash
   cd /home/alex/Development/desklets/prompt-vault
   node --test test/unit/pv_core.test.js
   ```
   Tests under `shouldSeedSamples — missing prompts.json must not clobber recoveries` expect `shouldSeedSamples(false, 1) === false`.

**What should happen instead:**  
Seed samples **only** when the live file is missing **and** there are zero other recoverable `*.json` files. Otherwise show an empty list and tell the user to Import.

**Why this matters:**  
Users who hit a one-time corrupt read (or a bad reload) can believe their prompts are gone and start overwriting mental models — while the real file sits renamed beside them.

**Exact fix instructions:**  
1. In `pv_core.js`, keep `shouldSeedSamples(promptsFileExists, siblingJsonCount)` fail-closed (unknown counts → do not seed).  
2. In `desklet.js` `_loadData`, when `prompts.json` is missing, compute sibling count via `countRecoverableVaultJson(_listJsonCandidates().map(f => f.name))` and only then call `_samplePrompts()` + `_saveData`.  
3. Re-run the unit suite above.

**Proof this is fixed:**  
- `test/unit/pv_core.test.js` › `shouldSeedSamples — …`  
- Red when helpers were missing (`Core.shouldSeedSamples is not a function`); green after implementation (see `test-execution-log.md`)

---

### [HIGH] [FIXED] Hotkey CLI last-writer-wins dropped prompts the desklet just added

**What is wrong (in plain words):**  
Pressing Super+Ctrl+N runs `prompt-vault-copy`, which read the vault, copied text, then wrote back the **old** prompt list. If you added a prompt in the desklet while that copy ran, the new prompt could vanish from `prompts.json`.

**Where exactly:**  
- File: `bin/prompt-vault-copy` — `cmd_copy_slot`  
- Workflow: desklet Add/Edit save concurrent with hotkey copy

**How to reproduce it (copy-paste steps):**  
```bash
cd /home/alex/Development/desklets/prompt-vault
python3 test/python/run_cli_tests.py
# specifically: test_cmd_copy_slot_keeps_prompt_added_during_clipboard
```
The test stubs `_copy_to_clipboard` to append prompt `b` mid-copy. Old CLI wrote only `a` back → assertion `ids == {"a","b"}` failed.

**What should happen instead:**  
After clipboard copy, re-read the file under the lock, apply usage to the copied id, write the **latest** list (keep prompts added on disk). Desklet and CLI must share a lock the GJS side can take.

**Why this matters:**  
Losing a prompt you just typed is silent data loss with no error dialog — the copy “succeeds.”

**Exact fix instructions:**  
1. Replace fcntl-only `prompts.json.lock` with directory lock `prompts.json.lockdir` (`mkdir` / `rmdir`) in `prompt-vault-copy` `_file_lock`.  
2. Add `_apply_copy_usage`; after `_copy_to_clipboard`, `_load_json_locked` again and save merged usage.  
3. In `desklet.js`, wrap `_saveData` with `_acquireDataLock` / `_releaseDataLock` on the same lockdir name.  
4. Re-run `python3 test/python/run_cli_tests.py`.

**Proof this is fixed:**  
- `test_cmd_copy_slot_keeps_prompt_added_during_clipboard` — red before re-read, green after  
- `test_dir_lock_serializes_two_usage_increments` — two threads → `useCount == 2`

---

### [HIGH] [FIXED] Duplicate prompt ids: delete one row deletes every row with that id

**What is wrong (in plain words):**  
If a vault or import contained two prompts with the same `id`, Delete (and several findIndex updates) operated on **every** row with that id. One click could remove two prompts.

**Where exactly:**  
- File: `prompt-vault@alex/desklet.js` — `_deletePrompt` uses `filter((p) => p.id !== prompt.id)`  
- File: `prompt-vault@alex/pv_core.js` — `uniquifyPromptIds` / `sanitizePromptList`  
- Workflow: load or import hostile/hand-edited JSON → Delete

**How to reproduce it:**  
```bash
node --test test/unit/pv_core.test.js
# uniquifyPromptIds + sanitizePromptList › keeps the first id and rewrites later duplicates…
```

**What should happen instead:**  
On load/import, first row keeps the id; later duplicates get new uuids before any UI action.

**Why this matters:**  
Silent multi-delete from a single user gesture; import of merged backups can create duplicate ids.

**Exact fix instructions:**  
1. Implement `uniquifyPromptIds` + `sanitizePromptList` in `pv_core.js`.  
2. Use `sanitizePromptList` in `_loadData`, `_importFromPath`, and disk merge for usage.  
3. Re-run unit tests above.

**Proof this is fixed:**  
- Unit tests for uniquify + sanitizePromptList (red when missing, green after)

---

### [HIGH] [OPEN] Lock acquire failure still saves (“saving anyway”)

**What is wrong (in plain words):**  
If the desklet cannot create `prompts.json.lockdir` within ~5 seconds, it logs a warning and **saves without the lock**. The CLI clobber class of bug can return under heavy contention or a stuck lockdir.

**Where exactly:**  
- File: `prompt-vault@alex/desklet.js` — `_acquireDataLock` returns `null` then `_saveData` continues  
- Workflow: CLI holds lock >5s (slow paste tools) while user edits

**How to reproduce it:**  
1. Manually `mkdir ~/.local/share/prompt-vault@alex/prompts.json.lockdir` and leave it.  
2. Edit a prompt in the desklet and save.  
3. Observe warning in Looking Glass / `.xsession-errors`; save still occurs.

**What should happen instead:**  
Prefer fail-closed: refuse save with a clear status (“Could not lock vault; try again”) after timeout, or steal only clearly stale locks with user-visible notice.

**Why this matters:**  
The High CLI race is mitigated for the happy path; this is the remaining hole in the same invariant.

**Exact fix instructions:**  
1. When `_acquireDataLock` returns `null`, return `false` from `_saveData` without writing (or only write after a confirmed stale lock steal >10s with status text).  
2. Add a Node-level characterization test for the policy function if extracted to `pv_core`, or a documented manual test in the execution log.  
3. Re-attack with a stuck lockdir.

**Proof this is fixed:**  
- Not fixed this engagement — listed as open High.

---

## Medium

### [MEDIUM] [FIXED] Import/`map(sanitize)` turned `null` rows into “Untitled” prompts

**What is wrong (in plain words):**  
A JSON array containing `null` or numbers was sanitized into real Untitled prompts instead of being skipped.

**Where exactly:**  
- `sanitizePromptList` in `pv_core.js`; desklet import path

**How to reproduce it:**  
```bash
node --test test/unit/pv_core.test.js
# drops non-object import rows instead of minting Untitled junk
```

**What should happen instead:**  
Only plain objects become prompts.

**Why this matters:**  
Hostile or broken exports pollute the vault with junk rows that look like user content.

**Exact fix instructions:**  
Use `sanitizePromptList` (filters `isPlainObject`) on load/import.

**Proof this is fixed:**  
- Unit test named above — red without helper, green after

---

### [MEDIUM] [FIXED] README disagreed with the code (import, “never lose state”, samples, Favorites, mutation threshold)

**What is wrong (in plain words):**  
Docs told users to drop `import.json` only; claimed a save can never lose state; said corrupt files “start fresh” (samples); still described Favorites as ★; mutation threshold listed as 80 while Stryker break is 85.

**Where exactly:**  
- File: `README.md` (updated this engagement to match code)

**How to reproduce it:**  
Diff README vs `desklet.js` `_chooseImportFile` / `_loadData` / chip label `_("Favorites")` / `stryker.conf.cjs` `break: 85`.

**What should happen instead:**  
Docs match runtime behavior (zenity picker, optional auto-backup, no sample seed when recoveries exist, Favorites word, threshold 85).

**Why this matters:**  
Misleading recovery instructions are how users destroy the wrong file.

**Exact fix instructions:**  
Already applied in `README.md`. Keep docs in the same PR as behavior changes.

**Proof this is fixed:**  
- README sections Importing / Features / Tests updated; remaining honesty: auto-backup is optional (see open High lock note)

---

### [MEDIUM] [FIXED] `normalizeTags` used a normal object as a “seen” map

**What is wrong (in plain words):**  
Tag dedupe used `var seen = {}`, which is unsafe if a tag key ever collides with special property names.

**Where exactly:**  
- `pv_core.js` `normalizeTags`

**How to reproduce it:**  
```bash
node --test test/unit/pv_core.test.js
# normalizeTags does not use a prototype-pollutable seen map
```

**What should happen instead:**  
`Object.create(null)` for the seen map (same pattern as merge-by-id).

**Proof this is fixed:**  
- Unit assertion + `Object.create(null)` in code

---

### [MEDIUM] [OPEN] `python3 -m pytest` is not available on this host

**What is wrong (in plain words):**  
`npm run test:python` prefers `python3 -m pytest`, but this machine has **no pytest module and no pip**. CLI tests still run via `test/python/run_cli_tests.py` fallback.

**Where exactly:**  
- `package.json` script `test:python`  
- Host: `python3 -m pytest` → `No module named pytest`

**How to reproduce it:**  
```bash
python3 -m pytest -q test/python
# /usr/bin/python3: No module named pytest
python3 test/python/run_cli_tests.py   # 17 passed
```

**What should happen instead:**  
CI/dev machines install pytest, **or** document the fallback as the supported path.

**Why this matters:**  
A green `npm run test:all` is a lie if someone only looks at the pytest primary command and ignores the `||` fallback.

**Exact fix instructions:**  
1. Install pytest into the environment used for CI, **or**  
2. Make `test:python` call `run_cli_tests.py` first and treat pytest as optional.

**Proof this is fixed:**  
- Open — fallback works; primary command does not

---

### [MEDIUM] [OPEN] 182 Stryker survivors remain (score only just clears 85)

**What is wrong (in plain words):**  
Mutation testing passed the break gate at **85.05%**, but **182** mutants still survived (many equivalent: `>` vs `>=` on slice lengths, `toLowerCase` vs `toUpperCase` for ASCII tag keys, empty-array fallbacks never hit in tests).

**Where exactly:**  
- Report: `reports/mutation/index.html`  
- Config: `stryker.conf.cjs` `thresholds.break: 85`

**How to reproduce it:**  
```bash
npm run test:mutation
# Final mutation score of 85.05 … break threshold 85
```

**What should happen instead:**  
Either kill more survivors with sharper tests, or document equivalent mutants explicitly and optionally raise `high` without lying about coverage quality.

**Why this matters:**  
A score of 85.05 means the suite is one soft patch away from failing the gate again; survivors near copy/sort paths are not all equivalent.

**Exact fix instructions:**  
1. Open `reports/mutation/index.html`, filter Survived.  
2. Prioritize non-equivalent survivors in `filterAndSortPrompts` / toolbar / `partitionCategoryChips`.  
3. Add tests until score is comfortably above 85 (e.g. ≥90) or mark true equivalents in an ignore comment with reason.

**Proof this is fixed:**  
- Open — gate green, sharpness incomplete

---

## Low

### [LOW] [OPEN] `data_dir` may contain `..` (trusted local path, not a sandbox)

**What is wrong (in plain words):**  
`isUsableDataDirPath` rejects NUL and overlong paths but allows strings like `/home/alex/../../tmp`. This is intentional for USB/sync layouts, not a multi-user jail.

**Where exactly:**  
- `pv_core.js` `isUsableDataDirPath`  
- Desklet setting `data_dir`

**What should happen instead:**  
Document that the setting is a **trusted path** chosen by the same user. Do not block `/media/...` by over-eager `..` rejection.

**Why this matters:**  
Low for a single-user desklet; would be higher if the path were attacker-controlled remotely (it is not).

**Exact fix instructions:**  
Keep current behavior; README already notes portable folders. Optional: canonicalize for display only.

---

### [LOW] [OPEN] Prompt titles can appear in desktop notifications

**What is wrong (in plain words):**  
Successful copy/paste notifications include the prompt title via `notify-send` / Cinnamon notify.

**Where exactly:**  
- `bin/prompt-vault-copy` `_notify`; desklet status/notify paths

**What should happen instead:**  
Optional setting to redact titles in notifications, or notify “Copied slot N” only.

**Why this matters:**  
Titles may contain sensitive project names; notification history is often less protected than `0600` JSON.

---

### [LOW] [FIXED earlier / verified] Tab no longer traps focus in list search

**What is wrong (in plain words):**  
List view focus chain is empty; Tab must propagate (WCAG 2.1.2). Encoded as `shouldTrapTab`.

**Proof:**  
- `test/unit/pv_core.test.js` › `shouldTrapTab — WCAG 2.1.2…`  
- Desklet `_handleEntryKeyPress` uses `PvCore.shouldTrapTab`

---

## Auth / API checklist note

No HTTP multi-user surface. Residual adversarial cases covered by tests: hostile import ids (`__proto__`, path-like ids), store size caps, lock + re-read, sample seed policy. **Inherent:** X11 XTEST / xdotool paste types into whichever window is focused — by design for Super+Ctrl paste; not a bug, but users must focus the target field first.

---

## Open Questions

1. Should a stuck `prompts.json.lockdir` after crash auto-steal after N seconds **without** user confirmation, or should the desklet always refuse save until the user clears it?  
2. Can we run an accessibility meter against Cinnamon `St` widgets in this environment, or is CSS-comment WCAG claiming the accepted standard for desklets?  
3. Should `npm run test:python` require a real pytest install in CI images going forward?  
4. Is losing disk-only prompts on desklet save (when `mergeUsageFromDisk` keeps memory as source of truth) acceptable forever, or should save also adopt unknown ids from disk under the lock?

---

## Test suite quality (honest)

| Claim | Evidence |
|-------|----------|
| Dummy assertions | None found in new tests; assertions check ids, counts, seed policy, error **messages** |
| Skipped tests | **0** in Node run |
| Coverage | c8: **100%** lines/stmts/fns, **94.14%** branches on `pv_core.js` |
| Mutation | **85.05%** (1018 killed, 17 timeout, 182 survived) |
| GJS UI E2E | Not automated (ReloadXlet + vault count smoke only) |
| axe | Not run (no DOM) |
