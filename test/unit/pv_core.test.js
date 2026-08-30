"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

const deps = {
  uuid: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
  now: () => "2026-01-15T12:00:00.000Z",
};

describe("sanitizePrompt", () => {
  it("fills defaults for empty / hostile input", () => {
    const p = Core.sanitizePrompt(null, deps);
    assert.equal(p.title, "Untitled");
    assert.equal(p.category, "General");
    assert.equal(p.content, "");
    assert.equal(p.hotkeySlot, 0);
    assert.equal(p.favorite, false);
    assert.equal(p.useCount, 0);
    assert.ok(p.id.startsWith("id-"));
  });

  it("clamps oversized strings and tag lists", () => {
    const p = Core.sanitizePrompt(
      {
        id: "keep-me",
        title: "x".repeat(500),
        category: "y".repeat(100),
        content: "z".repeat(Core.LIMITS.content + 50),
        notes: "n".repeat(Core.LIMITS.notes + 10),
        tags: Array.from({ length: 50 }, (_, i) => `tag${i}`),
        hotkeySlot: "3",
        useCount: "12.9",
        favorite: 1,
      },
      deps
    );
    assert.equal(p.id, "keep-me");
    assert.equal(p.title.length, Core.LIMITS.title);
    assert.equal(p.category.length, Core.LIMITS.category);
    assert.equal(p.content.length, Core.LIMITS.content);
    assert.equal(p.notes.length, Core.LIMITS.notes);
    assert.equal(p.tags.length, Core.LIMITS.tagsCount);
    assert.equal(p.hotkeySlot, 3);
    assert.equal(p.useCount, 12);
    assert.equal(p.favorite, true);
  });

  it("rejects invalid ISO dates and negative use counts", () => {
    const p = Core.sanitizePrompt(
      {
        id: "a",
        createdAt: "not-a-date",
        updatedAt: "also-bad",
        lastUsedAt: "nope",
        useCount: -5,
        hotkeySlot: 99,
      },
      deps
    );
    assert.equal(p.createdAt, deps.now());
    assert.equal(p.updatedAt, deps.now());
    assert.equal(p.lastUsedAt, null);
    assert.equal(p.useCount, 0);
    assert.equal(p.hotkeySlot, 0);
  });

  it("requires uuid/now deps (fail closed)", () => {
    assert.throws(() => Core.sanitizePrompt({ id: "x" }, {}), /deps\.uuid/);
    assert.throws(() => Core.sanitizePrompt({ id: "x" }), /deps\.uuid/);
  });
});

describe("normalizeHotkeySlot / formatHotkeyLabel", () => {
  it("accepts only integer slots 1–9", () => {
    assert.equal(Core.normalizeHotkeySlot(1), 1);
    assert.equal(Core.normalizeHotkeySlot("9"), 9);
    assert.equal(Core.normalizeHotkeySlot(0), 0);
    assert.equal(Core.normalizeHotkeySlot(10), 0);
    assert.equal(Core.normalizeHotkeySlot("abc"), 0);
    assert.equal(Core.normalizeHotkeySlot(null), 0);
    assert.equal(Core.normalizeHotkeySlot(3.7), 3);
  });

  it("formats paste shortcut labels", () => {
    assert.equal(Core.formatHotkeyLabel(0), "");
    assert.equal(Core.formatHotkeyLabel(7), "Super+Ctrl+7");
    assert.equal(Core.formatHotkeyLabel(2, "Super"), "Super+Ctrl+2");
    assert.equal(Core.formatHotkeyCompact(0), "");
    assert.equal(Core.formatHotkeyCompact(7), "#7");
  });
});

