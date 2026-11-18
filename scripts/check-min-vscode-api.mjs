#!/usr/bin/env node
// Typecheck the extension sources against the OLDEST VS Code API that
// package.json `engines.vscode` claims (issue 137).
//
// The regular lint compiles against whatever @types/vscode the lockfile
// resolves (newer than the minimum), so an API added after the minimum would
// compile and then fail at runtime on the oldest supported VS Code. This script
// fetches @types/vscode at exactly the engine minimum into a temp directory and
// compiles src/ against it alone. It does not replace running the installed
// VSIX on that VS Code version (the min-engine legs in real-runtime.yml).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const match = /^\^(\d+\.\d+\.\d+)$/u.exec(manifest.engines?.vscode ?? "");
if (!match) {
  console.error(`engines.vscode must be a caret range like ^1.90.0, got ${JSON.stringify(manifest.engines?.vscode)}`);
  process.exit(1);
}
const minimum = match[1];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "intentumdiff-min-api-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
try {
  const tarball = execFileSync(npm, ["pack", `@types/vscode@${minimum}`, "--silent"], { cwd: temp, encoding: "utf8" }).trim().split(/\r?\n/u).pop();
  execFileSync("tar", ["xzf", tarball], { cwd: temp });
  const declarations = path.join(temp, "vscode", "index.d.ts");
  if (!fs.existsSync(declarations)) {
    throw new Error(`@types/vscode@${minimum} did not unpack to vscode/index.d.ts`);
  }
  // `import "vscode"` resolves files before ambient modules, so it would find
  // the lockfile's newer node_modules/@types/vscode. Rename the minimum's
  // ambient module and map "vscode" (via `paths`) to a shim that re-exports
  // it: only the minimum's declarations are then visible to src/.
  const ambient = fs.readFileSync(declarations, "utf8");
  const renamed = ambient.replace(/^declare module ['"]vscode['"] \{/mu, "declare module 'intentumdiff-min-vscode' {");
  if (renamed === ambient) {
    throw new Error(`@types/vscode@${minimum} has no top-level declare module 'vscode' block`);
  }
  fs.writeFileSync(path.join(temp, "min-vscode.d.ts"), renamed);
  fs.writeFileSync(path.join(temp, "vscode-shim.d.ts"), 'export * from "intentumdiff-min-vscode";\n');
  const tsconfig = path.join(temp, "tsconfig.json");
  fs.writeFileSync(tsconfig, JSON.stringify({
    extends: path.join(root, "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      rootDir: path.parse(root).root,
      // Only @types/node is auto-included, never the lockfile's @types/vscode.
      types: ["node"],
      typeRoots: [path.join(root, "node_modules", "@types")],
      baseUrl: temp,
      paths: { vscode: ["./vscode-shim"] },
    },
    include: [path.join(root, "src", "**", "*.ts"), path.join(temp, "min-vscode.d.ts")],
  }, null, 2));
  execFileSync(npx, ["tsc", "-p", tsconfig], { cwd: root, stdio: "inherit" });
  console.log(`src/ typechecks against the VS Code ${minimum} API (engines.vscode ${manifest.engines.vscode}).`);
} catch (error) {
  console.error(`src/ does not typecheck against the VS Code ${minimum} API: raise engines.vscode or stop using newer APIs.`);
  if (error instanceof Error && !("status" in error)) console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
