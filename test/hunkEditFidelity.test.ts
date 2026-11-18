// Inline hunk editing must round-trip exact source characters: decorative
// Unicode markers are overlays, never source (issue 120). Runs the production
// webview script in JSDOM.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildReviewPanelModel, renderPanelHtml } from "../src/reviewWebviewModel";
import type { ReviewFile } from "../src/reviewModel";
import { planVerifiedHunkTextEdit, semanticReviewHunkEditForPayload } from "../src/reviewActionModel";

const file: ReviewFile = {
  folderName: "repo",
  folderUri: "file:///repo",
  relativePath: "src/app.js",
  status: "ready",
  diff: { language: "javascript", change_groups: [], changes: [], guardrail_violations: [] },
};

// Untouched characters that a DOM round trip can corrupt.
const TRICKY_LINES = [
  "const a = \"x​y\";",          // zero-width space (rendered as a marker)
  "const b = \"nb sp\";",        // NBSP (marker)
  "\tconst c = \"\u0007bell\";",       // tab + control char (marker)
  "const d = \"é\u{1F600}\";",  // combining mark + surrogate pair
  "const e = \"⁧rtl⁩﻿\";", // bidi isolates + BOM (markers)
];

interface Cell {
  getAttribute(name: string): string | null;
  textContent: string;
  dispatchEvent(event: unknown): boolean;
}

function renderAndRun(baseLines: string[], workingLines: string[]) {
  const html = renderPanelHtml(
    buildReviewPanelModel(file, `top\n${baseLines.join("\n")}\nend\n`, `top\n${workingLines.join("\n")}\nend\n`, "HEAD"),
    { nonce: "n1", cspSource: "vscode-resource:" },
  );
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const posted: unknown[] = [];
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message), getState: () => ({}), setState: () => undefined,
  });
  window.eval(window.document.querySelector("script:not([src])")?.textContent ?? "");
  const cells = Array.from(window.document.querySelectorAll("[data-hunk-edit-cell]")) as unknown as Cell[];
  const apply = () => {
    const hunkId = cells[0].getAttribute("data-hunk-id");
    const button = window.document.querySelector(`.hunk-apply-btn[data-hunk-id="${hunkId}"]`) as unknown as Cell;
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const messages = JSON.parse(JSON.stringify(posted)) as Array<{
      command: string;
      payload?: { hunk?: { newLines?: string[]; reviewedNewLines?: string[]; newStartLine?: number; newEndLine?: number } };
    }>;
    return messages.find((message) => message.command === "editHunk")?.payload?.hunk;
  };
  const edit = (cell: Cell, text: string) => {
    cell.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    cell.textContent = text;
    cell.dispatchEvent(new window.Event("input", { bubbles: true }));
    cell.dispatchEvent(new window.Event("focusout", { bubbles: true }));
  };
  const focusAndBlur = (cell: Cell) => {
    cell.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    const shown = cell.textContent;
    cell.dispatchEvent(new window.Event("focusout", { bubbles: true }));
    return shown;
  };
  return { window, cells, apply, edit, focusAndBlur };
}

test("untouched decorated cells post their exact source, not the marker text", () => {
  const working = [...TRICKY_LINES.map((line) => `${line} // v2`), "const z = 1;"];
  const { cells, apply, edit, focusAndBlur } = renderAndRun(TRICKY_LINES, working);
  assert.equal(cells.length, working.length, "one editable cell per working line");
  assert.match(cells[0].textContent, /U\+200B/u, "the marker is visible before editing");
  // Entering and leaving a decorated cell without typing must not change it.
  assert.equal(focusAndBlur(cells[0]), working[0], "editing starts from the raw source");
  // Edit only the last line; every other line must round-trip exactly.
  edit(cells[cells.length - 1], "const z = 2;");
  const hunk = apply();
  assert.ok(hunk, "an editHunk message is posted");
  assert.deepEqual(hunk?.newLines, [...working.slice(0, -1), "const z = 2;"]);
  assert.deepEqual(hunk?.reviewedNewLines, working, "the reviewed source travels unmodified");
});

test("an edit inside a decorated cell keeps its untouched invisible characters", () => {
  const working = ["const a = \"x​y\";", "const b = 1;"];
  const { cells, apply, window } = renderAndRun(["const a = 0;", "const b = 0;"], working);
  const cell = cells[0];
  cell.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  assert.equal(cell.textContent, working[0], "editing exposes the raw characters");
  cell.textContent = cell.textContent.replace("x", "X");
  cell.dispatchEvent(new window.Event("input", { bubbles: true }));
  cell.dispatchEvent(new window.Event("focusout", { bubbles: true }));
  assert.deepEqual(apply()?.newLines, ["const a = \"X​y\";", "const b = 1;"]);
});

test("a multiline paste is posted as embedded newlines and the reviewed range is kept", () => {
  const working = ["const a = 1;", "const b = 1;"];
  const { cells, apply, edit } = renderAndRun(["const a = 0;", "const b = 0;"], working);
  edit(cells[0], "const a = 1;\nconst inserted = 3;");
  const hunk = apply();
  assert.deepEqual(hunk?.newLines, ["const a = 1;\nconst inserted = 3;", "const b = 1;"]);
  assert.equal(hunk?.newStartLine, 2);
  assert.equal(hunk?.newEndLine, 3, "the host verifies and replaces the reviewed range, not a recomputed one");
});

test("Escape restores the rendered markers and the exact source", () => {
  const working = ["const a = \"x​y\";"];
  const { cells, apply, window } = renderAndRun(["const a = 0;"], working);
  const cell = cells[0];
  cell.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  cell.textContent = "garbage";
  cell.dispatchEvent(new window.Event("input", { bubbles: true }));
  cell.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.match(cell.textContent, /U\+200B/u, "the marker overlay is back");
  assert.deepEqual(apply()?.newLines, working);
});

test("render -> edit -> message -> host apply preserves every untouched character", () => {
  const working = [...TRICKY_LINES, "const z = 1;"];
  const { cells, apply, edit } = renderAndRun(TRICKY_LINES.map((line) => line.replace("const", "let")), working);
  edit(cells[cells.length - 1], "const z = 2;\nconst pasted = 3;");
  const hunk = apply();
  assert.ok(hunk);
  const result = semanticReviewHunkEditForPayload(
    {
      folderUri: "file:///repo",
      relativePath: "src/app.js",
      actionKind: "applyHunk",
      change: {
        change_type: "MODIFICATION",
        new_node: { label: "hunk", position: { start_line: 2, start_col: 0, end_line: 7, end_col: 0 } },
      },
      hunk,
    },
    () => "/repo",
  );
  assert.ok(result.edit, result.error);
  const documentLines = ["top", ...working, "end", ""];
  const plan = planVerifiedHunkTextEdit({ lines: documentLines, eol: "\r\n" }, result.edit!);
  assert.ok(plan.edit, plan.error);
  assert.equal(plan.edit!.text, [...TRICKY_LINES, "const z = 2;", "const pasted = 3;"].map((line) => `${line}\r\n`).join(""));
});