describe("tags + templates", () => {
  it("dedupes tags case-insensitively and trims", () => {
    assert.deepEqual(Core.normalizeTags([" Foo ", "foo", "Bar", "", "  "]), ["Foo", "Bar"]);
    assert.deepEqual(Core.normalizeTags("a, b, a"), ["a", "b"]);
    assert.deepEqual(Core.normalizeTags(42), []);
  });

  it("extracts unique {{placeholders}} in order", () => {
    const vars = Core.extractTemplateVars("Hello {{ name }} and {{name}} then {{other}}");
    assert.deepEqual(vars, ["name", "other"]);
  });

  it("applies template values and leaves unknown markers", () => {
    const out = Core.applyTemplate("A {{x}} B {{y}}", { x: "1" });
    assert.equal(out, "A 1 B {{y}}");
  });

  it("caps template var extraction", () => {
    const parts = [];
    for (let i = 0; i < Core.LIMITS.templateVars + 5; i++) parts.push(`{{v${i}}}`);
    const vars = Core.extractTemplateVars(parts.join(" "));
    assert.equal(vars.length, Core.LIMITS.templateVars);
  });

  it("does not leak lastIndex after a capped extract (apply still substitutes)", () => {
    const parts = [];
    for (let i = 0; i < Core.LIMITS.templateVars + 8; i++) parts.push(`{{v${i}}}`);
    Core.extractTemplateVars(parts.join(" "));
    assert.equal(Core.applyTemplate("keep {{v0}}", { v0: "OK" }), "keep OK");
  });

  it("ignores hostile template names", () => {
    assert.deepEqual(Core.extractTemplateVars("{{__proto__}} {{constructor}} {{good}}"), ["good"]);
    const hostile = Object.create(null);
    hostile["__proto__"] = "x";
    assert.equal(Core.applyTemplate("{{__proto__}}", hostile), "{{__proto__}}");
    assert.equal(Core.isSafeTemplateVar("topic"), true);
    assert.equal(Core.isSafeTemplateVar("x y"), false);
  });
});

