// Production hunk-apply flow (extension.ts) driven against a stubbed VS Code
// document API: stale hunks must never overwrite newer content, Preview must
// never write or save, and unrelated unsaved edits must never be persisted
// (issue #119).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import * as path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import { renderPanelHtml, buildReviewPanelModel } from "../src/reviewWebviewModel";
import type { ReviewFile } from "../src/reviewModel";

interface FakeDocument {
  text: string;
  eol: "\n" | "\r\n";
  version: number;
  isDirty: boolean;
  saves: number;
}

interface Harness {
  controller: any;
  document: FakeDocument;
  applied: Array<{ range: any; text: string }>;
  warnings: string[];
  infos: string[];
  shownDocuments: Array<{ language?: string; content?: string }>;
  refreshes: string[];
}

// Anything the hunk flow does not use resolves to an inert stub so module
// initialisers (decorations, code-action kinds, …) load without a real host.
function inertStub(): any {
  const target = function stub() { return inertStub(); };
  return new Proxy(target, {
    get: (_target, property) => (property === Symbol.toPrimitive ? () => "" : inertStub()),
    apply: () => inertStub(),
    construct: () => inertStub(),
  });
}

function withInertFallback<T extends object>(api: T): T {
  return new Proxy(api, {
    get: (target, property) => (property in target ? (target as any)[property] : inertStub()),
  });
}

