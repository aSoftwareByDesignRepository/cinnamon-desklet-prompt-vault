"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

describe("selectListFilter state machine", () => {
  it("selects all / favorites / category", () => {
    assert.deepEqual(Core.selectListFilter({ type: "all" }), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "favorites" }), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "Favourites" }), {
      favoritesOnly: true,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "category", category: "Linux Mint" }), {
      favoritesOnly: false,
      categoryFilter: "Linux Mint",
    });
  });

  it("falls back safely on bad input", () => {
    assert.deepEqual(Core.selectListFilter(null), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "category", category: "  " }), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
    assert.deepEqual(Core.selectListFilter({ type: "nope" }), {
      favoritesOnly: false,
      categoryFilter: "all",
    });
  });

  it("equals + signature are stable for chip sync", () => {
    const a = Core.selectListFilter({ type: "category", category: "General" });
    const b = { favoritesOnly: false, categoryFilter: "General" };
    const fav = Core.selectListFilter({ type: "favorites" });
    assert.equal(Core.listFilterEquals(a, b), true);
    assert.equal(Core.listFilterEquals(a, fav), false);
    assert.equal(Core.listFilterEquals(fav, { favoritesOnly: 1, categoryFilter: "all" }), true);
    assert.equal(Core.listFilterSignature(a), "category:General");
    assert.equal(Core.listFilterSignature(fav), "favorites");
    assert.equal(Core.listFilterSignature({ categoryFilter: "all" }), "all");
  });
});

describe("filter chip workflow integration", () => {
  const deps = {
    uuid: (() => {
      let n = 0;
      return () => `f-${++n}`;
    })(),
    now: () => "2026-08-15T16:00:00.000Z",
  };

  function prompt(partial) {
    return Core.sanitizePrompt(partial, deps);
  }

  const data = [
    prompt({ id: "1", title: "A", category: "General", favorite: true, content: "a" }),
    prompt({ id: "2", title: "B", category: "General", favorite: false, content: "b" }),
    prompt({ id: "3", title: "C", category: "Linux", favorite: false, content: "c" }),
    prompt({ id: "4", title: "D", category: "Nextcloud", favorite: true, content: "d" }),
  ];

  it("switching chips updates the visible set without leaking favorites mode", () => {
    let state = Core.selectListFilter({ type: "all" });
    let items = Core.filterAndSortPrompts(data, state);
    assert.equal(items.length, 4);

    state = Core.selectListFilter({ type: "favorites" });
    items = Core.filterAndSortPrompts(data, state);
    assert.deepEqual(
      items.map((p) => p.id).sort(),
      ["1", "4"]
    );

    state = Core.selectListFilter({ type: "category", category: "Linux" });
    assert.equal(state.favoritesOnly, false);
    items = Core.filterAndSortPrompts(data, state);
    assert.deepEqual(
      items.map((p) => p.id),
      ["3"]
    );

    state = Core.selectListFilter({ type: "category", category: "General" });
    items = Core.filterAndSortPrompts(data, state);
    assert.deepEqual(
      items.map((p) => p.id).sort(),
      ["1", "2"]
    );

    // Re-selecting the same chip is a no-op for state.
    const again = Core.selectListFilter({ type: "category", category: "General" });
    assert.equal(Core.listFilterEquals(state, again), true);
  });

  it("survives rapid alternating selections (no stuck favorites flag)", () => {
    let state = Core.selectListFilter({ type: "all" });
    const sequence = [
      { type: "favorites" },
      { type: "category", category: "Nextcloud" },
      { type: "favorites" },
      { type: "all" },
      { type: "category", category: "Linux" },
      { type: "category", category: "Linux" },
      { type: "favorites" },
      { type: "category", category: "General" },
    ];
    for (const sel of sequence) {
      state = Core.selectListFilter(sel);
      const items = Core.filterAndSortPrompts(data, {
        favoritesOnly: state.favoritesOnly,
        categoryFilter: state.categoryFilter,
        sortMode: "title",
      });
      if (state.favoritesOnly) {
        assert.ok(items.every((p) => p.favorite));
      } else if (state.categoryFilter !== "all") {
        assert.ok(items.every((p) => p.category === state.categoryFilter));
        assert.equal(state.favoritesOnly, false);
      }
    }
    assert.deepEqual(state, {
      favoritesOnly: false,
      categoryFilter: "General",
    });
  });
});
