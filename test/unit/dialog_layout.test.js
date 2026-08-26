"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

describe("estimateTextHeight", () => {
  it("returns 0 for empty text", () => {
    assert.equal(Core.estimateTextHeight("", 500), 0);
    assert.equal(Core.estimateTextHeight(null, 500), 0);
  });

  it("counts wrapped lines for long single-line blobs", () => {
    const blob = "x".repeat(800);
    const h = Core.estimateTextHeight(blob, 400);
    assert.ok(h > 200, "800 chars should wrap to many lines");
  });

  it("respects explicit newlines", () => {
    const text = Array.from({ length: 20 }, () => "line").join("\n");
    const h = Core.estimateTextHeight(text, 400, { lineHeight: 20 });
    assert.equal(h, 20 * 20);
  });

  it("guards hostile width and custom line metrics", () => {
    assert.ok(Core.estimateTextHeight("hello world", 0) > 0);
    assert.ok(Core.estimateTextHeight("hello world", NaN) > 0);
    const tall = Core.estimateTextHeight("abc", 400, {
      lineHeight: 30,
      avgCharPx: 3,
    });
    assert.equal(tall, 30);
  });
});

describe("dialogViewportBudget + dialogLayoutContext", () => {
  it("scales viewport with screen height within bounds", () => {
    const small = Core.dialogViewportBudget(720);
    const large = Core.dialogViewportBudget(1440);
    assert.ok(small >= Core.DIALOG_CONTENT.minViewport);
    assert.ok(large >= small);
    assert.ok(large <= Core.DIALOG_CONTENT.maxViewport);

    const ctx = Core.dialogLayoutContext(1920, 1080, { panelWidth: 360 });
    assert.ok(ctx.dialogWidth >= Core.DIALOG_CONTENT.minDialogWidth);
    assert.ok(ctx.dialogWidth <= Core.DIALOG_CONTENT.maxDialogWidth);
    assert.equal(ctx.maxViewport, Core.dialogViewportBudget(1080));
  });

  it("falls back safely on hostile screen / option input", () => {
    assert.equal(
      Core.dialogViewportBudget(NaN),
      Core.dialogViewportBudget(900)
    );
    assert.equal(
      Core.dialogViewportBudget(2000, { absMaxViewport: 400, minViewport: 300 }),
      400
    );
    assert.equal(
      Core.dialogViewportBudget(500, { chromeHeight: 400, minViewport: 200 }),
      200
    );

    const ctx = Core.dialogLayoutContext(NaN, NaN, { panelWidth: NaN });
    assert.ok(ctx.dialogWidth >= Core.DIALOG_CONTENT.minDialogWidth);
    assert.equal(ctx.minViewport, Core.DIALOG_CONTENT.minViewport);
  });

  it("prefers wider dialog when panel or screen allows", () => {
    const narrow = Core.dialogLayoutContext(800, 900, { panelWidth: 300 });
    const wide = Core.dialogLayoutContext(1920, 900, { panelWidth: 700 });
    assert.ok(wide.dialogWidth > narrow.dialogWidth);
    assert.ok(wide.dialogWidth <= Core.DIALOG_CONTENT.maxDialogWidth);
  });
});

describe("dialogContentMetrics", () => {
  it("gives new/empty prompts a tall editor (max viewport)", () => {
    const empty = Core.dialogContentMetrics(0, { isEmpty: true, maxViewport: 480 });
    assert.equal(empty.viewportHeight, 480);
    assert.ok(empty.entryHeight >= Core.DIALOG_CONTENT.minEntry);
    assert.equal(empty.needsScroll, false);

    const blankText = Core.dialogContentMetrics(0, { text: "", maxViewport: 480 });
    assert.equal(blankText.viewportHeight, 480);
    assert.equal(blankText.needsScroll, false);
  });

  it("shrink-wraps short prompts to the min viewport", () => {
    const short = Core.dialogContentMetrics(40, { text: "hello", maxViewport: 480 });
    assert.equal(short.viewportHeight, Core.DIALOG_CONTENT.minViewport);
    assert.ok(short.entryHeight >= Core.DIALOG_CONTENT.minEntry);
    assert.equal(short.needsScroll, false);
  });

  it("grows entry with content; viewport caps; needsScroll when overflowing", () => {
    const mid = Core.dialogContentMetrics(160, { text: "x".repeat(200), maxViewport: 480 });
    assert.ok(mid.entryHeight >= 160);
    assert.ok(mid.viewportHeight <= 480);
    assert.ok(mid.viewportHeight >= Core.DIALOG_CONTENT.minViewport);

    const long = Core.dialogContentMetrics(800, { text: "x".repeat(5000), maxViewport: 480 });
    assert.equal(long.viewportHeight, 480);
    assert.ok(long.entryHeight > long.viewportHeight, "long text must overflow into scroll");
    assert.equal(long.needsScroll, true);
    assert.ok(long.entryHeight < 2000, "must not apply Pango.SCALE-sized heights");

    // Huge prompt (Argus-scale): estimate lifts entry height when pref is tiny
    const argusLike = "You are **Argus**:\n" + "Assume breach. ".repeat(4000);
    const huge = Core.dialogContentMetrics(200, {
      text: argusLike,
      maxViewport: 480,
    });
    assert.equal(huge.viewportHeight, 480);
    assert.ok(huge.entryHeight > huge.viewportHeight);
    assert.equal(huge.needsScroll, true);
    assert.ok(huge.entryHeight > 5000, "estimate must exceed Clutter under-report");
  });

  it("never couples to desklet list_height and rejects hostile input", () => {
    const m = Core.dialogContentMetrics(NaN, { dialogWidth: 9999, text: "x" });
    assert.equal(m.innerWidth, Core.DIALOG_CONTENT.maxDialogWidth);
    assert.equal(m.viewportHeight, Core.DIALOG_CONTENT.minViewport);

    const neg = Core.dialogContentMetrics(-50, { dialogWidth: 100, text: "hi" });
    assert.equal(neg.innerWidth, Core.DIALOG_CONTENT.minDialogWidth);
    assert.ok(neg.entryHeight >= Core.DIALOG_CONTENT.minEntry);

    const custom = Core.dialogContentMetrics(50, {
      minViewport: 100,
      maxViewport: 150,
      minEntry: 90,
      pad: 10,
      dialogWidth: 480,
      text: "custom",
    });
    assert.equal(custom.innerWidth, 480);
    assert.equal(custom.viewportHeight, 100);
    assert.equal(custom.entryHeight, 90);
    assert.equal(custom.textWidth, 480 - Core.DIALOG_CONTENT.textChromeX);
  });

  it("keeps text width below inner width (wrap chrome)", () => {
    for (const w of [300, 420, 500, 700]) {
      const m = Core.dialogContentMetrics(10, { dialogWidth: w, text: "wrap" });
      assert.ok(m.textWidth < m.innerWidth);
      assert.ok(m.textWidth >= Core.DIALOG_CONTENT.minTextWidth);
      assert.ok(m.innerWidth >= Core.DIALOG_CONTENT.minDialogWidth);
      assert.ok(m.innerWidth <= Core.DIALOG_CONTENT.maxDialogWidth);
    }
  });

  it("swaps inverted min/max viewport safely", () => {
    const m = Core.dialogContentMetrics(200, {
      minViewport: 180,
      maxViewport: 100,
      text: "lines\n".repeat(30),
    });
    assert.ok(m.viewportHeight >= 180);
    assert.equal(m.viewportHeight, Math.max(180, Math.min(Math.max(180, 100), m.entryHeight)));
  });
});

