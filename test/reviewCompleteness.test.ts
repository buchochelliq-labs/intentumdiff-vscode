import assert from "node:assert/strict";
import test from "node:test";
import { diffToBaseDecorations, diffToModifiedDecorations, statusText, summarizeDiff } from "../src/mapper";
import { buildReleaseNotes, releaseNotesToMarkdown } from "../src/releaseNotes";
import {
  REPORT_COPY_ACTION,
  REPORT_OPEN_ACTION,
  REPORT_SHORTENED_NOTICE,
  UNEXPLAINED_RANGE_HOVER,
  incompleteMessage,
  rangeLines,
  runBugReportFlow,
  type BugReportUi,
} from "../src/reviewCompleteness";
import { reviewEntriesForFile, summarizeReview, tooltipForReviewFile, type ReviewFile } from "../src/reviewModel";
import {
  buildReviewPanelModel,
  isReviewWebviewMessage,
  renderPanelHtml,
} from "../src/reviewWebviewModel";
import { buildSemanticOnlyDocuments, SEMANTIC_EMPTY_MESSAGE } from "../src/semanticOnlyDiff";
import { statusForOwner } from "../src/statusOwnership";
import type { IncompleteReview, SemanticDiff } from "../src/types";

const MESSAGE = "IntentumDiff could not explain this change. The go sources differ, but no reviewable change "
  + "survived analysis and equivalence was not proven, so this result is incomplete rather than a clean review. "
  + "Please report a bug at https://github.com/buchochelliq-labs/intentumdiff-core/issues/new "
  + "(reason: unexplained_source_delta; language: go; core: 0.1.0).";
const TITLE = "Incomplete review: unexplained_source_delta (go, core 0.1.0)";
const BODY = "### IntentumDiff could not explain a change\n\n- core: 0.1.0\n- language: go\n\n"
  + "region 1: source_file > function_declaration > block\nblock(call_expression[id1](id1, string(9)))";
const ISSUE_URL = "https://github.com/buchochelliq-labs/intentumdiff-core/issues/new?title=Incomplete&body=outline";

const OLD_TEXT = "package main\n\nfunc main() {\n\tprintln(\"top-secret\")\n}\n";
const NEW_TEXT = "package main\n\nfunc main() {\n\tprintln(\"top-secret\")\n\tprintln(\"x\")\n}\n";

function incompletePayload(truncated = false): IncompleteReview {
  return {
    reason: "unexplained_source_delta",
    message: MESSAGE,
    report_url: ISSUE_URL,
    language: "go",
    core_version: "0.1.0",
    source_ranges: [{
      old_start_byte: 26, old_end_byte: 49, new_start_byte: 26, new_end_byte: 62,
      old_start_line: 3, old_end_line: 4, new_start_line: 3, new_end_line: 5,
    }],
    source_ranges_truncated: false,
    source_ranges_available: true,
    report: { title: TITLE, body_markdown: BODY, truncated, issue_url: ISSUE_URL, outline: { schema_version: 1 } },
  };
}

function incompleteDiff(truncated = false): SemanticDiff {
  return {
    old_filename: "services/secret_billing.go",
    new_filename: "services/secret_billing.go",
    language: "go",
    changes: [],
    change_groups: [],
    has_semantic_changes: false,
    is_style_only: false,
    completeness: "incomplete",
    incomplete: incompletePayload(truncated),
    metadata: { no_surviving_changes: true },
  };
}

function equivalentDiff(proof?: string): SemanticDiff {
  return {
    old_filename: "config.json",
    new_filename: "config.json",
    language: "json",
    changes: [],
    is_style_only: false,
    completeness: "equivalent",
    incomplete: null,
    metadata: proof ? { equivalence_proof: proof } : {},
  };
}

function legacyEmptyDiff(): SemanticDiff {
  return { old_filename: "a.py", new_filename: "a.py", language: "python", changes: [], is_style_only: false };
}

function reviewFile(diff: SemanticDiff, relativePath = "services/secret_billing.go"): ReviewFile {
  return { folderName: "repo", folderUri: "file:///repo", relativePath, status: "ready", diff };
}

const RENDER = { nonce: "n1", cspSource: "vscode-resource:" };

// --- incomplete -------------------------------------------------------------------------