function fakeVscode(harness: Omit<Harness, "controller">): any {
  class Position { constructor(public line: number, public character: number) {} }
  class Range {
    start: Position;
    end: Position;
    constructor(sl: number, sc: number, el: number, ec: number) {
      this.start = new Position(sl, sc);
      this.end = new Position(el, ec);
    }
  }
  class WorkspaceEdit {
    edits: Array<{ range: Range; text: string }> = [];
    replace(_uri: unknown, range: Range, text: string): void { this.edits.push({ range, text }); }
  }
  const doc = harness.document;
  const splitLines = (): string[] => doc.text.split(doc.eol);
  const textDocument = {
    get lineCount() { return splitLines().length; },
    lineAt: (index: number) => ({ text: splitLines()[index] }),
    get eol() { return doc.eol === "\r\n" ? 2 : 1; },
    get version() { return doc.version; },
    get isDirty() { return doc.isDirty; },
    save: async () => { doc.saves += 1; doc.isDirty = false; return true; },
  };
  const offsetOf = (line: number, character: number): number => {
    const lines = splitLines();
    let offset = 0;
    for (let index = 0; index < line; index += 1) {
      offset += lines[index].length + doc.eol.length;
    }
    return offset + character;
  };
  return withInertFallback({
    Range,
    Position,
    WorkspaceEdit,
    EndOfLine: { LF: 1, CRLF: 2 },
    Uri: {
      file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
      parse: (value: string) => ({ fsPath: value.replace(/^file:\/\//u, "") }),
    },
    window: withInertFallback({
      showWarningMessage: async (message: string, ...items: unknown[]) => {
        harness.warnings.push(message);
        // Confirm modal prompts (Revert Hunk) as the user would.
        return items.find((item) => item === "Revert Hunk");
      },
      showInformationMessage: async (message: string) => { harness.infos.push(message); return undefined; },
      showTextDocument: async () => undefined,
    }),
    workspace: withInertFallback({
      openTextDocument: async (arg: unknown) => {
        if (arg && typeof arg === "object" && "content" in (arg as Record<string, unknown>)) {
          harness.shownDocuments.push(arg as { language?: string; content?: string });
          return {};
        }
        return textDocument;
      },
      applyEdit: async (edit: WorkspaceEdit) => {
        for (const item of edit.edits) {
          harness.applied.push(item);
          const start = offsetOf(item.range.start.line, item.range.start.character);
          const end = offsetOf(item.range.end.line, item.range.end.character);
          doc.text = doc.text.slice(0, start) + item.text + doc.text.slice(end);
          doc.version += 1;
          doc.isDirty = true;
        }
        return true;
      },
    }),
  });
}

function makeHarness(text: string, options: Partial<FakeDocument> = {}): Harness {
  const partial: Omit<Harness, "controller"> = {
    document: { text, eol: "\n" as const, version: 1, isDirty: false, saves: 0, ...options },
    applied: [],
    warnings: [],
    infos: [],
    shownDocuments: [],
    refreshes: [],
  };
  const vscode = fakeVscode(partial);
  const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function load(request: string, ...rest: unknown[]) {
    return request === "vscode" ? vscode : originalLoad.call(this, request, ...rest);
  };
  try {
    const extensionPath = path.join(__dirname, "../src/extension.js");
    const source = readFileSync(extensionPath, "utf8");
    const localRequire = Module.createRequire(extensionPath);
    const exports: Record<string, any> = {};
    vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${source}\nexports.Controller = PysdController;\n})`)(
      exports, localRequire, { exports }, extensionPath, path.dirname(extensionPath),
    );
    const controller = Object.create(exports.Controller.prototype);
    Object.assign(controller, {
      output: { appendLine() {}, show() {} },
      requestFullReview: (reason: string) => partial.refreshes.push(reason),
    });
    return { controller, ...partial };
  } finally {
    moduleWithLoad._load = originalLoad;
  }
}

const reviewedHunk = {
  folderUri: "file:///repo",
  relativePath: "src/app.ts",
  change: {
    change_type: "MODIFICATION",
    old_node: { label: "Semantic hunk", position: { start_line: 2, start_col: 0, end_line: 2, end_col: 0 } },
    new_node: { label: "Semantic hunk", position: { start_line: 2, start_col: 0, end_line: 2, end_col: 0 } },
  },
  hunk: {
    oldLines: ["const value = 1;"],
    newLines: ["const value = 2;"],
    reviewedNewLines: ["const value = 2;"],
    oldStartLine: 2,
    oldEndLine: 2,
    newStartLine: 2,
    newEndLine: 2,
  },
};

function editedHunk(newLines: string[]): typeof reviewedHunk {
  return { ...reviewedHunk, hunk: { ...reviewedHunk.hunk, newLines } };
}

test("a stale hunk action cannot overwrite newer content on its target line", async () => {
  // The document moved on after review: version 99 and new content on line 2.
  const harness = makeHarness("a\nconst value = 99; // newer\nc\n", { version: 99 });
  await harness.controller.handleSemanticHunkAction("applyHunk", editedHunk(["const value = 3;"]));
  assert.equal(harness.document.text, "a\nconst value = 99; // newer\nc\n");
  assert.equal(harness.applied.length, 0, "no edit is applied");
  assert.equal(harness.document.saves, 0, "nothing is saved");
  assert.match(harness.warnings.join("\n"), /changed since it was reviewed/u);
  assert.deepEqual(harness.refreshes, ["stale semantic hunk action"], "the review is refreshed");

  await harness.controller.handleSemanticHunkAction("revertHunk", reviewedHunk);
  assert.equal(harness.document.text, "a\nconst value = 99; // newer\nc\n", "stale revert is rejected too");
});

test("a hunk shifted by an edit above it is rejected instead of hitting the wrong line", async () => {
  const harness = makeHarness("inserted\na\nconst value = 2;\nc\n");
  await harness.controller.handleSemanticHunkAction("applyHunk", editedHunk(["const value = 3;"]));
  assert.equal(harness.document.text, "inserted\na\nconst value = 2;\nc\n");
  assert.equal(harness.applied.length, 0);
});

test("a hunk payload without reviewed source never writes", async () => {
  const harness = makeHarness("a\nconst value = 2;\nc\n");
  const { reviewedNewLines: _ignored, ...hunk } = editedHunk(["const value = 3;"]).hunk;
  await harness.controller.handleSemanticHunkAction("applyHunk", { ...reviewedHunk, hunk });
  assert.equal(harness.document.text, "a\nconst value = 2;\nc\n");
  assert.match(harness.warnings.join("\n"), /no reviewed source/u);
});

test("Preview apply shows the patch and performs no write or save", async () => {
  const harness = makeHarness("a\nconst value = 2;\nc\n");
  await harness.controller.handleSemanticHunkAction("applyHunk", editedHunk(["const value = 3;"]), "preview");
  assert.equal(harness.applied.length, 0, "preview applies no edit");
  assert.equal(harness.document.saves, 0, "preview saves nothing");
  assert.equal(harness.document.text, "a\nconst value = 2;\nc\n");
  assert.equal(harness.shownDocuments.length, 1, "preview opens an untitled patch document");
  assert.equal(harness.shownDocuments[0].language, "diff");
  assert.match(harness.shownDocuments[0].content ?? "", /\+ const value = 3;/u);
});

test("the webview routes Preview apply and bare applyHunk messages to the non-mutating preview", () => {
  const source = readFileSync(path.join(__dirname, "../src/extension.js"), "utf8");
  assert.match(source, /message\.command === "previewHunk" \|\| message\.command === "applyHunk"/u);
  assert.match(source, /executeCommand\("intentumdiff\.reviewPanel\.previewHunk", message\.payload\)/u);
  const file: ReviewFile = {
    folderName: "repo",
    folderUri: "file:///repo",
    relativePath: "src/app.js",
    status: "ready",
    diff: { language: "javascript", change_groups: [], changes: [], guardrail_violations: [] },
  };
  const html = renderPanelHtml(
    buildReviewPanelModel(file, "a\nconst value = 1;\nc\n", "a\nconst value = 2;\nc\n", "HEAD"),
    { nonce: "n", cspSource: "vscode-resource:" },
  );
  assert.match(html, /data-command="previewHunk"[^>]*title="Preview apply"/u);
  assert.doesNotMatch(html, /data-command="applyHunk"/u, "no button posts a mutating applyHunk directly");
});

test("a verified apply with unrelated unsaved edits elsewhere is applied but not saved", async () => {
  const harness = makeHarness("a // unsaved\nconst value = 2;\nc\n", { isDirty: true });
  await harness.controller.handleSemanticHunkAction("applyHunk", editedHunk(["const value = 3;"]));
  assert.equal(harness.document.text, "a // unsaved\nconst value = 3;\nc\n");
  assert.equal(harness.document.saves, 0, "unrelated unsaved edits are not persisted");
  assert.match(harness.infos.join("\n"), /not saved/u);
});

test("a verified apply on a clean document saves, preserving CRLF and a missing final newline", async () => {
  const harness = makeHarness("a\r\nconst value = 2;", { eol: "\r\n" });
  await harness.controller.handleSemanticHunkAction("applyHunk", editedHunk(["const value = 3;", "const extra = 4;"]));
  assert.equal(harness.document.text, "a\r\nconst value = 3;\r\nconst extra = 4;");
  assert.equal(harness.document.saves, 1);

  const revertHarness = makeHarness("a\r\nconst value = 2;\r\nc\r\n", { eol: "\r\n" });
  await revertHarness.controller.handleSemanticHunkAction("revertHunk", reviewedHunk);
  assert.equal(revertHarness.document.text, "a\r\nconst value = 1;\r\nc\r\n");
});
