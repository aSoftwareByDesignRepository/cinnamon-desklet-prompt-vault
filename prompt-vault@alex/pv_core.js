/*
 * Prompt Vault — pure domain logic (no Cinnamon / GJS UI).
 *
 * Shared by the desklet (via imports.pv_core) and Node test runners
 * (via module.exports). Keep this file free of imports.gi / St / Main.
 *
 * Copyright (C) 2026 Alexander Mäule <alex@software-by-design.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

var DATA_VERSION = 1;

var LIMITS = {
  title: 200,
  category: 60,
  tag: 40,
  tagsCount: 30,
  notes: 2000,
  content: 100000,
  templateVars: 30,
};

/** Horizontal chrome reserved inside a prompt row (star + actions + padding). */
var ROW_CHROME_PX = {
  star: 36,
  /** Labeled Copy + ⋯ more menu. */
  actions: 108,
  rowPadding: 16,
  bodyPadding: 12,
  gaps: 10,
};

/** Hard caps so a hostile JSON file cannot freeze Cinnamon or exhaust RAM. */
var STORE_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPrompts: 500,
  maxIdLen: 80,
};

var PANEL = {
  minWidth: 260,
  maxWidth: 640,
  defaultWidth: 400,
  minListHeight: 140,
  maxListHeight: 720,
  defaultListHeight: 300,
  rootPadX: 32,
};

/** Edit-dialog content area — independent of desklet list height. */
var DIALOG_CONTENT = {
  minViewport: 200,
  /** Fallback cap when screen height is unknown; real dialogs use dialogViewportBudget(). */
  maxViewport: 520,
  minEntry: 120,
  pad: 24,
  /** Horizontal chrome inside the scroll (padding + border). */
  textChromeX: 34,
  minTextWidth: 180,
  minDialogWidth: 420,
  maxDialogWidth: 680,
  /** Fixed dialog chrome below the scroll (meta fields, slots, buttons, margins). */
  dialogChromeHeight: 380,
};

var TEMPLATE_RE_SOURCE = "\\{\\{\\s*([^{}]+?)\\s*\\}\\}";

function _templateRe() {
  // Always a fresh /g regex. Reusing one global instance leaks lastIndex
  // (extractTemplateVars can break early at LIMITS.templateVars).
  return new RegExp(TEMPLATE_RE_SOURCE, "g");
}

function isReservedKey(name) {
  return name === "__proto__" || name === "constructor" || name === "prototype";
}

function isSafePromptId(id) {
  if (typeof id !== "string" || !id) return false;
  if (id.length > STORE_LIMITS.maxIdLen) return false;
  if (isReservedKey(id)) return false;
  if (/[\x00-\x1f\x7f\/\\]/.test(id)) return false;
  return true;
}

function isSafeTemplateVar(name) {
  name = asStr(name).trim();
  if (!name || name.length > 60) return false;
  if (isReservedKey(name)) return false;
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(name);
}

function isUsableDataDirPath(p) {
  p = asStr(p);
  if (!p || p.indexOf("\0") !== -1) return false;
  if (p.length > 4096) return false;
  return true;
}

function exceedsStoreLimits(promptCount, byteLength) {
  if (Number(promptCount) > STORE_LIMITS.maxPrompts) return "prompts";
  if (Number(byteLength) > STORE_LIMITS.maxBytes) return "bytes";
  return null;
}

