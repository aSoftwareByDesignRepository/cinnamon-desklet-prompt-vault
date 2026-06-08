/*
 * Prompt Vault — a Cinnamon desklet to store, search and copy reusable prompts.
 *
 * Copyright (C) 2026 Alexander Mäule <alex@software-by-design.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://software-by-design.de
 * https://www.linkedin.com/in/alexander-m%C3%A4ule-7788a7a/
 *
 * Design notes (verified against Cinnamon 6.0.4 / cjs on Linux Mint):
 *  - Desklet is an ES6 class and is safe to extend.
 *  - Add/edit uses a Cinnamon ModalDialog (proper layout, focus & scroll).
 *  - Template fill and search use inline panels.
 *
 *  KEYBOARD INPUT — the hard part for desklets:
 *  Desklets live on the desktop "stage" window which normally never holds the
 *  window-manager keyboard focus. The old trick of set_stage_input_mode(FOCUSED)
 *  is unreliable: per cinnamon-global.c it silently reverts to NORMAL the moment
 *  the stage loses focus (which is immediately, because clicking a desklet does
 *  NOT focus the overlay window) and it is a complete no-op on Wayland. The
 *  result is the classic "my typing goes to the previously focused window" bug.
 *
 *  The robust fix (used by every Cinnamon modal dialog / popup menu) is a real
 *  compositor grab via Main.pushModal()/Main.popModal(), which performs
 *  global.begin_modal() and routes ALL keyboard + pointer input to the stage.
 *  We acquire that grab while a text field needs the keyboard (including for the
 *  whole add/edit session) and release it on Escape, on a click outside the
 *  desklet, after a copy, and on teardown. Focus always goes to ClutterText
 *  (entry.clutter_text), never the St.Entry shell or an inner scroll container.
 *
 *  - ModalDialog handles add/edit; ConfirmDialog for delete/import only.
 */

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const Cinnamon = imports.gi.Cinnamon;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Tooltips = imports.ui.tooltips;
const Main = imports.ui.main;
const CinnamonEntry = imports.ui.cinnamonEntry;

const UUID = "prompt-vault@alex";
const DATA_VERSION = 1;
const DEFAULT_DATA_SUBDIR = ["prompt-vault@alex"];
// Must match prompt-vault-setup-shortcuts default (Super+Ctrl avoids Super+1–9 app-switch conflicts).
const HOTKEY_COMBO_LABEL = _("Super") + "+Ctrl+";

// Hard limits to keep the UI and data files sane and resistant to malformed
// or hostile import files.
const LIMITS = {
  title: 200,
  category: 60,
  tag: 40,
  tagsCount: 30,
  notes: 2000,
  content: 100000,
  templateVars: 30,
};

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

// ---------------------------------------------------------------------------
// Pure helpers (no Cinnamon state) — easy to reason about and test.
// ---------------------------------------------------------------------------

function _nowIso() {
  return new Date().toISOString();
}

function _decode(bytes) {
  try {
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return imports.byteArray.toString(bytes);
  }
}

function _asStr(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function _clampStr(s, max) {
  s = _asStr(s);
  return s.length > max ? s.slice(0, max) : s;
}

function _asIso(v) {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? v : null;
}

function _asCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function _normalizeHotkeySlot(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 9) return 0;
  return Math.floor(n);
}

function _isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function _normalizeTags(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") arr = raw.split(",");
  else return [];

  const out = [];
  const seen = new Set();
  for (let t of arr) {
    t = _clampStr(String(t).trim(), LIMITS.tag);
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
      if (out.length >= LIMITS.tagsCount) break;
    }
  }
  return out;
}

function _tagsToString(tags) {
  return _normalizeTags(tags).join(", ");
}

function _extractTemplateVars(content) {
  TEMPLATE_RE.lastIndex = 0;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = TEMPLATE_RE.exec(content)) !== null) {
    const name = m[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
      if (out.length >= LIMITS.templateVars) break;
    }
  }
  return out;
}

