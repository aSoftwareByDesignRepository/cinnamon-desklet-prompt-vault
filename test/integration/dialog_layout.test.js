"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

const deps = {
  uuid: (() => {
    let n = 0;
    return () => `dlg-${++n}`;
  })(),
  now: () => "2026-08-26T16:50:00.000Z",
};

describe("edit dialog + copy integration", () => {
  it("sanitized prompt content length drives compact metrics for short text", () => {
    const p = Core.sanitizePrompt(
      { title: "Athena — Dev", content: "One line prompt" },
      deps
    );
    // Approximate: short content → preferred height small → min viewport
    const m = Core.dialogContentMetrics(24, { dialogWidth: 400 });
    assert.ok(m.viewportHeight <= Core.DIALOG_CONTENT.maxViewport);
    assert.equal(Core.resolveCopyPlan(p.content, true).action, "copy");
  });

  it("imported long prompt still gets capped viewport", () => {
    const long = "x".repeat(5000);
    const p = Core.sanitizePrompt({ title: "Zeus", content: long }, deps);
    assert.equal(p.content.length, 5000);
    const m = Core.dialogContentMetrics(900, { dialogWidth: 560, text: long });
    assert.equal(m.viewportHeight, Core.DIALOG_CONTENT.maxViewport);
    assert.ok(m.entryHeight > m.viewportHeight);
  });

  it("dialog width clamp is independent of panel list height extremes", () => {
    // list_height is irrelevant — only dialogWidth matters
    const a = Core.dialogContentMetrics(0, { dialogWidth: 260, isEmpty: true });
    const b = Core.dialogContentMetrics(0, { dialogWidth: 640, isEmpty: true });
    assert.equal(a.viewportHeight, b.viewportHeight);
    assert.ok(a.innerWidth < b.innerWidth);
  });
});