function asStr(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function clampStr(s, max) {
  s = asStr(s);
  return s.length > max ? s.slice(0, max) : s;
}

function asIso(v) {
  if (typeof v !== "string" || !v) return null;
  var t = Date.parse(v);
  return Number.isFinite(t) ? v : null;
}

function asCount(v) {
  var n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function normalizeHotkeySlot(v) {
  var n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 9) return 0;
  return Math.floor(n);
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeTags(raw) {
  var arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") arr = raw.split(",");
  else return [];

  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < arr.length; i++) {
    var t = clampStr(String(arr[i]).trim(), LIMITS.tag);
    var key = t.toLowerCase();
    if (t && !seen[key]) {
      seen[key] = true;
      out.push(t);
      if (out.length >= LIMITS.tagsCount) break;
    }
  }
  return out;
}

function tagsToString(tags) {
  return normalizeTags(tags).join(", ");
}

function extractTemplateVars(content) {
  var re = _templateRe();
  var seen = Object.create(null);
  var out = [];
  var m;
  while ((m = re.exec(content)) !== null) {
    var name = m[1].trim();
    if (!isSafeTemplateVar(name) || seen[name]) continue;
    seen[name] = true;
    out.push(name);
    if (out.length >= LIMITS.templateVars) break;
  }
  return out;
}

function applyTemplate(content, values) {
  values = values && typeof values === "object" ? values : {};
  return asStr(content).replace(_templateRe(), function (match, rawName) {
    var key = rawName.trim();
    if (!isSafeTemplateVar(key)) return match;
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

/**
 * @param {object} raw
 * @param {{ uuid: function(): string, now: function(): string }} deps
 */
function sanitizePrompt(raw, deps) {
  if (!deps || typeof deps.uuid !== "function" || typeof deps.now !== "function") {
    throw new Error("sanitizePrompt requires deps.uuid and deps.now");
  }
  var p = isPlainObject(raw) ? raw : {};
  var now = deps.now();
  return {
    id: isSafePromptId(p.id) ? p.id : deps.uuid(),
    title: clampStr(asStr(p.title).trim() || "Untitled", LIMITS.title),
    category: clampStr(asStr(p.category).trim() || "General", LIMITS.category),
    content: clampStr(asStr(p.content), LIMITS.content),
    tags: normalizeTags(p.tags),
    notes: clampStr(asStr(p.notes), LIMITS.notes),
    favorite: !!p.favorite,
    hotkeySlot: normalizeHotkeySlot(p.hotkeySlot),
    createdAt: asIso(p.createdAt) || now,
    updatedAt: asIso(p.updatedAt) || asIso(p.createdAt) || now,
    lastUsedAt: asIso(p.lastUsedAt),
    useCount: asCount(p.useCount),
  };
}

/**
 * Later duplicate ids get a new uuid so delete-by-id / findIndex cannot
 * hit two rows at once. First claim keeps the original id.
 */
function uniquifyPromptIds(prompts, uuidFn) {
  if (typeof uuidFn !== "function") {
    throw new Error("uniquifyPromptIds requires uuidFn");
  }
  var seen = Object.create(null);
  var list = Array.isArray(prompts) ? prompts : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || typeof p !== "object") continue;
    var id = p.id;
    if (!isSafePromptId(id) || seen[id]) {
      var nextId = uuidFn();
      var guard = 0;
      while ((!isSafePromptId(nextId) || seen[nextId]) && guard < 32) {
        nextId = uuidFn();
        guard++;
      }
      p = Object.assign({}, p, { id: nextId });
    }
    seen[p.id] = true;
    out.push(p);
  }
  return out;
}

function sanitizePromptList(rawList, deps) {
  if (!deps || typeof deps.uuid !== "function" || typeof deps.now !== "function") {
    throw new Error("sanitizePromptList requires deps.uuid and deps.now");
  }
  if (!Array.isArray(rawList)) return [];
  var objects = [];
  var i;
  for (i = 0; i < rawList.length; i++) {
    if (isPlainObject(rawList[i])) objects.push(rawList[i]);
  }
  var sanitized = [];
  for (i = 0; i < objects.length; i++) {
    sanitized.push(sanitizePrompt(objects[i], deps));
  }
  return uniquifyPromptIds(sanitized, deps.uuid);
}

/**
 * After quarantine, prompts.json is gone but backups remain. Seeding samples
 * would hide the user's real data behind tutorial prompts.
 * Fail closed: unknown / hostile sibling counts never seed.
 */
function shouldSeedSamples(promptsFileExists, siblingJsonCount) {
  if (promptsFileExists !== false) return false;
  if (typeof siblingJsonCount !== "number" || !Number.isFinite(siblingJsonCount)) return false;
  if (siblingJsonCount < 0) return false;
  return siblingJsonCount === 0;
}

function countRecoverableVaultJson(fileNames, liveName) {
  liveName = asStr(liveName) || "prompts.json";
  if (!Array.isArray(fileNames)) return 0;
  var n = 0;
  for (var i = 0; i < fileNames.length; i++) {
    var name = asStr(fileNames[i]);
    if (!name || name === liveName || name === "prompts.json.lock") continue;
    var lower = name.toLowerCase();
    if (lower.length < 5 || lower.slice(-5) !== ".json") continue;
    n++;
  }
  return n;
}

/** Tab must propagate in list view (empty chain) — WCAG 2.1.2. */
function shouldTrapTab(focusChainLength) {
  var n = Number(focusChainLength);
  return Number.isFinite(n) && n > 0;
}

/** First claim wins; later duplicates are cleared. Mutates prompts in place. */
function dedupeHotkeySlots(prompts, nowFn) {
  var seen = {};
  var list = Array.isArray(prompts) ? prompts : [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var slot = normalizeHotkeySlot(p.hotkeySlot);
    p.hotkeySlot = slot;
    if (!slot) continue;
    if (seen[slot]) {
      p.hotkeySlot = 0;
      if (typeof nowFn === "function") p.updatedAt = nowFn();
    } else {
      seen[slot] = true;
    }
  }
  return list;
}

/**
 * Assign a slot to one prompt and clear it from others.
 * @returns {object[]} new prompts array (shallow-copied entries that change)
 */
function assignHotkeySlot(prompts, promptId, slot, nowFn) {
  slot = normalizeHotkeySlot(slot);
  var now = typeof nowFn === "function" ? nowFn() : null;
  return (prompts || []).map(function (p) {
    if (p.id === promptId) {
      var next = Object.assign({}, p, { hotkeySlot: slot });
      if (now) next.updatedAt = now;
      return next;
    }
    if (slot && p.hotkeySlot === slot) {
      var cleared = Object.assign({}, p, { hotkeySlot: 0 });
      if (now) cleared.updatedAt = now;
      return cleared;
    }
    return p;
  });
}

function parsePromptsPayload(parsed) {
  if (isPlainObject(parsed) && Array.isArray(parsed.prompts)) return parsed.prompts;
  if (Array.isArray(parsed)) return parsed;
  return null;
}

function mergePromptsById(existing, incoming) {
  var byId = Object.create(null);
  var i;
  var list = existing || [];
  for (i = 0; i < list.length; i++) {
    if (list[i] && isSafePromptId(list[i].id)) byId[list[i].id] = list[i];
  }
  list = incoming || [];
  for (i = 0; i < list.length; i++) {
    if (list[i] && isSafePromptId(list[i].id)) byId[list[i].id] = list[i];
  }
  return Object.keys(byId).map(function (k) {
    return byId[k];
  });
}

/**
 * Keep desklet field edits, but never lose a higher useCount written by the
 * hotkey CLI in the same file.
 */
function mergeUsageFromDisk(memory, disk) {
  var byId = Object.create(null);
  var i;
  var dlist = disk || [];
  for (i = 0; i < dlist.length; i++) {
    if (dlist[i] && isSafePromptId(dlist[i].id)) byId[dlist[i].id] = dlist[i];
  }
  return (memory || []).map(function (p) {
    var d = p && byId[p.id];
    if (!d) return p;
    var next = Object.assign({}, p);
    var mu = asCount(p.useCount);
    var du = asCount(d.useCount);
    next.useCount = mu > du ? mu : du;
    var mt = asIso(p.lastUsedAt);
    var dt = asIso(d.lastUsedAt);
    if (dt && (!mt || dt > mt)) next.lastUsedAt = d.lastUsedAt;
    return next;
  });
}

function clampPanelWidth(w) {
  var n = Number(w);
  if (!Number.isFinite(n)) n = PANEL.defaultWidth;
  return Math.max(PANEL.minWidth, Math.min(PANEL.maxWidth, n));
}

function clampListHeight(h) {
  var n = Number(h);
  if (!Number.isFinite(n)) n = PANEL.defaultListHeight;
  return Math.max(PANEL.minListHeight, Math.min(PANEL.maxListHeight, n));
}

/** Inner content width inside the root surface (accounts for root padding). */
function innerContentWidth(panelWidth) {
  return Math.max(200, clampPanelWidth(panelWidth) - PANEL.rootPadX - 4);
}

/**
 * Max pixel width available for the title text inside a row.
 * Must stay below viewport so the action column is never clipped.
 */
function titleWrapWidth(panelWidth) {
  var chrome =
    ROW_CHROME_PX.star +
    ROW_CHROME_PX.actions +
    ROW_CHROME_PX.rowPadding +
    ROW_CHROME_PX.bodyPadding +
    ROW_CHROME_PX.gaps;
  // Never invent a title width larger than (inner - chrome) — that clips actions.
  return Math.max(64, innerContentWidth(panelWidth) - chrome);
}

/**
 * Rough text block height when ClutterText.get_preferred_height under-reports
 * (common for 10k+ char prompts in Cinnamon St.Entry).
 *
 * @param {string} text
 * @param {number} textWidthPx
 * @param {object} [opts]
 * @returns {number}
 */
function estimateTextHeight(text, textWidthPx, opts) {
  opts = opts || {};
  var lineHeight = Number(opts.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = 20;
  var avgCharPx = Number(opts.avgCharPx);
  if (!Number.isFinite(avgCharPx) || avgCharPx <= 0) avgCharPx = 7.2;
  text = asStr(text);
  if (!text) return 0;
  var width = Number(textWidthPx);
  if (!Number.isFinite(width) || width <= 0) width = 400;
  var charsPerLine = Math.max(16, Math.floor(width / avgCharPx));
  var lines = text.split("\n");
  var totalLines = 0;
  for (var i = 0; i < lines.length; i++) {
    var len = lines[i].length;
    totalLines += Math.max(1, Math.ceil(len / charsPerLine));
  }
  return totalLines * lineHeight;
}

/**
 * Viewport height budget from monitor height (meta fields + buttons eat the rest).
 * @param {number} screenHeightPx
 * @param {object} [opts]
 * @returns {number}
 */
function dialogViewportBudget(screenHeightPx, opts) {
  opts = opts || {};
  var minView = Number(opts.minViewport);
  if (!Number.isFinite(minView)) minView = DIALOG_CONTENT.minViewport;
  var absMax = Number(opts.absMaxViewport);
  if (!Number.isFinite(absMax)) absMax = DIALOG_CONTENT.maxViewport;
  var chrome = Number(opts.chromeHeight);
  if (!Number.isFinite(chrome)) chrome = DIALOG_CONTENT.dialogChromeHeight;
  var h = Number(screenHeightPx);
  if (!Number.isFinite(h) || h <= 0) h = 900;
  var budget = Math.floor(h - chrome);
  return Math.max(minView, Math.min(absMax, budget));
}

/**
 * Dialog width + viewport budget from screen / desklet panel width.
 * @param {number} screenWidthPx
 * @param {number} screenHeightPx
 * @param {object} [opts]
 * @returns {{ dialogWidth: number, maxViewport: number, minViewport: number }}
 */
function dialogLayoutContext(screenWidthPx, screenHeightPx, opts) {
  opts = opts || {};
  var panelW = Number(opts.panelWidth);
  var screenW = Number(screenWidthPx);
  if (!Number.isFinite(screenW) || screenW <= 0) screenW = 1920;
  var fromPanel = Number.isFinite(panelW) && panelW > 0 ? panelW : 0;
  var fromScreen = Math.floor(screenW * 0.42);
  var targetW = Math.max(fromPanel, fromScreen, DIALOG_CONTENT.minDialogWidth);
  var dialogWidth = Math.max(
    DIALOG_CONTENT.minDialogWidth,
    Math.min(DIALOG_CONTENT.maxDialogWidth, Math.floor(targetW))
  );
  return {
    dialogWidth: dialogWidth,
    maxViewport: dialogViewportBudget(screenHeightPx, opts),
    minViewport: DIALOG_CONTENT.minViewport,
  };
}

/**
 * Dialog content textarea metrics.
 * Empty/new prompts get a tall editor (max viewport). Short prompts shrink-wrap.
 * Long prompts grow the entry to full text height; only the viewport caps so
 * ScrollView scrolls — never clip entryHeight to the viewport.
 *
 * CRITICAL: never couple this to desklet list_height, and never feed Pango.SCALE
 * into ClutterActor.set_size (pixels only).
 *
 * @param {number} preferredTextHeightPx - from ClutterText.get_preferred_height
 * @param {object} [opts]
 * @returns {{ viewportHeight: number, entryHeight: number, textWidth: number, innerWidth: number, needsScroll: boolean }}
 */
function dialogContentMetrics(preferredTextHeightPx, opts) {
  opts = opts || {};
  var minView = Number(opts.minViewport);
  var maxView = Number(opts.maxViewport);
  var minEntry = Number(opts.minEntry);
  var pad = Number(opts.pad);
  var dialogW = Number(opts.dialogWidth);
  if (!Number.isFinite(minView)) minView = DIALOG_CONTENT.minViewport;
  if (!Number.isFinite(maxView)) maxView = DIALOG_CONTENT.maxViewport;
  if (!Number.isFinite(minEntry)) minEntry = DIALOG_CONTENT.minEntry;
  if (!Number.isFinite(pad)) pad = DIALOG_CONTENT.pad;
  if (!Number.isFinite(dialogW)) dialogW = DIALOG_CONTENT.minDialogWidth;

  minView = Math.max(80, Math.floor(minView));
  maxView = Math.max(minView, Math.floor(maxView));
  minEntry = Math.max(40, Math.floor(minEntry));
  pad = Math.max(0, Math.floor(pad));

  var innerWidth = Math.max(
    DIALOG_CONTENT.minDialogWidth,
    Math.min(DIALOG_CONTENT.maxDialogWidth, Math.floor(dialogW))
  );
  var textWidth = Math.max(DIALOG_CONTENT.minTextWidth, innerWidth - DIALOG_CONTENT.textChromeX);

  var text = asStr(opts.text);
  var isEmpty = opts.isEmpty === true || text.length === 0;

  if (isEmpty) {
    var emptyEntry = Math.max(minEntry, maxView - 8);
    return {
      viewportHeight: maxView,
      entryHeight: emptyEntry,
      textWidth: textWidth,
      innerWidth: innerWidth,
      needsScroll: false,
    };
  }

  var pref = Number(preferredTextHeightPx);
  if (!Number.isFinite(pref) || pref < 0) pref = 0;
  pref = Math.floor(pref);
  var estimated = estimateTextHeight(text, textWidth, opts);
  var contentH = Math.max(pref, estimated);

  // Entry ALWAYS fits the full text. Never clamp to viewport (that clips content).
  var entryHeight = Math.max(minEntry, contentH + pad);
  var viewportHeight = Math.max(minView, Math.min(maxView, entryHeight));
  var needsScroll = entryHeight > viewportHeight + 1;

  return {
    viewportHeight: viewportHeight,
    entryHeight: entryHeight,
    textWidth: textWidth,
    innerWidth: innerWidth,
    needsScroll: needsScroll,
  };
}

/**
 * Pixel delta for forwarding wheel/touchpad scroll onto a ScrollView adjustment.
 * Pure helper so Clutter scroll-event wiring stays testable.
 *
 * @param {string} direction - "up"|"down"|"smooth"|"left"|"right"|other
 * @param {number} stepIncrement - adjustment.step_increment
 * @param {number} [smoothDy=0] - dy from SMOOTH scroll events
 * @returns {number} delta to add to adjustment.value (0 = ignore)
 */
function dialogScrollDelta(direction, stepIncrement, smoothDy) {
  var step = Number(stepIncrement);
  if (!Number.isFinite(step) || step <= 0) step = 40;
  var dir = asStr(direction).toLowerCase();
  if (dir === "up") return -step * 3;
  if (dir === "down") return step * 3;
  if (dir === "smooth") {
    var dy = Number(smoothDy);
    if (!Number.isFinite(dy) || dy === 0) return 0;
    return dy * step;
  }
  return 0;
}

/**
 * Clamp a scroll adjustment value into a valid range.
 * @param {number} value
 * @param {number} lower
 * @param {number} upper
 * @param {number} pageSize
 */
function clampScrollValue(value, lower, upper, pageSize) {
  var v = Number(value);
  var lo = Number(lower);
  var up = Number(upper);
  var page = Number(pageSize);
  if (!Number.isFinite(v)) v = 0;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(up)) up = 0;
  if (!Number.isFinite(page) || page < 0) page = 0;
  var max = Math.max(lo, up - page);
  if (v < lo) return lo;
  if (v > max) return max;
  return v;
}

/**
 * Responsive toolbar packing — same breakpoints as the original readable layout.
 * @returns {"one-row"|"two-row"|"stack"}
 */
function toolbarLayoutMode(panelWidth) {
  var w = clampPanelWidth(panelWidth);
  if (w >= 520) return "one-row";
  if (w >= 300) return "two-row";
  return "stack";
}

/** Canonical footer actions (order matters for packing). */
function toolbarButtons() {
  return [
    { id: "add", icon: "list-add-symbolic", style: "primary" },
    { id: "shortcuts", icon: "input-keyboard-symbolic", style: "shortcuts" },
    { id: "export", icon: "document-save-symbolic", style: "" },
    { id: "import", icon: "document-open-symbolic", style: "" },
    { id: "folder", icon: "folder-symbolic", style: "" },
  ];
}

/**
 * Pack buttons into rows so every label stays fully readable.
 * - one-row: all five across (wide desklets)
 * - two-row: Add+Shortcuts, then Export+Import+Folder
 * - stack: one full-width button per row (narrow)
 *
 * @param {string} mode
 * @returns {Array<{ id: string, buttons: Array }>}
 */
function toolbarRowsForMode(mode) {
  var btns = toolbarButtons();
  var m = asStr(mode).trim().toLowerCase();
  if (m === "one-row") {
    return [{ id: "all", buttons: btns.slice() }];
  }
  if (m === "stack") {
    return btns.map(function (b) {
      return { id: "row-" + b.id, buttons: [b] };
    });
  }
  // two-row (default / unknown)
  return [
    { id: "primary", buttons: [btns[0], btns[1]] },
    { id: "secondary", buttons: [btns[2], btns[3], btns[4]] },
  ];
}

/**
 * Blueprint for the current width. Remount destroys+recreates — never reparents.
 * @param {number} [panelWidth]
 */
function toolbarStructure(panelWidth) {
  var mode = toolbarLayoutMode(panelWidth);
  return {
    reparentSafe: true,
    remountStrategy: "destroy-and-recreate",
    mode: mode,
    rows: toolbarRowsForMode(mode),
  };
}

/**
 * Mount / remount plan. Same mode + existing rows ⇒ noop (no flicker).
 * Mode change ⇒ remount with fresh rows (caller destroys children first).
 *
 * @param {number|object} existingRowCountOrOpts
 * @param {string} [currentMode]
 * @param {string} [nextMode]
 */
function toolbarMountPlan(existingRowCountOrOpts, currentMode, nextMode) {
  var existing;
  var cur;
  var next;
  if (existingRowCountOrOpts && typeof existingRowCountOrOpts === "object") {
    existing = existingRowCountOrOpts.existingRowCount;
    cur = existingRowCountOrOpts.currentMode;
    next = existingRowCountOrOpts.nextMode;
  } else {
    existing = existingRowCountOrOpts;
    cur = currentMode;
    next = nextMode;
  }

  var n = Number(existing);
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.floor(n);

  var mode = asStr(next).trim().toLowerCase();
  if (mode !== "one-row" && mode !== "two-row" && mode !== "stack") {
    mode = "two-row";
  }
  var prev = asStr(cur).trim().toLowerCase();

  if (n > 0 && prev === mode) {
    return { op: "noop", reason: "mode-unchanged", mode: mode };
  }
  if (n > 0) {
    return {
      op: "remount",
      reason: "mode-changed",
      mode: mode,
      rows: toolbarRowsForMode(mode),
    };
  }
  return {
    op: "mount",
    reason: "initial-build",
    mode: mode,
    rows: toolbarRowsForMode(mode),
  };
}

/**
 * Max buttons allowed on any single toolbar row for a mode (readability guard).
 * @param {string} mode
 */
function toolbarMaxButtonsPerRow(mode) {
  var m = asStr(mode).trim().toLowerCase();
  if (m === "one-row") return 5;
  if (m === "stack") return 1;
  return 3; // two-row
}

/**
 * Decide whether a click copies immediately or opens the fill panel.
 * Default / undefined alwaysCopyRaw ⇒ copy raw (never trap the user in a form).
 * @param {string} content
 * @param {boolean} [alwaysCopyRaw]
 * @returns {{ action: "copy"|"fill", text: string|null, vars: string[] }}
 */
function resolveCopyPlan(content, alwaysCopyRaw) {
  var text = asStr(content);
  if (alwaysCopyRaw !== false) {
    return { action: "copy", text: text, vars: [] };
  }
  var vars = extractTemplateVars(text);
  if (!vars.length) {
    return { action: "copy", text: text, vars: [] };
  }
  return { action: "fill", text: null, vars: vars };
}

/**
 * Produce clipboard text after an optional fill-in step.
 * @param {string} content
 * @param {Object<string,string>|null} values
 * @param {boolean} raw
 */
function materializeCopyText(content, values, raw) {
  if (raw) return asStr(content);
  return applyTemplate(asStr(content), values || {});
}

function formatHotkeyLabel(slot, superLabel) {
  slot = normalizeHotkeySlot(slot);
  if (!slot) return "";
  var head = superLabel || "Super";
  return head + "+Ctrl+" + slot;
}

/** Short overview badge; full combo belongs in a tooltip via formatHotkeyLabel. */
function formatHotkeyCompact(slot) {
  slot = normalizeHotkeySlot(slot);
  if (!slot) return "";
  return "#" + slot;
}

function filterAndSortPrompts(prompts, opts) {
  opts = opts || {};
  var items = (prompts || []).slice();
  var favoritesOnly = !!opts.favoritesOnly;
  var categoryFilter = opts.categoryFilter || "all";
  var searchQuery = asStr(opts.searchQuery).trim().toLowerCase();
  var mode = opts.sortMode || "recent";

  if (favoritesOnly) {
    items = items.filter(function (p) {
      return p.favorite;
    });
  } else if (categoryFilter !== "all") {
    items = items.filter(function (p) {
      return p.category === categoryFilter;
    });
  }

  if (searchQuery) {
    items = items.filter(function (p) {
      return [p.title, p.category, p.content, p.notes, tagsToString(p.tags)]
        .join(" ")
        .toLowerCase()
        .indexOf(searchQuery) !== -1;
    });
  }

  items.sort(function (a, b) {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    if (mode === "title") return asStr(a.title).localeCompare(asStr(b.title));
    if (mode === "category") {
      var c = asStr(a.category).localeCompare(asStr(b.category));
      return c !== 0 ? c : asStr(a.title).localeCompare(asStr(b.title));
    }
    if (mode === "uses") {
      var d = (b.useCount || 0) - (a.useCount || 0);
      return d !== 0 ? d : asStr(a.title).localeCompare(asStr(b.title));
    }
    var at = a.lastUsedAt || a.updatedAt || a.createdAt || "";
    var bt = b.lastUsedAt || b.updatedAt || b.createdAt || "";
    return bt.localeCompare(at);
  });

  return items;
}

function uniqueCategories(prompts) {
  var set = {};
  var list = prompts || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].category) set[list[i].category] = true;
  }
  return Object.keys(set).sort(function (a, b) {
    return a.localeCompare(b);
  });
}

