import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCandidateManifest, validateCandidateManifest } from "./integration/candidateMedia";

test("candidate media rejects stale identity and changed evidence bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-media-"));
  try {
    fs.writeFileSync(path.join(root, "capture.png"), "actual captured bytes");
    const identity = { extension_version: "0.0.2-beta.1", extension_commit: "a".repeat(40), vsix_sha256: "b".repeat(64) };
    const manifest = createCandidateManifest(root, identity);
    validateCandidateManifest(root, manifest, identity);
    assert.throws(() => validateCandidateManifest(root, manifest, { ...identity, extension_commit: "c".repeat(40) }), /identity/);
    fs.writeFileSync(path.join(root, "capture.png"), "changed");
    assert.throws(() => validateCandidateManifest(root, manifest, identity), /checksum/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
