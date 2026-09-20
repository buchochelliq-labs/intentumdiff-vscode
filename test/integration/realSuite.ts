import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import * as vscode from "vscode";

interface Entry { relativePath: string; status: string; changeCount: number;
  assetDiff?: { status: string; artifacts: Record<string, string> };
  parseErrorCount: number; isStyleOnly: boolean; groupKinds: string[]; }
async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const evidence = process.env.INTENTUMDIFF_REAL_EVIDENCE!;
  try {
    fs.writeFileSync(path.join(evidence, "failure-review-state.json"), JSON.stringify(
      await vscode.commands.executeCommand("intentumdiff.test.getReviewState"), null, 2));
  } catch (error) { console.error("Could not capture review state", error); }
  if (process.platform === "linux") {
    try { execFileSync("scrot", [path.join(evidence, "failure.png")]); } catch { /* retain original timeout */ }
  }
  throw new Error(`Timed out: ${label}`);
}
async function files(): Promise<Entry[]> {
  const state = await vscode.commands.executeCommand<{ files: Entry[] }>("intentumdiff.test.getReviewState");
  return state?.files ?? [];
}
export async function run(): Promise<void> {
  const root = process.env.INTENTUMDIFF_REAL_WORKSPACE!;
  const evidence = process.env.INTENTUMDIFF_REAL_EVIDENCE!;
  const fixtures = [
    { name: "edit.py", old: "def f(", partial: "def g(", valid: "def g():\n    return 2\n" },
    { name: "edit.js", old: "function f(", partial: "function g(", valid: "function g() { return 2; }\n" },
  ];
  for (const f of fixtures) fs.writeFileSync(path.join(root, f.name), f.old);
  const assetFixtures = path.resolve(__dirname, "../../../test/fixtures/assets");
  fs.copyFileSync(path.join(assetFixtures, "before.png"), path.join(root, "sample.png"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init"); git("add", ".");
  git("-c", "user.name=IntentumDiff acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "Incomplete baseline");
  const extension = vscode.extensions.getExtension("buchochelliq-labs.intentumdiff");
  assert.ok(extension);
  assert.equal(extension.extensionPath, process.env.INTENTUMDIFF_REAL_INSTALLED);
  await extension.activate();
  const results: object[] = [];

  for (const f of fixtures) {
    const uri = vscode.Uri.file(path.join(root, f.name));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    // Completion must update this same panel without reopening it.
    if (f.name === "edit.py") await vscode.commands.executeCommand("intentumdiff.openReviewPanel", {
      folderUri: vscode.Uri.file(root).toString(), relativePath: f.name,
    });
    const replace = async (text: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(await document.save());
      await vscode.commands.executeCommand("intentumdiff.refreshReview");
    };
    const beforePath = path.join(evidence, `before-${f.name}`);
    const afterPath = path.join(evidence, `after-${f.name}`);
    fs.writeFileSync(beforePath, f.old); fs.writeFileSync(afterPath, f.partial);
    const raw = execFileSync(process.env.INTENTUMDIFF_TEST_CLI!,
      ["diff", "--json", beforePath, afterPath], { encoding: "utf8", timeout: 60000 });
    const direct = JSON.parse(raw);
    assert.equal(direct.metadata.engine_owner, "rust");
    assert.equal(direct.metadata.semantic_contract, "rust_source_fallback_v1");
    assert.equal(direct.is_fallback, true);
    assert.equal(direct.is_style_only, false);
    assert.equal(direct.changes.length, 1);
    assert.equal(direct.changes[0].old_node.label, "f");
    assert.equal(direct.changes[0].new_node.label, "g");
    const offset = f.name.endsWith(".py") ? 4 : 9;
    assert.deepEqual(direct.metadata.source_ranges, {
      old_start_byte: offset, old_end_byte: offset + 1,
      new_start_byte: offset, new_end_byte: offset + 1,
    });
    fs.writeFileSync(path.join(evidence, `${f.name}.diff.json`), raw);
    await replace(f.partial);
    await waitFor(async () => (await files()).some(x => x.relativePath === f.name &&
      x.status === "ready" && x.changeCount > 0 && x.parseErrorCount > 0 && !x.isStyleOnly), `${f.name} incomplete review`);
    if (f.name === "edit.py") {
      await new Promise(resolve => setTimeout(resolve, 1500));
      execFileSync("scrot", [path.join(evidence, "pending-to-ready.png")]);
    }
    const partial = (await files()).find(x => x.relativePath === f.name)!;
    assert.ok(partial.groupKinds.includes("MEANINGFUL_CHANGE"));
    const payload = { folderUri: vscode.Uri.file(root).toString(), relativePath: f.name };
    await vscode.commands.executeCommand("intentumdiff.openSemanticDiff", payload);
    await waitFor(async () => vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
      t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === uri.toString())), "native diff tab for current file");
    await waitFor(async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
      return !!lenses?.some(l => l.command?.command.startsWith("intentumdiff."));
    }, "IntentumDiff CodeLens");
    await vscode.commands.executeCommand("intentumdiff.openReviewPanel", payload);
    await waitFor(async () => vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
      t.isActive && t.input instanceof vscode.TabInputWebview && t.label === `IntentumDiff: ${f.name}`)), "review panel for current file");
    // Capture for manual visual inspection; panel creation is not a render-readiness proof.
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (process.platform === "linux") execFileSync("scrot", [path.join(evidence, `${f.name}.png`)]);
    // Commit a valid baseline before checking recovery: both inputs must be valid.
    await replace(f.valid); git("add", f.name); git("-c", "user.name=IntentumDiff acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", `Valid ${f.name}`);
    await replace(f.valid.replace("2", "3"));
    await waitFor(async () => (await files()).some(x => x.relativePath === f.name &&
      x.status === "ready" && x.changeCount > 0 && x.parseErrorCount === 0), `${f.name} valid recovery`);
    results.push({ file: f.name, partial, recovered: (await files()).find(x => x.relativePath === f.name) });
  }
  // Exercise a tracked image through the same live server, never a fabricated manifest.
  fs.copyFileSync(path.join(assetFixtures, "after.png"), path.join(root, "sample.png"));
  await vscode.commands.executeCommand("intentumdiff.refreshReview");
  await waitFor(async () => (await files()).some(f => f.relativePath === "sample.png" && f.assetDiff?.status === "compared"), "real image artifacts");
  const asset = (await files()).find(f => f.relativePath === "sample.png")!;
  for (const name of ["before", "after", "diff", "heatmap", "mask", "overlay"]) {
    const artifact = asset.assetDiff!.artifacts[name];
    assert.ok(artifact && fs.existsSync(artifact), `Missing engine artifact: ${name}`);
  }
  results.push({ image: asset });
  const payload = { folderUri: vscode.Uri.file(root).toString(), relativePath: "sample.png" };
  await vscode.commands.executeCommand("intentumdiff.openReviewPanel", payload);
  const capture = async (name: string) => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    execFileSync("scrot", [path.join(evidence, `${name}.png`)]);
  };
  for (const [name, theme] of [["dark", "Default Dark Modern"], ["light", "Default Light Modern"], ["high-contrast", "Default High Contrast"]]) {
    await vscode.workspace.getConfiguration("workbench").update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    await capture(`asset-${name}`);
  }
  await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration("window").update("zoomLevel", 2, vscode.ConfigurationTarget.Global);
  await capture("asset-narrow");
  await vscode.workspace.getConfiguration("window").update("zoomLevel", 0, vscode.ConfigurationTarget.Global);
  // A real desktop recording of source → native diff → review, including CodeLens.
  const recorder = spawn("ffmpeg", ["-y", "-f", "x11grab", "-video_size", "1440x1000", "-framerate", "10", "-i", process.env.DISPLAY!, "-t", "16", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(evidence, "workflow.mp4")], { stdio: "ignore" });
  const recorded = new Promise<void>((resolve, reject) => { recorder.on("error", reject); recorder.on("exit", code => code === 0 ? resolve() : reject(new Error(`Recorder exit ${code}`))); });
  const source = vscode.Uri.file(path.join(root, "edit.py"));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
  await capture("source-codelens");
  await new Promise(resolve => setTimeout(resolve, 2500));
  const sourcePayload = { folderUri: payload.folderUri, relativePath: "edit.py" };
  await vscode.commands.executeCommand("intentumdiff.openSemanticDiff", sourcePayload);
  await capture("native-diff");
  await new Promise(resolve => setTimeout(resolve, 2500));
  await vscode.commands.executeCommand("intentumdiff.openReviewPanel", sourcePayload);
  await capture("recovered-review");
  await recorded;
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
}