function _applyTemplate(content, values) {
  return content.replace(TEMPLATE_RE, (match, rawName) => {
    const key = rawName.trim();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

function _sanitizePrompt(raw) {
  const p = _isPlainObject(raw) ? raw : {};
  const now = _nowIso();
  return {
    id: typeof p.id === "string" && p.id ? p.id : GLib.uuid_string_random(),
    title: _clampStr(_asStr(p.title).trim() || "Untitled", LIMITS.title),
    category: _clampStr(_asStr(p.category).trim() || "General", LIMITS.category),
    content: _clampStr(_asStr(p.content), LIMITS.content),
    tags: _normalizeTags(p.tags),
    notes: _clampStr(_asStr(p.notes), LIMITS.notes),
    favorite: !!p.favorite,
    hotkeySlot: _normalizeHotkeySlot(p.hotkeySlot),
    createdAt: _asIso(p.createdAt) || now,
    updatedAt: _asIso(p.updatedAt) || _asIso(p.createdAt) || now,
    lastUsedAt: _asIso(p.lastUsedAt),
    useCount: _asCount(p.useCount),
  };
}

function _samplePrompts() {
  const now = _nowIso();
  const mk = (o) => Object.assign(
    {
      tags: [],
      notes: "",
      favorite: false,
      hotkeySlot: 0,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
    },
    o,
    { id: GLib.uuid_string_random() }
  );
  return [
    mk({
      title: "Desklet code review",
      category: "Desklet dev",
      content:
        "Review this Cinnamon desklet for correctness, Cinnamon/GJS API usage and UX.\n" +
        "List concrete issues by severity, then propose the smallest safe fix for each.",
      tags: ["cinnamon", "gjs", "review"],
      favorite: true,
      hotkeySlot: 1,
    }),
    mk({
      title: "Explain like I'm busy",
      category: "Writing",
      content:
        "Explain {{topic}} in plain language.\n" +
        "Lead with the answer, then give 3-5 key bullet points. Keep it under 200 words.",
      tags: ["summary", "communication"],
      notes: "Uses a {{topic}} placeholder you fill in on copy.",
    }),
    mk({
      title: "Git commit message",
      category: "Dev workflow",
      content:
        "Write a concise git commit message (imperative mood, 1-2 sentences) for these changes.\n" +
        "Focus on why, not what:\n\n{{diff}}",
      tags: ["git"],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Add / edit dialog — Cinnamon ModalDialog (reliable layout, focus & scroll)
// ---------------------------------------------------------------------------

class PromptEditDialog {
  constructor(desklet, existing) {
    this._desklet = desklet;
    this._existing = existing || null;
    this._innerW = Math.max(420, Math.min(580, Number(desklet.panel_width) || 340));
    this._scrollH = Math.max(280, Math.min(480, Number(desklet.list_height) || 300));

    this._dialog = new ModalDialog.ModalDialog({ styleClass: "prompt-vault-edit-dialog" });
    desklet._trackDialog(this._dialog);
    this._dialog.connect("destroy", () => {
      desklet._editDialog = null;
    });
    this._build();
  }

  _build() {
    const layout = this._dialog.contentLayout;
    layout.style = `width: ${this._innerW + 48}px;`;

    layout.add(
      new St.Label({
        text: this._existing ? _("Edit prompt") : _("New prompt"),
        style_class: "prompt-vault-dialog-title",
      }),
      { x_fill: true }
    );

    const mkField = (labelText, hintText) => {
      const box = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-field" });
      box.add(new St.Label({ text: labelText, style_class: "prompt-vault-field-label" }), { x_fill: true });
      const entry = new St.Entry({
        style_class: "prompt-vault-input",
        can_focus: true,
        hint_text: hintText || "",
      });
      try {
        CinnamonEntry.addContextMenu(entry);
      } catch (e) {
        /* ignore */
      }
      box.add(entry, { x_fill: true });
      layout.add(box, { x_fill: true });
      return entry;
    };

    this._titleEntry = mkField(_("Title") + " *", _("Short name for this prompt"));
    this._categoryEntry = mkField(_("Category"), _("e.g. Writing, Dev workflow"));
    this._tagsEntry = mkField(_("Tags"), _("Comma-separated"));
    this._notesEntry = mkField(_("Notes"), _("Optional — not copied"));

    const slotTitle = new St.Label({
      text: _("Shortcut slot"),
      style_class: "prompt-vault-section-title prompt-vault-dialog-slot-title",
    });
    new Tooltips.Tooltip(
      slotTitle,
      HOTKEY_COMBO_LABEL +
        "1–9 pastes this prompt into the focused field after installing shortcuts from the desklet toolbar. Also copies to clipboard. Raw text (no {{placeholder}} fill)."
    );
    layout.add(slotTitle, { x_fill: true });

    const slotHint = new St.Label({
      text:
        _("Optional — link this prompt to a number below.") +
        " " +
        HOTKEY_COMBO_LABEL +
        _("1–9 pastes it into the text field you are typing in.") +
        " " +
        _("None means no hotkey.") +
        " " +
        _("Click Shortcuts in the desklet toolbar once to install the keys."),
      style_class: "prompt-vault-hint prompt-vault-dialog-slot-hint",
    });
    slotHint.clutter_text.line_wrap = true;
    layout.add(slotHint, { x_fill: true });

    this._selectedSlot = 0;
    this._slotChips = [];
    const mkSlotChip = (parent, label, value) => {
      const chip = new St.Button({
        label,
        can_focus: true,
        style_class: "prompt-vault-slot-chip prompt-vault-dialog-slot-chip",
      });
      chip._pvSlotValue = value;
      const tip =
        value === 0
          ? _("No global shortcut for this prompt")
          : _("Slot") + " " + value + " — " + HOTKEY_COMBO_LABEL + value;
      new Tooltips.Tooltip(chip, tip);
      chip.connect("clicked", () => {
        this._selectedSlot = value;
        this._updateSlotChips();
      });
      parent.add(chip, { expand: true, x_fill: true });
      this._slotChips.push(chip);
      return chip;
    };
    const slotGrid = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-dialog-slot-grid" });
    const slotRowA = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-dialog-slot-row" });
    const slotRowB = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-dialog-slot-row" });
    mkSlotChip(slotRowA, _("None"), 0);
    for (let s = 1; s <= 5; s++) mkSlotChip(slotRowA, String(s), s);
    for (let s = 6; s <= 9; s++) mkSlotChip(slotRowB, String(s), s);
    slotGrid.add(slotRowA, { x_fill: true });
    slotGrid.add(slotRowB, { x_fill: true });
    layout.add(slotGrid, { x_fill: true });

    const labelRow = new St.BoxLayout({ vertical: false });
    labelRow.add(
      new St.Label({ text: _("Content") + " *", style_class: "prompt-vault-field-label" }),
      { expand: true, x_fill: true }
    );
    this._charCount = new St.Label({ text: "", style_class: "prompt-vault-charcount" });
    labelRow.add(this._charCount, { expand: false });
    layout.add(labelRow, { x_fill: true });

    this._scroll = new St.ScrollView({
      style_class: "prompt-vault-dialog-scroll",
      clip_to_allocation: true,
    });
    this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._scroll.style = `height: ${this._scrollH}px;`;
    this._scrollInner = new St.BoxLayout({ vertical: true });
    this._scroll.add_actor(this._scrollInner);
    layout.add(this._scroll, { x_fill: true });

    this._contentEntry = new St.Entry({
      style_class: "prompt-vault-input prompt-vault-textarea",
      can_focus: true,
      hint_text: _("Your prompt text — scroll to read long prompts"),
      clip_to_allocation: true,
    });
    _configureMultilineEntry(this._contentEntry);
    try {
      CinnamonEntry.addContextMenu(this._contentEntry);
    } catch (e) {
      /* ignore */
    }
    this._scrollInner.add(this._contentEntry, { x_fill: true });
    this._contentEntry.clutter_text.connect("text-changed", () => {
      this._charCount.set_text(`${this._contentEntry.get_text().length} ${_("chars")}`);
      this._syncContentLayout();
    });

    this._errorLabel = new St.Label({ text: "", style_class: "prompt-vault-panel-error" });
    this._errorLabel.clutter_text.line_wrap = true;
    this._errorLabel.hide();
    layout.add(this._errorLabel, { x_fill: true });

    layout.add(
      new St.Label({
        text: _("Scroll for long text · Tab between fields · Ctrl+Enter to save"),
        style_class: "prompt-vault-kbd-hint",
      }),
      { x_fill: true }
    );

    const entries = [
      this._titleEntry,
      this._categoryEntry,
      this._tagsEntry,
      this._notesEntry,
      this._contentEntry,
    ];
    for (const entry of entries) {
      entry.clutter_text.connect("text-changed", () => {
        if (this._errorLabel.visible) this._setError("");
      });
      entry.clutter_text.connect("key-press-event", (actor, event) => {
        const mods = Cinnamon.get_event_state(event);
        if (
          (mods & Clutter.ModifierType.CONTROL_MASK) &&
          (event.get_key_symbol() === Clutter.KEY_Return ||
            event.get_key_symbol() === Clutter.KEY_KP_Enter)
        ) {
          this._save();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });
    }

    this._dialog.setButtons([
      {
        label: _("Cancel"),
        action: () => this.close(),
        key: Clutter.KEY_Escape,
      },
      {
        label: _("Save"),
        action: () => this._save(),
      },
    ]);

    this._dialog.connect("opened", () => {
      this._scheduleContentLayoutSync();
      this._updateSlotChips();
      const focusEntry = this._existing ? this._contentEntry : this._titleEntry;
      this._dialog.setInitialKeyFocus(focusEntry);
      focusEntry.clutter_text.grab_key_focus();
    });
  }

  _scheduleContentLayoutSync() {
    const run = () => {
      if (!this._contentEntry) return GLib.SOURCE_REMOVE;
      this._syncContentLayout();
      return GLib.SOURCE_REMOVE;
    };
    this._syncContentLayout();
    Mainloop.timeout_add(0, run);
    Mainloop.timeout_add(80, run);
  }

  _updateSlotChips() {
    for (const chip of this._slotChips || []) {
      const active = chip._pvSlotValue === this._selectedSlot;
      if (active) chip.add_style_class_name("prompt-vault-slot-chip-active");
      else chip.remove_style_class_name("prompt-vault-slot-chip-active");
    }
  }

  _syncContentLayout() {
    if (!this._scrollInner || !this._contentEntry) return;
    const innerW = this._innerW;
    // Subtract scroll + entry padding so line-wrap height matches what is actually rendered.
    const textW = Math.max(180, innerW - 34);
    const bottomPad = 40;
    this._scrollInner.style = `width: ${innerW}px; min-width: ${innerW}px;`;
    const ct = this._contentEntry.clutter_text;
    try {
      ct.set_size(textW * Pango.SCALE, -1);
      const [, prefH] = ct.get_preferred_height(textW);
      const boxH = Math.max(this._scrollH - 8, prefH + bottomPad);
      this._scrollInner.style = `width: ${innerW}px; min-width: ${innerW}px; min-height: ${boxH}px;`;
      this._contentEntry.set_height(boxH);
      ct.set_min_height(boxH);
      ct.set_size(textW * Pango.SCALE, boxH * Pango.SCALE);
      this._scrollInner.queue_relayout();
      this._scroll.queue_relayout();
    } catch (e) {
      /* ignore */
    }
  }

  _setError(message) {
    if (message) {
      this._errorLabel.text = message;
      this._errorLabel.show();
    } else {
      this._errorLabel.text = "";
      this._errorLabel.hide();
    }
  }

  _save() {
    const title = this._titleEntry.get_text().trim();
    const content = this._contentEntry.get_text().trim();
    if (!title) {
      this._setError(_("Please enter a title."));
      this._titleEntry.clutter_text.grab_key_focus();
      return;
    }
    if (!content) {
      this._setError(_("Please enter the prompt text."));
      this._contentEntry.clutter_text.grab_key_focus();
      return;
    }
    this._setError("");
    if (
      this._desklet._commitPrompt(this._existing, {
        title: _clampStr(title, LIMITS.title),
        category: _clampStr(this._categoryEntry.get_text().trim() || "General", LIMITS.category),
        content: _clampStr(content, LIMITS.content),
        tags: _normalizeTags(this._tagsEntry.get_text()),
        notes: _clampStr(this._notesEntry.get_text().trim(), LIMITS.notes),
        hotkeySlot: this._selectedSlot,
      })
    ) {
      this.close();
    }
  }

  open() {
    const ex = this._existing;
    this._selectedSlot = ex ? _normalizeHotkeySlot(ex.hotkeySlot) : 0;
    this._titleEntry.set_text(ex ? ex.title : "");
    this._categoryEntry.set_text(ex ? ex.category : "General");
    this._tagsEntry.set_text(ex ? _tagsToString(ex.tags) : "");
    this._notesEntry.set_text(ex ? ex.notes || "" : "");
    this._contentEntry.set_text(ex ? ex.content : "");
    this._charCount.set_text(`${this._contentEntry.get_text().length} ${_("chars")}`);
    this._setError("");
    this._dialog.open();
    this._scheduleContentLayoutSync();
  }

  close() {
    this._dialog.destroy();
  }
}

// ---------------------------------------------------------------------------
// Desklet
// ---------------------------------------------------------------------------

function _configureMultilineEntry(entry) {
  const ct = entry.clutter_text;
  ct.set_single_line_mode(false);
  ct.set_activatable(false);
  ct.set_editable(true);
  ct.set_selectable(true);
  ct.set_line_wrap(true);
  ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
  ct.set_reactive(true);
  entry.set_reactive(true);
  entry.set_can_focus(true);
}

function _entryTextLength(entry) {
  return (entry.get_text() || "").length;
}

function _getEntrySelection(entry) {
  const ct = entry.clutter_text;
  try {
    const sel = ct.get_selection();
    if (sel) return sel;
  } catch (e) {
    /* older Clutter may lack get_selection() */
  }
  const pos = ct.get_cursor_position();
  const bound = ct.get_selection_bound();
  if (pos === bound) return "";
  const text = entry.get_text() || "";
  const start = Math.min(pos, bound);
  const end = Math.max(pos, bound);
  return text.slice(start, end);
}

function _insertTextAtCursor(entry, insert) {
  const ct = entry.clutter_text;
  const text = entry.get_text() || "";
  const pos = ct.get_cursor_position();
  const bound = ct.get_selection_bound();
  const start = Math.min(pos, bound);
  const end = Math.max(pos, bound);
  const next = text.slice(0, start) + insert + text.slice(end);
  entry.set_text(next);
  const newPos = start + insert.length;
  ct.set_cursor_position(newPos);
  ct.set_selection_bound(newPos);
}

function _deleteEntrySelection(entry) {
  const ct = entry.clutter_text;
  const pos = ct.get_cursor_position();
  const bound = ct.get_selection_bound();
  if (pos === bound) return;
  const text = entry.get_text() || "";
  const start = Math.min(pos, bound);
  const end = Math.max(pos, bound);
  entry.set_text(text.slice(0, start) + text.slice(end));
  ct.set_cursor_position(start);
  ct.set_selection_bound(start);
}

class PromptVaultDesklet extends Desklet.Desklet {
  constructor(metadata, deskletId) {
    super(metadata, deskletId);

    this._destroyed = false;
    this._prompts = [];
    this._searchQuery = "";
    this._categoryFilter = "all";
    this._favoritesOnly = false;
    this._statusTimeoutId = 0;
    this._flashTimeouts = new Set();
    this._timeouts = new Set();
    this._openDialogs = new Set();
    this._editDialog = null;
    this._viewMode = "list";

    // Keyboard-grab state (see "KEYBOARD INPUT" notes at the top of this file).
    this._grabbed = false;
    this._stageCaptureId = 0;
    this._lastFocusedEntry = null;
    this._templateFocusChain = [];

    this._settings = new Settings.DeskletSettings(this, metadata.uuid, deskletId);
    this._settings.bind("data_dir", "data_dir", this._onDataDirChanged.bind(this));
    this._settings.bind("sort_mode", "sort_mode", this._renderList.bind(this));
    this._settings.bind("show_tags", "show_tags", this._renderList.bind(this));
    this._settings.bind("show_usage", "show_usage", this._renderList.bind(this));
    this._settings.bind("confirm_delete", "confirm_delete", null);
    this._settings.bind("auto_backup", "auto_backup", null);
    this._settings.bind("enable_templates", "enable_templates", null);
    this._settings.bind("panel_width", "panel_width", this._applyDimensions.bind(this));
    this._settings.bind("list_height", "list_height", this._applyDimensions.bind(this));

    this.setHeader(_("Prompt Vault"));

    this._loadData();
    this._buildUi();
    this._buildContextMenu();
    this._applyDimensions();
    this._renderList();
  }

  // -- Paths & storage ------------------------------------------------------

  _getDataDir() {
    const custom = _asStr(this.data_dir).trim();
    if (custom) {
      // Expand a leading ~ for convenience.
      if (custom === "~") return GLib.get_home_dir();
      if (custom.startsWith("~/")) {
        return GLib.build_filenamev([GLib.get_home_dir(), custom.slice(2)]);
      }
      return custom;
    }
    return GLib.build_filenamev([GLib.get_home_dir(), ".local", "share", ...DEFAULT_DATA_SUBDIR]);
  }

  _getPromptsPath() {
    return GLib.build_filenamev([this._getDataDir(), "prompts.json"]);
  }

  _getRollingBackupPath() {
    return GLib.build_filenamev([this._getDataDir(), "prompts.auto-backup.json"]);
  }

  _getImportPath() {
    return GLib.build_filenamev([this._getDataDir(), "import.json"]);
  }

  _getTimestampBackupPath() {
    const stamp = GLib.DateTime.new_now_local().format("%Y-%m-%d_%H%M%S");
    return GLib.build_filenamev([this._getDataDir(), `prompts-backup-${stamp}.json`]);
  }

  _getDefaultDataDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), ".local", "share", ...DEFAULT_DATA_SUBDIR]);
  }

  _resolveBinScript(name) {
    const local = GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", name]);
    if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE)) return local;
    try {
      const dev = GLib.build_filenamev([this.metadata.path, "..", "..", "bin", name]);
      const resolved = GLib.canonicalize_filename(dev, null);
      if (GLib.file_test(resolved, GLib.FileTest.IS_EXECUTABLE)) return resolved;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  _spawnEnvPatch(patch) {
    const env = GLib.get_environ();
    const out = env.slice();
    for (const [key, value] of Object.entries(patch)) {
      const entry = `${key}=${value}`;
      const idx = out.findIndex((pair) => pair.startsWith(`${key}=`));
      if (idx >= 0) out[idx] = entry;
      else out.push(entry);
    }
    return out;
  }

  _dedupeHotkeySlots() {
    const seen = new Set();
    for (const p of this._prompts) {
      const slot = _normalizeHotkeySlot(p.hotkeySlot);
      p.hotkeySlot = slot;
      if (!slot) continue;
      if (seen.has(slot)) {
        p.hotkeySlot = 0;
        p.updatedAt = _nowIso();
      } else {
        seen.add(slot);
      }
    }
  }

  _setMode(file, mode) {
    // Best-effort hardening; never fatal if the filesystem can't store modes.
    try {
      file.set_attribute_uint32(
        "unix::mode",
        mode,
        Gio.FileQueryInfoFlags.NONE,
        null
      );
    } catch (e) {
      /* ignore (e.g. non-POSIX filesystems) */
    }
  }

  _ensureDataDir() {
    const dir = this._getDataDir();
    GLib.mkdir_with_parents(dir, 0o700);
    const file = Gio.File.new_for_path(dir);
    this._setMode(file, 0o700);
    try {
      const info = file.query_info("access::can-write", Gio.FileQueryInfoFlags.NONE, null);
      if (!info.get_attribute_boolean("access::can-write")) {
        global.logWarning(`[Prompt Vault] Data directory is not writable: ${dir}`);
        this._setStatus(_("Data folder is not writable — saves will fail."), true);
      }
    } catch (e) {
      /* ignore on exotic filesystems */
    }
    return dir;
  }

  _serialize() {
    return JSON.stringify(
      { version: DATA_VERSION, exportedAt: _nowIso(), prompts: this._prompts },
      null,
      2
    );
  }

  _writeFile(path, contents, secure) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(
      contents,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );
    if (secure) this._setMode(file, 0o600);
    return file;
  }

  _loadData() {
    this._ensureDataDir();
    const path = this._getPromptsPath();
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null)) {
      this._prompts = _samplePrompts();
      this._saveData({ backup: false });
      return;
    }

    try {
      const [ok, contents] = file.load_contents(null);
      if (!ok) throw new Error("file could not be read");
      const parsed = JSON.parse(_decode(contents));
      const list = _isPlainObject(parsed) && Array.isArray(parsed.prompts)
        ? parsed.prompts
        : Array.isArray(parsed)
        ? parsed
        : null;
      if (!list) throw new Error("unexpected data format");
      this._prompts = list.map(_sanitizePrompt);
      this._dedupeHotkeySlots();
    } catch (e) {
      this._quarantineFile(path, e);
      this._prompts = _samplePrompts();
      this._saveData({ backup: false });
    }
  }

  _quarantineFile(path, error) {
    try {
      const stamp = GLib.DateTime.new_now_local().format("%Y-%m-%d_%H%M%S");
      const dest = GLib.build_filenamev([this._getDataDir(), `prompts.corrupt-${stamp}.json`]);
      Gio.File.new_for_path(path).move(
        Gio.File.new_for_path(dest),
        Gio.FileCopyFlags.OVERWRITE,
        null,
        null
      );
      global.logWarning(`[Prompt Vault] Unreadable data file moved to ${dest}: ${error}`);
      Main.notifyError(
        _("Prompt Vault"),
        _("Your prompts file was unreadable and has been set aside. Starting fresh.")
      );
    } catch (e) {
      global.logError(`[Prompt Vault] Could not quarantine corrupt file: ${e}`);
    }
  }

  _saveData({ backup = false } = {}) {
    try {
      this._ensureDataDir();
      const path = this._getPromptsPath();
      const file = Gio.File.new_for_path(path);

      if (backup && this.auto_backup && file.query_exists(null)) {
        try {
          file.copy(
            Gio.File.new_for_path(this._getRollingBackupPath()),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null
          );
          this._setMode(Gio.File.new_for_path(this._getRollingBackupPath()), 0o600);
        } catch (e) {
          global.logWarning(`[Prompt Vault] Auto-backup failed: ${e}`);
        }
      }

      this._writeFile(path, this._serialize(), true);
      return true;
    } catch (e) {
      global.logError(`[Prompt Vault] Save failed: ${e}`);
      this._setStatus(_("Could not save changes."), true);
      Main.notifyError(_("Prompt Vault"), _("Failed to save prompts: ") + e.message);
      return false;
    }
  }

  _onDataDirChanged() {
    if (this._editDialog) this._editDialog.close();
    if (this._viewMode !== "list") this._showListView();
    this._loadData();
    this._categoryFilter = "all";
    this._favoritesOnly = false;
    this._renderList();
    this._setStatus(_("Loaded prompts from the configured folder."));
  }

  // -- UI construction ------------------------------------------------------

  _buildUi() {
    this._root = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-root" });
    this.setContent(this._root);

    this._headerRow = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-header" });
    this._backBtn = this._mkIconBtn("go-previous-symbolic", _("Back to list"), () => this._showListView());
    this._backBtn.hide();
    this._headerRow.add(this._backBtn, { expand: false, y_align: St.Align.MIDDLE, y_fill: false });
    this._headerLabel = new St.Label({ text: _("Prompt Vault"), style_class: "prompt-vault-title" });
    this._headerRow.add(this._headerLabel, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
    this._countBadge = new St.Label({ text: "", style_class: "prompt-vault-count-badge" });
    this._headerRow.add(this._countBadge, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
    this._root.add(this._headerRow, { x_fill: true });

    // ---- List view --------------------------------------------------------
    this._listPanel = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-list-panel" });

    const searchRow = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-search-row" });
    this._searchEntry = new St.Entry({
      hint_text: _("Search title, category, tags, text…"),
      style_class: "prompt-vault-search",
      can_focus: true,
    });
    this._searchEntry.clutter_text.connect("text-changed", () => {
      this._searchQuery = this._searchEntry.get_text().trim().toLowerCase();
      this._renderList();
    });
    this._wireDeskletEntry(this._searchEntry);
    searchRow.add(this._searchEntry, { expand: true, x_fill: true });
    this._clearBtn = this._mkIconBtn("edit-clear-symbolic", _("Clear search"), () => {
      this._searchEntry.set_text("");
      this._focusEntry(this._searchEntry);
    });
    searchRow.add(this._clearBtn, { expand: false });
    this._listPanel.add(searchRow, { x_fill: true });

    this._filterScroll = new St.ScrollView({ style_class: "prompt-vault-filter-scroll" });
    this._filterScroll.set_policy(St.PolicyType.AUTOMATIC, St.PolicyType.NEVER);
    this._filterRow = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-filters" });
    this._filterScroll.add_actor(this._filterRow);
    this._listPanel.add(this._filterScroll, { x_fill: true });

    this._scrollView = new St.ScrollView({ style_class: "prompt-vault-scroll" });
    this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._listBox = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-list" });
    this._scrollView.add_actor(this._listBox);
    this._listPanel.add(this._scrollView, { expand: true, x_fill: true, y_fill: true });

    this._toolbar = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-toolbar" });
    this._toolbarBtns = [
      this._mkTextBtn(
        null,
        "list-add-symbolic",
        _("Add prompt"),
        () => this._openEditor(null),
        "prompt-vault-btn-primary"
      ),
      this._mkTextBtn(
        null,
        "input-keyboard-symbolic",
        _("Shortcuts"),
        () => this._setupKeyboardShortcuts(),
        "prompt-vault-btn-shortcuts"
      ),
      this._mkTextBtn(null, "document-save-symbolic", _("Export"), () => this._exportBackup()),
      this._mkTextBtn(null, "document-open-symbolic", _("Import"), () => this._importBackup(false)),
      this._mkTextBtn(null, "folder-symbolic", _("Data folder"), () => this._openDataFolder()),
    ];
    this._listPanel.add(this._toolbar, { x_fill: true });

    this._root.add(this._listPanel, { expand: true, x_fill: true, y_fill: true });

    this._buildTemplatePanel();

    // Status line: an icon carries the meaning too, so success/error is never
    // signalled by color alone (WCAG 1.4.1 Use of Color).
    this._statusRow = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-status-row" });
    this._statusIcon = new St.Icon({
      icon_name: "dialog-information-symbolic",
      icon_type: St.IconType.SYMBOLIC,
      icon_size: 14,
      style_class: "prompt-vault-status-icon",
    });
    this._statusIcon.hide();
    this._statusRow.add(this._statusIcon, { y_align: St.Align.MIDDLE, y_fill: false });
    this._status = new St.Label({ text: "", style_class: "prompt-vault-status" });
    this._status.clutter_text.line_wrap = true;
    this._statusRow.add(this._status, { expand: true, x_fill: true, y_align: St.Align.MIDDLE });
    this._root.add(this._statusRow, { x_fill: true });
  }

  _buildTemplatePanel() {
    this._templatePanel = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-panel" });
    this._templatePanel.hide();

    this._templateSubtitle = new St.Label({ text: "", style_class: "prompt-vault-panel-subtitle" });
    this._templateSubtitle.clutter_text.line_wrap = true;
    this._templatePanel.add(this._templateSubtitle, { x_fill: true });

    this._templateScroll = new St.ScrollView({ style_class: "prompt-vault-edit-scroll" });
    this._templateScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._templateFieldsBox = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-edit-form" });
    this._templateScroll.add_actor(this._templateFieldsBox);
    this._templatePanel.add(this._templateScroll, { expand: true, x_fill: true, y_fill: true });

    this._templatePanel.add(
      new St.Label({
        text: _("Tab moves between fields · Esc cancels"),
        style_class: "prompt-vault-kbd-hint",
      }),
      { x_fill: true }
    );

    const actions = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-panel-actions" });
    this._mkPanelBtn(actions, _("Cancel"), () => this._showListView());
    this._mkPanelBtn(actions, _("Copy raw"), () => this._finishTemplateCopy(true), null, "edit-copy-symbolic");
    this._mkPanelBtn(actions, _("Copy filled"), () => this._finishTemplateCopy(false), "prompt-vault-btn-primary", "edit-copy-symbolic");
    this._templatePanel.add(actions, { x_fill: true });

    this._root.add(this._templatePanel, { expand: true, x_fill: true, y_fill: true });
  }

  _mkPanelBtn(parent, label, onClick, extraClass, iconName) {
    const box = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-panel-btn-inner" });
    if (iconName) {
      box.add(
        new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 15 }),
        { y_align: St.Align.MIDDLE, y_fill: false }
      );
    }
    box.add(
      new St.Label({ text: label, style_class: "prompt-vault-panel-btn-label" }),
      { y_align: St.Align.MIDDLE, y_fill: false }
    );
    const btn = new St.Button({
      style_class: "prompt-vault-panel-btn" + (extraClass ? " " + extraClass : ""),
      can_focus: true,
      child: box,
    });
    this._a11y(btn, label);
    btn.connect("clicked", () => onClick());
    parent.add(btn, { expand: true, x_fill: true });
    return btn;
  }

  _showListView() {
    this._releaseGrab();
    this._lastFocusedEntry = null;
    this._viewMode = "list";
    this._templatePrompt = null;
    this._templateRow = null;
    this._templateEntries = null;
    this._templateFocusChain = [];

    this._listPanel.show();
    this._templatePanel.hide();
    this._backBtn.hide();
    this._headerLabel.text = _("Prompt Vault");
    this._countBadge.show();
    this._renderList();
  }

  _showTemplatePanel(prompt, vars, row) {
    this._viewMode = "template";
    this._templatePrompt = prompt;
    this._templateRow = row;

    this._listPanel.hide();
    this._templatePanel.show();
    this._backBtn.show();
    this._headerLabel.text = _("Fill placeholders");
    this._countBadge.hide();

    this._templateSubtitle.text = "“" + prompt.title + "”";
    this._templateFieldsBox.destroy_all_children();
    this._templateEntries = {};
    this._templateFocusChain = [];

    for (const v of vars) {
      const box = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-field" });
      box.add(
        new St.Label({ text: _("Value for") + " {{" + v + "}}", style_class: "prompt-vault-field-label" }),
        { x_fill: true }
      );
      const entry = new St.Entry({
        style_class: "prompt-vault-input",
        can_focus: true,
        hint_text: _("Enter a value for {{") + v + "}}",
      });
      entry.x_expand = true;
      this._a11y(entry, v);
      this._wireDeskletEntry(entry);
      box.add(entry, { x_fill: true });
      this._templateFieldsBox.add(box, { x_fill: true });
      this._templateEntries[v] = entry;
      this._templateFocusChain.push(entry);
    }

    this._layoutScrollContent(this._templateScroll, this._templateFieldsBox);

    const first = vars[0];
    const focusTarget = first && this._templateEntries ? this._templateEntries[first] : null;
    this._finalizeFormPanel(focusTarget);
  }

  _finishTemplateCopy(raw) {
    const prompt = this._templatePrompt;
    const row = this._templateRow;
    if (!prompt) {
      this._showListView();
      return;
    }
    let text = prompt.content;
    if (!raw && this._templateEntries) {
      const values = {};
      for (const [k, e] of Object.entries(this._templateEntries)) values[k] = e.get_text();
      text = _applyTemplate(prompt.content, values);
    }
    this._showListView();
    this._doCopy(text, prompt, row);
  }

  _openEditor(existing) {
    if (this._editDialog) return;
    this._releaseGrab();
    this._editDialog = new PromptEditDialog(this, existing);
    this._editDialog.open();
  }

  _getPanelWidth() {
    return Math.max(260, Math.min(640, Number(this.panel_width) || 340));
  }

  _getInnerContentWidth(panelWidth) {
    const w = panelWidth || this._getPanelWidth();
    // Root padding (32px) + scroll/form padding (~4px).
    return Math.max(200, w - 36);
  }

  // St.ScrollView does not propagate parent width to its child. Without an
  // explicit width the inner form stays at 0px wide — labels and entries vanish.
  _layoutScrollContent(scrollView, innerBox, panelWidth) {
    if (!innerBox) return;
    const innerW = this._getInnerContentWidth(panelWidth);
    try {
      innerBox.set_width(innerW);
    } catch (e) {
      /* older St */
    }
    innerBox.style = `width: ${innerW}px; min-width: ${innerW}px; max-width: ${innerW}px;`;
    if (scrollView) scrollView.queue_relayout();
    innerBox.queue_relayout();
  }

  _refreshFormPanelLayout() {
    const w = this._getPanelWidth();
    if (this._root) {
      this._root.style = `width: ${w}px; max-width: ${w}px; min-width: ${w}px;`;
    }
    this._layoutScrollContent(this._templateScroll, this._templateFieldsBox, w);
    if (this._headerRow) this._headerRow.queue_relayout();
    if (this._templatePanel && this._templatePanel.visible) this._templatePanel.queue_relayout();
  }

  _finalizeFormPanel(focusEntry) {
    this._applyDimensions();
    this._refreshFormPanelLayout();

    const activate = () => {
      if (this._destroyed || this._viewMode !== "template") return;
      this._refreshFormPanelLayout();
      this._ensureGrab();
      if (focusEntry) this._focusEntry(focusEntry);
    };

    this._addTimeout(0, () => {
      activate();
      return GLib.SOURCE_REMOVE;
    });
    this._addTimeout(50, () => {
      activate();
      return GLib.SOURCE_REMOVE;
    });
  }

  _applyDimensions() {
    const w = this._getPanelWidth();
    const h = Math.max(140, Math.min(720, Number(this.list_height) || 300));
    const formH = Math.max(200, Math.min(520, h + 80));
    if (this._root) {
      this._root.style = `width: ${w}px; max-width: ${w}px; min-width: ${w}px;`;
    }
    if (this._scrollView) this._scrollView.style = `height: ${h}px;`;
    if (this._templateScroll) this._templateScroll.style = `height: ${formH}px; min-height: ${formH}px;`;
    this._layoutScrollContent(this._templateScroll, this._templateFieldsBox, w);
    this._layoutToolbar();
  }

  // Tracked timeout so nothing fires after the desklet is removed.
  _addTimeout(ms, fn) {
    const id = Mainloop.timeout_add(ms, () => {
      this._timeouts.delete(id);
      if (this._destroyed) return GLib.SOURCE_REMOVE;
      return fn();
    });
    this._timeouts.add(id);
    return id;
  }

  // -- Keyboard grab --------------------------------------------------------
  // A real compositor grab is the only reliable way to receive keyboard input
  // on the desktop stage (set_stage_input_mode is unreliable on X11 and a no-op
  // on Wayland). We hold the grab only while a text field needs the keyboard.

  _ensureGrab() {
    if (this._destroyed) return false;
    if (this._grabbed) return true;

    let ok = false;
    try {
      // Use the desklet actor (same pattern as deskletManager.setModal) — not the
      // inner content box, which is not a valid keyboard-focus target.
      ok = Main.pushModal(this.actor);
    } catch (e) {
      global.logWarning(`[Prompt Vault] pushModal failed: ${e}`);
      ok = false;
    }

    if (ok) {
      this._grabbed = true;
      // Click outside the desklet dismisses the grab (proven popup pattern).
      this._stageCaptureId = global.stage.connect(
        "captured-event",
        (actor, event) => this._onStageCapture(event)
      );
      // pushModal() focuses the modal actor; restore the active text field.
      if (this._lastFocusedEntry) {
        this._refocusLastEntry();
      }
    } else {
      // Best-effort fallback for the rare case where a modal grab is refused.
      try {
        if (global.stage_input_mode !== Cinnamon.StageInputMode.FULLSCREEN) {
          global.set_stage_input_mode(Cinnamon.StageInputMode.FOCUSED);
        }
      } catch (e) {
        /* ignore */
      }
    }
    return this._grabbed;
  }

  _refocusLastEntry() {
    const entry = this._lastFocusedEntry;
    if (!entry || this._destroyed) return;
    try {
      const ct = entry.clutter_text;
      ct.set_editable(true);
      ct.set_selectable(true);
      ct.grab_key_focus();
    } catch (e) {
      /* entry may have been destroyed */
    }
  }

  _releaseGrab() {
    if (this._stageCaptureId) {
      try {
        global.stage.disconnect(this._stageCaptureId);
      } catch (e) {
        /* ignore */
      }
      this._stageCaptureId = 0;
    }

    if (this._grabbed) {
      this._grabbed = false;
      try {
        Main.popModal(this.actor);
      } catch (e) {
        /* modal may have been auto-popped on destroy */
      }
    } else {
      try {
        if (global.stage_input_mode === Cinnamon.StageInputMode.FOCUSED) {
          global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
        }
      } catch (e) {
        /* ignore */
      }
    }

    try {
      global.stage.set_key_focus(null);
    } catch (e) {
      /* ignore */
    }
  }

  _isEntryContextMenuOpen() {
    const entries = [];
    if (this._searchEntry) entries.push(this._searchEntry);
    if (this._templateFocusChain) entries.push(...this._templateFocusChain);
    for (const e of entries) {
      try {
        if (e && e._menu && e._menu.isOpen) return true;
      } catch (err) {
        /* ignore */
      }
    }
    return false;
  }

  _onStageCapture(event) {
    if (!this._grabbed || this._destroyed) return Clutter.EVENT_PROPAGATE;

    // Defer entirely while a menu or confirmation dialog is open: they install
    // their own input handling on top of our grab.
    if (this._menu && this._menu.isOpen) return Clutter.EVENT_PROPAGATE;
    if (this._isEntryContextMenuOpen()) return Clutter.EVENT_PROPAGATE;
    if (this._openDialogs && this._openDialogs.size > 0) return Clutter.EVENT_PROPAGATE;

    let type;
    try {
      type = event.type();
    } catch (e) {
      return Clutter.EVENT_PROPAGATE;
    }
    if (type !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;

    const src = event.get_source();
    if (
      src &&
      (typeof src.is_finalized !== "function" || !src.is_finalized()) &&
      this._root &&
      this._root.contains(src)
    ) {
      // Click landed inside the desklet — let it through normally.
      return Clutter.EVENT_PROPAGATE;
    }

    // Click outside the desklet: drop the keyboard grab so the rest of the
    // desktop stays usable. We never discard unsaved edits here.
    this._releaseGrab();
    return Clutter.EVENT_STOP;
  }

  // Acquire the grab (if needed) and move keyboard focus to `entry`.
  _focusEntry(entry) {
    if (!entry || this._destroyed) return;
    this._lastFocusedEntry = entry;
    this._ensureGrab();
    try {
      const ct = entry.clutter_text;
      ct.set_editable(true);
      ct.set_selectable(true);
      if (global.stage.get_key_focus() !== ct) {
        ct.grab_key_focus();
      }
    } catch (e) {
      global.logWarning(`[Prompt Vault] Could not focus entry: ${e}`);
    }
  }

  _focusChain() {
    if (this._viewMode === "template") return this._templateFocusChain || [];
    return [];
  }

  // Move focus to the next/previous field (Tab / Shift+Tab) so keyboard users
  // are never trapped in a single field (WCAG 2.1.2 No Keyboard Trap, 2.4.3).
  _moveFieldFocus(entry, dir) {
    const chain = this._focusChain();
    if (!chain.length) return;
    let i = chain.indexOf(entry);
    if (i < 0) i = dir > 0 ? -1 : 0;
    const next = chain[(i + dir + chain.length) % chain.length];
    if (next) this._focusEntry(next);
  }

  _onEscape(entry) {
    if (this._viewMode === "template") {
      this._showListView();
      return;
    }
    // List view: first Escape clears a non-empty search, second drops the grab.
    if (entry === this._searchEntry && this._searchEntry && this._searchEntry.get_text()) {
      this._searchEntry.set_text("");
      return;
    }
    this._releaseGrab();
  }

  _handleEntryKeyPress(entry, event) {
    const symbol = event.get_key_symbol();
    const mods = Cinnamon.get_event_state(event);
    const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;

    if (symbol === Clutter.KEY_Escape) {
      this._onEscape(entry);
      return Clutter.EVENT_STOP;
    }

    // Tab navigation between fields (multiline content included — accessibility
    // beats inserting a literal tab character here).
    if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
      this._moveFieldFocus(entry, shift || symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
      return Clutter.EVENT_STOP;
    }

    if (!ctrl) return Clutter.EVENT_PROPAGATE;

    const ct = entry.clutter_text;
    const len = _entryTextLength(entry);

    // Desklet entries do not get the shell's default clipboard bindings, so we
    // implement select-all / copy / cut / paste explicitly and reliably.
    if (symbol === Clutter.KEY_a || symbol === Clutter.KEY_A) {
      if (len > 0) {
        ct.set_selection(0, len);
        ct.set_cursor_position(len);
      }
      return Clutter.EVENT_STOP;
    }

    if (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C) {
      const sel = _getEntrySelection(entry);
      if (sel) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, sel);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    if (symbol === Clutter.KEY_x || symbol === Clutter.KEY_X) {
      const sel = _getEntrySelection(entry);
      if (sel) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, sel);
        _deleteEntrySelection(entry);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    if (symbol === Clutter.KEY_v || symbol === Clutter.KEY_V) {
      this._pasteClipboard(entry, St.ClipboardType.CLIPBOARD);
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _pasteClipboard(entry, target) {
    St.Clipboard.get_default().get_text(target, (clip, text) => {
      if (text && !this._destroyed) _insertTextAtCursor(entry, text);
    });
  }

  _wireDeskletEntry(entry) {
    const ct = entry.clutter_text;
    ct.set_editable(true);
    ct.set_selectable(true);
    entry.set_can_focus(true);

    // Right-click context menu (Copy / Paste) — same as Cinnamon's own dialogs.
    try {
      CinnamonEntry.addContextMenu(entry);
    } catch (e) {
      global.logWarning(`[Prompt Vault] Could not add entry context menu: ${e}`);
    }

    const onPress = (actor, event) => {
      if (event) {
        const button = event.get_button();
        // Middle-click paste (primary selection on X11).
        if (button === 2) {
          this._focusEntry(entry);
          this._pasteClipboard(entry, St.ClipboardType.PRIMARY);
          return Clutter.EVENT_STOP;
        }
        // Right-click: context menu handler owns this event.
        if (button === 3) return Clutter.EVENT_PROPAGATE;
      }

      this._lastFocusedEntry = entry;
      this._ensureGrab();
      if (global.stage.get_key_focus() !== ct) {
        try {
          ct.grab_key_focus();
        } catch (e) {
          /* ignore */
        }
      }
      return Clutter.EVENT_PROPAGATE;
    };

    entry.connect("button-press-event", onPress);
    ct.connect("button-press-event", onPress);

    ct.connect("key-focus-in", () => {
      this._lastFocusedEntry = entry;
    });

    ct.connect("key-press-event", (actor, event) => {
      const symbol = event.get_key_symbol();
      const mods = Cinnamon.get_event_state(event);
      const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
      // Shift+Insert paste (common accessibility shortcut).
      if (shift && symbol === Clutter.KEY_Insert) {
        this._pasteClipboard(entry, St.ClipboardType.CLIPBOARD);
        return Clutter.EVENT_STOP;
      }
      return this._handleEntryKeyPress(entry, event);
    });
  }

  _a11y(actor, name) {
    // set_accessible_name is not guaranteed across Clutter/St versions; use it
    // when present, otherwise rely on tooltips and visible labels.
    try {
      if (actor && typeof actor.set_accessible_name === "function") {
        actor.set_accessible_name(name);
      }
    } catch (e) {
      /* ignore */
    }
  }

  _mkIconBtn(iconName, tooltip, onClick, extraClass) {
    const btn = new St.Button({
      style_class: "prompt-vault-icon-btn" + (extraClass ? " " + extraClass : ""),
      can_focus: true,
      child: new St.Icon({
        icon_name: iconName,
        icon_type: St.IconType.SYMBOLIC,
        icon_size: 16,
      }),
    });
    if (tooltip) {
      new Tooltips.Tooltip(btn, tooltip);
      this._a11y(btn, tooltip);
    }
    btn.connect("clicked", () => onClick());
    return btn;
  }

  _mkTextBtn(parent, iconName, label, onClick, extraClass) {
    const box = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-toolbar-btn-inner" });
    box.add(
      new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 15 }),
      { y_align: St.Align.MIDDLE, y_fill: false }
    );
    const text = new St.Label({ text: label, style_class: "prompt-vault-toolbar-label" });
    try {
      text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } catch (e) {
      /* ignore */
    }
    box.add(text, { y_align: St.Align.MIDDLE, y_fill: false, expand: true });
    const btn = new St.Button({
      style_class: "prompt-vault-toolbar-btn" + (extraClass ? " " + extraClass : ""),
      can_focus: true,
      child: box,
      x_expand: true,
    });
    this._a11y(btn, label);
    new Tooltips.Tooltip(btn, label);
    btn.connect("clicked", () => onClick());
    if (parent) parent.add(btn, { expand: true, x_fill: true });
    return btn;
  }

  _clearToolbarRows() {
    if (!this._toolbar) return;
    while (this._toolbar.get_n_children() > 0) {
      this._toolbar.remove_actor(this._toolbar.get_child_at_index(0));
    }
  }

  _addToolbarRow(buttons, fullWidth) {
    const row = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-toolbar-row" });
    for (const btn of buttons) {
      row.add(btn, { expand: true, x_fill: true });
    }
    this._toolbar.add(row, { x_fill: fullWidth, expand: false });
  }

  // Reflow toolbar so icon + text labels stay readable at every desklet width.
  _layoutToolbar() {
    if (!this._toolbar || !this._toolbarBtns || !this._toolbarBtns.length) return;

    const w = this._getPanelWidth();
    const btns = this._toolbarBtns;
    this._clearToolbarRows();
    this._toolbar.remove_style_class_name("prompt-vault-toolbar-compact");

    if (w >= 520) {
      this._addToolbarRow(btns, true);
    } else if (w >= 300) {
      this._addToolbarRow(btns.slice(0, 2), true);
      this._addToolbarRow(btns.slice(2), true);
    } else {
      this._toolbar.add_style_class_name("prompt-vault-toolbar-compact");
      for (const btn of btns) this._addToolbarRow([btn], true);
    }
    this._toolbar.queue_relayout();
  }

  // -- Status / feedback ----------------------------------------------------

  _setStatus(message, isError) {
    if (!this._status) return;
    this._status.text = message || "";

    if (isError) this._status.add_style_class_name("prompt-vault-status-error");
    else this._status.remove_style_class_name("prompt-vault-status-error");

    if (this._statusIcon) {
      if (message) {
        this._statusIcon.icon_name = isError
          ? "dialog-warning-symbolic"
          : "emblem-ok-symbolic";
        if (isError) this._statusIcon.add_style_class_name("prompt-vault-status-error");
        else this._statusIcon.remove_style_class_name("prompt-vault-status-error");
        this._statusIcon.show();
      } else {
        this._statusIcon.hide();
      }
    }

    if (this._statusTimeoutId) {
      Mainloop.source_remove(this._statusTimeoutId);
      this._statusTimeoutId = 0;
    }
    if (message) {
      this._statusTimeoutId = Mainloop.timeout_add(4000, () => {
        this._statusTimeoutId = 0;
        if (!this._destroyed && this._status) {
          this._status.text = "";
          this._status.remove_style_class_name("prompt-vault-status-error");
          if (this._statusIcon) this._statusIcon.hide();
        }
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  _flashRow(row) {
    if (!row) return;
    try {
      row.add_style_class_name("prompt-vault-row-copied");
    } catch (e) {
      return;
    }
    const id = Mainloop.timeout_add(750, () => {
      this._flashTimeouts.delete(id);
      try {
        row.remove_style_class_name("prompt-vault-row-copied");
      } catch (e) {
        /* row was destroyed by a re-render — nothing to undo */
      }
      return GLib.SOURCE_REMOVE;
    });
    this._flashTimeouts.add(id);
  }

  // -- Filtering & rendering ------------------------------------------------

  _getCategories() {
    const set = new Set();
    for (const p of this._prompts) if (p.category) set.add(p.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  _filteredPrompts() {
    let items = this._prompts.slice();

    if (this._favoritesOnly) {
      items = items.filter((p) => p.favorite);
    } else if (this._categoryFilter !== "all") {
      items = items.filter((p) => p.category === this._categoryFilter);
    }

    if (this._searchQuery) {
      const q = this._searchQuery;
      items = items.filter((p) =>
        [p.title, p.category, p.content, p.notes, _tagsToString(p.tags)]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    const mode = this.sort_mode || "recent";
    items.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      if (mode === "title") return a.title.localeCompare(b.title);
      if (mode === "category") {
        const c = a.category.localeCompare(b.category);
        return c !== 0 ? c : a.title.localeCompare(b.title);
      }
      if (mode === "uses") {
        const d = (b.useCount || 0) - (a.useCount || 0);
        return d !== 0 ? d : a.title.localeCompare(b.title);
      }
      const at = a.lastUsedAt || a.updatedAt || a.createdAt || "";
      const bt = b.lastUsedAt || b.updatedAt || b.createdAt || "";
      return bt.localeCompare(at);
    });

    return items;
  }

  _renderFilters() {
    this._filterRow.destroy_all_children();

    const mkChip = (label, isActive, onClick, extraClass) => {
      const chip = new St.Button({
        label,
        can_focus: true,
        style_class:
          "prompt-vault-chip" +
          (isActive ? " prompt-vault-chip-active" : "") +
          (extraClass ? " " + extraClass : ""),
      });
      this._a11y(chip, label);
      chip.connect("clicked", () => onClick());
      this._filterRow.add(chip, { expand: false });
    };

    mkChip(_("All"), this._categoryFilter === "all" && !this._favoritesOnly, () => {
      this._categoryFilter = "all";
      this._favoritesOnly = false;
      this._renderList();
    });

    const favCount = this._prompts.filter((p) => p.favorite).length;
    mkChip(
      "★ " + _("Favorites") + (favCount ? " (" + favCount + ")" : ""),
      this._favoritesOnly,
      () => {
        this._favoritesOnly = true;
        this._categoryFilter = "all";
        this._renderList();
      },
      "prompt-vault-chip-fav"
    );

    for (const cat of this._getCategories()) {
      mkChip(cat, !this._favoritesOnly && this._categoryFilter === cat, () => {
        this._categoryFilter = cat;
        this._favoritesOnly = false;
        this._renderList();
      });
    }
  }

  _renderList() {
    if (!this._listBox) return;
    this._renderFilters();
    this._listBox.destroy_all_children();

    const items = this._filteredPrompts();

    // Update count badge.
    const total = this._prompts.length;
    if (this._countBadge) {
      this._countBadge.text =
        items.length === total
          ? `${total} ${total === 1 ? _("prompt") : _("prompts")}`
          : `${items.length} / ${total}`;
    }

    if (items.length === 0) {
      const empty = new St.Label({
        text:
          total === 0
            ? _("No prompts yet. Click “Add prompt” to create your first one.")
            : _("Nothing matches your search or filter."),
        style_class: "prompt-vault-empty",
      });
      empty.clutter_text.line_wrap = true;
      this._listBox.add(empty, { x_fill: true });
      return;
    }

    for (const prompt of items) {
      this._listBox.add(this._buildPromptRow(prompt), { x_fill: true });
    }
  }

  _usageText(p) {
    if (!p.useCount) return _("Not copied yet");
    return p.useCount === 1 ? _("Copied once") : `${_("Copied")} ${p.useCount}×`;
  }

  _buildPromptRow(prompt) {
    const row = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-row" });

    // Favorite toggle.
    const star = this._mkIconBtn(
      prompt.favorite ? "starred-symbolic" : "non-starred-symbolic",
      prompt.favorite ? _("Remove from favorites") : _("Add to favorites"),
      () => this._toggleFavorite(prompt.id),
      prompt.favorite ? "prompt-vault-star-active" : "prompt-vault-star"
    );
    row.add(star, { expand: false, y_align: St.Align.START, y_fill: false });

    // Clickable body → copy.
    const body = new St.BoxLayout({ vertical: true, style_class: "prompt-vault-row-body" });

    const titleRow = new St.BoxLayout({ vertical: false });
    const title = new St.Label({ text: prompt.title, style_class: "prompt-vault-row-title" });
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    titleRow.add(title, { expand: true, x_fill: true });
    const badge = new St.Label({ text: prompt.category, style_class: "prompt-vault-category" });
    badge.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    titleRow.add(badge, { expand: false, y_align: St.Align.MIDDLE, y_fill: false });
    if (prompt.hotkeySlot) {
      const slotBadge = new St.Label({
        text: "⌨" + prompt.hotkeySlot,
        style_class: "prompt-vault-hotkey-badge",
      });
      new Tooltips.Tooltip(
        slotBadge,
        _("Paste via") + " " + HOTKEY_COMBO_LABEL + prompt.hotkeySlot
      );
      titleRow.add(slotBadge, { expand: false, y_align: St.Align.MIDDLE, y_fill: false });
    }
    body.add(titleRow, { x_fill: true });

    const preview = new St.Label({
      text: prompt.content.replace(/\s+/g, " ").trim(),
      style_class: "prompt-vault-row-preview",
    });
    preview.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    body.add(preview, { x_fill: true });

    if (this.show_tags && prompt.tags.length) {
      const tags = new St.Label({
        text: "# " + prompt.tags.join("  # "),
        style_class: "prompt-vault-row-tags",
      });
      tags.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      body.add(tags, { x_fill: true });
    }

    if (prompt.notes) {
      const notes = new St.Label({ text: prompt.notes, style_class: "prompt-vault-row-notes" });
      notes.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      body.add(notes, { x_fill: true });
    }

    if (this.show_usage) {
      const usage = new St.Label({ text: this._usageText(prompt), style_class: "prompt-vault-row-usage" });
      body.add(usage, { x_fill: true });
      row._pvUsageLabel = usage;
    }

    const bodyBtn = new St.Button({
      style_class: "prompt-vault-row-bodybtn",
      can_focus: true,
      child: body,
      x_expand: true,
    });
    this._a11y(bodyBtn, _("Copy") + ": " + prompt.title);
    new Tooltips.Tooltip(bodyBtn, _("Click to copy to clipboard"));
    bodyBtn.connect("clicked", () => this._copyPrompt(prompt, row));
    row.add(bodyBtn, { expand: true, x_fill: true });

    // Action buttons.
    const actions = new St.BoxLayout({ vertical: false, style_class: "prompt-vault-actions" });
    actions.add(this._mkIconBtn("edit-copy-symbolic", _("Copy to clipboard"), () => this._copyPrompt(prompt, row)));
    actions.add(this._mkIconBtn("document-edit-symbolic", _("Edit"), () => this._openEditor(prompt)));
    actions.add(this._mkIconBtn("tab-new-symbolic", _("Duplicate"), () => this._duplicatePrompt(prompt)));
    actions.add(this._mkIconBtn("edit-delete-symbolic", _("Delete"), () => this._deletePrompt(prompt), "prompt-vault-danger"));
    row.add(actions, { expand: false, y_align: St.Align.START, y_fill: false });

    return row;
  }

  // -- Actions --------------------------------------------------------------

  _copyPrompt(prompt, row) {
    const vars = this.enable_templates ? _extractTemplateVars(prompt.content) : [];
    if (vars.length > 0) {
      this._showTemplatePanel(prompt, vars, row);
      return;
    }
    this._doCopy(prompt.content, prompt, row);
  }

  _doCopy(text, prompt, row) {
    try {
      St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    } catch (e) {
      this._setStatus(_("Could not access the clipboard."), true);
      return;
    }

    const idx = this._prompts.findIndex((p) => p.id === prompt.id);
    if (idx >= 0) {
      this._prompts[idx].lastUsedAt = _nowIso();
      this._prompts[idx].useCount = (this._prompts[idx].useCount || 0) + 1;
      this._saveData({ backup: false });
      if (row && row._pvUsageLabel) {
        try {
          row._pvUsageLabel.set_text(this._usageText(this._prompts[idx]));
        } catch (e) {
          /* row gone */
        }
      }
    }

    // The user's next move after a copy is almost always to paste elsewhere, so
    // drop any keyboard grab (e.g. from the search box) to keep the desktop free.
    this._releaseGrab();

    this._setStatus(`${_("Copied")} “${prompt.title}”`);
    this._flashRow(row);
  }

  _toggleFavorite(id) {
    const idx = this._prompts.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this._prompts[idx].favorite = !this._prompts[idx].favorite;
    this._prompts[idx].updatedAt = _nowIso();
    this._saveData({ backup: true });
    this._renderList();
  }

  _commitPrompt(existing, values) {
    const slot = _normalizeHotkeySlot(values.hotkeySlot);
    values.hotkeySlot = slot;
    if (slot) {
      const keepId = existing ? existing.id : null;
      for (const p of this._prompts) {
        if (p.hotkeySlot === slot && p.id !== keepId) {
          p.hotkeySlot = 0;
          p.updatedAt = _nowIso();
        }
      }
    }

    if (existing) {
      const idx = this._prompts.findIndex((p) => p.id === existing.id);
      if (idx < 0) {
        this._setStatus(_("That prompt no longer exists."), true);
        return false;
      }
      this._prompts[idx] = Object.assign({}, this._prompts[idx], values, { updatedAt: _nowIso() });
    } else {
      const now = _nowIso();
      this._prompts.push(
        Object.assign({ id: GLib.uuid_string_random() }, values, {
          favorite: false,
          hotkeySlot: slot,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
          useCount: 0,
        })
      );
    }
    if (this._saveData({ backup: true })) {
      if (this._viewMode === "list") this._renderList();
      this._setStatus(existing ? _("Prompt updated.") : _("Prompt added."));
      return true;
    }
    return false;
  }

  _duplicatePrompt(prompt) {
    const now = _nowIso();
    this._prompts.push(
      Object.assign({}, prompt, {
        id: GLib.uuid_string_random(),
        title: _clampStr(prompt.title + " " + _("(copy)"), LIMITS.title),
        favorite: false,
        hotkeySlot: 0,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        useCount: 0,
      })
    );
    if (this._saveData({ backup: true })) {
      this._renderList();
      this._setStatus(_("Prompt duplicated."));
    }
  }

  _deletePrompt(prompt) {
    const doDelete = () => {
      this._prompts = this._prompts.filter((p) => p.id !== prompt.id);
      if (this._saveData({ backup: true })) {
        this._renderList();
        this._setStatus(_("Prompt deleted."));
      }
    };

    if (this.confirm_delete) {
      const dialog = new ModalDialog.ConfirmDialog(
        _("Delete this prompt?") + "\n\n“" + prompt.title + "”",
        () => doDelete()
      );
      this._trackDialog(dialog);
      dialog.open();
    } else {
      doDelete();
    }
  }

  // -- Confirm dialogs (delete / import replace only) -----------------------

  _trackDialog(dialog) {
    this._openDialogs.add(dialog);
    try {
      dialog._group.connect("destroy", () => this._openDialogs.delete(dialog));
    } catch (e) {
      /* ignore */
    }
  }

  // -- Export / import / folder --------------------------------------------

  _exportBackup() {
    try {
      this._ensureDataDir();
      const dest = this._getTimestampBackupPath();
      this._writeFile(dest, this._serialize(), true);
      this._setStatus(`${_("Exported")} ${this._prompts.length} ${_("prompt(s).")}`);
      Main.notify(_("Prompt Vault"), _("Backup saved to:") + "\n" + dest);
    } catch (e) {
      global.logError(`[Prompt Vault] Export failed: ${e}`);
      this._setStatus(_("Export failed."), true);
      Main.notifyError(_("Prompt Vault"), _("Export failed: ") + e.message);
    }
  }

  _importBackup(replace) {
    let file, parsed;
    try {
      this._ensureDataDir();
      const importPath = this._getImportPath();
      file = Gio.File.new_for_path(importPath);
      if (!file.query_exists(null)) {
        this._setStatus(_("No import.json found in the data folder."), true);
        Main.notify(
          _("Prompt Vault"),
          _("To import, place your backup at:") + "\n" + importPath + "\n" + _("then choose Import again.")
        );
        return;
      }
      const [ok, contents] = file.load_contents(null);
      if (!ok) throw new Error("could not read import.json");
      parsed = JSON.parse(_decode(contents));
    } catch (e) {
      global.logError(`[Prompt Vault] Import read failed: ${e}`);
      this._setStatus(_("Import failed: file is not valid JSON."), true);
      return;
    }

    const rawList = _isPlainObject(parsed) && Array.isArray(parsed.prompts)
      ? parsed.prompts
      : Array.isArray(parsed)
      ? parsed
      : null;
    if (!rawList) {
      this._setStatus(_("Import failed: no prompts found in the file."), true);
      return;
    }
    const incoming = rawList.map(_sanitizePrompt);

    const apply = () => {
      if (replace) {
        this._prompts = incoming;
      } else {
        const byId = new Map(this._prompts.map((p) => [p.id, p]));
        for (const p of incoming) byId.set(p.id, p);
        this._prompts = Array.from(byId.values());
      }
      this._dedupeHotkeySlots();
      if (this._saveData({ backup: true })) {
        this._categoryFilter = "all";
        this._favoritesOnly = false;
        this._renderList();
        this._setStatus(`${_("Imported")} ${incoming.length} ${_("prompt(s).")}`);
      }
    };

    if (replace) {
      const dialog = new ModalDialog.ConfirmDialog(
        _("Replace ALL current prompts with the contents of import.json?") +
          "\n\n" +
          `${this._prompts.length} → ${incoming.length} ${_("prompt(s).")}`,
        () => apply()
      );
      this._trackDialog(dialog);
      dialog.open();
    } else {
      apply();
    }
  }

  _openDataFolder() {
    try {
      const dir = this._ensureDataDir();
      const uri = Gio.File.new_for_path(dir).get_uri();
      Gio.app_info_launch_default_for_uri(uri, null);
    } catch (e) {
      global.logError(`[Prompt Vault] Open folder failed: ${e}`);
      this._setStatus(_("Could not open the data folder."), true);
    }
  }

  _setupKeyboardShortcuts() {
    const setupPath = this._resolveBinScript("prompt-vault-setup-shortcuts");
    const copyPath = this._resolveBinScript("prompt-vault-copy");
    const hotkeyPath = this._resolveBinScript("prompt-vault-hotkey");
    if (!setupPath || !copyPath || !hotkeyPath) {
      this._setStatus(_("Shortcut tools missing — run ./install.sh from the repo."), true);
      Main.notify(
        _("Prompt Vault"),
        _("Install the shortcut helpers first:\n./install.sh\n\nThen click Shortcuts again.")
      );
      return;
    }

    const envPatch = {
      PROMPT_VAULT_COPY_CMD: copyPath,
      PROMPT_VAULT_HOTKEY_CMD: hotkeyPath,
    };
    const dataDir = this._getDataDir();
    if (dataDir !== this._getDefaultDataDir()) {
      envPatch.PROMPT_VAULT_DATA_DIR = dataDir;
    }

    try {
      GLib.spawn_async(
        null,
        [setupPath],
        this._spawnEnvPatch(envPatch),
        GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
        null,
        null
      );
      const assigned = this._prompts.filter((p) => p.hotkeySlot).length;
      const combo = HOTKEY_COMBO_LABEL + "1–9";
      const hint =
        assigned > 0
          ? combo + _(" pastes assigned slots — focus a text field first.")
          : _("Shortcuts registered. Edit a prompt and pick slot 1–9.");
      this._setStatus(_("Keyboard shortcuts installed.") + " " + hint);
      Main.notify(_("Prompt Vault"), _("Global shortcuts installed:") + " " + combo);
    } catch (e) {
      global.logError(`[Prompt Vault] Shortcut setup failed: ${e}`);
      this._setStatus(_("Could not install keyboard shortcuts."), true);
    }
  }

  // -- Context menu ---------------------------------------------------------

  _buildContextMenu() {
    const add = (label, cb) => {
      const item = new PopupMenu.PopupMenuItem(label);
      item.connect("activate", () => cb());
      this._menu.addMenuItem(item);
      return item;
    };

    add(_("Add prompt"), () => this._openEditor(null));
    add(_("Install keyboard shortcuts"), () => this._setupKeyboardShortcuts());
    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    add(_("Export backup"), () => this._exportBackup());
    add(_("Import (merge)"), () => this._importBackup(false));
    add(_("Import (replace all)"), () => this._importBackup(true));
    add(_("Reload from disk"), () => this._onDataDirChanged());
    add(_("Open data folder"), () => this._openDataFolder());
  }

  // -- Lifecycle ------------------------------------------------------------

  on_desklet_removed() {
    this._destroyed = true;
    this._releaseGrab();

    if (this._statusTimeoutId) {
      Mainloop.source_remove(this._statusTimeoutId);
      this._statusTimeoutId = 0;
    }
    for (const id of this._flashTimeouts) Mainloop.source_remove(id);
    this._flashTimeouts.clear();
    for (const id of this._timeouts) Mainloop.source_remove(id);
    this._timeouts.clear();

    for (const dialog of this._openDialogs) {
      try {
        dialog.destroy();
      } catch (e) {
        /* already gone */
      }
    }
    this._openDialogs.clear();
  }
}

function main(metadata, deskletId) {
  return new PromptVaultDesklet(metadata, deskletId);
}
