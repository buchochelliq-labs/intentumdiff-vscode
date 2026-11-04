/**
 * Every asset the webview loads at runtime must survive `.vscodeignore`.
 *
 * WHY THIS EXISTS
 *
 * `.vscodeignore` line 1 is `node_modules/`, which is correct for a bundled extension and
 * wrong for this one: there is no bundler, and `@vscode/codicons` is a *runtime* dependency
 * that `reviewWebview.ts` links by path:
 *
 *     joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css")
 *
 * The 0.0.2 release candidate packaged 112 files containing zero codicon entries, so in any
 * Marketplace install that stylesheet 404s and every `codicon codicon-*` span renders blank —
 * against the project rule that chrome uses codicons and never bundled SVG.
 *
 * Nothing caught it. The existing packaging test reads the SVGs from the repo, which proves
 * they exist on disk, not that they ship. Those are different claims, and only the second one
 * reaches a user. `vsce ls` answers the real question but takes ~21s, longer than this whole
 * suite, so this test applies vsce's own inclusion rule directly instead.
 *
 * The rule is mirrored from @vscode/vsce/out/package.js (collectFiles):
 *
 *     files.filter(f => !ignore.some(i => minimatch(f, i, {dot: true}))
 *                    || negate.some(i => minimatch(f, i.substr(1), {dot: true})))
 *
 * with folder patterns expanded to `/**` beforehand, exactly as vsce does.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { minimatch } from "minimatch";

const repoRoot = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * Assets referenced by absolute extension path at runtime, each paired with the source
 * fragment that references it.
 *
 * The pairing is the point: asserting the reference still exists stops this list quietly
 * rotting into a set of paths nothing loads any more, which would leave the test green while
 * checking nothing that matters.
 */
const RUNTIME_ASSETS: ReadonlyArray<{ file: string; referencedBy: string; reference: RegExp }> = [
  {
    file: "node_modules/@vscode/codicons/dist/codicon.css",
    referencedBy: "src/reviewWebview.ts",
    reference: /joinPath\(\s*this\.extensionUri,\s*"node_modules",\s*"@vscode",\s*"codicons",\s*"dist"\s*\)/u,
  },
  {
    // codicon.css @font-faces this; shipping the stylesheet without the font still renders
    // every glyph blank, which looks identical to shipping neither.
    file: "node_modules/@vscode/codicons/dist/codicon.ttf",
    referencedBy: "node_modules/@vscode/codicons/dist/codicon.css",
    reference: /url\(["']?\.\/codicon\.ttf/u,
  },
  {
    file: "resources/review-icon-dark.svg",
    referencedBy: "src/reviewWebview.ts",
    reference: /"resources",\s*"review-icon-dark\.svg"/u,
  },
  {
    file: "resources/review-icon-light.svg",
    referencedBy: "src/reviewWebview.ts",
    reference: /"resources",\s*"review-icon-light\.svg"/u,
  },
];

/** vsce's inclusion decision for one path, mirroring collectFiles. */
function vsceWouldPackage(file: string): boolean {
  const raw = read(".vscodeignore")
    .split(/[\n\r]/u)
    .map((s) => s.trim())
    .filter((s) => !!s && !/^\s*#/u.test(s));

  // vsce appends '/**' to anything whose last segment has no glob, so `node_modules/`
  // excludes its contents rather than only a file of that exact name.
  const patterns = [
    ...raw,
    ...raw.filter((i) => !/(^|\/)[^/]*\*[^/]*$/u.test(i)).map((i) => (/\/$/u.test(i) ? `${i}**` : `${i}/**`)),
  ];

  const ignore = patterns.filter((p) => !/^\s*!/u.test(p));
  const negate = patterns.filter((p) => /^\s*!/u.test(p));

  const opts = { dot: true };
  return !ignore.some((i) => minimatch(file, i, opts)) || negate.some((i) => minimatch(file, i.slice(1), opts));
}

test("the ignore rule this test mirrors actually excludes things", () => {
  // Guard the guard. If vsceWouldPackage ever returned true unconditionally, every
  // assertion below would pass while checking nothing.
  assert.equal(vsceWouldPackage("src/extension.ts"), false, "src/ is ignored and must read as excluded");
  assert.equal(vsceWouldPackage("out/test/foo.test.js"), false, "out/test/ is ignored");
  assert.equal(vsceWouldPackage("node_modules/typescript/lib/tsc.js"), false, "ordinary node_modules stay excluded");
  assert.equal(vsceWouldPackage("package.json"), true, "package.json is packaged");
});

for (const { file, referencedBy, reference } of RUNTIME_ASSETS) {
  test(`${file} is still referenced at runtime`, () => {
    assert.match(
      read(referencedBy),
      reference,
      `${referencedBy} no longer references ${file}. If the reference was removed on purpose, ` +
        `drop this entry from RUNTIME_ASSETS and its .vscodeignore negation; otherwise the ` +
        `packaging assertion below is now guarding nothing.`,
    );
  });

  test(`${file} survives .vscodeignore and reaches the VSIX`, () => {
    assert.equal(
      vsceWouldPackage(file),
      true,
      `${file} is loaded at runtime but .vscodeignore excludes it, so it will be absent from ` +
        `the packaged extension. A Marketplace install would 404 on it while a source ` +
        `checkout works fine — add "!${file}" to .vscodeignore.`,
    );
  });
}
