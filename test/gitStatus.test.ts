import assert from "node:assert/strict";
import test from "node:test";
import { parseGitStatusPorcelain } from "../src/gitStatus";

test("parseGitStatusPorcelain handles common working-tree states", () => {
  assert.deepEqual(
    parseGitStatusPorcelain([
      " M src/app.py",
      "A  src/new.py",
      "?? scratch.yaml",
      "D  old.yaml",
      "R  old-name.yaml -> new-name.yaml",
      ' M "space dir/file.yaml"',
    ].join("\n")),
    [
      { relativePath: "src/app.py", status: "modified" },
      { relativePath: "src/new.py", status: "added" },
      { relativePath: "scratch.yaml", status: "untracked" },
      { relativePath: "old.yaml", status: "deleted" },
      { relativePath: "new-name.yaml", status: "renamed", originalPath: "old-name.yaml" },
      { relativePath: "space dir/file.yaml", status: "modified" },
    ],
  );
});

test("parseGitStatusPorcelain skips untracked directories (trailing-slash paths)", () => {
  // `git status --porcelain` collapses an untracked directory to a single
  // trailing-slash entry; it is not a reviewable file and `git show <ref>:dir/`
  // would fail, so it must be dropped while real files are kept.
  assert.deepEqual(
    parseGitStatusPorcelain([
      "?? .claude/",
      "?? dist/",
      " M image.png",
      "?? notes.txt",
    ].join("\n")),
    [
      { relativePath: "image.png", status: "modified" },
      { relativePath: "notes.txt", status: "untracked" },
    ],
  );
});

// #126: lossless parsing and failure propagation.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as childProcess from "node:child_process";
import { GIT_STATUS_ARGS, parseGitStatusPorcelainZ, unquoteGitPath } from "../src/gitStatus";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const awkwardNames = [
  "café.js",
  "a -> b.txt",
  "back\\slash.txt",
  " lead and trail .txt ",
  "tab\there.txt",
  "new\nline.txt",
  "quote\"d.txt",
];

function awkwardRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "intentumdiff-status-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  for (const name of [...awkwardNames, "rename-me.txt", "keep.txt"]) {
    writeFileSync(path.join(dir, name), `${name}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  for (const name of awkwardNames) {
    writeFileSync(path.join(dir, name), `${name} changed\n`);
  }
  renameSync(path.join(dir, "rename-me.txt"), path.join(dir, "renamed ünï.txt"));
  git(dir, "add", "-A", "--", "rename-me.txt", "renamed ünï.txt");
  mkdirSync(path.join(dir, "fresh", "nested"), { recursive: true });
  writeFileSync(path.join(dir, "fresh", "nested", "deep.txt"), "x\n");
  return dir;
}

test("NUL-delimited porcelain parses Unicode, arrows, backslashes, whitespace, tabs/newlines and renames from a real repo (#126)", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only filenames");
    return;
  }
  const dir = awkwardRepo();
  try {
    const entries = parseGitStatusPorcelainZ(git(dir, ...GIT_STATUS_ARGS));
    const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
    for (const name of awkwardNames) {
      assert.equal(byPath.get(name)?.status, "modified", JSON.stringify(name));
    }
    assert.deepEqual(byPath.get("renamed ünï.txt"), { relativePath: "renamed ünï.txt", status: "renamed", originalPath: "rename-me.txt" });
    assert.equal(byPath.get("fresh/nested/deep.txt")?.status, "untracked", "nested untracked files are listed individually");
    assert.equal(byPath.has("keep.txt"), false);
    assert.equal(entries.length, awkwardNames.length + 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("line porcelain unquotes octal escapes and keeps a non-rename arrow and backslash literal (#126)", () => {
  assert.equal(unquoteGitPath('"caf\\303\\251.js"'), "café.js");
  assert.equal(unquoteGitPath('"tab\\there"'), "tab\there");
  assert.deepEqual(
    parseGitStatusPorcelain([
      ' M "caf\\303\\251.js"',
      " M a -> b.txt",
      " M back\\slash.txt",
      'R  "old \\"q\\".txt" -> "new\\tname.txt"',
    ].join("\n")),
    [
      { relativePath: "café.js", status: "modified" },
      { relativePath: "a -> b.txt", status: "modified" },
      { relativePath: "back\\slash.txt", status: "modified" },
      { relativePath: "new\tname.txt", status: "renamed", originalPath: 'old "q".txt' },
    ],
  );
});

function loadScm(): any {
  const source = readFileSync(path.join(__dirname, "../src/scm.js"), "utf8");
  const exports = {};
  const uriOf = (fsPath: string) => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` });
  const modules: Record<string, unknown> = {
    child_process: childProcess,
    path,
    vscode: { Uri: { file: uriOf }, extensions: { getExtension: () => undefined }, workspace: {} },
    "./gitStatus": require("../src/gitStatus"),
  };
  vm.runInNewContext(source, { exports, require: (id: string) => modules[id] ?? {}, Buffer });
  return { scm: exports, uriOf };
}

test("a Git command failure invokes the Git-extension fallback and never masquerades as clean (#126)", async () => {
  const { scm, uriOf } = loadScm();
  const notARepo = mkdtempSync(path.join(os.tmpdir(), "intentumdiff-norepo-"));
  try {
    const folder = { uri: uriOf(notARepo), name: "x" };
    let fallbackCalls = 0;
    const fallbackFiles = [{ relativePath: "a.txt", status: "modified" }];
    const viaFallback = await scm.discoverWorkingTreeFilesForFolder(folder, {
      gitApi: async () => { fallbackCalls += 1; return fallbackFiles; },
    });
    assert.equal(fallbackCalls, 1);
    assert.equal(viaFallback, fallbackFiles);
    // The extension's genuine "clean" answer is honoured...
    assert.deepEqual(await scm.discoverWorkingTreeFilesForFolder(folder, { gitApi: async () => [] }), []);
    // ...but when both fail, the Git error propagates instead of returning [].
    await assert.rejects(scm.discoverWorkingTreeFilesForFolder(folder, { gitApi: async () => undefined }));
    // Default wiring: no Git extension available either.
    await assert.rejects(scm.discoverWorkingTreeFilesForFolder(folder));
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("real git discovery returns verbatim paths and rename sources (#126)", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only filenames");
    return;
  }
  const { scm, uriOf } = loadScm();
  const dir = awkwardRepo();
  try {
    const files = await scm.discoverWorkingTreeFilesForFolder({ uri: uriOf(dir), name: "x" });
    const renamed = files.find((file: any) => file.status === "renamed");
    assert.equal(renamed.relativePath, "renamed ünï.txt");
    assert.equal(renamed.originalPath, "rename-me.txt");
    assert.ok(files.some((file: any) => file.relativePath === "new\nline.txt"));
    assert.ok(files.some((file: any) => file.uri.fsPath === path.join(dir, "back\\slash.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
