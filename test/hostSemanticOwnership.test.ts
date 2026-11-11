// The extension renders engine dispositions; it must not decide on its own that
// an engine change is "noise" by comparing trees (issue 131). Expected values
// are judged from the source edits, not from extension behaviour.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { diffToBaseDecorations, diffToModifiedDecorations } from "../src/mapper";
import { reviewEntriesForFile, type ReviewEntry, type ReviewFile } from "../src/reviewModel";
import type { SemanticChange, SemanticDiff } from "../src/types";

const at = (line: number) => ({ start_line: line, start_col: 0, end_line: line, end_col: 5 });

// `["a", "b"]` -> `["b", "a"]` style edit: each element keeps its value but its
// array index moves. That is a real reorder of user data; only the engine may
// call it noise.
const arrayIndexChange: SemanticChange = {
  change_type: "MODIFICATION",
  description: "Update array element",
  old_node: { node_type: "array_element", label: "[0]", position: at(2), children: [{ node_type: "string", label: "\"a\"" }] },
  new_node: { node_type: "array_element", label: "[1]", position: at(3), children: [{ node_type: "string", label: "\"a\"" }] },
};

// A modification whose nodes carry no label/type/children facts at all.
const factlessChange: SemanticChange = {
  change_type: "MODIFICATION",
  description: "Modified line",
  old_node: { position: at(4) },
  new_node: { position: at(4) },
};

function fileWith(diff: SemanticDiff): ReviewFile {
  return { folderName: "repo", folderUri: "file:///repo", relativePath: "data.json", status: "ready", diff };
}

function flatten(entries: ReviewEntry[]): ReviewEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.evidence ?? [])]);
}

for (const [name, change] of [["array-index relabel", arrayIndexChange], ["missing node facts", factlessChange]] as const) {
  test(`an ungrouped ${name} change is retained as review evidence`, () => {
    const entries = flatten(reviewEntriesForFile(fileWith({ language: "json", changes: [change], change_groups: [] })));
    assert.ok(
      entries.some((entry) => entry.change === change),
      "the engine change must not be silently removed by the host",
    );
    assert.ok(!entries.some((entry) => entry.kind === "clean"), "the file must not read as having no changes");
  });

  test(`an ungrouped ${name} change is decorated in the editor`, () => {
    const diff: SemanticDiff = { language: "json", changes: [change], change_groups: [] };
    assert.equal(diffToModifiedDecorations(diff).length, 1);
  });
}

test("engine-classified noise is the only noise the editor hides, and its evidence stays in the tree", () => {
  const deletion: SemanticChange = {
    change_type: "DELETION",
    old_node: { node_type: "array_element", label: "[2]", position: at(5) },
  };
  const diff: SemanticDiff = {
    language: "json",
    changes: [arrayIndexChange, deletion, factlessChange],
    change_groups: [
      { kind: "NOISE_SUPPRESSED", raw_change_indices: [0, 1] },
      { kind: "MEANINGFUL_CHANGE", raw_change_indices: [2] },
    ],
  };
  assert.deepEqual(diffToModifiedDecorations(diff).map((item) => item.position.start_line), [4]);
  assert.deepEqual(diffToBaseDecorations(diff), [], "engine-noise deletions are not decorated");
  const entries = flatten(reviewEntriesForFile(fileWith(diff)));
  assert.ok(entries.some((entry) => entry.kind === "noise-suppressed"), "the core-authored disposition is visible");
  assert.ok(entries.some((entry) => entry.change === arrayIndexChange), "suppressed evidence is retained");
});

test("a change also owned by a shown group is never hidden as noise", () => {
  const diff: SemanticDiff = {
    language: "json",
    changes: [arrayIndexChange],
    change_groups: [
      { kind: "NOISE_SUPPRESSED", raw_change_indices: [0] },
      { kind: "MEANINGFUL_CHANGE", raw_change_indices: [0] },
    ],
  };
  assert.equal(diffToModifiedDecorations(diff).length, 1);
});

test("no host tree comparison classifies changes as presentation noise", () => {
  for (const file of ["mapper.js", "reviewModel.js"]) {
    const source = readFileSync(path.join(__dirname, "..", "src", file), "utf8");
    assert.doesNotMatch(source, /isPresentationNoiseChange|sameSemanticContentIgnoringArrayIndex|isArrayIndexLabel/u, file);
  }
});
