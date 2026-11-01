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

// Independent source oracle for the five suppressed semantic edits in Core #159.
// A broad gallery addition can mask missing edits; probe an isolated single
// source change and require a meaningful diff anchored to its exact token.
type IsolatedEdit = { before: string; after: string; line: string; token: string };
const isolatedEdits: Record<string, IsolatedEdit> = {
  php: {
    before: "function add($a, $b) {",
    after: "function add(int $a, int $b): int {",
    line: "function add(int $a, int $b): int {", token: "int $a",
  },
  delphi: {
    before: "function Add(A, B: Integer): Integer;",
    after: "function Add(const A, B: Integer): Integer;",
    line: "function Add(const A, B: Integer): Integer;", token: "const",
  },
  lua: {
    before: "function greet(name)",
    after: "local function greet(name)",
    line: "local function greet(name)", token: "local",
  },
  qsharp: {
    before: "operation SayHello() : Unit {",
    after: "operation SayHello(name : String) : Unit {",
    line: "operation SayHello(name : String) : Unit {", token: "name : String",
  },
  m: {
    before: "in\n    FilteredRows\n",
    after: "in\n    Source\n",
    line: "    Source", token: "Source",
  },
};

export async function assertSourceJudgedReleaseCase(
  executable: string, repository: string, relativePath: string,
  example: { language: string; old: string; new: string }, evidence: string,
): Promise<void> {
  const isolated = isolatedEdits[example.language];
  if (!isolated && example.language !== "assemblyscript" && example.language !== "clojure") return;
  let probedSource = example.new;
  if (isolated) {
    const parts = example.old.split(isolated.before);
    assert.equal(parts.length, 2, example.language + ": isolated source oracle must occur exactly once");
    probedSource = parts.join(isolated.after);
  }
  const raw = await liveDiffProbe(executable, repository, relativePath, probedSource);
  // Retain full native/Python public wire evidence when an assertion fails.
  fs.writeFileSync(path.join(evidence, "source-judged-" + example.language + ".json"), raw);
  const diff = JSON.parse(raw) as Diff;
  assert.equal(diff.language, example.language);
  assert.deepEqual(diff.parse_errors, []);
  assert.equal(diff.is_fallback, false);
  assert.equal(diff.has_semantic_changes, true,
    example.language + ": independently meaningful source edit was lost");
  assert.equal(diff.is_style_only, false,
    example.language + ": semantic source edit was incorrectly reduced to style only");
  assert.ok(Array.isArray(diff.changes) && diff.changes.length > 0
    && Array.isArray(diff.change_groups), example.language + ": no certified semantic changes");
  if (isolated) {
    const lines = probedSource.split("\n");
    const row = lines.findIndex(line => line.trim() === isolated.line.trim());
    assert.ok(row >= 0, example.language + ": missing exact source oracle line");
    const col = lines[row].indexOf(isolated.token);
    assert.ok(col >= 0, example.language + ": missing exact changed token");
    assert.ok(diff.changes.some(change => covers(change.new_node,
      { line: row, col }, isolated.token.length)),
    example.language + ": semantic change must anchor the changed source token");
  } else if (example.language === "assemblyscript") {
    assertAssemblyscript(example.old, example.new, diff);
  } else {
    assertClojure(example.old, example.new, diff);
  }
}