test("incomplete review: tree entry carries core's message verbatim and never reads as clean", () => {
  const entries = reviewEntriesForFile(reviewFile(incompleteDiff()));
  assert.equal(entries[0].kind, "incomplete");
  assert.equal(entries[0].label, MESSAGE);
  assert.equal(entries[0].severity, "warning");
  assert.deepEqual(entries[0].position, { start_line: 3, start_col: 0, end_line: 3, end_col: 0 });
  assert.equal(entries[0].positionSide, "modified");
  assert.ok(!entries.some((entry) => entry.kind === "clean" || /no semantic changes/iu.test(entry.label)));

  const summary = summarizeReview([reviewFile(incompleteDiff())]);
  assert.equal(summary.incompleteCount, 1);
  assert.equal(summary.cleanCount, 0);
  assert.match(tooltipForReviewFile(reviewFile(incompleteDiff())), new RegExp(escapeRegExp(MESSAGE), "u"));
  assert.doesNotMatch(tooltipForReviewFile(reviewFile(incompleteDiff())), /No semantic changes/u);
});

test("incomplete review: status bar says incomplete and carries the message in its tooltip", () => {
  const diff = incompleteDiff();
  assert.equal(statusText(diff), "IntentumDiff: incomplete review");
  assert.equal(summarizeDiff(diff).incompleteMessage, MESSAGE);
  const status = statusForOwner("IntentumDiff", undefined, { relativePath: "x.go", baseline: "live file", diff });
  assert.equal(status.text, "IntentumDiff: incomplete review");
  assert.ok(status.tooltip.endsWith(MESSAGE));
  const workspace = statusForOwner("IntentumDiff: review 1 incomplete", undefined, undefined, MESSAGE);
  assert.ok(workspace.tooltip.includes(MESSAGE));
});

test("incomplete review: the panel shows core's message verbatim with a report action, never a clean state", () => {
  const html = renderPanelHtml(buildReviewPanelModel(reviewFile(incompleteDiff()), OLD_TEXT, NEW_TEXT, "HEAD"), RENDER);
  assert.match(html, /class="incomplete-notice" role="alert"/u);
  assert.ok(html.includes(`<span class="incomplete-message">${htmlEscape(MESSAGE)}</span>`));
  assert.match(html, /data-command="reportIncomplete"/u);
  assert.match(html, /<h2>Incomplete review<\/h2>/u);
  assert.doesNotMatch(html, /No semantic changes/u);
  assert.doesNotMatch(html, /Nothing behavior-affecting was detected/u);
  // Theme-native: the notice binds to editor theme variables, not a bespoke palette.
  const css = html.match(/\.incomplete-notice \{[^}]*\}/u)?.[0] ?? "";
  assert.match(css, /var\(--vscode-editorWarning-foreground\)/u);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu);
  assert.ok(isReviewWebviewMessage({ command: "reportIncomplete", payload: { folderUri: "file:///repo", relativePath: "a.go" } }));
});

test("incomplete review: semantic-only documents show the message instead of 'no semantic changes'", () => {
  const pair = buildSemanticOnlyDocuments(OLD_TEXT, NEW_TEXT, incompleteDiff(), {
    contextLines: 3, showAdditions: true, showDeletions: true, showModifications: true, movedCode: true, hideComments: false,
  });
  assert.equal(pair.modifiedText, MESSAGE);
  assert.equal(pair.baseText, MESSAGE);
});

test("incomplete review: source ranges highlight as changed-but-unexplained lines, positions only", () => {
  const modified = diffToModifiedDecorations(incompleteDiff());
  assert.deepEqual(modified, [{
    kind: "unexplained",
    message: UNEXPLAINED_RANGE_HOVER,
    position: { start_line: 3, start_col: 0, end_line: 4, end_col: 0 },
  }]);
  const base = diffToBaseDecorations(incompleteDiff());
  assert.deepEqual(base.map((item) => [item.kind, item.position]), [
    ["unexplained", { start_line: 3, start_col: 0, end_line: 3, end_col: 0 }],
  ]);
  for (const decoration of [...modified, ...base]) {
    assert.equal(decoration.deletedText, undefined);
    assert.doesNotMatch(decoration.message, /secret|println/u);
  }
  // A pure insertion's empty side marks its anchor line; a mid-line end stays on its line.
  const range = { old_start_byte: 5, old_end_byte: 5, new_start_byte: 5, new_end_byte: 9,
    old_start_line: 1, old_end_line: 1, new_start_line: 1, new_end_line: 1 };
  assert.deepEqual(rangeLines(range, "old"), { start: 1, end: 1 });
  assert.deepEqual(rangeLines(range, "new"), { start: 1, end: 1 });
});

// --- equivalent -------------------------------------------------------------------------

