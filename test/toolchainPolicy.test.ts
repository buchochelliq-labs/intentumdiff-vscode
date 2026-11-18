import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { chooseLiveServerLaunch, VERIFIED_NATIVE_PLATFORMS } from "../src/config";

// #136: one authoritative runtime/toolchain policy; docs match the shipped defaults.
const root = join(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

test(".nvmrc, every workflow and BUILDING.md name the same Node toolchain (#136)", () => {
  const nvmrc = read(".nvmrc").trim();
  assert.equal(nvmrc, "22");
  const workflows = readdirSync(join(root, ".github/workflows")).filter((file) => file.endsWith(".yml"));
  for (const workflow of workflows) {
    for (const match of read(`.github/workflows/${workflow}`).matchAll(/node-version:\s*['"]?([\d.]+)/gu)) {
      assert.equal(match[1], nvmrc, `${workflow} pins Node ${match[1]}`);
    }
  }
  const building = read("docs/BUILDING.md");
  assert.match(building, new RegExp(`build and test with \\*\\*Node ${nvmrc}\\*\\*`, "u"));
  assert.doesNotMatch(building, /Toolchain: \*\*Node 20\*\*/u);
});

test("ARCHITECTURE.md describes the audited auto selection, not a native default (#136)", () => {
  const architecture = read("docs/ARCHITECTURE.md");
  assert.doesNotMatch(architecture, /starts the external Rust `intentumdiff-live-server` by default/u);
  assert.equal(VERIFIED_NATIVE_PLATFORMS.length, 0);
  assert.match(architecture, /`auto` selects the \*\*Python runtime on every platform\*\*/u);
  for (const platform of ["linux-x64", "darwin-arm64", "win32-x64"]) {
    assert.deepEqual(chooseLiveServerLaunch("intentumdiff", "auto", undefined, platform), { kind: "python" });
  }
});

test("build docs avoid fixed test-count promises that drift (#136)", () => {
  assert.doesNotMatch(read("docs/BUILDING.md"), /\(\d+ tests\)/u);
});
