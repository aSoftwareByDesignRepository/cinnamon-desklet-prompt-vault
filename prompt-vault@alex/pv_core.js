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
  star: 28,
  /** Copy + ⋯ more menu. */
  actions: 60,
  rowPadding: 14,
  bodyPadding: 10,
  gaps: 8,
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
  minViewport: 140,
  maxViewport: 220,
  minEntry: 120,
  pad: 20,
  /** Horizontal chrome inside the scroll (padding + border). */
  textChromeX: 34,
  minTextWidth: 180,
  minDialogWidth: 420,
  maxDialogWidth: 560,
};

var TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

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
  var seen = {};
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
  TEMPLATE_RE.lastIndex = 0;
  var seen = {};
  var out = [];
  var m;
  while ((m = TEMPLATE_RE.exec(content)) !== null) {
    var name = m[1].trim();
    if (name && !seen[name]) {
      seen[name] = true;
      out.push(name);
      if (out.length >= LIMITS.templateVars) break;
    }
  }
  return out;
}

function applyTemplate(content, values) {
  values = values || {};
  return asStr(content).replace(TEMPLATE_RE, function (match, rawName) {
    var key = rawName.trim();
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
    id: typeof p.id === "string" && p.id ? p.id : deps.uuid(),
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
  var byId = {};
  var i;
  var list = existing || [];
  for (i = 0; i < list.length; i++) byId[list[i].id] = list[i];
  list = incoming || [];
  for (i = 0; i < list.length; i++) byId[list[i].id] = list[i];
  return Object.keys(byId).map(function (k) {
    return byId[k];
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
 * Dialog content textarea metrics.
 * Shrink-wraps short prompts; caps the viewport so empty/new prompts never open
 * as a huge empty cavern. Entry may grow beyond the viewport (scroll handles it).
 *
 * CRITICAL: never couple this to desklet list_height, and never feed Pango.SCALE
 * into ClutterActor.set_size (pixels only).
 *
 * @param {number} preferredTextHeightPx - from ClutterText.get_preferred_height
 * @param {object} [opts]
 * @returns {{ viewportHeight: number, entryHeight: number, textWidth: number, innerWidth: number }}
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

  var pref = Number(preferredTextHeightPx);
  if (!Number.isFinite(pref) || pref < 0) pref = 0;
  pref = Math.floor(pref);

  var entryHeight = Math.max(minEntry, pref + pad);
  // Viewport follows content up to max — never forces empty space to list_height.
  var viewportHeight = Math.max(minView, Math.min(maxView, entryHeight));

  return {
    viewportHeight: viewportHeight,
    entryHeight: entryHeight,
    textWidth: textWidth,
    innerWidth: innerWidth,
  };
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
    if (mode === "title") return a.title.localeCompare(b.title);
    if (mode === "category") {
      var c = a.category.localeCompare(b.category);
      return c !== 0 ? c : a.title.localeCompare(b.title);
    }
    if (mode === "uses") {
      var d = (b.useCount || 0) - (a.useCount || 0);
      return d !== 0 ? d : a.title.localeCompare(b.title);
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
  dedupeHotkeySlots: dedupeHotkeySlots,
  assignHotkeySlot: assignHotkeySlot,
  parsePromptsPayload: parsePromptsPayload,
  mergePromptsById: mergePromptsById,
  clampPanelWidth: clampPanelWidth,
  clampListHeight: clampListHeight,
  innerContentWidth: innerContentWidth,
  titleWrapWidth: titleWrapWidth,
  dialogContentMetrics: dialogContentMetrics,
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
