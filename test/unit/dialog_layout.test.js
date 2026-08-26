"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

describe("dialogContentMetrics", () => {
  it("shrink-wraps empty / short prompts to the min viewport (no cavern)", () => {
    const empty = Core.dialogContentMetrics(0);
    assert.equal(empty.viewportHeight, Core.DIALOG_CONTENT.minViewport);
    assert.equal(empty.entryHeight, Core.DIALOG_CONTENT.minEntry);
    assert.ok(empty.viewportHeight <= 220, "empty dialog must stay compact");
    assert.ok(empty.entryHeight <= empty.viewportHeight || empty.entryHeight === Core.DIALOG_CONTENT.minEntry);

    const short = Core.dialogContentMetrics(40);
    assert.equal(short.viewportHeight, Core.DIALOG_CONTENT.minViewport);
    assert.equal(short.entryHeight, Core.DIALOG_CONTENT.minEntry);
  });

  it("grows viewport with content until the max, then scrolls via taller entry", () => {
    const mid = Core.dialogContentMetrics(160);
    assert.ok(mid.entryHeight >= 160);
    assert.ok(mid.viewportHeight <= Core.DIALOG_CONTENT.maxViewport);
    assert.ok(mid.viewportHeight >= Core.DIALOG_CONTENT.minViewport);

    const long = Core.dialogContentMetrics(800);
    assert.equal(long.viewportHeight, Core.DIALOG_CONTENT.maxViewport);
    assert.ok(long.entryHeight > long.viewportHeight, "long text must overflow into scroll");
    assert.ok(long.entryHeight < 2000, "must not apply Pango.SCALE-sized heights");
  });

  it("never couples to desklet list_height and rejects hostile input", () => {
    const m = Core.dialogContentMetrics(NaN, { dialogWidth: 9999 });
    assert.equal(m.innerWidth, Core.DIALOG_CONTENT.maxDialogWidth);
    assert.equal(m.viewportHeight, Core.DIALOG_CONTENT.minViewport);

    const neg = Core.dialogContentMetrics(-50, { dialogWidth: 100 });
    assert.equal(neg.innerWidth, Core.DIALOG_CONTENT.minDialogWidth);
    assert.ok(neg.entryHeight >= Core.DIALOG_CONTENT.minEntry);

    const custom = Core.dialogContentMetrics(50, {
      minViewport: 100,
      maxViewport: 150,
      minEntry: 90,
      pad: 10,
      dialogWidth: 480,
    });
    assert.equal(custom.innerWidth, 480);
    assert.equal(custom.viewportHeight, 100);
    assert.equal(custom.entryHeight, 90);
    assert.equal(custom.textWidth, 480 - Core.DIALOG_CONTENT.textChromeX);
  });

  it("keeps text width below inner width (wrap chrome)", () => {
    for (const w of [300, 420, 500, 700]) {
      const m = Core.dialogContentMetrics(10, { dialogWidth: w });
      assert.ok(m.textWidth < m.innerWidth);
      assert.ok(m.textWidth >= Core.DIALOG_CONTENT.minTextWidth);
      assert.ok(m.innerWidth >= Core.DIALOG_CONTENT.minDialogWidth);
      assert.ok(m.innerWidth <= Core.DIALOG_CONTENT.maxDialogWidth);
    }
  });

  it("swaps inverted min/max viewport safely", () => {
    // max < min → max becomes at least min
    const m = Core.dialogContentMetrics(200, { minViewport: 180, maxViewport: 100 });
    assert.ok(m.viewportHeight >= 180);
    assert.equal(m.viewportHeight, Math.max(180, Math.min(Math.max(180, 100), m.entryHeight)));
  });
});