test("equivalent review: shown as equivalent/style-only with the proof id", () => {
  const proof = "keyed_data.unordered_mapping_member_order";
  const entries = reviewEntriesForFile(reviewFile(equivalentDiff(proof), "config.json"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "style");
  assert.equal(entries[0].label, "Equivalent (style-only)");
  assert.equal(entries[0].description, `proof: ${proof}`);
  assert.equal(statusText(equivalentDiff(proof)), "IntentumDiff: equivalent (style-only)");
  assert.equal(summarizeDiff(equivalentDiff(proof)).equivalenceProof, proof);
  const summary = summarizeReview([reviewFile(equivalentDiff(proof), "config.json")]);
  assert.equal(summary.styleOnlyCount, 1);
  assert.equal(summary.cleanCount, 0);

  const html = renderPanelHtml(buildReviewPanelModel(reviewFile(equivalentDiff(proof), "config.json"), "{\"a\":1,\"b\":2}\n", "{\"b\":2,\"a\":1}\n", "HEAD"), RENDER);
  assert.match(html, /<h2>Equivalent \(style-only\)<\/h2>/u);
  assert.ok(html.includes(proof));
  assert.doesNotMatch(html, /class="incomplete-notice"/u);

  const noProof = reviewEntriesForFile(reviewFile(equivalentDiff(), "config.json"));
  assert.equal(noProof[0].label, "Equivalent (style-only)");
  assert.equal(noProof[0].description, undefined);
});

// --- complete / legacy ------------------------------------------------------------------

test("complete review and DTOs without completeness render exactly as before", () => {
  for (const diff of [legacyEmptyDiff(), { ...legacyEmptyDiff(), completeness: "complete" as const, incomplete: null }]) {
    const entries = reviewEntriesForFile(reviewFile(diff, "a.py"));
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.label]), [["clean", "No semantic changes"]]);
    assert.equal(statusText(diff), "IntentumDiff: clean");
    assert.equal(summarizeReview([reviewFile(diff, "a.py")]).cleanCount, 1);
    assert.deepEqual(diffToModifiedDecorations(diff), []);
    assert.equal(incompleteMessage(diff), undefined);
    const html = renderPanelHtml(buildReviewPanelModel(reviewFile(diff, "a.py"), "x = 1\n", "x = 1\n", "HEAD"), RENDER);
    assert.doesNotMatch(html, /class="incomplete-notice"/u);
    assert.match(html, /No semantic changes/u);
    const pair = buildSemanticOnlyDocuments("x\n", "x\n", diff, {
      contextLines: 3, showAdditions: true, showDeletions: true, showModifications: true, movedCode: true, hideComments: false,
    });
    assert.equal(pair.modifiedText, SEMANTIC_EMPTY_MESSAGE);
  }
  // Legacy summaries gain no new keys.
  assert.deepEqual(Object.keys(summarizeDiff(legacyEmptyDiff())).sort(),
    ["changeCount", "guardrailCount", "hasParseErrors", "immutableCount", "importantCount", "language", "styleOnly"]);
});

test("a stray incomplete object without the incomplete verdict is ignored", () => {
  const diff = { ...legacyEmptyDiff(), incomplete: incompletePayload() };
  assert.equal(incompleteMessage(diff), undefined);
  assert.equal(reviewEntriesForFile(reviewFile(diff, "a.py"))[0].kind, "clean");
});

// --- report-a-bug flow -------------------------------------------------------------------

interface UiCalls {
  confirm: Array<{ title: string; detail: string; actions: string[] }>;
  notify: Array<{ message: string; actions: string[] }>;
  opened: string[];
  copied: string[];
}

function fakeUi(confirmChoice: string | undefined, notifyChoice?: string): { ui: BugReportUi; calls: UiCalls } {
  const calls: UiCalls = { confirm: [], notify: [], opened: [], copied: [] };
  return {
    calls,
    ui: {
      confirm: async (title, detail, actions) => {
        calls.confirm.push({ title, detail, actions });
        return confirmChoice;
      },
      notify: async (message, actions) => {
        calls.notify.push({ message, actions });
        return notifyChoice;
      },
      openExternal: async (url) => {
        calls.opened.push(url);
        return true;
      },
      writeClipboard: async (text) => {
        calls.copied.push(text);
      },
    },
  };
}

test("report flow: cancelling the preview opens nothing and copies nothing", async () => {
  const { ui, calls } = fakeUi(undefined);
  assert.equal(await runBugReportFlow(incompletePayload(), ui), "cancelled");
  assert.equal(calls.confirm.length, 1);
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.copied, []);
});

