"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

const deps = {
  uuid: (() => {
    let n = 0;
    return () => `uuid-${++n}`;
  })(),
  now: () => "2026-08-15T10:00:00.000Z",
};

function prompt(partial) {
  return Core.sanitizePrompt(partial, deps);
}

describe("filterAndSortPrompts", () => {
  const data = [
    prompt({
      id: "1",
      title: "Zebra",
      category: "Writing",
      content: "alpha draft",
      favorite: false,
      useCount: 2,
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      tags: ["draft"],
    }),
    prompt({
      id: "2",
      title: "Alpha",
      category: "Dev",
      content: "code review helper",
      favorite: true,
      useCount: 9,
      lastUsedAt: "2026-02-01T00:00:00.000Z",
      tags: ["review"],
    }),
    prompt({
      id: "3",
      title: "Beta",
      category: "Dev",
      content: "security audit",
      favorite: false,
      useCount: 5,
      lastUsedAt: "2026-03-01T00:00:00.000Z",
      tags: ["sec"],
    }),
  ];

  it("always ranks favorites first", () => {
    const out = Core.filterAndSortPrompts(data, { sortMode: "title" });
    assert.equal(out[0].id, "2");
    assert.deepEqual(
      out.slice(1).map((p) => p.title),
      ["Beta", "Zebra"]
    );
  });

  it("filters by category and favorites", () => {
    assert.deepEqual(
      Core.filterAndSortPrompts(data, { categoryFilter: "Dev" }).map((p) => p.id),
      ["2", "3"]
    );
    assert.deepEqual(
      Core.filterAndSortPrompts(data, { favoritesOnly: true }).map((p) => p.id),
      ["2"]
    );
  });

  it("searches across title, category, tags, notes, content", () => {
    const byTag = Core.filterAndSortPrompts(data, { searchQuery: "review" });
    assert.equal(byTag.length, 1);
    assert.equal(byTag[0].id, "2");
    const byContent = Core.filterAndSortPrompts(data, { searchQuery: "AUDIT" });
    assert.equal(byContent[0].id, "3");
  });

  it("sorts by uses and recent", () => {
    const byUses = Core.filterAndSortPrompts(data, { sortMode: "uses" });
    assert.deepEqual(
      byUses.map((p) => p.id),
      ["2", "3", "1"]
    );
    const byRecent = Core.filterAndSortPrompts(data, { sortMode: "recent" });
    assert.deepEqual(
      byRecent.map((p) => p.id),
      ["2", "3", "1"]
    );
  });

  it("breaks ties on equal useCount by title and uses updatedAt when never used", () => {
    const tied = [
      prompt({
        id: "x",
        title: "X",
        useCount: 3,
        favorite: false,
        lastUsedAt: null,
        updatedAt: "2026-05-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      prompt({
        id: "w",
        title: "W",
        useCount: 3,
        favorite: false,
        lastUsedAt: null,
        updatedAt: "2026-04-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    assert.deepEqual(
      Core.filterAndSortPrompts(tied, { sortMode: "uses" }).map((p) => p.id),
      ["w", "x"]
    );
    assert.deepEqual(
      Core.filterAndSortPrompts(tied, { sortMode: "recent" }).map((p) => p.id),
      ["x", "w"]
    );
  });
});

describe("hotkey slot integrity", () => {
  it("dedupes duplicate slots (first claim wins)", () => {
    const prompts = [
      prompt({ id: "a", hotkeySlot: 3, title: "First" }),
      prompt({ id: "b", hotkeySlot: 3, title: "Second" }),
      prompt({ id: "c", hotkeySlot: 1, title: "Other" }),
    ];
    Core.dedupeHotkeySlots(prompts, () => "2026-08-15T11:00:00.000Z");
    assert.equal(prompts[0].hotkeySlot, 3);
    assert.equal(prompts[1].hotkeySlot, 0);
    assert.equal(prompts[1].updatedAt, "2026-08-15T11:00:00.000Z");
    assert.equal(prompts[2].hotkeySlot, 1);
  });

  it("assignHotkeySlot clears the slot from other prompts", () => {
    const before = [
      prompt({ id: "a", hotkeySlot: 5 }),
      prompt({ id: "b", hotkeySlot: 0 }),
    ];
    const after = Core.assignHotkeySlot(before, "b", 5, () => "t1");
    assert.equal(after.find((p) => p.id === "b").hotkeySlot, 5);
    assert.equal(after.find((p) => p.id === "a").hotkeySlot, 0);
    assert.equal(after.find((p) => p.id === "a").updatedAt, "t1");
  });
});

describe("import / merge workflows", () => {
  it("parses both wrapped and raw array payloads", () => {
    assert.deepEqual(Core.parsePromptsPayload({ prompts: [{ id: "1" }] }), [{ id: "1" }]);
    assert.deepEqual(Core.parsePromptsPayload([{ id: "2" }]), [{ id: "2" }]);
    assert.equal(Core.parsePromptsPayload({ nope: true }), null);
    assert.equal(Core.parsePromptsPayload("x"), null);
  });

  it("merge replaces by id without dropping unrelated prompts", () => {
    const existing = [prompt({ id: "keep", title: "Old Keep" }), prompt({ id: "upd", title: "Old" })];
    const incoming = [prompt({ id: "upd", title: "New" }), prompt({ id: "fresh", title: "Fresh" })];
    const merged = Core.mergePromptsById(existing, incoming);
    const byId = Object.fromEntries(merged.map((p) => [p.id, p]));
    assert.equal(byId.keep.title, "Old Keep");
    assert.equal(byId.upd.title, "New");
    assert.equal(byId.fresh.title, "Fresh");
    assert.equal(merged.length, 3);
  });

  it("sanitizes hostile import then dedupes slots end-to-end", () => {
    const payload = {
      version: 1,
      prompts: [
        { id: "1", title: "A", hotkeySlot: 2, content: "{{x}}" },
        { id: "2", title: "B", hotkeySlot: 2, content: "plain" },
        { title: "", hotkeySlot: "nope", tags: "x, x, y" },
      ],
    };
    const raw = Core.parsePromptsPayload(payload);
    const incoming = Core.sanitizePromptList(raw, deps);
    Core.dedupeHotkeySlots(incoming, deps.now);
    assert.equal(incoming[0].hotkeySlot, 2);
    assert.equal(incoming[1].hotkeySlot, 0);
    assert.equal(incoming[2].title, "Untitled");
    assert.deepEqual(incoming[2].tags, ["x", "y"]);
    assert.deepEqual(Core.extractTemplateVars(incoming[0].content), ["x"]);
  });

  it("refuses an oversized import list", () => {
    assert.equal(Core.exceedsStoreLimits(Core.STORE_LIMITS.maxPrompts + 1, 100), "prompts");
  });
});

describe("uniqueCategories", () => {
  it("returns sorted unique categories and skips empty", () => {
    const a = prompt({ id: "1", category: "Zebra" });
    const b = prompt({ id: "2", category: "Alpha" });
    const c = prompt({ id: "3", category: "Alpha" });
    const empty = prompt({ id: "4", category: "Tmp" });
    empty.category = "";
    const cats = Core.uniqueCategories([a, b, c, empty]);
    assert.deepEqual(cats, ["Alpha", "Zebra"]);
    assert.deepEqual(Core.uniqueCategories(null), []);
  });
});
