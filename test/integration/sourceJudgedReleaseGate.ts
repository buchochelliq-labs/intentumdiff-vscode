import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { liveDiffProbe } from "./liveDiffProbe";

// Independent source oracle for Core #191/#192. A green 74-language aggregate
// gallery previously hid both defects; never weaken this gate to changeCount.
type Point = { line: number; col: number };
type Span = { start_line: number; start_col: number; end_line: number; end_col: number };
type Node = { label: string; position: Span };
type Change = {
  change_type: string; refactoring_kind?: string | null;
  old_node?: Node | null; new_node?: Node | null;
};
type Diff = {
  language: string; changes: Change[]; change_groups: Array<{ kind: string }>;
  parse_errors: unknown[]; has_semantic_changes: boolean;
  is_style_only: boolean; is_fallback: boolean;
};

function point(source: string, lineText: string, token: string): Point {
  const lines = source.split("\n");
  const line = lines.findIndex(text => text.includes(lineText));
  assert.ok(line >= 0, `Missing oracle source: ${lineText}`);
  const col = lines[line].indexOf(token, lines[line].indexOf(lineText));
  assert.ok(col >= 0, `Missing oracle token: ${token}`);
  return { line, col };
}
function compare(left: Point, right: Point): number {
  return left.line - right.line || left.col - right.col;
}
function covers(node: Node | null | undefined, at: Point, width: number): boolean {
  const p = node?.position;
  return !!p
    && compare({ line: p.start_line, col: p.start_col }, at) <= 0
    && compare({ line: p.end_line, col: p.end_col }, { line: at.line, col: at.col + width }) >= 0;
}
function exact(node: Node | null | undefined, at: Point, width: number): boolean {
  const p = node?.position;
  return !!p && p.start_line === at.line && p.start_col === at.col
    && p.end_line === at.line && p.end_col === at.col + width;
}
function assertAssemblyscript(oldSource: string, newSource: string, diff: Diff): void {
  const oldOp = point(oldSource, "return n * n;", "*");
  const newOp = point(newSource, "return n ** 2;", "**");
  assert.equal(diff.changes.filter(c => c.change_type === "MODIFICATION"
    && covers(c.old_node, oldOp, 1) && covers(c.new_node, newOp, 2)).length, 1,
  "square's changed arithmetic operator must survive as one source-anchored MODIFICATION");
  const cube = point(newSource, "export function cube(", "cube");
  assert.equal(diff.changes.filter(c => c.change_type === "ADDITION"
    && covers(c.new_node, cube, 4)).length, 1,
  "new cube must be one named-entity ADDITION");
  assert.ok(!diff.change_groups.some(g => g.kind === "IGNORED_STYLE"),
    "An arithmetic-operator change cannot be formatting-only");
}
function assertClojure(oldSource: string, newSource: string, diff: Diff): void {
  const oldOpen = point(oldSource, "(defn add [a b]", "[");
  const newOpen = point(newSource, "(defn add [x y]", "[");
  for (const [index, before, after] of [[0, "a", "x"], [1, "b", "y"]] as const) {
    const oldParam = { line: oldOpen.line, col: oldOpen.col + 1 + 2 * index };
    const newParam = { line: newOpen.line, col: newOpen.col + 1 + 2 * index };
    assert.equal(diff.changes.filter(c => c.change_type === "REFACTORING"
      && c.refactoring_kind === "RENAME_VARIABLE"
      && c.old_node?.label === before && c.new_node?.label === after
      && exact(c.old_node, oldParam, 1) && exact(c.new_node, newParam, 1)).length, 1,
    `add parameter ${before}->${after} must be a scoped RENAME_VARIABLE with exact byte spans`);
  }
  const oldAdd = point(oldSource, "(defn add [a b]", "add");
  const newAdd = point(newSource, "(defn add [x y]", "add");
  assert.ok(!diff.changes.some(c =>
    (c.change_type === "DELETION" && covers(c.old_node, oldAdd, 3))
    || (c.change_type === "ADDITION" && covers(c.new_node, newAdd, 3))),
  "Continuing add cannot be represented as whole-form DELETE+ADD");
  const multiply = point(newSource, "(defn multiply [x y]", "multiply");
  assert.equal(diff.changes.filter(c => c.change_type === "ADDITION"
    && covers(c.new_node, multiply, 8)).length, 1,
  "new multiply must be a single named-entity ADDITION");
}

export async function assertSourceJudgedReleaseCase(
  executable: string, repository: string, relativePath: string,
  example: { language: string; old: string; new: string }, evidence: string,
): Promise<void> {
  if (example.language !== "assemblyscript" && example.language !== "clojure") return;
  const raw = await liveDiffProbe(executable, repository, relativePath, example.new);
  // Retain full native/Python public wire evidence even when assertions fail.
  fs.writeFileSync(path.join(evidence, `source-judged-${example.language}.json`), raw);
  const diff = JSON.parse(raw) as Diff;
  assert.equal(diff.language, example.language);
  assert.deepEqual(diff.parse_errors, []);
  assert.equal(diff.is_fallback, false);
  assert.equal(diff.has_semantic_changes, true);
  assert.equal(diff.is_style_only, false);
  assert.ok(Array.isArray(diff.changes) && Array.isArray(diff.change_groups));
  if (example.language === "assemblyscript") assertAssemblyscript(example.old, example.new, diff);
  else assertClojure(example.old, example.new, diff);
}
