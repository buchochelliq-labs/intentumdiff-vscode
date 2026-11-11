import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDiffRows, hunkSyntheticChange, hunkTextPayloadAt } from "../src/reviewDiffRows";
import { planVerifiedHunkTextEdit, semanticReviewHunkEditForPayload, type SemanticReviewActionKind } from "../src/reviewActionModel";
import type { ReviewDiffRow } from "../src/reviewWebviewModel";

// #125: pure insertions and deletions are ordinary zero-length-side hunk actions.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function repo(file: string, base: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "intentumdiff-hunk-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), base);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** The single change hunk in production rows as `[start, end)`. */
function onlyHunk(rows: ReviewDiffRow[]): [number, number] {
  const flat = rows;
  const start = flat.findIndex((row) => row.kind !== "equal" && row.kind !== "collapsed");
  let end = start;
  while (end < flat.length && flat[end].kind !== "equal" && flat[end].kind !== "collapsed") end += 1;
  assert.ok(start >= 0, "a hunk exists");
  assert.equal(flat.slice(end).some((row) => row.kind !== "equal" && row.kind !== "collapsed"), false, "exactly one hunk");
  return [start, end];
}

function editFor(kind: SemanticReviewActionKind, file: string, oldText: string, newText: string) {
  const rows = buildDiffRows(oldText, newText, undefined);
  const [start, end] = onlyHunk(rows);
  const hunk = hunkTextPayloadAt(rows, start, end);
  const change = hunkSyntheticChange(rows[start], rows.slice(start, end));
  return semanticReviewHunkEditForPayload(
    { folderUri: "file:///repo", relativePath: file, actionKind: kind, change, hunk },
    () => "/repo",
  );
}

function applyPlanned(text: string, kind: SemanticReviewActionKind, file: string, oldText: string): string {
  const result = editFor(kind, file, oldText, text);
  assert.equal(result.error, undefined);
  const lines = text.split("\n");
  const plan = planVerifiedHunkTextEdit({ lines, eol: "\n" }, result.edit!);
  assert.equal(plan.error, undefined, plan.error);
  const offset = (line: number, character: number) =>
    lines.slice(0, line).reduce((total, current) => total + current.length + 1, 0) + character;
  const edit = plan.edit!;
  return text.slice(0, offset(edit.startLine, edit.startCharacter)) + edit.text + text.slice(offset(edit.endLine, edit.endCharacter));
}

const cases: Array<{ name: string; base: string; work: string }> = [
  { name: "insertion at BOF", base: "a\nb\nc\n", work: "x\na\nb\nc\n" },
  { name: "insertion in the middle", base: "a\nb\nc\nd\n", work: "a\nb\nx\ny\nc\nd\n" },
  { name: "insertion at EOF", base: "a\nb\n", work: "a\nb\nx\n" },
  { name: "insertion into an empty file", base: "", work: "x\ny\n" },
  { name: "deletion at BOF", base: "x\na\nb\n", work: "a\nb\n" },
  { name: "deletion in the middle", base: "a\nb\nx\ny\nc\nd\n", work: "a\nb\nc\nd\n" },
  { name: "deletion at EOF", base: "a\nb\nx\n", work: "a\nb\n" },
  { name: "deletion of every line", base: "x\ny\n", work: "" },
  { name: "insertion in a file without final newline", base: "a\nb\nc", work: "a\nx\nb\nc" },
  { name: "deletion in a file without final newline", base: "a\nx\nb\nc", work: "a\nb\nc" },
];

for (const { name, base, work } of cases) {
  for (const file of ["src/app.txt", "dir with space/café ünï.txt"]) {
    test(`stage ${name} (${file}) writes exactly the hunk into the index (#125)`, () => {
      const dir = repo(file, base);
      try {
        writeFileSync(path.join(dir, file), work);
        const result = editFor("stageHunk", file, base, work);
        assert.equal(result.error, undefined);
        execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], { cwd: dir, input: result.edit!.indexPatch });
        assert.equal(git(dir, "show", `:${file}`), work);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  test(`revert ${name} restores the base text (#125)`, () => {
    assert.equal(applyPlanned(work, "revertHunk", "src/app.txt", base), base);
  });
}

test("staging validates against the actual index: an existing staged edit shifts, a conflicting one rejects (#125)", () => {
  const file = "src/app.txt";
  const base = "a\nb\nc\nd\ne\nf\ng\n";
  const dir = repo(file, base);
  try {
    // Already staged: a new first line (shifts the hunk down by one in the index).
    git(dir, "update-index", "--add", "--cacheinfo", `100644,${execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: `z\n${base}` }).toString().trim()},${file}`);
    const work = "a\nb\nc\nd\ne\nf\nX\ng\n";
    const result = editFor("stageHunk", file, base, work);
    execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], { cwd: dir, input: result.edit!.indexPatch });
    assert.equal(git(dir, "show", `:${file}`), `z\n${work}`);

    // Staged edit that rewrote the hunk's context: the patch must not apply blindly.
    const conflicting = "a\nb\nc\nd\ne\nCHANGED\ng\n";
    git(dir, "update-index", "--cacheinfo", `100644,${execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: conflicting }).toString().trim()},${file}`);
    assert.throws(() => execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], { cwd: dir, input: result.edit!.indexPatch, stdio: "pipe" }));
    assert.equal(git(dir, "show", `:${file}`), conflicting);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reverting a deletion verifies its neighbours instead of inserting blindly (#125)", () => {
  const base = "a\nb\nx\nc\nd\n";
  const work = "a\nb\nc\nd\n";
  const result = editFor("revertHunk", "f.txt", base, work);
  assert.deepEqual(result.edit?.expectedLines, ["a", "b", "c", "d"]);
  const stale = planVerifiedHunkTextEdit({ lines: "a\nB\nc\nd\n".split("\n"), eol: "\n" }, result.edit!);
  assert.match(stale.error ?? "", /changed since it was reviewed/u);
});

test("a deletion hunk carries an explicit anchor, not an unavailable range (#125)", () => {
  const rows = buildDiffRows("a\nx\nb\n", "a\nb\n", undefined);
  const [start, end] = onlyHunk(rows);
  const hunk = hunkTextPayloadAt(rows, start, end);
  assert.deepEqual(hunk.newLines, []);
  assert.equal(hunk.newLinesBefore, 1);
  assert.equal(hunk.oldLinesBefore, 1);
  assert.deepEqual(hunk.contextBefore, ["a"]);
  assert.deepEqual(hunk.contextAfter, ["b"]);
  const staged = editFor("stageHunk", "f.txt", "a\nx\nb\n", "a\nb\n");
  assert.equal(staged.error, undefined);
  assert.equal(staged.edit?.editStartLine, 2);
  assert.equal(staged.edit?.editEndLine, 1, "an empty working-tree range after line 1");
});
