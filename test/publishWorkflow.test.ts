import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Release independent review. Compiled to out/test/, so the repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");
const publishYml = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  scripts: Record<string, string>;
};

test("publish promotes the reviewed VSIX instead of rebuilding it (#101)", () => {
  // The Marketplace/Open VSX bytes must be the exact VSIX that real-runtime acceptance
  // installed. Re-packaging from the tag ships unreviewed bytes.
  assert.doesNotMatch(publishYml, /run:\s*npm run vsix\b/, "publish.yml re-packages the VSIX from the tag");
  assert.match(publishYml, /sha256/i, "publish.yml must verify the promoted VSIX's sha256");
});

test(`${pkg.version} defers the release-media gate, recording it, and still verifies supplied media (#103)`, () => {
  // No workflow captures rc-release-media yet. Omitting it must be visible, not silent,
  // and supplying it must still run the full verification below.
  // 0.0.3 deferred it again, to 0.0.4: the workflow must say so, citing #103.
  assert.match(publishYml, /deferred to 0\.0\.4[^\n]*#103/);
  assert.match(publishYml, /name: Record that release media was not supplied[^\n]*\n\s+if: env\.REVIEWED_MEDIA_ARTIFACT_ID == ''/);
  assert.match(publishYml, /GITHUB_STEP_SUMMARY/);
  assert.match(publishYml, /name: Download and verify separately reviewed release media\n\s+if: env\.REVIEWED_MEDIA_ARTIFACT_ID != ''/);
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

test(`${pkg.version} is packaged and published on the pre-release channel`, () => {
  // The Marketplace rejects semver pre-release suffixes: the channel comes from
  // `--pre-release`, so the version itself stays plain major.minor.patch.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.scripts.vsix, /vsce package --pre-release\b/);
  assert.match(publishYml, /vsce publish --pre-release (--skip-duplicate )?--packagePath/);
  // ovsx >= 1.4 ignores --pre-release for a prepackaged VSIX: the channel comes from the
  // reviewed VSIX manifest (checked below) and is verified on Open VSX after upload.
  assert.match(publishYml, /ovsx publish \S+ --skip-duplicate/);
  assert.doesNotMatch(publishYml, /ovsx publish \S+ --pre-release/);
  assert.match(publishYml, /Microsoft\.VisualStudio\.Code\.PreRelease" Value="true"/);
});

test("Open VSX is a required registry, checked before any upload and verified after", () => {
  // Both tokens are required up front, so a missing one cannot leave a one-registry release.
  const preflight = publishYml.indexOf("name: Require Marketplace and Open VSX tokens");
  const marketplace = publishYml.indexOf("name: Publish to the VS Code Marketplace");
  assert.ok(preflight > 0 && preflight < marketplace, "token check must precede the first upload");
  assert.doesNotMatch(publishYml, /OVSX_PAT is not set - skipping Open VSX/);
  assert.match(publishYml, /vsce publish --pre-release --skip-duplicate/);
  assert.match(publishYml, /ovsx publish \S+ --skip-duplicate --pat/);
  assert.match(publishYml, /open-vsx\.org\/api\/\$namespace\/\$name\/\$version/);
  assert.match(publishYml, /preRelease/);
});

test("publish tells a repo release and an orchestrated release apart before touching bytes", () => {
  // scripts/release_mode.py decides; every later job keys off its output.
  assert.match(publishYml, /\n {2}mode:\n {4}name: Release mode\n/);
  assert.match(publishYml, /run: python3 scripts\/release_mode\.py/);
  assert.match(publishYml, /DISPATCH_PUBLISHES_FROM_TAG: "true"/, "a dispatch on the tag with dry_run=false still publishes");
  assert.match(publishYml, /REQUIRED_INPUTS: candidate_run_id,candidate_artifact_id,candidate_sha256,candidate_source_sha/);
  assert.match(publishYml, /orchestrator_run:\n\s+description: "Set only by intentumdiff-release/);
  // The orchestrated tag's own push must not publish from stale variables.
  assert.match(publishYml, /needs: mode\n\s+if: needs\.mode\.outputs\.mode != 'deferred' && needs\.mode\.outputs\.mode != 'none'/);
  assert.match(
    publishYml,
    /needs: \[mode, package, scan\][\s\S]*?if: startsWith\(github\.ref, 'refs\/tags\/v'\) && \(needs\.mode\.outputs\.mode == 'repo' \|\| needs\.mode\.outputs\.mode == 'orchestrated'\)/,
  );
  assert.match(publishYml, /^run-name: /m);
});

test("release_mode.py: repo releases unchanged, orchestrated ones fail closed", () => {
  // Drive the shipped script with a fake GitHub API, exactly as the workflow calls it.
  const harness = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("m", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
RUN = "https://github.com/buchochelliq-labs/intentumdiff-release/actions/runs/9"
TAGS = {"v1.0.0": None, "v2.0.0": "x\n\nRelease-Orchestrator: " + RUN + "\n"}
def get(path):
    name = path.rsplit("/", 1)[1]
    if "/git/ref/tags/" in path:
        return {"object": {"type": "commit"}} if TAGS[name] is None else {"object": {"type": "tag", "sha": name}}
    return {"message": TAGS[name]}
pins = {"INPUT_CANDIDATE_RUN_ID": "1", "INPUT_CANDIDATE_ARTIFACT_ID": "2",
        "INPUT_CANDIDATE_SHA256": "3", "INPUT_CANDIDATE_SOURCE_SHA": "4"}
base = {"REPOSITORY": "o/r", "DISPATCH_PUBLISHES_FROM_TAG": "true",
        "REQUIRED_INPUTS": "candidate_run_id,candidate_artifact_id,candidate_sha256,candidate_source_sha"}
def mode(tag, **env):
    try:
        return m.decide({**base, "REF": "refs/tags/" + tag, "REF_NAME": tag, **env}, get)[0]
    except m.ModeError:
        return "error"
print(json.dumps({
    "tag push": mode("v1.0.0", EVENT_NAME="push"),
    "orchestrated tag push": mode("v2.0.0", EVENT_NAME="push"),
    "dispatch on tag": mode("v1.0.0", EVENT_NAME="workflow_dispatch", DRY_RUN="false"),
    "dry-run dispatch": mode("v1.0.0", EVENT_NAME="workflow_dispatch", DRY_RUN="true"),
    "orchestrated": mode("v2.0.0", EVENT_NAME="workflow_dispatch", DRY_RUN="false", ORCHESTRATOR_RUN=RUN, **pins),
    "orchestrated, own tag": mode("v1.0.0", EVENT_NAME="workflow_dispatch", DRY_RUN="false", ORCHESTRATOR_RUN=RUN, **pins),
    "orchestrated, no pins": mode("v2.0.0", EVENT_NAME="workflow_dispatch", DRY_RUN="false", ORCHESTRATOR_RUN=RUN),
}))
`;
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync("python3", ["-c", harness, path.join(repoRoot, "scripts", "release_mode.py")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    "tag push": "repo",
    "orchestrated tag push": "deferred",
    "dispatch on tag": "repo",
    "dry-run dispatch": "rehearsal",
    "orchestrated": "orchestrated",
    "orchestrated, own tag": "error",
    "orchestrated, no pins": "error",
  });
});
