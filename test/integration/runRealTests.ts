import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

import { createCandidateManifest, validateCandidateManifest } from "./candidateMedia";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../../..");
  const vsix = process.env.INTENTUMDIFF_TEST_VSIX;
  const cli = process.env.INTENTUMDIFF_TEST_CLI;
  if (!vsix || !cli || !path.isAbsolute(vsix) || !path.isAbsolute(cli) ||
      !fs.existsSync(vsix) || !fs.existsSync(cli)) {
    throw new Error("Set INTENTUMDIFF_TEST_VSIX and INTENTUMDIFF_TEST_CLI to existing absolute artifact/executable paths");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "intentumdiff-real-"));
  const user = path.join(temp, "profile"), extensions = path.join(temp, "extensions");
  const workspace = path.join(temp, "workspace");
  const evidence = path.join(root, "artifacts", "real-runtime");
  fs.rmSync(evidence, { recursive: true, force: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(path.join(user, "User"), { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(user, "User", "settings.json"), JSON.stringify({
    "intentumdiff.executable": cli, "intentumdiff.enabled": true,
    "intentumdiff.intent.llm.enabled": false, "intentumdiff.schemas.fetchMode": "off",
    "intentumdiff.ref": "HEAD", "intentumdiff.debounceMs": 50,
    "workbench.startupEditor": "none", "security.workspace.trust.enabled": false,
  }));
  const executable = await downloadAndUnzipVSCode({ version: "1.138.0" });
  const [command, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(command, [...args, "--user-data-dir", user, "--extensions-dir", extensions,
    "--install-extension", vsix, "--force"], { encoding: "utf8", timeout: 120000 });
  const installed = fs.readdirSync(extensions).map(n => path.join(extensions, n)).find(p => {
    try { const m = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8"));
      return m.publisher === "buchochelliq-labs" && m.name === "intentumdiff"; } catch { return false; }
  });
  if (!installed) throw new Error("VSIX installation did not produce the expected extension");
  fs.writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify({
    vsix_sha256: createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
    extension_version: JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version,
    extension_commit: process.env.GITHUB_SHA ?? "local", vscode_version: "1.138.0",
    python_commit: process.env.INTENTUMDIFF_TEST_PYTHON_COMMIT ?? null,
    core_commit: process.env.INTENTUMDIFF_TEST_CORE_COMMIT ?? null,
    mode: "installed VSIX bytes loaded by VS Code test host; external real CLI",
  }, null, 2));
  try {
  await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: installed,
    extensionTestsPath: path.join(__dirname, "realSuite.js"),
    launchArgs: [workspace, "--user-data-dir", user, "--extensions-dir", extensions,
      "--disable-workspace-trust", "--skip-welcome"],
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined,
      INTENTUMDIFF_TEST_CLI: cli,
      INTENTUMDIFF_ENFORCE_RUST_ONLY_ENGINE: "1", INTENTUMDIFF_REAL_WORKSPACE: workspace,
      INTENTUMDIFF_REAL_INSTALLED: installed, INTENTUMDIFF_REAL_EVIDENCE: evidence },
  });
  const identity = JSON.parse(fs.readFileSync(path.join(evidence, "provenance.json"), "utf8"));
  const manifest = createCandidateManifest(evidence, identity);
  validateCandidateManifest(evidence, manifest, identity);
  fs.writeFileSync(path.join(evidence, "capture-manifest.json"), JSON.stringify(manifest, null, 2));
  } finally {
    const logs = path.join(user, "logs");
    try {
      if (fs.existsSync(logs)) fs.cpSync(logs, path.join(evidence, "vscode-logs"), { recursive: true });
    } catch (error) { console.error("Could not retain VS Code logs", error); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
