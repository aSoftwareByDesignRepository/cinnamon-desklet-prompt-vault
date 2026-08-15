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

  it("picks toolbar packing by width breakpoints", () => {
    assert.equal(Core.toolbarLayoutMode(260), "stack");
    assert.equal(Core.toolbarLayoutMode(300), "two-row");
    assert.equal(Core.toolbarLayoutMode(519), "two-row");
    assert.equal(Core.toolbarLayoutMode(520), "one-row");
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

describe("previewText", () => {
  it("collapses whitespace and truncates", () => {
    assert.equal(Core.previewText("a\n\nb   c", 100), "a b c");
    assert.equal(Core.previewText("abcdefghij", 5), "abcde");
    assert.equal(Core.previewText("  padded  ", 100), "padded");
    assert.equal(Core.previewText("exact", 5), "exact");
    assert.equal(Core.previewText("toolong", 4), "tool");
  });
});
