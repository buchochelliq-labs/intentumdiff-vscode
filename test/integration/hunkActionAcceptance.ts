// Installed-extension acceptance for hunk actions (issues 119/120, certified
// under 137): drives the installed VSIX's own commands against real VS Code
// documents. Stale hunks must not overwrite newer content, Preview must not
// write or save, CRLF and a missing final newline must survive, and unrelated
// unsaved edits must never be saved.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface HunkPayload {
  oldLines: string[];
  newLines: string[];
  reviewedNewLines: string[];
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
}

function hunk(reviewed: string[], edited: string[], line: number): HunkPayload {
  const end = line + reviewed.length - 1;
  return {
    oldLines: reviewed,
    newLines: edited,
    reviewedNewLines: reviewed,
    oldStartLine: line,
    oldEndLine: end,
    newStartLine: line,
    newEndLine: end,
  };
}

export async function runHunkActionAcceptance(root: string, evidence: string): Promise<Record<string, unknown>> {
  const folderUri = vscode.Uri.file(root).toString();
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => fs.readFileSync(file(name), "utf8");
  const payload = (relativePath: string, h: HunkPayload) => {
    const position = { start_line: h.newStartLine, start_col: 0, end_line: h.newEndLine, end_col: 0 };
    return {
      folderUri,
      relativePath,
      change: {
        change_type: "MODIFICATION",
        description: "Semantic hunk",
        old_node: { label: "Semantic hunk", position },
        new_node: { label: "Semantic hunk", position },
      },
      hunk: h,
    };
  };
  const results: Record<string, unknown> = {};

  // 1. Verified apply on a clean CRLF document without a final newline.
  fs.writeFileSync(file("hunk-crlf.py"), "a = 1\r\nb = 2");
  await vscode.commands.executeCommand("intentumdiff.reviewPanel.applyHunk",
    payload("hunk-crlf.py", hunk(["b = 2"], ["b = 3", "c = 4"], 2)));
  assert.equal(read("hunk-crlf.py"), "a = 1\r\nb = 3\r\nc = 4", "CRLF and no-final-newline preserved");
  results.crlfNoFinalNewline = "applied+saved, EOL and final-newline state preserved";

  // 2. Stale hunk: the target line changed after review.
  fs.writeFileSync(file("hunk-stale.py"), "a = 1\nb = 99\n");
  await vscode.commands.executeCommand("intentumdiff.reviewPanel.applyHunk",
    payload("hunk-stale.py", hunk(["b = 2"], ["b = 3"], 2)));
  const staleDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(file("hunk-stale.py")));
  assert.equal(staleDocument.getText(), "a = 1\nb = 99\n", "stale hunk must not touch the document");
  assert.equal(staleDocument.isDirty, false);
  assert.equal(read("hunk-stale.py"), "a = 1\nb = 99\n");
  results.staleRejected = true;

  // 3. Preview performs no write and no save.
  const before = read("hunk-crlf.py");
  await vscode.commands.executeCommand("intentumdiff.reviewPanel.previewHunk",
    payload("hunk-crlf.py", hunk(["b = 3"], ["b = 5"], 2)));
  const previewed = await vscode.workspace.openTextDocument(vscode.Uri.file(file("hunk-crlf.py")));
  assert.equal(previewed.isDirty, false, "preview must not edit the document");
  assert.equal(read("hunk-crlf.py"), before, "preview must not write the file");
  results.previewNonMutating = true;

  // 4. Unrelated unsaved edits are kept unsaved.
  fs.writeFileSync(file("hunk-dirty.py"), "a = 1\nb = 2\n");
  const dirty = await vscode.workspace.openTextDocument(vscode.Uri.file(file("hunk-dirty.py")));
  await vscode.window.showTextDocument(dirty);
  const unrelated = new vscode.WorkspaceEdit();
  unrelated.insert(dirty.uri, new vscode.Position(0, 5), " # unsaved");
  assert.ok(await vscode.workspace.applyEdit(unrelated));
  await vscode.commands.executeCommand("intentumdiff.reviewPanel.applyHunk",
    payload("hunk-dirty.py", hunk(["b = 2"], ["b = 3"], 2)));
  assert.equal(dirty.getText(), "a = 1 # unsaved\nb = 3\n", "verified hunk applied in the open document");
  assert.equal(dirty.isDirty, true);
  assert.equal(read("hunk-dirty.py"), "a = 1\nb = 2\n", "unrelated unsaved edits must not be saved");
  results.unrelatedUnsavedKept = true;
  await vscode.commands.executeCommand("workbench.action.files.revert");

  fs.writeFileSync(path.join(evidence, "hunk-actions.json"), JSON.stringify(results, null, 2));
  return results;
}
