import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readContractLanguages, buildLanguageSmokeFiles } from "./integration/runtimeConfig";

test("standalone contract discovery needs neither parent pyproject nor Python", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intentumdiff-standalone-"));
  try {
    fs.mkdirSync(path.join(root, "test", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "fixtures", "contract-languages.json"),
      JSON.stringify(["typescript", "python", "python"]));
    assert.deepEqual(readContractLanguages(root), ["python", "typescript"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit missing Python fails instead of silently using fixture coverage", () => {
  assert.throws(() => readContractLanguages(process.cwd(),
    path.join(os.tmpdir(), "nonexistent-intentumdiff-python", "python")),
    /Cannot query INTENTUMDIFF_TEST_PYTHON/);
});

test("blank explicit interpreter is rejected", () => {
  assert.throws(() => readContractLanguages(process.cwd(), " "), /must name a Python executable/);
});

test("checked-in contract catalogue includes primary live-edit languages", () => {
  const languages = readContractLanguages(path.resolve(__dirname, "../.."));
  for (const name of ["python", "javascript", "typescript", "tsx", "delphi"]) {
    assert.ok(languages.includes(name), name);
  }
});


test("one runtime language still covers every smoke kind without path collisions", () => {
  const files = buildLanguageSmokeFiles(["python"]);
  assert.equal(new Set(files.map(f => f.kind)).size, 7);
  assert.equal(new Set(files.map(f => f.path)).size, files.length);
  assert.ok(files.every(f => f.language === "python"));
});