/**
 * Split categories into a short visible chip list and an overflow list for a ⋯ menu.
 * Keeps the selected category among the visible chips when possible.
 * @param {string[]} categories
 * @param {string} selectedCategory - current category filter, or "" / "all"
 * @param {number} maxVisible
 * @returns {{ visible: string[], overflow: string[] }}
 */
function partitionCategoryChips(categories, selectedCategory, maxVisible) {
  var max = Number(maxVisible);
  if (!Number.isFinite(max) || max < 0) max = 3;
  max = Math.floor(max);

  var cats = Array.isArray(categories) ? categories.slice() : [];
  var selected = asStr(selectedCategory).trim();
  if (!selected || selected === "all") selected = "";

  var visible = [];
  var used = {};

  if (selected) {
    for (var i = 0; i < cats.length; i++) {
      if (cats[i] === selected) {
        visible.push(selected);
        used[selected] = true;
        break;
      }
    }
  }

  for (var j = 0; j < cats.length; j++) {
    var c = cats[j];
    if (used[c]) continue;
    if (visible.length < max) {
      visible.push(c);
      used[c] = true;
    }
  }

  var overflow = [];
  for (var k = 0; k < cats.length; k++) {
    if (!used[cats[k]]) overflow.push(cats[k]);
  }

  return { visible: visible, overflow: overflow };
}

