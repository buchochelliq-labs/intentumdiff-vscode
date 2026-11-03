import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// 0.0.2 independent review. Compiled to out/test/, so the repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");
const publishYml = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");

test("publish promotes the reviewed VSIX instead of rebuilding it (#101)", () => {
  // The Marketplace/Open VSX bytes must be the exact VSIX that real-runtime acceptance
  // installed. Re-packaging from the tag ships unreviewed bytes.
  assert.doesNotMatch(publishYml, /run:\s*npm run vsix\b/, "publish.yml re-packages the VSIX from the tag");
  assert.match(publishYml, /sha256/i, "publish.yml must verify the promoted VSIX's sha256");
});

test("committed release media is stamped with the current extension version (#103)", () => {
  // Mirrors scripts/validate_release_media_manifest.py's candidate checks that do not depend
  // on which commit is checked out: every screenshot must name this version and a full commit.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string };
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "release-media", "manifest.json"), "utf8")) as {
    screenshots: Array<{ surface?: string; extension_version?: string; commit?: string }>;
  };
  const stale = manifest.screenshots
    .filter((s) => s.extension_version !== pkg.version || !/^[0-9a-f]{40}$/.test(s.commit ?? ""))
    .map((s) => `${s.surface ?? "?"} (version=${s.extension_version ?? "missing"}, commit=${s.commit ?? "missing"})`);
  assert.deepEqual(stale, [], `release media not recorded from ${pkg.version}:\n${stale.join("\n")}`);
});
