"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

const deps = {
  uuid: (() => {
    let n = 0;
    return () => `cp-${++n}`;
  })(),
  now: () => "2026-08-26T16:00:00.000Z",
};

describe("copy + toolbar integration", () => {
  it("mount plan matches structure and remounts only on mode change", () => {
    const structure = Core.toolbarStructure(400);
    const mount = Core.toolbarMountPlan(0, null, structure.mode);
    assert.equal(mount.op, "mount");
    assert.deepEqual(
      mount.rows.map((r) => r.id),
      structure.rows.map((r) => r.id)
    );
    assert.equal(
      Core.toolbarMountPlan({
        existingRowCount: structure.rows.length,
        currentMode: structure.mode,
        nextMode: structure.mode,
      }).op,
      "noop"
    );
    assert.equal(
      Core.toolbarMountPlan({
        existingRowCount: structure.rows.length,
        currentMode: "two-row",
        nextMode: "one-row",
      }).op,
      "remount"
    );
  });

  it("favorites-first list then raw-copy never enters fill UI", () => {
    const prompts = [
      Core.sanitizePrompt(
        { id: "a", title: "Zeus — God Mode", content: "Do {{task}}", favorite: true },
        deps
      ),
      Core.sanitizePrompt(
        { id: "b", title: "Hermes — SEO", content: "plain", favorite: false },
        deps
      ),
    ];
    const listed = Core.filterAndSortPrompts(prompts, { sortMode: "title" });
    assert.equal(listed[0].id, "a");
    const plan = Core.resolveCopyPlan(listed[0].content, true);
    assert.equal(plan.action, "copy");
    assert.match(plan.text, /\{\{task\}\}/);
  });

  it("import merge preserves content for subsequent copy plans", () => {
    const existing = [
      Core.sanitizePrompt({ id: "keep", title: "Athena — Dev", content: "old {{x}}" }, deps),
    ];
    const incoming = [
      Core.sanitizePrompt({ id: "keep", title: "Athena — Dev", content: "new {{x}}" }, deps),
      Core.sanitizePrompt({ id: "fresh", title: "Clio — Docs", content: "manual" }, deps),
    ];
    const merged = Core.mergePromptsById(existing, incoming);
    const keep = merged.find((p) => p.id === "keep");
    assert.equal(keep.content, "new {{x}}");
    assert.equal(Core.resolveCopyPlan(keep.content, true).action, "copy");
    assert.equal(Core.resolveCopyPlan(keep.content, false).action, "fill");
    assert.equal(Core.materializeCopyText(keep.content, { x: "ok" }, false), "new ok");
  });

  it("responsive chrome never claims more width than the panel", () => {
    for (const w of [260, 300, 400, 520, 640]) {
      const inner = Core.innerContentWidth(w);
      assert.ok(inner <= w);
      assert.ok(Core.titleWrapWidth(w) <= inner);
      assert.ok(["stack", "two-row", "one-row"].includes(Core.toolbarLayoutMode(w)));
    }
  });
});
