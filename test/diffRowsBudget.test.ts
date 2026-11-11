import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDiffRowsResult,
  hunkTextPayloadAt,
  hunkSyntheticChange,
  lineAlignment,
  LCS_CELL_BUDGET,
  myersOperations,
  type LineOperation,
} from "../src/reviewDiffRows";
import { semanticReviewHunkEditForPayload } from "../src/reviewActionModel";
import { buildReviewPanelModel, renderPanelHtml } from "../src/reviewWebviewModel";

// #127: no false whole-file hunks once the textual diff exceeds its LCS budget.

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index}`);

function counts(operations: LineOperation[]) {
  return {
    equal: operations.filter((op) => op.type === "equal").length,
    insert: operations.filter((op) => op.type === "insert").length,
    delete: operations.filter((op) => op.type === "delete").length,
  };
}

function apply(oldLines: string[], newLines: string[], operations: LineOperation[]): string[] {
  const result: string[] = [];
  let oldCursor = 0;
  for (const op of operations) {
    if (op.type === "equal") {
      assert.equal(oldLines[op.oldIndex], newLines[op.newIndex]);
      assert.equal(op.oldIndex, oldCursor);
      oldCursor += 1;
      result.push(newLines[op.newIndex]);
    } else if (op.type === "delete") {
      assert.equal(op.oldIndex, oldCursor);
      oldCursor += 1;
    } else {
      result.push(newLines[op.newIndex]);
    }
  }
  assert.equal(oldCursor, oldLines.length);
  return result;
}

test("one inserted line in a 400-line file stays one insert past the LCS budget (#127)", () => {
  const oldLines = lines(400);
  const newLines = ["inserted", ...oldLines];
  assert.ok(oldLines.length * newLines.length > LCS_CELL_BUDGET);
  const alignment = lineAlignment(oldLines, newLines);
  assert.equal(alignment.exact, true);
  assert.deepEqual(counts(alignment.operations), { equal: 400, insert: 1, delete: 0 });
  assert.deepEqual(apply(oldLines, newLines, alignment.operations), newLines);
});

test("line shifts around the cutoff keep accurate equal regions (#127)", () => {
  for (const size of [340, 346, 347, 350, 600]) {
    const oldLines = lines(size);
    const middle = Math.floor(size / 2);
    const newLines = [...oldLines.slice(0, middle), "x1", "x2", ...oldLines.slice(middle + 1)];
    const alignment = lineAlignment(oldLines, newLines);
    assert.equal(alignment.exact, true, String(size));
    assert.deepEqual(counts(alignment.operations), { equal: size - 1, insert: 2, delete: 1 }, String(size));
    assert.deepEqual(apply(oldLines, newLines, alignment.operations), newLines);
  }
});

test("bounded Myers finds a minimal script with scattered edits in a large file (#127)", () => {
  const oldLines = lines(3000);
  const newLines = oldLines.map((line, index) => (index % 300 === 7 ? `${line} edited` : line));
  newLines.splice(1500, 0, "added in the middle");
  const alignment = lineAlignment(oldLines, newLines);
  assert.equal(alignment.exact, true);
  assert.deepEqual(counts(alignment.operations), { equal: 2990, insert: 11, delete: 10 });
  assert.deepEqual(apply(oldLines, newLines, alignment.operations), newLines);
  // Deletions precede insertions in each changed run (so they pair as "change").
  const ops = myersOperations(["a", "b", "c"], ["a", "B", "c"], 10)!;
  assert.deepEqual(ops.map((op) => op.type), ["equal", "delete", "insert", "equal"]);
});

test("an edit distance beyond the budget is reported inexact and the panel falls back visibly (#127)", () => {
  const oldLines = lines(1500, "old");
  const newLines = lines(1500, "new");
  const alignment = lineAlignment(oldLines, newLines);
  assert.equal(alignment.exact, false);
  assert.equal(myersOperations(oldLines, newLines, 50), undefined);
  const result = buildDiffRowsResult(oldLines.join("\n"), newLines.join("\n"), undefined);
  assert.equal(result.exact, false);
  const model = buildReviewPanelModel(
    { folderName: "w", folderUri: "file:///w", relativePath: "big.txt", status: "ready", diff: { language: "text", changes: [], change_groups: [] } } as any,
    oldLines.join("\n"),
    newLines.join("\n"),
    "HEAD",
  );
  assert.equal(model.diffRowsImprecise, true);
  const html = renderPanelHtml(model, { nonce: "n", cspSource: "c" } as any);
  assert.match(html, /too large to align line by line/u);
  assert.doesNotMatch(html, /data-command="stageHunk"/u);
});

test("a generated hunk past the budget round-trips through git apply (#127)", () => {
  const oldText = `${lines(500).join("\n")}\n`;
  const newLines = lines(500);
  newLines.splice(250, 0, "inserted mid-file");
  const newText = `${newLines.join("\n")}\n`;
  const { rows, exact } = buildDiffRowsResult(oldText, newText, undefined);
  assert.equal(exact, true);
  const start = rows.findIndex((row) => row.kind !== "equal" && row.kind !== "collapsed");
  let end = start;
  while (rows[end] && rows[end].kind !== "equal" && rows[end].kind !== "collapsed") end += 1;
  assert.equal(end - start, 1, "one localized insert row");
  const dir = mkdtempSync(path.join(os.tmpdir(), "intentumdiff-budget-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(path.join(dir, "f.txt"), oldText);
    git("add", "f.txt");
    const edit = semanticReviewHunkEditForPayload({
      folderUri: "file:///w", relativePath: "f.txt", actionKind: "stageHunk",
      change: hunkSyntheticChange(rows[start], rows.slice(start, end)),
      hunk: hunkTextPayloadAt(rows, start, end),
    }, () => dir);
    execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], { cwd: dir, input: edit.edit!.indexPatch });
    assert.equal(git("show", ":f.txt"), newText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
