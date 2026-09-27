import * as fs from "node:fs";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { readContractLanguages } from "./runtimeConfig";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite.js");
  const supportedLanguages = readContractLanguages(extensionDevelopmentPath, process.env.INTENTUMDIFF_TEST_PYTHON);
  // Allow relocating the mutable fixture outside OneDrive-synced paths, where
  // sync locks cause EPERM during the suite's rmSync/mkdir fixture setup. Set
  // INTENTUMDIFF_FIXTURE_DIR to a non-synced directory (the suite git-inits and
  // populates it from scratch).
  const fixtureWorkspace = process.env.INTENTUMDIFF_FIXTURE_DIR
    ? path.resolve(process.env.INTENTUMDIFF_FIXTURE_DIR)
    : path.join(
        extensionDevelopmentPath,
        "test",
        "fixtures",
        "workspace",
      );
  const downloadedExecutable = await downloadAndUnzipVSCode({
    version: "stable",
    extensionDevelopmentPath,
  });

  // The downloaded test VS Code uses the same singleton mutex name as the
  // user's running editor, which makes downloadAndUnzipVSCode fail with
  // "Error: Error mutex already exists". Patch product.json to use a unique
  // productName so the test VS Code acquires a separate mutex.
  const productJsonPath = path.join(
    path.dirname(downloadedExecutable),
    "resources",
    "app",
    "product.json",
  );
  if (fs.existsSync(productJsonPath)) {
    try {
      const product = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
      const orig = product.nameShort || product.name || "Code";
      product.nameShort = "IntentumDiffTestVSCode";
      product.name = "IntentumDiffTestVSCode";
      product.applicationName = "intentumdiff-test-vscode";
      // productQuality is read by the app for the singleton mutex seed.
      product.quality = "intentumdiff-test-" + Date.now();
      fs.writeFileSync(productJsonPath, JSON.stringify(product, null, "	"), "utf8");
      console.log("[runTests] patched product.json: " + orig + " -> IntentumDiffTestVSCode");
    } catch (e) {
      console.warn("[runTests] could not patch product.json: " + e);
    }
  }

  await runTests({
    vscodeExecutablePath: downloadedExecutable,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      "--disable-workspace-trust",
      "--disable-extensions",
      // Open the fixture folder as the initial workspace so
      // ensureWorkspaceFolder() in suite.ts succeeds. Without this the
      // extension host starts in empty-workspace mode and updateWorkspaceFolders
      // is a no-op, causing the test to time out. The folder must exist BEFORE
      // launch — VS Code silently drops a nonexistent workspace path (the
      // INTENTUMDIFF_FIXTURE_DIR relocation starts from nothing).
      (fs.mkdirSync(fixtureWorkspace, { recursive: true }), fixtureWorkspace),
    ],
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      INTENTUMDIFF_NODE_EXECUTABLE: process.execPath,
      INTENTUMDIFF_SUPPORTED_LANGUAGES: JSON.stringify(supportedLanguages),
      INTENTUMDIFF_VSCODE_FIXTURE: fixtureWorkspace,
      INTENTUMDIFF_VSCODE_LOG: path.join(fixtureWorkspace, ".intentumdiff-fake-log.jsonl"),
      INTENTUMDIFF_SCREENSHOT_DIR: path.join(extensionDevelopmentPath, "artifacts"),
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