describe("store safety", () => {
  it("rejects reserved and path-like prompt ids", () => {
    assert.equal(Core.isSafePromptId("keep-me"), true);
    assert.equal(Core.isSafePromptId("__proto__"), false);
    assert.equal(Core.isSafePromptId("constructor"), false);
    assert.equal(Core.isSafePromptId("../etc/passwd"), false);
    assert.equal(Core.isSafePromptId("a\0b"), false);
    const p = Core.sanitizePrompt({ id: "__proto__", title: "x" }, deps);
    assert.notEqual(p.id, "__proto__");
    assert.ok(p.id.startsWith("id-"));
  });

  it("mergePromptsById does not pollute Object.prototype", () => {
    const merged = Core.mergePromptsById(
      [{ id: "ok", title: "Keep" }],
      [{ id: "__proto__", title: "Evil" }]
    );
    assert.equal(Object.prototype.title, undefined);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "ok");
  });

  it("mergeUsageFromDisk keeps edits and the higher useCount", () => {
    const memory = [
      { id: "a", title: "Edited", useCount: 2, lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const disk = [
      { id: "a", title: "Stale", useCount: 9, lastUsedAt: "2026-06-01T00:00:00.000Z" },
    ];
    const out = Core.mergeUsageFromDisk(memory, disk);
    assert.equal(out[0].title, "Edited");
    assert.equal(out[0].useCount, 9);
    assert.equal(out[0].lastUsedAt, "2026-06-01T00:00:00.000Z");
  });

  it("enforces store limits and data-dir path sanity", () => {
    assert.equal(Core.exceedsStoreLimits(Core.STORE_LIMITS.maxPrompts + 1, 10), "prompts");
    assert.equal(Core.exceedsStoreLimits(1, Core.STORE_LIMITS.maxBytes + 1), "bytes");
    assert.equal(Core.exceedsStoreLimits(1, 10), null);
    assert.equal(Core.isUsableDataDirPath("/home/alex/vault"), true);
    assert.equal(Core.isUsableDataDirPath("a\0b"), false);
    assert.equal(Core.isUsableDataDirPath(""), false);
    assert.equal(Core.isUsableDataDirPath("x".repeat(5000)), false);
    // Trusted local path: `..` is allowed (USB/sync folders). Not a sandbox.
    assert.equal(Core.isUsableDataDirPath("/home/alex/../../tmp"), true);
  });

  it("normalizeTags does not use a prototype-pollutable seen map", () => {
    const tags = Core.normalizeTags(["__proto__", "ok", "constructor"]);
    assert.ok(tags.includes("ok"));
    assert.equal(Object.prototype.ok, undefined);
    assert.equal(typeof Object.prototype.constructor, "function");
  });
});

describe("shouldSeedSamples — missing prompts.json must not clobber recoveries", () => {
  it("seeds only when the live file is gone AND no sibling JSON exists", () => {
    assert.equal(Core.shouldSeedSamples(false, 0), true);
    assert.equal(Core.shouldSeedSamples(false, 1), false);
    assert.equal(Core.shouldSeedSamples(false, 2), false);
    assert.equal(Core.shouldSeedSamples(true, 0), false);
    assert.equal(Core.shouldSeedSamples(true, 9), false);
  });

  it("fails closed when the sibling count is unknown or hostile", () => {
    assert.equal(Core.shouldSeedSamples(false, undefined), false);
    assert.equal(Core.shouldSeedSamples(false, null), false);
    assert.equal(Core.shouldSeedSamples(false, NaN), false);
    assert.equal(Core.shouldSeedSamples(false, -1), false);
    assert.equal(Core.shouldSeedSamples(false, "0"), false);
    assert.equal(Core.shouldSeedSamples("yes", 0), false);
    assert.equal(Core.shouldSeedSamples(undefined, 0), false);
    assert.equal(Core.shouldSeedSamples(0, 0), false);
  });
});

describe("countRecoverableVaultJson", () => {
  it("counts backup/corrupt/export JSON and ignores the live file and lock junk", () => {
    assert.equal(
      Core.countRecoverableVaultJson([
        "prompts.json",
        "prompts.auto-backup.json",
        "prompts.corrupt-2026-08-30_114949.json",
        "prompts.json.lock",
        "notes.txt",
        "import.json",
      ]),
      3
    );
    assert.equal(Core.countRecoverableVaultJson([]), 0);
    assert.equal(Core.countRecoverableVaultJson(null), 0);
  });
});

describe("uniquifyPromptIds + sanitizePromptList", () => {
  it("keeps the first id and rewrites later duplicates so delete-by-id cannot wipe two rows", () => {
    let n = 0;
    const uuid = () => `fresh-${++n}`;
    const out = Core.uniquifyPromptIds(
      [
        { id: "dup", title: "First" },
        { id: "dup", title: "Second" },
        { id: "ok", title: "Third" },
      ],
      uuid
    );
    assert.equal(out[0].id, "dup");
    assert.equal(out[0].title, "First");
    assert.equal(out[1].id, "fresh-1");
    assert.equal(out[1].title, "Second");
    assert.equal(out[2].id, "ok");
    assert.equal(new Set(out.map((p) => p.id)).size, 3);
  });

  it("retries uuid when the generator collides with an id already kept", () => {
    let i = 0;
    const uuid = () => {
      i += 1;
      if (i === 1) return "dup";
      return "fresh";
    };
    const out = Core.uniquifyPromptIds([{ id: "dup", title: "A" }, { id: "dup", title: "B" }], uuid);
    assert.equal(out[0].id, "dup");
    assert.equal(out[1].id, "fresh");
  });

  it("requires a uuid function (fail closed)", () => {
    assert.throws(() => Core.uniquifyPromptIds([{ id: "a" }]), /uuidFn/);
    assert.throws(() => Core.uniquifyPromptIds([{ id: "a" }], null), /uuidFn/);
  });

  it("drops non-object import rows instead of minting Untitled junk", () => {
    const out = Core.sanitizePromptList(
      [null, 42, "x", { id: "keep", title: "Keep", content: "c" }],
      deps
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "keep");
    assert.equal(out[0].title, "Keep");
    assert.equal(out[0].content, "c");
  });

  it("uniquifies after sanitize so a duplicate-id import stays two prompts", () => {
    const localDeps = {
      uuid: (() => {
        let n = 0;
        return () => `u-${++n}`;
      })(),
      now: () => "2026-01-15T12:00:00.000Z",
    };
    const out = Core.sanitizePromptList(
      [
        { id: "same", title: "A", content: "a" },
        { id: "same", title: "B", content: "b" },
      ],
      localDeps
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "same");
    assert.notEqual(out[1].id, "same");
    assert.equal(out[1].title, "B");
  });

  it("returns empty for a non-array payload", () => {
    assert.deepEqual(Core.sanitizePromptList(null, deps), []);
    assert.deepEqual(Core.sanitizePromptList({ prompts: [] }, deps), []);
  });

  it("requires uuid/now deps (fail closed)", () => {
    assert.throws(() => Core.sanitizePromptList([], {}), /deps\.uuid/);
    assert.throws(() => Core.sanitizePromptList([{ id: "x" }]), /deps\.uuid/);
  });
});

describe("shouldTrapTab — WCAG 2.1.2 no keyboard trap in list view", () => {
  it("propagates Tab when the focus chain is empty; traps only when there are fields", () => {
    assert.equal(Core.shouldTrapTab(0), false);
    assert.equal(Core.shouldTrapTab(1), true);
    assert.equal(Core.shouldTrapTab(3), true);
    assert.equal(Core.shouldTrapTab(-1), false);
    assert.equal(Core.shouldTrapTab(NaN), false);
    assert.equal(Core.shouldTrapTab(undefined), false);
  });
});

describe("layout metrics (responsive chrome)", () => {
  it("clamps panel width and list height", () => {
    assert.equal(Core.clampPanelWidth(100), 260);
    assert.equal(Core.clampPanelWidth(9999), 640);
    assert.equal(Core.clampPanelWidth("bad"), 400);
    assert.equal(Core.clampListHeight(10), 140);
    assert.equal(Core.clampListHeight(9000), 720);
  });

  it("keeps title wrap width below chrome so actions cannot be clipped", () => {
    for (const w of [260, 300, 340, 400, 520, 640]) {
      const titleW = Core.titleWrapWidth(w);
      const inner = Core.innerContentWidth(w);
      const chrome =
        Core.ROW_CHROME_PX.star +
        Core.ROW_CHROME_PX.actions +
        Core.ROW_CHROME_PX.rowPadding +
        Core.ROW_CHROME_PX.bodyPadding +
        Core.ROW_CHROME_PX.gaps;
      assert.equal(titleW, Math.max(64, inner - chrome));
      assert.ok(titleW + chrome <= inner || titleW === 64);
      assert.ok(titleW >= 64);
      // Regression: these are CSS/actor pixels. Never feed them through Pango.SCALE
      // into ClutterActor.set_size — that blew rows up to ~40k px and blanked the list.
      assert.ok(titleW < 1000, `title width ${titleW} looks like pango units, not pixels`);
    }
  });

  it("covers asStr coercion edge cases", () => {
    assert.equal(Core.asStr("ok"), "ok");
    assert.equal(Core.asStr(null), "");
    assert.equal(Core.asStr(undefined), "");
    assert.equal(Core.asStr(42), "42");
  });

  it("picks toolbar packing by width breakpoints (readable labels)", () => {
    assert.equal(Core.toolbarLayoutMode(260), "stack");
    assert.equal(Core.toolbarLayoutMode(299), "stack");
    assert.equal(Core.toolbarLayoutMode(300), "two-row");
    assert.equal(Core.toolbarLayoutMode(519), "two-row");
    assert.equal(Core.toolbarLayoutMode(520), "one-row");
    assert.equal(Core.toolbarLayoutMode(640), "one-row");
    assert.equal(Core.toolbarLayoutMode("bad"), "two-row");
  });

  it("packs rows so every label stays readable (no 4-across crush)", () => {
    const one = Core.toolbarRowsForMode("one-row");
    assert.equal(one.length, 1);
    assert.deepEqual(
      one[0].buttons.map((b) => b.id),
      ["add", "shortcuts", "export", "import", "folder"]
    );
    assert.ok(one[0].buttons.length <= Core.toolbarMaxButtonsPerRow("one-row"));

    const two = Core.toolbarRowsForMode("two-row");
    assert.equal(two.length, 2);
    assert.deepEqual(
      two[0].buttons.map((b) => b.id),
      ["add", "shortcuts"]
    );
    assert.deepEqual(
      two[1].buttons.map((b) => b.id),
      ["export", "import", "folder"]
    );
    for (const row of two) {
      assert.ok(row.buttons.length <= Core.toolbarMaxButtonsPerRow("two-row"));
    }

    const stack = Core.toolbarRowsForMode("stack");
    assert.equal(stack.length, 5);
    for (const row of stack) {
      assert.equal(row.buttons.length, 1);
      assert.ok(row.buttons.length <= Core.toolbarMaxButtonsPerRow("stack"));
    }
    // unknown mode falls back to two-row packing
    assert.equal(Core.toolbarRowsForMode("nope").length, 2);
  });

  it("exposes a reparent-safe structure with remount strategy", () => {
    const s = Core.toolbarStructure(400);
    assert.equal(s.reparentSafe, true);
    assert.equal(s.remountStrategy, "destroy-and-recreate");
    assert.equal(s.mode, "two-row");
    assert.equal(s.rows.length, 2);
    const ids = s.rows.flatMap((r) => r.buttons.map((b) => b.id));
    assert.equal(new Set(ids).size, ids.length, "button ids must be unique");
    assert.equal(Core.toolbarButtons().length, 5);
  });

  it("toolbar mount plan is noop for same mode, remount on mode change", () => {
    const first = Core.toolbarMountPlan(0, null, "two-row");
    assert.equal(first.op, "mount");
    assert.equal(first.reason, "initial-build");
    assert.ok(first.rows.length >= 2);

    const same = Core.toolbarMountPlan({
      existingRowCount: first.rows.length,
      currentMode: "two-row",
      nextMode: "two-row",
    });
    assert.equal(same.op, "noop");
    assert.equal(same.reason, "mode-unchanged");

    const changed = Core.toolbarMountPlan({
      existingRowCount: 2,
      currentMode: "two-row",
      nextMode: "stack",
    });
    assert.equal(changed.op, "remount");
    assert.equal(changed.reason, "mode-changed");
    assert.equal(changed.rows.length, 5);

    assert.equal(Core.toolbarMountPlan(-1, null, "one-row").op, "mount");
    assert.equal(Core.toolbarMountPlan("x", null, "bad-mode").mode, "two-row");
  });
});

describe("resolveCopyPlan + materializeCopyText", () => {
  it("defaults to raw copy (alwaysCopyRaw undefined/true)", () => {
    const content = "Hello {{name}}";
    assert.deepEqual(Core.resolveCopyPlan(content, true), {
      action: "copy",
      text: content,
      vars: [],
    });
    assert.deepEqual(Core.resolveCopyPlan(content, undefined), {
      action: "copy",
      text: content,
      vars: [],
    });
    assert.deepEqual(Core.resolveCopyPlan(content, null), {
      action: "copy",
      text: content,
      vars: [],
    });
  });

  it("opens fill only when alwaysCopyRaw is false and placeholders exist", () => {
    const plan = Core.resolveCopyPlan("A {{x}} B {{y}}", false);
    assert.equal(plan.action, "fill");
    assert.equal(plan.text, null);
    assert.deepEqual(plan.vars, ["x", "y"]);
    const plain = Core.resolveCopyPlan("no placeholders", false);
    assert.equal(plain.action, "copy");
    assert.equal(plain.text, "no placeholders");
  });

  it("materializes raw vs filled clipboard text", () => {
    assert.equal(Core.materializeCopyText("A {{x}}", { x: "1" }, true), "A {{x}}");
    assert.equal(Core.materializeCopyText("A {{x}}", { x: "1" }, false), "A 1");
    assert.equal(Core.materializeCopyText("A {{x}}", null, false), "A {{x}}");
    assert.equal(Core.materializeCopyText(null, {}, true), "");
  });
});

describe("category sort tie-break + assign without now", () => {
  it("sorts same category by title", () => {
    const deps = {
      uuid: (() => {
        let n = 0;
        return () => `c-${++n}`;
      })(),
      now: () => "t",
    };
    const data = [
      Core.sanitizePrompt({ id: "b", title: "B", category: "Same", favorite: false }, deps),
      Core.sanitizePrompt({ id: "a", title: "A", category: "Same", favorite: false }, deps),
    ];
    const out = Core.filterAndSortPrompts(data, { sortMode: "category" });
    assert.deepEqual(
      out.map((p) => p.title),
      ["A", "B"]
    );
  });

  it("assignHotkeySlot works without nowFn and ignores no-ops", () => {
    const deps = {
      uuid: () => "u",
      now: () => "t",
    };
    const before = [
      Core.sanitizePrompt({ id: "a", hotkeySlot: 1 }, deps),
      Core.sanitizePrompt({ id: "b", hotkeySlot: 0 }, deps),
    ];
    const after = Core.assignHotkeySlot(before, "missing", 0);
    assert.equal(after[0].hotkeySlot, 1);
    assert.equal(after[1].hotkeySlot, 0);
    const moved = Core.assignHotkeySlot(before, "b", 1);
    assert.equal(moved.find((p) => p.id === "b").hotkeySlot, 1);
    assert.equal(moved.find((p) => p.id === "a").hotkeySlot, 0);
    assert.equal(moved.find((p) => p.id === "a").updatedAt, before[0].updatedAt);
  });
});

describe("resolveDefaultFilter", () => {
  it("starts on all by default", () => {
    assert.deepEqual(Core.resolveDefaultFilter("all"), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.resolveDefaultFilter(""), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
  });

  it("resolves favorites aliases", () => {
    assert.deepEqual(Core.resolveDefaultFilter("favorites"), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.resolveDefaultFilter("Favourites"), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
  });

  it("resolves a category with case-insensitive match", () => {
    assert.deepEqual(Core.resolveDefaultFilter("category", "general", ["General", "Dev"]), {
      favoritesOnly: false,
      categoryFilter: "General",
    });
    assert.deepEqual(Core.resolveDefaultFilter("category", "Missing", ["General"]), {
      favoritesOnly: false,
      categoryFilter: "Missing",
    });
    assert.deepEqual(Core.resolveDefaultFilter("category", "  ", ["General"]), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
  });
});

describe("selectListFilter", () => {
  it("maps chip selections and compares filter state", () => {
    assert.deepEqual(Core.selectListFilter({ type: "all" }), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "favorites" }), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "category", category: "Dev" }), {
      favoritesOnly: false,
      categoryFilter: "Dev",
    });
    assert.equal(
      Core.listFilterEquals(
        Core.selectListFilter({ type: "favorites" }),
        { favoritesOnly: true, categoryFilter: "all" }
      ),
      true
    );
    assert.equal(Core.listFilterSignature(Core.selectListFilter({ type: "all" })), "all");
  });
});