/**
 * Resolve the configured startup filter.
 * @param {string} mode - "all" | "favorites" | "category"
 * @param {string} categoryName - used when mode === "category"
 * @param {string[]} [knownCategories] - for case-insensitive match
 * @returns {{ favoritesOnly: boolean, categoryFilter: string }}
 */
function resolveDefaultFilter(mode, categoryName, knownCategories) {
  var m = asStr(mode).trim().toLowerCase();
  if (m === "favorites" || m === "favourite" || m === "favourites" || m === "fav") {
    return { favoritesOnly: true, categoryFilter: "all" };
  }
  if (m === "category") {
    var wanted = asStr(categoryName).trim();
    if (!wanted) return { favoritesOnly: false, categoryFilter: "all" };
    var cats = knownCategories || [];
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].toLowerCase() === wanted.toLowerCase()) {
        return { favoritesOnly: false, categoryFilter: cats[i] };
      }
    }
    return { favoritesOnly: false, categoryFilter: wanted };
  }
  return { favoritesOnly: false, categoryFilter: "all" };
}

/**
 * Apply a list-filter chip selection.
 * @param {{ type: string, category?: string }} selection
 * @returns {{ favoritesOnly: boolean, categoryFilter: string }}
 */
function selectListFilter(selection) {
  var sel = selection && typeof selection === "object" ? selection : {};
  var type = asStr(sel.type).trim().toLowerCase();
  if (type === "favorites" || type === "favourite" || type === "favourites") {
    return { favoritesOnly: true, categoryFilter: "all" };
  }
  if (type === "category") {
    var cat = asStr(sel.category).trim();
    if (!cat) return { favoritesOnly: false, categoryFilter: "all" };
    return { favoritesOnly: false, categoryFilter: cat };
  }
  return { favoritesOnly: false, categoryFilter: "all" };
}