test("report flow: openExternal is called with core's issue_url only after confirmation", async () => {
  const { ui, calls } = fakeUi(REPORT_OPEN_ACTION);
  assert.equal(await runBugReportFlow(incompletePayload(), ui), "opened");
  assert.deepEqual(calls.confirm[0].actions, [REPORT_OPEN_ACTION]);
  assert.deepEqual(calls.opened, [ISSUE_URL]);
  assert.deepEqual(calls.copied, []);
});

test("report flow: a truncated report says the link was shortened and offers the full copy", async () => {
  const copyOnly = fakeUi(REPORT_COPY_ACTION, undefined);
  assert.equal(await runBugReportFlow(incompletePayload(true), copyOnly.ui), "copied");
  assert.deepEqual(copyOnly.calls.confirm[0].actions, [REPORT_OPEN_ACTION, REPORT_COPY_ACTION]);
  assert.equal(copyOnly.calls.confirm[0].detail, `${BODY}\n\n${REPORT_SHORTENED_NOTICE}`);
  assert.deepEqual(copyOnly.calls.copied, [BODY]);
  assert.deepEqual(copyOnly.calls.opened, [], "copying never opens the link by itself");

  const copyThenOpen = fakeUi(REPORT_COPY_ACTION, REPORT_OPEN_ACTION);
  assert.equal(await runBugReportFlow(incompletePayload(true), copyThenOpen.ui), "opened");
  assert.deepEqual(copyThenOpen.calls.opened, [ISSUE_URL]);

  // An untruncated report never offers (or honours) the copy action.
  const notTruncated = fakeUi(REPORT_COPY_ACTION);
  assert.equal(await runBugReportFlow(incompletePayload(false), notTruncated.ui), "cancelled");
  assert.deepEqual(notTruncated.calls.copied, []);
  assert.deepEqual(notTruncated.calls.opened, []);
});

test("report flow: without core's report nothing is previewed or opened", async () => {
  const missing = { ...incompletePayload(), report: undefined };
  const { ui, calls } = fakeUi(REPORT_OPEN_ACTION);
  assert.equal(await runBugReportFlow(missing, ui), "unavailable");
  assert.equal(calls.confirm.length, 0);
  assert.deepEqual(calls.opened, []);
  const insecure = incompletePayload();
  insecure.report = { ...insecure.report!, issue_url: "http://example.invalid/new" };
  assert.equal(await runBugReportFlow(insecure, ui), "unavailable");
  assert.deepEqual(calls.opened, []);
});

test("privacy: the preview, the clipboard and the opened URL contain only core-provided text", async () => {
  const diff = incompleteDiff(true);
  const { ui, calls } = fakeUi(REPORT_COPY_ACTION, REPORT_OPEN_ACTION);
  await runBugReportFlow(diff.incomplete!, ui);
  const [preview] = calls.confirm;
  assert.equal(preview.title, TITLE);
  assert.equal(preview.detail, `${BODY}\n\n${REPORT_SHORTENED_NOTICE}`);
  assert.deepEqual(calls.copied, [BODY]);
  assert.deepEqual(calls.opened, [ISSUE_URL]);
  const everything = [preview.title, preview.detail, ...calls.copied, ...calls.opened].join("\n");
  for (const local of ["secret_billing", "services/", "file:///repo", "top-secret", "println(\"x\")", OLD_TEXT, NEW_TEXT]) {
    assert.ok(!everything.includes(local), `report must not include local data: ${local}`);
  }
});

function htmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("incomplete review: release notes (tab and Markdown export) show core's message, never 'no behavior-facing changes'", () => {
  const html = renderPanelHtml(buildReviewPanelModel(reviewFile(incompleteDiff()), OLD_TEXT, NEW_TEXT, "HEAD"), RENDER);
  const notesPage = html.slice(html.indexOf('data-review-page="release-notes"'));
  assert.ok(notesPage.includes(`<li class="release-note-empty">${htmlEscape(MESSAGE)}</li>`));
  assert.doesNotMatch(notesPage, /No behavior-facing changes detected/u);
  const markdown = releaseNotesToMarkdown(buildReleaseNotes(incompleteDiff()), { incompleteMessage: MESSAGE });
  assert.ok(markdown.includes(`## Behavior changes\n- ${MESSAGE}`) || markdown.includes(MESSAGE));
  assert.doesNotMatch(markdown, /No behavior-facing changes detected/u);
  // Older wheels and complete reviews keep the old empty line.
  assert.match(releaseNotesToMarkdown(buildReleaseNotes(legacyEmptyDiff())), /No behavior-facing changes detected/u);
});
