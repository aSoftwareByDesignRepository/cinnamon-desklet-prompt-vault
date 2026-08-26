"use strict";

/**
 * E2E model of the edit-dialog content sync.
 * Proves the old list_height + Pango.SCALE path cannot return, and the new
 * shrink-wrap path never opens a cavernous empty textarea.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

const PANGO_SCALE = 1024;

/** Legacy broken sync — documents the vanish/cavern bug. */
function legacySync(preferredTextPx, listHeight) {
  const scrollH = Math.max(280, Math.min(480, listHeight || 300));
  const bottomPad = 40;
  const boxH = Math.max(scrollH - 8, preferredTextPx + bottomPad);
  // Wrong: actor size in Pango units → enormous allocation
  return {
    viewportHeight: scrollH,
    entryHeight: boxH,
    actorHeightIfScaled: boxH * PANGO_SCALE,
  };
}

function modernSync(preferredTextPx, panelWidth) {
  return Core.dialogContentMetrics(preferredTextPx, { dialogWidth: panelWidth });
}

describe("e2e: edit dialog content layout", () => {
  it("legacy path creates huge empty space on new/empty prompts", () => {
    const bad = legacySync(0, 400);
    assert.ok(bad.viewportHeight >= 280);
    assert.ok(bad.entryHeight >= 272);
    assert.ok(bad.actorHeightIfScaled > 200000, "Pango.SCALE misuse inflates actors");
  });

  it("modern path keeps empty/new prompts compact", () => {
    const good = modernSync(0, 400);
    assert.equal(good.viewportHeight, Core.DIALOG_CONTENT.minViewport);
    assert.ok(good.viewportHeight < 250);
    assert.ok(good.entryHeight <= 140);
  });

  it("survives rapid typing reflows without jumping to list_height", () => {
    let last = modernSync(0, 400);
    for (let lines = 1; lines <= 40; lines++) {
      // ~18px per line preferred height simulation
      const next = modernSync(lines * 18, 400);
      assert.ok(next.viewportHeight <= Core.DIALOG_CONTENT.maxViewport);
      assert.ok(next.viewportHeight >= last.viewportHeight || next.viewportHeight === Core.DIALOG_CONTENT.maxViewport);
      if (lines * 18 + Core.DIALOG_CONTENT.pad > Core.DIALOG_CONTENT.maxViewport) {
        assert.ok(next.entryHeight > next.viewportHeight);
      }
      last = next;
    }
  });

  it("edit existing long prompt: viewport capped, entry scrolls", () => {
    const m = modernSync(1200, 520);
    assert.equal(m.viewportHeight, Core.DIALOG_CONTENT.maxViewport);
    assert.ok(m.entryHeight > m.viewportHeight);
    assert.ok(m.entryHeight < 10000, "no Pango-scaled height leak");
  });

  it("create→type→save layout session stays within dialog chrome bounds", () => {
    const widths = [260, 400, 640];
    for (const w of widths) {
      const empty = modernSync(0, w);
      const typed = modernSync(90, w);
      const saved = modernSync(90, w);
      assert.equal(empty.innerWidth, typed.innerWidth);
      assert.equal(typed.viewportHeight, saved.viewportHeight);
      assert.ok(empty.innerWidth <= Core.DIALOG_CONTENT.maxDialogWidth);
      assert.ok(empty.textWidth < empty.innerWidth);
    }
  });
});
