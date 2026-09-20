import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
export interface CandidateIdentity { extension_version: string; extension_commit: string; vsix_sha256: string; }
interface Manifest { schema_version: number; identity: CandidateIdentity; status: string; captures: { file: string; sha256: string }[]; }
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function createCandidateManifest(root: string, identity: CandidateIdentity): Manifest {
  return { schema_version: 1, identity, status: "awaiting_independent_visual_review", captures: fs.readdirSync(root).filter(n => /\.(png|mp4)$/u.test(n)).sort().map(file => ({ file, sha256: digest(path.join(root, file)) })) };
}
export function validateCandidateManifest(root: string, manifest: Manifest, expected: CandidateIdentity): void {
  for (const key of ["extension_version", "extension_commit", "vsix_sha256"] as const) {
    if (!expected[key] || manifest.identity[key] !== expected[key]) throw new Error(`Capture identity mismatch: ${key}`);
  }
  if (!manifest.captures.length) throw new Error("No captures");
  for (const capture of manifest.captures) {
    if (path.basename(capture.file) !== capture.file) throw new Error("Invalid capture path");
    if (digest(path.join(root, capture.file)) !== capture.sha256) throw new Error(`Capture checksum mismatch: ${capture.file}`);
  }
}
