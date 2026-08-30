"use strict";

/**
 * Mutation-hardening tests — each assertion exists to kill a specific Stryker
 * survivor (aliases, branch guards, null coalescing, trim, equality).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

describe("mutation: resolveDefaultFilter aliases + guards", () => {
  it("accepts every favorites spelling independently", () => {
    for (const mode of ["favorites", "favourite", "favourites", "fav", "FAV", " Favourite "]) {
      assert.deepEqual(
        Core.resolveDefaultFilter(mode),
        { favoritesOnly: true, categoryFilter: "all" },
        mode
      );
    }
  });

  it("does not treat non-category modes as category even when a name is set", () => {
    // Kills `if (m === "category")` → `if (true)`
    assert.deepEqual(Core.resolveDefaultFilter("all", "Dev", ["Dev"]), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.resolveDefaultFilter("recent", "Dev", ["Dev"]), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
  });

  it("uses empty knownCategories when omitted (no phantom matches)", () => {
    // Kills `knownCategories || []` → `|| ["Stryker was here"]`
    assert.deepEqual(Core.resolveDefaultFilter("category", "stryker was here", undefined), {
      favoritesOnly: false,
      categoryFilter: "stryker was here",
    });
    assert.deepEqual(Core.resolveDefaultFilter("category", "stryker was here", null), {
      favoritesOnly: false,
      categoryFilter: "stryker was here",
    });
  });
});

describe("mutation: selectListFilter + equals", () => {
  it("rejects non-object selections and trims type", () => {
    assert.deepEqual(Core.selectListFilter(null), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter("favorites"), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "  Favourites  " }), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "favourite" }), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
  });

  it("ignores category payload unless type is category", () => {
    assert.deepEqual(Core.selectListFilter({ type: "all", category: "Dev" }), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "favorites", category: "Dev" }), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
  });

  it("equals requires BOTH favorites flag and category", () => {
    const fav = { favoritesOnly: true, categoryFilter: "all" };
    const all = { favoritesOnly: false, categoryFilter: "all" };
    const dev = { favoritesOnly: false, categoryFilter: "Dev" };
    assert.equal(Core.listFilterEquals(fav, all), false);
    assert.equal(Core.listFilterEquals(all, dev), false);
    assert.equal(Core.listFilterEquals(fav, fav), true);
    assert.equal(Core.listFilterEquals(null, {}), true);
    assert.equal(Core.listFilterEquals(undefined, undefined), true);
  });

  it("signatures distinguish all / favorites / category", () => {
    assert.equal(Core.listFilterSignature({ favoritesOnly: true }), "favorites");
    assert.equal(Core.listFilterSignature({ favoritesOnly: false, categoryFilter: "all" }), "all");
    assert.equal(Core.listFilterSignature({ favoritesOnly: false, categoryFilter: "" }), "all");
    assert.equal(Core.listFilterSignature({ favoritesOnly: false, categoryFilter: "Dev" }), "category:Dev");
    assert.equal(Core.listFilterSignature(null), "all");
  });
});

describe("mutation: toolbar + copy plan edge guards", () => {
  it("mount plan is noop for same mode and remounts on mode change", () => {
    assert.equal(Core.toolbarMountPlan(0, null, "two-row").op, "mount");
    assert.equal(Core.toolbarMountPlan(0, null, "two-row").reason, "initial-build");
    assert.equal(
      Core.toolbarMountPlan({
        existingRowCount: 1,
        currentMode: "two-row",
        nextMode: "two-row",
      }).op,
      "noop"
    );
    assert.equal(
      Core.toolbarMountPlan({
        existingRowCount: 1,
        currentMode: "two-row",
        nextMode: "two-row",
      }).reason,
      "mode-unchanged"
    );
  });

  it("structure rows are fresh objects (no shared mutable singleton)", () => {
    const a = Core.toolbarStructure(400);
    const b = Core.toolbarStructure(400);
    assert.notEqual(a, b);
    assert.notEqual(a.rows, b.rows);
    a.rows[0].buttons.push({ id: "evil" });
    assert.equal(Core.toolbarStructure(400).rows[0].buttons.length, 2);
  });

  it("resolveCopyPlan distinguishes false from other falsy only for fill", () => {
    assert.equal(Core.resolveCopyPlan("{{x}}", false).action, "fill");
    assert.equal(Core.resolveCopyPlan("{{x}}", 0).action, "copy"); // 0 !== false → raw
    assert.equal(Core.resolveCopyPlan("{{x}}", "").action, "copy");
  });

  it("materializeCopyText raw short-circuits before applyTemplate", () => {
    assert.equal(Core.materializeCopyText("{{x}}", { x: "Z" }, true), "{{x}}");
    assert.equal(Core.materializeCopyText("{{x}}", undefined, false), "{{x}}");
    assert.equal(Core.materializeCopyText("{{x}}", { x: "Z" }, false), "Z");
  });
});

describe("mutation: previewText boundaries", () => {
  it("does not truncate when length equals maxLen", () => {
    assert.equal(Core.previewText("exact", 5), "exact");
    assert.equal(Core.previewText("toolong", 4), "tool");
    assert.equal(Core.previewText("short", 100), "short");
    assert.equal(Core.previewText("", 10), "");
  });
});

describe("mutation: exact ceilings on ids, store, paths, tags", () => {
  it("rejects reserved id prototype (not only __proto__/constructor)", () => {
    assert.equal(Core.isSafePromptId("prototype"), false);
    assert.equal(Core.isSafePromptId(""), false);
    const max = "a".repeat(Core.STORE_LIMITS.maxIdLen);
    const over = "a".repeat(Core.STORE_LIMITS.maxIdLen + 1);
    assert.equal(Core.isSafePromptId(max), true);
    assert.equal(Core.isSafePromptId(over), false);
  });

  it("allows count/bytes equal to the cap and rejects one over", () => {
    assert.equal(Core.exceedsStoreLimits(Core.STORE_LIMITS.maxPrompts, 10), null);
    assert.equal(Core.exceedsStoreLimits(Core.STORE_LIMITS.maxPrompts + 1, 10), "prompts");
    assert.equal(Core.exceedsStoreLimits(1, Core.STORE_LIMITS.maxBytes), null);
    assert.equal(Core.exceedsStoreLimits(1, Core.STORE_LIMITS.maxBytes + 1), "bytes");
  });

  it("allows data-dir length 4096 and rejects 4097", () => {
    assert.equal(Core.isUsableDataDirPath("x".repeat(4096)), true);
    assert.equal(Core.isUsableDataDirPath("x".repeat(4097)), false);
  });

  it("trims template names; length 60 is allowed, 61 is not", () => {
    assert.deepEqual(Core.extractTemplateVars("only {{ topic }} here"), ["topic"]);
    assert.equal(Core.applyTemplate("{{ topic }}", { topic: "X" }), "X");
    const ok = "A" + "b".repeat(59);
    const too = "A" + "b".repeat(60);
    assert.equal(ok.length, 60);
    assert.equal(too.length, 61);
    assert.equal(Core.isSafeTemplateVar(ok), true);
    assert.equal(Core.isSafeTemplateVar(too), false);
    assert.equal(Core.isSafeTemplateVar("  topic  "), true);
  });

  it("joins tags with comma-space and trims title/category on sanitize", () => {
    assert.equal(Core.tagsToString(["Foo", "Bar"]), "Foo, Bar");
    assert.equal(Core.tagsToString(["Foo", "foo"]), "Foo");
    const deps = { uuid: () => "id-x", now: () => "t" };
    const p = Core.sanitizePrompt({ id: "id-x", title: "  Hello  ", category: "  Dev  " }, deps);
    assert.equal(p.title, "Hello");
    assert.equal(p.category, "Dev");
  });

  it("normalizeHotkeySlot rejects 0 and values below 1 independently of the upper bound", () => {
    assert.equal(Core.normalizeHotkeySlot(0), 0);
    assert.equal(Core.normalizeHotkeySlot(1), 1);
    assert.equal(Core.normalizeHotkeySlot(9), 9);
  });

  it("uniquifyPromptIds skips non-objects instead of throwing", () => {
    const out = Core.uniquifyPromptIds([null, { id: "ok" }, "x"], () => "n1");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "ok");
  });

  it("rejects non-string prompt ids (numbers must not be treated as safe)", () => {
    assert.equal(Core.isSafePromptId(123), false);
    assert.equal(Core.isSafePromptId(null), false);
    assert.equal(Core.isSafePromptId(undefined), false);
  });

  it("applyTemplate does not throw when values is null or undefined", () => {
    assert.equal(Core.applyTemplate("{{x}}", null), "{{x}}");
    assert.equal(Core.applyTemplate("{{x}}", undefined), "{{x}}");
  });

  it("counts uppercase .JSON names as recoverable vault files", () => {
    assert.equal(Core.countRecoverableVaultJson(["BACKUP.JSON", "prompts.json"]), 1);
  });

  it("sanitizePrompt names both missing deps in the error message", () => {
    try {
      Core.sanitizePrompt({}, { uuid: () => "a" });
      assert.fail("should throw");
    } catch (e) {
      assert.equal(e.message, "sanitizePrompt requires deps.uuid and deps.now");
    }
    try {
      Core.sanitizePrompt({}, { now: () => "t" });
      assert.fail("should throw");
    } catch (e) {
      assert.equal(e.message, "sanitizePrompt requires deps.uuid and deps.now");
    }
  });
});
