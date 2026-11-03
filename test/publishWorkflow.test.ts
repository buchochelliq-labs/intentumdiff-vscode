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

test("publish uses independently reviewed release-media bytes, not historical screenshots (#103)", () => {
  // A committed manifest cannot truthfully contain its own final source commit SHA.
  // A separately retained artifact must be bound to the approved acceptance run,
  // pinned by SHA-256, and have every screenshot checked against the reviewed SHA.
  assert.match(publishYml, /REVIEWED_MEDIA_ARTIFACT_ID:/);
  assert.match(publishYml, /REVIEWED_MEDIA_SHA256:/);
  assert.match(publishYml, /\['?\$\(gh api "\$media" --jq '\.workflow_run\.id'\)"?\]?|media not from reviewed acceptance run/);
  assert.match(publishYml, /sha256sum --check/);
  assert.match(publishYml, /validate_release_media_manifest\.py "[^"]*reviewed-media\/manifest\.json"/);
  assert.match(publishYml, /--expected-commit "\$REVIEWED_SOURCE_SHA"/);
  assert.doesNotMatch(publishYml, /validate_release_media_manifest\.py release-media\/manifest\.json/);
});
