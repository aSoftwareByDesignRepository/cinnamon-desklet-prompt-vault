"use strict";

/**
 * End-to-end lifecycle model of the footer toolbar.
 *
 * Proves:
 *  1) Legacy reparent+destroy annihilates buttons (documented regression).
 *  2) Safe remount destroy-and-recreates so labels stay readable across widths.
 *  3) Same-mode reflows are noop (no flicker / no unnecessary teardown).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "..", "prompt-vault@alex", "pv_core.js"));

class MockActor {
  constructor(name) {
    this.name = name || "actor";
    this.children = [];
    this.parent = null;
    this.destroyed = false;
    this.styleClasses = new Set();
    this.label = "";
  }

  add_actor(child) {
    assert.ok(!this.destroyed, `${this.name}: add on destroyed`);
    assert.ok(!child.destroyed, `${child.name}: already destroyed`);
    if (child.parent) child.parent.remove_actor(child);
    child.parent = this;
    this.children.push(child);
  }

  remove_actor(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child.parent === this) child.parent = null;
  }

  get_n_children() {
    return this.children.length;
  }

  get_child_at_index(i) {
    return this.children[i];
  }

  get_parent() {
    return this.parent;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const kids = this.children.slice();
    this.children = [];
    for (const k of kids) k.destroy();
    if (this.parent) this.parent.remove_actor(this);
  }

  add_style_class_name(c) {
    this.styleClasses.add(c);
  }

  remove_style_class_name(c) {
    this.styleClasses.delete(c);
  }
}

/** Broken legacy reflow — documents the vanish bug. */
function legacyReflowDestroying(toolbar, buttons) {
  while (toolbar.get_n_children() > 0) {
    const row = toolbar.get_child_at_index(0);
    toolbar.remove_actor(row);
    row.destroy();
  }
  const row = new MockActor("row");
  for (const b of buttons) {
    if (!b.destroyed) row.add_actor(b);
  }
  toolbar.add_actor(row);
}

function clearToolbar(toolbar) {
  while (toolbar.get_n_children() > 0) {
    const child = toolbar.get_child_at_index(0);
    toolbar.remove_actor(child);
    child.destroy();
  }
}

/** Production-safe remount: destroy rows, recreate buttons from plan. */
function safeRemount(toolbar, state, panelWidth, force) {
  const mode = Core.toolbarLayoutMode(panelWidth);
  const plan = Core.toolbarMountPlan({
    existingRowCount: toolbar.get_n_children(),
    currentMode: state.mode,
    nextMode: mode,
  });
  if (!force && plan.op === "noop") {
    return { op: "noop", buttons: state.buttons };
  }

  clearToolbar(toolbar);
  const buttons = Object.create(null);
  for (const rowSpec of plan.rows) {
    const row = new MockActor(`row:${rowSpec.id}`);
    for (const btnSpec of rowSpec.buttons) {
      const btn = new MockActor(`btn:${btnSpec.id}`);
      btn.label = btnSpec.id;
      buttons[btnSpec.id] = btn;
      row.add_actor(btn);
    }
    toolbar.add_actor(row);
  }
  state.mode = plan.mode;
  state.buttons = buttons;
  return { op: plan.op, buttons };
}

function assertReadablePacking(toolbar, mode) {
  const max = Core.toolbarMaxButtonsPerRow(mode);
  for (const row of toolbar.children) {
    assert.ok(
      row.children.length <= max,
      `${mode}: row has ${row.children.length} buttons, max ${max}`
    );
    assert.ok(row.children.length >= 1);
  }
  const ids = toolbar.children.flatMap((r) => r.children.map((b) => b.label));
  assert.deepEqual(ids.sort(), ["add", "export", "folder", "import", "shortcuts"]);
}

