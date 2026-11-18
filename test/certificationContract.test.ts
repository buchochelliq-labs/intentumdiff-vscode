// Static guards for the installed-VSIX certification contract (issue 137).
// These do not certify anything themselves: they keep the real-runner gates
// (min-engine legs, hunk-action acceptance, theme captures, min-API typecheck)
// from silently drifting out of the workflows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const manifest = JSON.parse(read("package.json")) as { engines: { vscode: string }; scripts: Record<string, string> };
const minimum = /^\^(\d+\.\d+\.\d+)$/u.exec(manifest.engines.vscode)?.[1];

test("engines.vscode is a caret range with an exact minimum", () => {
  assert.ok(minimum, manifest.engines.vscode);
});

test("real-runtime acceptance runs the installed VSIX on the minimum VS Code for both runtimes", () => {
  const workflow = read(".github", "workflows", "real-runtime.yml");
  for (const runtime of ["python", "native"]) {
    const leg = new RegExp(
      `- runtime: ${runtime}\\s+capture: capabilities\\s+profile: min-engine\\s+vscode: "${minimum!.replaceAll(".", "\\.")}"`,
      "u",
    );
    assert.match(workflow, leg, `${runtime} min-engine leg must pin VS Code ${minimum}`);
  }
  assert.match(workflow, /INTENTUMDIFF_TEST_VSCODE_VERSION: \$\{\{ matrix\.vscode \}\}/u);
  assert.match(workflow, /name: real-runtime-\$\{\{ matrix\.runtime \}\}-\$\{\{ matrix\.capture \}\}-\$\{\{ matrix\.profile \}\}/u,
    "evidence artifacts of the min-engine legs must not collide with the current legs");
  const runner = read("test", "integration", "runRealTests.ts");
  assert.match(runner, /downloadAndUnzipVSCode\(\{ version: vscodeVersion \}\)/u);
  assert.match(runner, /vscode_version: vscodeVersion/u, "provenance records the VS Code actually run");
});

test("CI typechecks src against the minimum VS Code API", () => {
  assert.equal(manifest.scripts["lint:min-engine"], "node scripts/check-min-vscode-api.mjs");
  assert.match(read(".github", "workflows", "ci.yml"), /run: npm run lint:min-engine/u);
});

test("installed-extension acceptance exercises hunk actions and every theme family", () => {
  const suite = read("test", "integration", "realSuite.ts");
  assert.match(suite, /runHunkActionAcceptance\(root, evidence\)/u);
  for (const theme of ["Default Dark+", "Default Light+", "Default High Contrast", "Default High Contrast Light"]) {
    assert.ok(suite.includes(`"${theme}"`), theme);
  }
  const hunks = read("test", "integration", "hunkActionAcceptance.ts");
  for (const command of ["intentumdiff.reviewPanel.applyHunk", "intentumdiff.reviewPanel.previewHunk"]) {
    assert.ok(hunks.includes(command), command);
  }
});
