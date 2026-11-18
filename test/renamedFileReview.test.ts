import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { baseRelativePathFor, gitShowArgs } from "../src/baseUri";

// #124: renamed-file review reads the base from old_filename and the modified side from new_filename.

function load(name: string, overrides: Record<string, unknown>): any {
  const source = readFileSync(path.join(__dirname, "../src", `${name}.js`), "utf8");
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id: string) => overrides[id] ?? {}, setTimeout, clearTimeout, console });
  return exports;
}

test("baseRelativePathFor uses old_filename for an engine-reported rename (#124)", () => {
  assert.equal(baseRelativePathFor("new.js", { old_filename: "old.js", new_filename: "new.js" }), "old.js");
  assert.equal(baseRelativePathFor("src/b/mod.py", { old_filename: "src/a/mod.py", new_filename: "src/b/mod.py" }), "src/a/mod.py");
  assert.deepEqual(gitShowArgs({ folderUri: "f", ref: "HEAD", relativePath: baseRelativePathFor("new.js", { old_filename: "old.js", new_filename: "new.js" }) }), ["show", "HEAD:old.js"]);
});

test("baseRelativePathFor keeps the review path when the diff is not a rename of it (#124)", () => {
  assert.equal(baseRelativePathFor("a.js"), "a.js");
  assert.equal(baseRelativePathFor("a.js", { old_filename: "a.js", new_filename: "a.js" }), "a.js");
  assert.equal(baseRelativePathFor("a.js", { old_filename: "x.js", new_filename: "other.js" }), "a.js");
  for (const unsafe of ["../escape.js", "/abs.js", "dir/", "nul\0.js"]) {
    assert.equal(baseRelativePathFor("new.js", { old_filename: unsafe, new_filename: "new.js" }), "new.js");
  }
});

test("native open of a renamed review requests HEAD:old.js for the base, new.js on the right (#124)", async () => {
  const created: any[] = [];
  const diffs: any[] = [];
  const uriOf = (value: string) => ({ value, fsPath: value.replace(/^file:\/\//u, ""), toString: () => value });
  const vscode = {
    Uri: { parse: uriOf, file: (p: string) => uriOf(`file://${p}`) },
    commands: { executeCommand: async (...args: any[]) => { diffs.push(args); } },
    window: { showInformationMessage() {}, showWarningMessage() {}, setStatusBarMessage() {} },
  };
  const baseUri = load("baseUri", {});
  const { DiffSurfaceController } = load("diffSurfaceController", {
    path,
    vscode,
    "./baseUri": baseUri,
    "./extensionEditorUtils": {
      normalizeOpenReviewPayload: (value: unknown) => value,
      existingOrEmptyModifiedUri: async (uri: unknown) => uri,
      findVisibleTextEditor: async () => undefined,
      shouldRevealBaseSide: () => false,
      delay: async () => undefined,
    },
    "./extensionSettings": { readLiveServerSettings: () => ({ ref: "HEAD" }), readDiffMode: () => "full", readSemanticOnlyOptions: () => ({}) },
    "./reviewAssetDiffs": { isImageLikePath: () => false },
    "./mapper": { summarizeDiff: () => ({}) },
  });
  const diff = { old_filename: "old.js", new_filename: "new.js", changes: [], change_groups: [] };
  const controller = new DiffSurfaceController({
    output: { appendLine() {} },
    baseContentProvider: { createUri: (identity: any) => { created.push(identity); return uriOf(`intentumdiff-base:${identity.relativePath}`); } },
    reviewFileFor: () => ({ status: "ready", relativePath: "new.js", diff }),
    resolvedCommitFor: () => undefined,
    applyDiffVisuals() {}, applyBaseDiffVisuals() {}, onContextsChanged() {}, hideComments: () => false,
  });
  await controller.open({ folderUri: "file:///ws", relativePath: "new.js" });
  assert.equal(created.length, 1);
  assert.equal(created[0].relativePath, "old.js");
  assert.equal(diffs[0][0], "vscode.diff");
  assert.equal(diffs[0][1].toString(), "intentumdiff-base:old.js");
  assert.equal(diffs[0][2].toString(), "file:///ws/new.js");
  assert.match(diffs[0][3], /^old\.js → new\.js /u);
});