function listFilterEquals(a, b) {
  a = a || {};
  b = b || {};
  return !!a.favoritesOnly === !!b.favoritesOnly && asStr(a.categoryFilter) === asStr(b.categoryFilter);
}

function listFilterSignature(state) {
  state = state || {};
  if (state.favoritesOnly) return "favorites";
  var cat = asStr(state.categoryFilter);
  if (!cat || cat === "all") return "all";
  return "category:" + cat;
}

function previewText(content, maxLen) {
  maxLen = maxLen || 160;
  var s = asStr(content).replace(/\s+/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// GJS exports every top-level binding. Node gets an explicit surface.
var PvCore = {
  DATA_VERSION: DATA_VERSION,
  LIMITS: LIMITS,
  STORE_LIMITS: STORE_LIMITS,
  ROW_CHROME_PX: ROW_CHROME_PX,
  PANEL: PANEL,
  DIALOG_CONTENT: DIALOG_CONTENT,
  asStr: asStr,
  clampStr: clampStr,
  asIso: asIso,
  asCount: asCount,
  normalizeHotkeySlot: normalizeHotkeySlot,
  isPlainObject: isPlainObject,
  normalizeTags: normalizeTags,
  tagsToString: tagsToString,
  extractTemplateVars: extractTemplateVars,
  applyTemplate: applyTemplate,
  sanitizePrompt: sanitizePrompt,
  uniquifyPromptIds: uniquifyPromptIds,
  sanitizePromptList: sanitizePromptList,
  shouldSeedSamples: shouldSeedSamples,
  countRecoverableVaultJson: countRecoverableVaultJson,
  shouldTrapTab: shouldTrapTab,
  dedupeHotkeySlots: dedupeHotkeySlots,
  assignHotkeySlot: assignHotkeySlot,
  parsePromptsPayload: parsePromptsPayload,
  mergePromptsById: mergePromptsById,
  mergeUsageFromDisk: mergeUsageFromDisk,
  isSafePromptId: isSafePromptId,
  isSafeTemplateVar: isSafeTemplateVar,
  isUsableDataDirPath: isUsableDataDirPath,
  exceedsStoreLimits: exceedsStoreLimits,
  clampPanelWidth: clampPanelWidth,
  clampListHeight: clampListHeight,
  innerContentWidth: innerContentWidth,
  titleWrapWidth: titleWrapWidth,
  estimateTextHeight: estimateTextHeight,
  dialogViewportBudget: dialogViewportBudget,
  dialogLayoutContext: dialogLayoutContext,
  dialogContentMetrics: dialogContentMetrics,
  dialogScrollDelta: dialogScrollDelta,
  clampScrollValue: clampScrollValue,
  toolbarLayoutMode: toolbarLayoutMode,
  toolbarButtons: toolbarButtons,
  toolbarRowsForMode: toolbarRowsForMode,
  toolbarStructure: toolbarStructure,
  toolbarMountPlan: toolbarMountPlan,
  toolbarMaxButtonsPerRow: toolbarMaxButtonsPerRow,
  resolveCopyPlan: resolveCopyPlan,
  materializeCopyText: materializeCopyText,
  formatHotkeyLabel: formatHotkeyLabel,
  formatHotkeyCompact: formatHotkeyCompact,
  filterAndSortPrompts: filterAndSortPrompts,
  uniqueCategories: uniqueCategories,
  partitionCategoryChips: partitionCategoryChips,
  resolveDefaultFilter: resolveDefaultFilter,
  selectListFilter: selectListFilter,
  listFilterEquals: listFilterEquals,
  listFilterSignature: listFilterSignature,
  previewText: previewText,
};

/* Stryker disable all: Node/CJS export shim — not domain logic */
if (typeof module !== "undefined" && module.exports) {
  module.exports = PvCore;
}
/* Stryker restore all */
