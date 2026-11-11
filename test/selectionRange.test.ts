import assert from "node:assert/strict";
import test from "node:test";
import {
  engineRangeToUtf16,
  rangeBounds,
  selectionTargetForDocument,
  utf8ColumnToUtf16,
} from "../src/selectionRange";

function documentOf(lines: string[]) {
  return {
    lineCount: lines.length,
    lineAt(line: number) {
      return { text: lines[line] ?? "" };
    },
  };
}

test("selectionTargetForDocument preserves exact in-bounds ranges", () => {
  const target = selectionTargetForDocument(
    { start_line: 0, start_col: 0, end_line: 0, end_col: 10 },
    documentOf(["gone: true"]),
  );

  assert.equal(target.exact, true);
  assert.equal(target.shouldSelect, true);
  assert.deepEqual(target.position, { start_line: 0, start_col: 0, end_line: 0, end_col: 10 });
});

test("selectionTargetForDocument reveals without selecting when columns are stale", () => {
  const target = selectionTargetForDocument(
    { start_line: 0, start_col: 4, end_line: 0, end_col: 25 },
    documentOf(["short"]),
  );

  assert.equal(target.exact, false);
  assert.equal(target.shouldSelect, false);
  assert.deepEqual(target.position, { start_line: 0, start_col: 4, end_line: 0, end_col: 4 });
});

test("selectionTargetForDocument reveals the nearest line when the target line is stale", () => {
  const target = selectionTargetForDocument(
    { start_line: 9, start_col: 3, end_line: 9, end_col: 7 },
    documentOf(["first", "last"]),
  );

  assert.equal(target.exact, false);
  assert.equal(target.shouldSelect, false);
  assert.deepEqual(target.position, { start_line: 1, start_col: 3, end_line: 1, end_col: 3 });
});

// #121: engine columns are UTF-8 byte offsets; VS Code needs UTF-16 code units.
test("selectionTargetForDocument converts engine UTF-8 byte columns to UTF-16 (#121)", () => {
  const source = 'const s="😀"; const n=2;';
  // The engine reports the `2` literal at byte columns 24..25 (😀 is 4 bytes, 2 UTF-16 units).
  const byteStart = Buffer.byteLength(source.slice(0, source.indexOf("2")), "utf8");
  assert.equal(byteStart, 24);
  const target = selectionTargetForDocument(
    { start_line: 0, start_col: 24, end_line: 0, end_col: 25 },
    documentOf([source]),
  );
  assert.equal(target.exact, true);
  assert.equal(target.shouldSelect, true);
  assert.deepEqual(target.position, { start_line: 0, start_col: 22, end_line: 0, end_col: 23 });
  assert.equal(source.slice(target.position.start_col, target.position.end_col), "2");
});

test("engineRangeToUtf16 converts each bound on its own line for multiline ranges (#121)", () => {
  const lines = ["héllo = (", "  é)"];
  // start after `héllo = ` (9 bytes), end after `  é` (4 bytes) on the next line.
  const converted = engineRangeToUtf16(
    { start_line: 0, start_col: 9, end_line: 1, end_col: 4 },
    documentOf(lines),
  );
  assert.equal(converted.exact, true);
  assert.deepEqual(converted.position, { start_line: 0, start_col: 8, end_line: 1, end_col: 3 });
});

test("multiline range end column is not widened by the start column (#121)", () => {
  assert.deepEqual(rangeBounds({ start_line: 0, start_col: 8, end_line: 1, end_col: 2 }), [0, 8, 1, 2]);
  const target = selectionTargetForDocument(
    { start_line: 0, start_col: 8, end_line: 1, end_col: 2 },
    documentOf(["function f() {", "}}"]),
  );
  assert.equal(target.exact, true);
  assert.deepEqual(target.position, { start_line: 0, start_col: 8, end_line: 1, end_col: 2 });
  // Same-line reversed bounds still clamp.
  assert.deepEqual(rangeBounds({ start_line: 2, start_col: 5, end_line: 2, end_col: 1 }), [2, 5, 2, 5]);
  assert.deepEqual(rangeBounds({ start_line: 3, start_col: 5, end_line: 1, end_col: 9 }), [3, 5, 3, 5]);
});

test("byte columns inside a code point or malformed bounds are inexact, never invented (#121)", () => {
  assert.deepEqual(utf8ColumnToUtf16("a😀b", 2, "down"), { column: 1, exact: false });
  assert.deepEqual(utf8ColumnToUtf16("a😀b", 2, "up"), { column: 3, exact: false });
  assert.deepEqual(utf8ColumnToUtf16("a😀b", 5), { column: 3, exact: true });
  assert.deepEqual(utf8ColumnToUtf16("a😀b", 6), { column: 4, exact: true });
  assert.deepEqual(utf8ColumnToUtf16("a😀b", 9), { column: 4, exact: false });
  const split = selectionTargetForDocument(
    { start_line: 0, start_col: 2, end_line: 0, end_col: 5 },
    documentOf(["a😀b"]),
  );
  assert.equal(split.exact, false);
  assert.equal(split.shouldSelect, false);
  for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
    const target = selectionTargetForDocument(
      { start_line: 0, start_col: 0, end_line: 0, end_col: bad },
      documentOf(["value"]),
    );
    assert.equal(target.exact, false, String(bad));
    assert.equal(target.shouldSelect, false, String(bad));
  }
  const reversedLines = selectionTargetForDocument(
    { start_line: 1, start_col: 0, end_line: 0, end_col: 2 },
    documentOf(["ab", "cd"]),
  );
  assert.equal(reversedLines.exact, false);
});

test("CJK and combining text select the intended characters on each side (#121)", () => {
  const oldLine = "名前 = '値';";
  const newLine = "名前 = 'é値';";
  const byteCol = (text: string, needle: string) => Buffer.byteLength(text.slice(0, text.indexOf(needle)), "utf8");
  for (const [line, needle] of [[oldLine, "'値'"], [newLine, "'é値'"]] as const) {
    const target = selectionTargetForDocument(
      { start_line: 0, start_col: byteCol(line, needle), end_line: 0, end_col: byteCol(line, needle) + Buffer.byteLength(needle, "utf8") },
      documentOf([line]),
    );
    assert.equal(target.exact, true);
    assert.equal(line.slice(target.position.start_col, target.position.end_col), needle);
  }
});
