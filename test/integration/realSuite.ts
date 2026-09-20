import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";

interface Entry { relativePath: string; status: string; changeCount: number;
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
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
}
