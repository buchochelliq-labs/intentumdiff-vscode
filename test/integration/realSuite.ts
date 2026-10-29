import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import * as vscode from "vscode";
import { waitForVisible } from "./desktopEvidence";
import { liveDiffProbe } from "./liveDiffProbe";
import { assertMeasuredWasmTelemetry } from "./telemetryAcceptance";

interface Entry { relativePath: string; status: string; changeCount: number; error?: string;
  assetDiff?: { status: string; artifacts: Record<string, string> };
  parseErrorCount: number; isStyleOnly: boolean; groupKinds: string[]; engineTelemetry?: unknown; }
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
    { name: "edit.py", old: "def f():\n    return 1\n", partial: "def g():\n    return 1\n",
      invalid: "def g(", valid: "def g():\n    return 2\n" },
    { name: "edit.js", old: "function f() { return 1; }\n",
      partial: "function g() { return 1; }\n",
      invalid: "function g(", valid: "function g() { return 2; }\n" },
  ];
  for (const f of fixtures) fs.writeFileSync(path.join(root, f.name), f.old);
  const assetFixtures = path.resolve(__dirname, "../../../test/fixtures/assets");
  fs.copyFileSync(path.join(assetFixtures, "before.png"), path.join(root, "sample.png"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init"); git("add", ".");
  git("-c", "user.name=IntentumDiff acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "Valid baseline");
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
    // The shared Rust completeness contract must fail closed on malformed
    // source. Do not call a source fallback a complete semantic review.
    let invalidDiagnostic = "";
    await assert.rejects(
      liveDiffProbe(process.env.INTENTUMDIFF_TEST_CLI!, root, f.name, f.invalid),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"code":"native_parse_incomplete"/u);
        assert.ok(error.message.includes(`${f.name}:`),
          `${f.name}: missing failed-file provenance`);
        invalidDiagnostic = error.message;
        return true;
      },
      `${f.name}: malformed source must fail closed`,
    );
    fs.writeFileSync(path.join(evidence, `${f.name}.incomplete-error.txt`), invalidDiagnostic);

    // The installed extension must also surface the malformed edit as an
    // error, never a "ready" review with manufactured empty/style-only edits.
    await replace(f.invalid);
    await waitFor(async () => (await files()).some(x =>
      x.relativePath === f.name && x.status === "error"),
    `${f.name} incomplete editor review must fail closed`);
    const rejected = (await files()).find(x => x.relativePath === f.name)!;
    assert.ok(rejected.error?.includes(`${f.name}:`),
      `${f.name}: rejected review must retain the Rust failed-file diagnostic`);
    assert.match(rejected.error ?? "", /incomplete|invalid/iu,
      `${f.name}: rejected review must describe invalid source`);
    assert.equal(rejected.changeCount, 0,
      `${f.name}: rejected source must not advertise semantic changes`);
    assert.equal(rejected.isStyleOnly, false,
      `${f.name}: rejected source must not advertise style equivalence`);
    fs.writeFileSync(path.join(evidence, `${f.name}.incomplete-review.json`),
      JSON.stringify(rejected, null, 2));

    // Use valid sources for installed-UI review and recovery checks. The
    // actual Rust result must contain semantic changes, not style/fallback.
    const raw = await liveDiffProbe(process.env.INTENTUMDIFF_TEST_CLI!, root, f.name, f.partial);
    const direct = JSON.parse(raw);
    assert.equal(direct.metadata.engine_owner, "rust");
    assert.deepEqual(direct.parse_errors, []);
    assert.equal(direct.is_fallback, false);
    assert.equal(direct.is_style_only, false);
    assert.equal(direct.has_semantic_changes, true);
    assert.ok(Array.isArray(direct.changes) && direct.changes.length > 0);
    fs.writeFileSync(path.join(evidence, `${f.name}.diff.json`), raw);
    await replace(f.partial);
    await waitFor(async () => (await files()).some(x => x.relativePath === f.name &&
      x.status === "ready" && x.changeCount > 0 && x.parseErrorCount === 0 && !x.isStyleOnly), `${f.name} valid review`);
    if (f.name === "edit.py") {
      await new Promise(resolve => setTimeout(resolve, 1500));
      execFileSync("scrot", [path.join(evidence, "pending-to-ready.png")]);
    }
    const partial = (await files()).find(x => x.relativePath === f.name)!;
    assert.ok(partial.groupKinds.some(kind => kind === "MEANINGFUL_CHANGE" || kind === "REFACTORING"),
      `${f.name}: no semantic change/refactoring group`);
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
    // Commit an updated valid baseline before testing another real source edit.
    await replace(f.valid); git("add", f.name); git("-c", "user.name=IntentumDiff acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", `Valid ${f.name}`);
    await replace(f.valid.replace("2", "3"));
    await waitFor(async () => (await files()).some(x => x.relativePath === f.name &&
      x.status === "ready" && x.changeCount > 0 && x.parseErrorCount === 0), `${f.name} valid recovery`);
    const recovered = (await files()).find(x => x.relativePath === f.name)!;
    if (f.name === "edit.js") {
      assertMeasuredWasmTelemetry(recovered.engineTelemetry, process.env.INTENTUMDIFF_TEST_RUNTIME_KIND === "native");
      const state = await vscode.commands.executeCommand<{ fuelHistory: Record<string, number[]> }>("intentumdiff.test.getReviewState");
      assert.ok(Object.entries(state?.fuelHistory ?? {}).some(([key, values]) =>
        key.endsWith(f.name) && values.some(value => value > 0)), "Measured Wasm fuel must reach recorded history");
    }
    results.push({ file: f.name, partial, recovered });
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
  // Additional real capability views, kept outside the short introductory video.
  await vscode.commands.executeCommand("intentumdiff.openFullDiff", sourcePayload);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", source);
  const peek = lenses?.find(lens => lens.command?.command === "intentumdiff.peekIntent")?.command;
  assert.ok(peek, "A real intent lens must supply Peek arguments");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), { preview: false });
  await vscode.commands.executeCommand(peek.command, ...(peek.arguments ?? []));
  await waitForVisible(".peekview-widget .ref-tree");
  await capture("capability-peek");
  await vscode.commands.executeCommand("closeReferenceSearch");
  await vscode.commands.executeCommand("intentumdiff.openSemanticOnlyDiff", sourcePayload);
  await capture("capability-semantic-only");
  await vscode.commands.executeCommand("intentumdiff.expandSemanticDiffContext");
  await capture("capability-expanded-context");
  await vscode.commands.executeCommand("intentumdiff.openReviewPanel", sourcePayload);
  await waitForVisible('.product-tab[data-review-view="evidence"]', true, false, undefined,
    '.diff-app[data-review-view="evidence"] [data-review-page="evidence"]');
  await waitForVisible('.diff-app[data-review-view="evidence"] [data-review-page="evidence"]');
  await capture("capability-evidence");
  await waitForVisible('.product-tab[data-review-view="intent"]', true, false, undefined,
    '.diff-app[data-review-view="intent"] [data-review-page="intent"]');
  await waitForVisible('.diff-app[data-review-view="intent"] [data-review-page="intent"]');
  await waitForVisible('.intent-hero', false, true);
  await capture("capability-intent");
  await vscode.commands.executeCommand("intentumdiff.openReviewDashboard");
  await waitForVisible(".dashboard-pills", false, true);
  await capture("capability-dashboard");
  await vscode.commands.executeCommand("intentumdiff.openDiagnostics");
  await capture("capability-diagnostics");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(evidence, "workflow.mp4"), "-filter_complex", "[0:v]fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=sierra2_4a", path.join(evidence, "workflow.gif")], { timeout: 60000 });
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
}
