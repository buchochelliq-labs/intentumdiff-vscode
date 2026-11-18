import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

// #123: an already-open native comparison must follow live results for its baseline.

function load(name: string, overrides: Record<string, unknown>): any {
  const source = readFileSync(path.join(__dirname, "../src", `${name}.js`), "utf8");
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id: string) => overrides[id] ?? {}, setTimeout, clearTimeout, console });
  return exports;
}

const uri = (value: string) => ({ toString: () => value });
const diffWith = (changes: number) => ({
  language: "python",
  changes: Array.from({ length: changes }, () => ({ change_type: "MODIFICATION" })),
  change_groups: [],
});

function harness() {
  const applied: string[] = [];
  let contextsChanged = 0;
  const { DiffSurfaceController, comparisonTracksResult } = load("diffSurfaceController", {
    path,
    vscode: { workspace: { openTextDocument: async () => ({ getText: () => "" }) }, window: {} },
    "./extensionSettings": { readSemanticOnlyOptions: () => ({}) },
    "./mapper": { diffToBaseDecorations: () => [], diffToModifiedDecorations: () => [] },
  });
  const controller = new DiffSurfaceController({
    applyDiffVisuals: (target: any) => applied.push(`modified:${target}`),
    applyBaseDiffVisuals: (target: any) => applied.push(`base:${target}`),
    hideComments: () => false,
    onContextsChanged: () => { contextsChanged += 1; },
  });
  const remember = (context: any) => {
    (controller as any).openDiffContexts.set(context.baseUri.toString(), context);
    (controller as any).openDiffContexts.set(context.modifiedUri.toString(), context);
    return context;
  };
  return { controller, comparisonTracksResult, applied, remember, changed: () => contextsChanged };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    mode: "full",
    folderUri: "file:///ws",
    relativePath: "app.py",
    baseUri: uri("intentumdiff-base:/app.py"),
    modifiedUri: uri("file:///ws/app.py"),
    diff: diffWith(1),
    baselineRef: "HEAD",
    tracksWorkingTree: true,
    ...overrides,
  };
}

test("edit -> result -> clean updates an already-open native comparison (#123)", () => {
  const h = harness();
  const open = h.remember(context());
  const clean = diffWith(0);
  const updated = h.controller.reconcile({ folderUri: "file:///ws", relativePath: "app.py", baselineRef: "HEAD" }, clean);
  assert.equal(updated, 1);
  // Base and modified sides resolve to the same, current diff.
  assert.equal(h.controller.get("intentumdiff-base:/app.py").diff, clean);
  assert.equal(h.controller.get("file:///ws/app.py").diff, clean);
  assert.equal(open.diff.changes.length, 0);
  assert.deepEqual(h.applied, ["modified:file:///ws/app.py", "base:intentumdiff-base:/app.py"]);
  assert.equal(h.changed(), 1, "lens/status/navigation refresh once");
});

test("unrelated and historical comparisons remain unchanged (#123)", () => {
  const h = harness();
  const otherFile = h.remember(context({ relativePath: "other.py", baseUri: uri("b:other"), modifiedUri: uri("m:other") }));
  const otherRef = h.remember(context({ baselineRef: "origin/main", baseUri: uri("b:ref"), modifiedUri: uri("m:ref") }));
  const snapshot = h.remember(context({ tracksWorkingTree: false, baseUri: uri("b:snap"), modifiedUri: uri("m:snap") }));
  const before = [otherFile.diff, otherRef.diff, snapshot.diff];
  const updated = h.controller.reconcile({ folderUri: "file:///ws", relativePath: "app.py", baselineRef: "HEAD" }, diffWith(0));
  assert.equal(updated, 0);
  assert.deepEqual([otherFile.diff, otherRef.diff, snapshot.diff], before);
  assert.equal(h.changed(), 0);
});

test("full refresh keeps open comparisons for reconciliation and drops closed ones (#123)", () => {
  const h = harness();
  h.remember(context());
  h.remember(context({ relativePath: "closed.py", baseUri: uri("b:closed"), modifiedUri: uri("m:closed") }));
  h.controller.retainOpen((value: string) => value === "file:///ws/app.py");
  assert.ok(h.controller.get("intentumdiff-base:/app.py"));
  assert.equal(h.controller.get("b:closed"), undefined);
  assert.equal(h.controller.get("m:closed"), undefined);
  assert.equal(h.controller.reconcile({ folderUri: "file:///ws", relativePath: "app.py", baselineRef: "HEAD" }, diffWith(0)), 1);
});
