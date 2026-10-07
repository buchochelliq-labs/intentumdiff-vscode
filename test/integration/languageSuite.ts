import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import { waitForVisible } from "./desktopEvidence";

interface Example {
  language: string; filename: string; old: string; new: string;
  expected_summary: string; caveats: string[];
  expected_language?: string;
}
interface Entry {
  relativePath: string; status: string; language?: string; changeCount: number;
  parseErrorCount: number; isStyleOnly: boolean;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function state(): Promise<Entry[]> {
  return (await vscode.commands.executeCommand<{ files: Entry[] }>("intentumdiff.test.getReviewState"))?.files ?? [];
}
async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function run(): Promise<void> {
  const root = process.env.INTENTUMDIFF_REAL_WORKSPACE!;
  const evidence = process.env.INTENTUMDIFF_REAL_EVIDENCE!;
  const shard = Number(process.env.INTENTUMDIFF_CAPTURE_SET!.split("-")[1]);
  assert.ok(Number.isInteger(shard) && shard >= 0 && shard < 4);
  const all: Example[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../test/integration/languageExamples.json"), "utf8"));
  assert.equal(all.length, 74);
  assert.equal(new Set(all.map(f => f.language)).size, 74);
  const examples = all.filter((_, index) => index % 4 === shard);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init");
  const extension = vscode.extensions.getExtension("buchochelliq-labs.intentumdiff");
  assert.ok(extension);
  assert.equal(extension.extensionPath, process.env.INTENTUMDIFF_REAL_INSTALLED);
  await extension.activate();
  // Make source readable before taking evidence; do not rely on profile defaults.
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  await vscode.commands.executeCommand("workbench.action.closePanel");
  const results: object[] = [];
  const failures: string[] = [];
  const capture = async (name: string) => {
    // A tab check is not DOM render proof; every screenshot still needs visual review.
    await delay(1500);
    execFileSync("scrot", [path.join(evidence, `${name}.png`)]);
  };
  const assertComparisonStatus = async (relativePath: string) => {
    const current = await vscode.commands.executeCommand<{ comparisonStatus: string; comparisonStatusTooltip: string }>("intentumdiff.test.getReviewState");
    assert.ok(current?.comparisonStatus.startsWith("IntentumDiff:"), "comparison status missing");
    assert.doesNotMatch(current.comparisonStatus, /style-only|clean|diffing|pending/u,
      `${relativePath}: active meaningful comparison has contradictory status`);
    assert.ok(current.comparisonStatusTooltip.includes(relativePath),
      `${relativePath}: status belongs to another comparison`);
  };
  for (const f of examples) {
    assert.match(f.language, /^[a-z0-9-]+$/u);
    assert.equal(path.basename(f.filename), f.filename);
    const relativePath = `${f.language}/${f.filename}`;
    const filename = path.join(root, relativePath);
    const uri = vscode.Uri.file(filename);
    const payload = { folderUri: vscode.Uri.file(root).toString(), relativePath };
    try {
      // Commit each baseline before editing: only this fixture is dirty at capture time.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, f.old);
      git("add", relativePath);
      git("-c", "user.name=IntentumDiff acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", `Baseline ${f.language}`);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), f.new);
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(await document.save());
      await vscode.commands.executeCommand("intentumdiff.refreshReview");
      await waitFor(async () => (await state()).some(x => x.relativePath === relativePath && (x.status === "ready" || x.status === "error")), relativePath);
      const observed = (await state()).find(x => x.relativePath === relativePath)!;
      assert.equal(observed.status, "ready", `${relativePath}: engine review failed`);
      assert.ok(observed.language && observed.language !== "binary", `${relativePath}: text fixture routed as ${observed.language}`);
      assert.ok(observed.changeCount > 0, `${relativePath}: meaningful edit returned no changes`);
      assert.equal(observed.isStyleOnly, false, `${relativePath}: meaningful edit reported as style-only`);
      if (f.expected_language) assert.equal(observed.language, f.expected_language, `${relativePath}: unexpected routing`);
      await vscode.commands.executeCommand("intentumdiff.openReviewPanel", payload);
      await waitFor(async () => vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.isActive && t.input instanceof vscode.TabInputWebview)), "review tab");
      await waitForVisible(".product-file-line strong", false, false, relativePath);
      await waitForVisible('.diff-app[data-diff-mode="text"] .diff-workbench');
      await assertComparisonStatus(relativePath);
      await capture(`language-${f.language}-review`);
      await assertComparisonStatus(relativePath);
      await vscode.commands.executeCommand("intentumdiff.openFullDiff", payload);
      await waitFor(async () => vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.isActive && t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === uri.toString())), "native diff");
      await assertComparisonStatus(relativePath);
      // Every fixture source line, including changed suffixes and offscreen rows,
      // must be visibly rendered before the native evidence can be accepted.
      await waitForVisible(".monaco-diff-editor", false, false, undefined, undefined,
        [...f.old.split("\n"), ...f.new.split("\n")].filter(line => line.trim().length > 0));
      await capture(`language-${f.language}-native`);
      await assertComparisonStatus(relativePath);
      results.push({ example: f.language, relativePath, expected_summary: f.expected_summary,
        caveats: f.caveats, observed, assessment: "awaiting_independent_output_and_visual_review" });
    } catch (error) {
      failures.push(`${f.language}: ${String(error)}`);
      await capture(`language-${f.language}-failure`);
      results.push({ example: f.language, error: String(error), observed: await state(),
        lifecycle: await vscode.commands.executeCommand("intentumdiff.test.getReviewState") });
    } finally {
      fs.writeFileSync(path.join(evidence, "language-results.json"), JSON.stringify(results, null, 2));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // Keep later captures isolated even when this example failed.
      git("restore", "--worktree", "--", relativePath);
      await vscode.commands.executeCommand("intentumdiff.clearReview");
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}