describe("dialogScrollDelta + clampScrollValue", () => {
  it("maps wheel directions to adjustment deltas", () => {
    assert.equal(Core.dialogScrollDelta("up", 40), -120);
    assert.equal(Core.dialogScrollDelta("down", 40), 120);
    assert.equal(Core.dialogScrollDelta("UP", 10), -30);
    assert.equal(Core.dialogScrollDelta("smooth", 40, 2.5), 100);
    assert.equal(Core.dialogScrollDelta("smooth", 40, -1), -40);
    assert.equal(Core.dialogScrollDelta("smooth", 40, 0), 0);
    assert.equal(Core.dialogScrollDelta("smooth", 40, NaN), 0);
    assert.equal(Core.dialogScrollDelta("left", 40), 0);
    assert.equal(Core.dialogScrollDelta("right", 40), 0);
    assert.equal(Core.dialogScrollDelta("", 40), 0);
    assert.equal(Core.dialogScrollDelta("down", 0), 120);
    assert.equal(Core.dialogScrollDelta("down", -5), 120);
    assert.equal(Core.dialogScrollDelta("down", NaN), 120);
  });

  it("clamps scroll values into the visible page range", () => {
    assert.equal(Core.clampScrollValue(50, 0, 100, 30), 50);
    assert.equal(Core.clampScrollValue(-10, 0, 100, 30), 0);
    assert.equal(Core.clampScrollValue(999, 0, 100, 30), 70);
    assert.equal(Core.clampScrollValue(70, 0, 100, 30), 70);
    assert.equal(Core.clampScrollValue(71, 0, 100, 30), 70);
    assert.equal(Core.clampScrollValue(NaN, 0, 100, 30), 0);
    assert.equal(Core.clampScrollValue(10, NaN, 100, 30), 10);
    assert.equal(Core.clampScrollValue(10, 0, NaN, 30), 0);
    assert.equal(Core.clampScrollValue(10, 0, 100, NaN), 10);
    assert.equal(Core.clampScrollValue(10, 0, 100, -5), 10);
    assert.equal(Core.clampScrollValue(5, 10, 8, 30), 10);
  });

  it("needsScroll is false when entry fits viewport and true when it overflows", () => {
    const fit = Core.dialogContentMetrics(100, {
      minViewport: 160,
      maxViewport: 360,
      pad: 0,
      text: "fits",
    });
    assert.equal(fit.needsScroll, false);
    const overflow = Core.dialogContentMetrics(500, {
      minViewport: 160,
      maxViewport: 360,
      pad: 0,
      text: "x".repeat(800),
    });
    assert.equal(overflow.needsScroll, true);
    assert.ok(overflow.entryHeight > overflow.viewportHeight);
    assert.ok(overflow.entryHeight >= 500);
    assert.equal(overflow.viewportHeight, 360);

    const edge = Core.dialogContentMetrics(361, {
      minViewport: 160,
      maxViewport: 360,
      pad: 0,
      minEntry: 40,
      text: "edge",
    });
    assert.equal(edge.entryHeight, 361);
    assert.equal(edge.viewportHeight, 360);
    assert.equal(edge.needsScroll, false);
    const justOver = Core.dialogContentMetrics(362, {
      minViewport: 160,
      maxViewport: 360,
      pad: 0,
      minEntry: 40,
      text: "over",
    });
    assert.equal(justOver.needsScroll, true);
  });
});