describe("partitionCategoryChips", () => {
  it("keeps at most N visible and puts the rest in overflow", () => {
    const cats = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    const parts = Core.partitionCategoryChips(cats, "", 3);
    assert.deepEqual(parts.visible, ["Alpha", "Beta", "Gamma"]);
    assert.deepEqual(parts.overflow, ["Delta", "Epsilon"]);
  });

  it("promotes the selected category into the visible set", () => {
    const cats = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    const parts = Core.partitionCategoryChips(cats, "Epsilon", 3);
    assert.equal(parts.visible[0], "Epsilon");
    assert.equal(parts.visible.length, 3);
    assert.ok(!parts.overflow.includes("Epsilon"));
    assert.ok(parts.visible.includes("Alpha"));
    assert.ok(parts.visible.includes("Beta"));
  });

  it("handles empty / small lists", () => {
    assert.deepEqual(Core.partitionCategoryChips([], "X", 3), { visible: [], overflow: [] });
    assert.deepEqual(Core.partitionCategoryChips(["Only"], "", 3), {
      visible: ["Only"],
      overflow: [],
    });
  });
});

describe("previewText", () => {
  it("collapses whitespace and truncates", () => {
    assert.equal(Core.previewText("a\n\nb   c", 100), "a b c");
    assert.equal(Core.previewText("abcdefghij", 5), "abcde");
    assert.equal(Core.previewText("  padded  ", 100), "padded");
    assert.equal(Core.previewText("exact", 5), "exact");
    assert.equal(Core.previewText("toolong", 4), "tool");
  });
});
