import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscodeTypes from "vscode";
import type { ReviewFile } from "../src/reviewModel";
import type { IncompleteReview, SemanticDiff } from "../src/types";

interface ModalCall { message: string; options: { modal?: boolean; detail?: string }; items: string[] }

const calls = {
  warning: [] as ModalCall[],
  info: [] as Array<{ message: string; items: string[] }>,
  opened: [] as string[],
  copied: [] as string[],
};
let warningChoice: string | undefined;
let infoChoice: string | undefined;

installVscodeMock();
const { reportIncompleteReview } = require("../src/incompleteReport") as typeof import("../src/incompleteReport");
const { SemanticReviewTreeProvider } = require("../src/reviewTree") as typeof import("../src/reviewTree");

const MESSAGE = "IntentumDiff could not explain this change. Please report a bug (reason: unexplained_source_delta; language: go; core: 0.1.0).";
const TITLE = "Incomplete review: unexplained_source_delta (go, core 0.1.0)";
const BODY = "### IntentumDiff could not explain a change\n\nblock(call_expression[id1](id1, string(9)))";
const ISSUE_URL = "https://github.com/buchochelliq-labs/intentumdiff-core/issues/new?title=Incomplete&body=outline";

function incomplete(truncated = false): IncompleteReview {
  return {
    reason: "unexplained_source_delta",
    message: MESSAGE,
    report_url: ISSUE_URL,
    language: "go",
    core_version: "0.1.0",
    source_ranges: [{ old_start_byte: 0, old_end_byte: 4, new_start_byte: 0, new_end_byte: 6,
      old_start_line: 0, old_end_line: 1, new_start_line: 0, new_end_line: 1 }],
    report: { title: TITLE, body_markdown: BODY, truncated, issue_url: ISSUE_URL, outline: {} },
  };
}

function reset(warning: string | undefined, info?: string): void {
  calls.warning = [];
  calls.info = [];
  calls.opened = [];
  calls.copied = [];
  warningChoice = warning;
  infoChoice = info;
}

test("vscode adapter: the preview is a modal with core's exact title and body; Cancel opens nothing", async () => {
  reset(undefined);
  assert.equal(await reportIncompleteReview(incomplete()), "cancelled");
  assert.equal(calls.warning.length, 1);
  assert.equal(calls.warning[0].message, TITLE);
  assert.equal(calls.warning[0].options.modal, true);
  assert.equal(calls.warning[0].options.detail, BODY);
  assert.deepEqual(calls.warning[0].items, ["Open GitHub issue"]);
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.copied, []);
});

test("vscode adapter: confirming opens core's issue_url through env.openExternal", async () => {
  reset("Open GitHub issue");
  assert.equal(await reportIncompleteReview(incomplete()), "opened");
  assert.deepEqual(calls.opened, [ISSUE_URL]);
});

test("vscode adapter: a truncated report offers Copy full report and copies core's body", async () => {
  reset("Copy full report", undefined);
  assert.equal(await reportIncompleteReview(incomplete(true)), "copied");
  assert.deepEqual(calls.warning[0].items, ["Open GitHub issue", "Copy full report"]);
  assert.match(calls.warning[0].options.detail ?? "", /shortened/u);
  assert.deepEqual(calls.copied, [BODY]);
  assert.deepEqual(calls.opened, []);
  assert.equal(calls.info.length, 1);
});

test("vscode adapter: no report means a notice, never a browser", async () => {
  reset("Open GitHub issue");
  assert.equal(await reportIncompleteReview(undefined), "unavailable");
  assert.equal(calls.warning.length, 0);
  assert.deepEqual(calls.opened, []);
  assert.equal(calls.info.length, 1);
});

test("Semantic Changes tree: an incomplete file shows core's message, a warning icon and the report action context", () => {
  const diff: SemanticDiff = {
    old_filename: "main.go", new_filename: "main.go", language: "go", changes: [],
    is_style_only: false, completeness: "incomplete", incomplete: incomplete(),
  };
  const file: ReviewFile = { folderName: "repo", folderUri: "file:///repo", relativePath: "main.go", status: "ready", diff };
  const provider = new SemanticReviewTreeProvider();
  provider.setFiles([file]);
  const [fileNode] = provider.getChildren();
  const fileItem = provider.getTreeItem(fileNode) as unknown as { description?: string; iconPath?: { id: string; color?: { id: string } } };
  assert.match(fileItem.description ?? "", /incomplete review/u);
  assert.doesNotMatch(fileItem.description ?? "", /clean/u);
  assert.equal(fileItem.iconPath?.id, "warning");
  assert.equal(fileItem.iconPath?.color?.id, "intentumdiff.semanticChanges.incomplete");
  const [entryNode] = provider.getChildren(fileNode);
  const entryItem = provider.getTreeItem(entryNode) as unknown as { label: string; contextValue?: string; iconPath?: { id: string } };
  assert.equal(entryItem.label, MESSAGE);
  assert.equal(entryItem.contextValue, "intentumdiffReviewEntry.incomplete");
  assert.equal(entryItem.iconPath?.id, "warning");

  const equivalent: ReviewFile = { ...file, relativePath: "config.json", diff: {
    old_filename: "config.json", new_filename: "config.json", language: "json", changes: [], is_style_only: false,
    completeness: "equivalent", incomplete: null, metadata: { equivalence_proof: "keyed_data.unordered_mapping_member_order" },
  } };
  provider.setFiles([equivalent]);
  const [eqNode] = provider.getChildren();
  const eqItem = provider.getTreeItem(eqNode) as unknown as { description?: string };
  assert.equal(eqItem.description, "json | equivalent | proof: keyed_data.unordered_mapping_member_order");
});

function installVscodeMock(): void {
  const originalLoad = (Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  })._load;
  class ThemeColor { constructor(readonly id: string) {} }
  class ThemeIcon { constructor(readonly id: string, readonly color?: ThemeColor) {} }
  class TreeItem {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: ThemeIcon;
    command?: unknown;
    resourceUri?: unknown;
    constructor(label: string, readonly collapsibleState = 0) {
      this.label = label;
    }
  }
  class EventEmitter<T> {
    readonly event = (() => undefined) as unknown;
    fire(_value: T): void {}
    dispose(): void {}
  }
  const mock = {
    ThemeColor,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter,
    Uri: {
      parse(value: string, _strict?: boolean): { fsPath: string; toString(): string } {
        return { fsPath: value.replace(/^file:\/\/\/?/u, "/"), toString: () => value };
      },
      file(value: string): { fsPath: string } {
        return { fsPath: value };
      },
    },
    window: {
      showWarningMessage(message: string, options: ModalCall["options"], ...items: string[]): Promise<string | undefined> {
        calls.warning.push({ message, options, items });
        return Promise.resolve(warningChoice);
      },
      showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
        calls.info.push({ message, items });
        return Promise.resolve(infoChoice);
      },
    },
    env: {
      openExternal(uri: { toString(): string }): Promise<boolean> {
        calls.opened.push(uri.toString());
        return Promise.resolve(true);
      },
      clipboard: {
        writeText(text: string): Promise<void> {
          calls.copied.push(text);
          return Promise.resolve();
        },
      },
    },
  } as unknown as typeof vscodeTypes;
  (Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  })._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return mock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