describe("e2e: toolbar actor lifecycle", () => {
  it("legacy reparent+destroy annihilates buttons (documents the bug)", () => {
    const toolbar = new MockActor("toolbar");
    const buttons = [new MockActor("add"), new MockActor("export")];
    const row = new MockActor("row0");
    for (const b of buttons) row.add_actor(b);
    toolbar.add_actor(row);

    legacyReflowDestroying(toolbar, buttons);
    assert.equal(buttons.filter((b) => b.destroyed).length, 2);
  });

  it("safe remount keeps five readable buttons across width changes", () => {
    const toolbar = new MockActor("toolbar");
    const state = { mode: null, buttons: Object.create(null) };

    let r = safeRemount(toolbar, state, 400, true);
    assert.equal(r.op, "mount");
    assert.equal(Object.keys(state.buttons).length, 5);
    assertReadablePacking(toolbar, "two-row");

    // same mode → noop
    r = safeRemount(toolbar, state, 420, false);
    assert.equal(r.op, "noop");
    assert.equal(toolbar.get_n_children(), 2);

    // widen → one-row remount
    const oldAdd = state.buttons.add;
    r = safeRemount(toolbar, state, 560, false);
    assert.equal(r.op, "remount");
    assert.equal(oldAdd.destroyed, true);
    assert.equal(state.buttons.add.destroyed, false);
    assertReadablePacking(toolbar, "one-row");
    assert.equal(toolbar.get_n_children(), 1);

    // narrow → stack
    r = safeRemount(toolbar, state, 260, false);
    assert.equal(r.op, "remount");
    assertReadablePacking(toolbar, "stack");
    assert.equal(toolbar.get_n_children(), 5);

    for (let i = 0; i < 100; i++) {
      safeRemount(toolbar, state, 260 + (i % 3) * 150, false);
    }
    assert.equal(Object.keys(state.buttons).length, 5);
    for (const b of Object.values(state.buttons)) {
      assert.equal(b.destroyed, false);
    }
  });

  it("list↔template view toggling never requires button reparent", () => {
    const toolbar = new MockActor("toolbar");
    const state = { mode: null, buttons: Object.create(null) };
    safeRemount(toolbar, state, 400, true);
    toolbar.visible = true;
    toolbar.visible = false;
    toolbar.visible = true;
    for (const b of Object.values(state.buttons)) {
      assert.equal(b.destroyed, false);
    }
  });
});

describe("e2e: copy workflow with always_copy_raw", () => {
  function runCopyClick(content, alwaysCopyRaw, fillValues) {
    const plan = Core.resolveCopyPlan(content, alwaysCopyRaw);
    if (plan.action === "copy") {
      return { ui: "none", clipboard: plan.text };
    }
    const text = Core.materializeCopyText(content, fillValues, false);
    return { ui: "fill", clipboard: text, vars: plan.vars };
  }

  it("one-click copy when always raw (security-critical path)", () => {
    const r = runCopyClick("Deploy {{env}} now", true);
    assert.equal(r.ui, "none");
    assert.equal(r.clipboard, "Deploy {{env}} now");
  });

  it("fill path only when explicitly enabled", () => {
    const r = runCopyClick("Deploy {{env}} now", false, { env: "prod" });
    assert.equal(r.ui, "fill");
    assert.deepEqual(r.vars, ["env"]);
    assert.equal(r.clipboard, "Deploy prod now");
  });

  it("raw escape from fill panel preserves markers", () => {
    const plan = Core.resolveCopyPlan("X {{a}}", false);
    assert.equal(plan.action, "fill");
    assert.equal(Core.materializeCopyText("X {{a}}", { a: "1" }, true), "X {{a}}");
  });

  it("round-trips a full vault filter→copy session without losing plan integrity", () => {
    const deps = {
      uuid: (() => {
        let n = 0;
        return () => `e2e-${++n}`;
      })(),
      now: () => "2026-08-26T12:00:00.000Z",
    };
    const vault = [
      Core.sanitizePrompt(
        { id: "1", title: "Athena — General Dev", content: "plain", favorite: true },
        deps
      ),
      Core.sanitizePrompt(
        { id: "2", title: "Hermes — SEO", content: "Rank {{keyword}}", category: "Marketing" },
        deps
      ),
    ];
    const listed = Core.filterAndSortPrompts(vault, { favoritesOnly: true });
    assert.equal(listed.length, 1);
    const plan = Core.resolveCopyPlan(listed[0].content, true);
    assert.equal(plan.action, "copy");
    assert.equal(plan.text, "plain");

    const marketing = Core.filterAndSortPrompts(vault, { categoryFilter: "Marketing" });
    const fill = Core.resolveCopyPlan(marketing[0].content, false);
    assert.equal(fill.action, "fill");
    assert.equal(
      Core.materializeCopyText(marketing[0].content, { keyword: "mint" }, false),
      "Rank mint"
    );
  });
});
