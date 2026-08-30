# Prompt Vault — Test Execution Log

**App:** `desklets/prompt-vault`  
**Host:** Linux, native (no Docker for this app)  
**Auditor:** Momos  
**All timestamps UTC unless noted**

Commands run from:
```bash
cd /home/alex/Development/desklets/prompt-vault
```

---

## 2026-08-30T09:59:21Z — RED baseline (helpers missing)

### Node (expected failures)

```text
node --test test/unit/pv_core.test.js test/integration/workflows.test.js
# tests 58
# pass 48
# fail 10
```

Representative errors:
```text
TypeError: Core.shouldSeedSamples is not a function
TypeError: Core.countRecoverableVaultJson is not a function
TypeError: Core.uniquifyPromptIds is not a function
TypeError: Core.sanitizePromptList is not a function
TypeError: Core.shouldTrapTab is not a function
```

### Python primary command (broken on this host)

```text
python3 -m pytest -q test/python/test_prompt_vault_copy.py
/usr/bin/python3: No module named pytest
```

Also: `python3 -m pip` → `No module named pip`.

---

## 2026-08-30T10:02:28Z — GREEN after core/CLI/desklet fixes

### Full Node suite

```text
date -u --iso-8601=seconds
2026-08-30T10:02:28+00:00

node --test test/unit/*.test.js test/integration/*.test.js test/e2e/*.test.js
# tests 111
# suites 34
# pass 111
# fail 0
# skipped 0
# duration_ms 98.888018
```

### CLI syntax

```text
python3 -m py_compile bin/prompt-vault-copy
COMPILE_OK
```

---

## 2026-08-30T10:02:53Z — Python CLI via fallback runner

```text
python3 test/python/run_cli_tests.py
ok   test_apply_copy_usage_increments_only_copied_id
ok   test_cmd_copy_slot_keeps_prompt_added_during_clipboard
ok   test_data_dir_tilde_expansion
ok   test_dir_lock_serializes_two_usage_increments
ok   test_find_by_slot_first_match
ok   test_load_save_roundtrip_locked
ok   test_normalize_slot[(1, 1)]
… (parametrized rows) …
ok   test_paste_clipboard_falls_back_to_xlib
ok   test_paste_clipboard_prefers_xdotool
ok   test_paste_clipboard_wayland_needs_tool
17 passed, 0 failed, 17 total
```

**Red→green note:** `test_cmd_copy_slot_keeps_prompt_added_during_clipboard` fails against the pre-fix CLI (writes stale snapshot without prompt `b`); passes after re-read + `_apply_copy_usage`.

---

## 2026-08-30T10:03:06Z — Live vault + c8 coverage

```text
prompts 22 bytes 290000 mode 0o600

npm run test:coverage
# tests 111 pass
------------|---------|----------|---------|---------|-------------------
File        | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
------------|---------|----------|---------|---------|-------------------
 pv_core.js |    99.8 |    92.69 |     100 |    99.8 | 244-245
------------|---------|----------|---------|---------|-------------------
```

(Thresholds: lines/fns/stmts 95, branches 85 — **passed**.)

---

## 2026-08-30T10:03:20Z — Desklet reload smoke

```text
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
  --method org.Cinnamon.ReloadXlet 'prompt-vault@alex' 'DESKLET'
()
after_reload prompts 22 bytes 290000
```

---

## 2026-08-30T10:03:30Z — Stryker run 1 (below gate)

```text
npm run test:mutation
Instrumented 1 source file(s) with 1224 mutant(s)
…
All files | 82.83 | 991 killed | 17 timeout | 209 survived
ERROR Final mutation score 82.83 under breaking threshold 85
Done in 1 minute 39 seconds.
```

---

## 2026-08-30T10:06:04Z — Stryker run 2 (after boundary tests)

```text
npm run test:mutation
All files | 84.63 | 1013 killed | 17 timeout | 187 survived
ERROR Final mutation score 84.63 under breaking threshold 85
Done in 2 minutes 37 seconds.
```

---

## 2026-08-30T10:06:02Z — Node suite after mutation-hardening additions

```text
# tests 119
# pass 119
# fail 0
```

---

## 2026-08-30T10:11:00Z — Stryker run 3 (gate cleared)

```text
npm run test:mutation
All files | 85.05 | 1018 killed | 17 timeout | 182 survived
INFO Final mutation score of 85.05 is greater than or equal to break threshold 85
Done in 2 minutes 10 seconds.
EXIT:0
```

HTML report: `file:///home/alex/Development/desklets/prompt-vault/reports/mutation/index.html`

---

## 2026-08-30T10:14:28Z — Final proof pack (post-report drafting)

```text
node --test test/unit/*.test.js test/integration/*.test.js test/e2e/*.test.js
# tests 123
# suites 35
# pass 123
# fail 0
# skipped 0

npm run test:coverage
------------|---------|----------|---------|---------|----------------------------------------------
File        | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
------------|---------|----------|---------|---------|----------------------------------------------
 pv_core.js |     100 |    94.14 |     100 |     100 | … (branch detail only)
------------|---------|----------|---------|---------|----------------------------------------------

python3 test/python/run_cli_tests.py
17 passed, 0 failed, 17 total

vault: prompts 22 bytes 290000 mode 0o600
```

---

## Accessibility / axe

**Not executed.** Cinnamon `St` has no HTML DOM for axe-core / Playwright. Keyboard policy covered by unit tests (`shouldTrapTab`). Contrast claimed in `stylesheet.css` header comments; no meter run this engagement.

---

## Commands cheat-sheet used

```bash
node --test test/unit/*.test.js test/integration/*.test.js test/e2e/*.test.js
npm run test:coverage
npm run test:mutation
python3 test/python/run_cli_tests.py   # preferred on hosts without pytest
# python3 -m pytest -q test/python     # preferred when pytest exists
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
  --method org.Cinnamon.ReloadXlet 'prompt-vault@alex' 'DESKLET'
```
