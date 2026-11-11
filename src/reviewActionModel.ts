import * as path from "path";
import { assertSafeRelativePath } from "./baseUri";
import type { NodePosition, SemanticChange } from "./types";

export interface ReviewActionPayloadLike {
  folderUri?: string;
  relativePath?: string;
}

export interface ReviewActionTarget {
  fsPath: string;
}

export interface ReviewActionTargetResult {
  target?: ReviewActionTarget;
  error?: string;
}

export type SemanticReviewActionKind = "stageHunk" | "revertHunk" | "applyHunk";

export interface SemanticReviewActionPayloadLike extends ReviewActionPayloadLike {
  change?: SemanticChange;
  actionKind?: SemanticReviewActionKind;
  hunk?: SemanticReviewHunkPayloadLike;
}

export interface SemanticReviewHunkPayloadLike {
  oldLines?: string[];
  newLines?: string[];
  oldStartLine?: number;
  oldEndLine?: number;
  newStartLine?: number;
  newEndLine?: number;
  /**
   * The exact working-tree lines the host rendered for this hunk (the reviewed
   * source). Inline edits replace `newLines`; this field is left untouched so the
   * host can verify the live document still holds what the user reviewed before
   * it writes anything (issue 119).
   */
  reviewedNewLines?: string[];
}

export interface SemanticReviewActionTarget extends ReviewActionTarget {
  kind: SemanticReviewActionKind;
  startLine: number;
  endLine: number;
  side: "base" | "modified";
  previewLabel: string;
}

export interface SemanticReviewActionTargetResult {
  target?: SemanticReviewActionTarget;
  error?: string;
}

export interface SemanticReviewHunkEdit {
  target: SemanticReviewActionTarget;
  relativePath: string;
  editStartLine: number;
  editEndLine: number;
  replacementLines: string[];
  replacementText: string;
  /**
   * Working-tree lines that must still be present, byte-for-byte, at
   * `editStartLine..editEndLine` before the edit may be written. Undefined means
   * the action carries no reviewed source and must not mutate the document.
   */
  expectedLines?: string[];
  previewPatch: string;
  indexPatch?: string;
}

export interface SemanticReviewHunkEditResult {
  edit?: SemanticReviewHunkEdit;
  error?: string;
}

export function reviewActionTargetForPayload(
  payload: ReviewActionPayloadLike | undefined,
  folderFsPath: (folderUri: string) => string,
): ReviewActionTargetResult {
  if (!payload?.folderUri || !payload.relativePath) {
    return {};
  }
  try {
    assertSafeRelativePath(payload.relativePath);
    return {
      target: {
        fsPath: path.join(folderFsPath(payload.folderUri), payload.relativePath),
      },
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function semanticReviewActionTargetForPayload(
  payload: SemanticReviewActionPayloadLike | undefined,
  folderFsPath: (folderUri: string) => string,
): SemanticReviewActionTargetResult {
  const fileTarget = reviewActionTargetForPayload(payload, folderFsPath);
  if (fileTarget.error || !fileTarget.target) {
    return fileTarget.error ? { error: fileTarget.error } : {};
  }
  const kind = payload?.actionKind;
  if (!kind) {
    return { error: "missing semantic review action kind" };
  }
  const change = payload?.change;
  if (!change) {
    return { error: "missing semantic review change" };
  }
  const side = semanticActionSide(kind, change);
  const position = side === "base" ? change.old_node?.position : change.new_node?.position;
  const range = semanticActionRange(position);
  if (!range) {
    return { error: "semantic review action has no concrete line range" };
  }
  return {
    target: {
      ...fileTarget.target,
      kind,
      side,
      startLine: range.startLine,
      endLine: range.endLine,
      previewLabel: semanticActionPreviewLabel(kind, change),
    },
  };
}

export function semanticReviewHunkEditForPayload(
  payload: SemanticReviewActionPayloadLike | undefined,
  folderFsPath: (folderUri: string) => string,
): SemanticReviewHunkEditResult {
  const targetResult = semanticReviewActionTargetForPayload(payload, folderFsPath);
  if (!targetResult.target) {
    return targetResult.error ? { error: targetResult.error } : {};
  }
  const hunk = payload?.hunk;
  if (!hunk) {
    return { error: "semantic review hunk action has no hunk text" };
  }
  const oldLines = concreteLines(hunk.oldLines);
  const newLines = concreteLines(hunk.newLines);
  const modifiedRange = semanticModifiedEditRange(payload.actionKind, hunk);
  if (!modifiedRange) {
    return { error: "semantic review hunk action has no modified-side edit range" };
  }
  const replacementLines = splitEditedLines(payload.actionKind === "revertHunk" ? oldLines : newLines);
  const reviewedNewLines = Array.isArray(hunk.reviewedNewLines) ? concreteLines(hunk.reviewedNewLines) : undefined;
  // Revert replaces the rendered working lines, so the rendered lines are the
  // precondition. Apply writes user-edited lines, so only the untouched reviewed
  // copy can serve as the precondition.
  const expectedLines = payload.actionKind === "revertHunk" ? (reviewedNewLines ?? newLines) : reviewedNewLines;
  if (payload.actionKind === "revertHunk" && oldLines.length === 0) {
    return { error: "semantic review hunk revert has no base-side lines" };
  }
  if ((payload.actionKind === "applyHunk" || payload.actionKind === "stageHunk") && newLines.length === 0) {
    return { error: "semantic review hunk apply has no modified-side lines" };
  }
  const edit: SemanticReviewHunkEdit = {
    target: targetResult.target,
    relativePath: payload?.relativePath ?? "",
    editStartLine: modifiedRange.startLine,
    editEndLine: modifiedRange.endLine,
    replacementLines,
    replacementText: replacementLines.join("\n"),
    expectedLines,
    previewPatch: semanticHunkPreviewPatch(
      targetResult.target.fsPath,
      payload.actionKind,
      modifiedRange.startLine,
      modifiedRange.endLine,
      oldLines,
      newLines,
      replacementLines,
    ),
    indexPatch: payload.actionKind === "stageHunk"
      ? semanticHunkIndexPatch(payload.relativePath ?? "", hunk, oldLines, newLines)
      : undefined,
  };
  return { edit };
}

function semanticActionSide(
  kind: SemanticReviewActionKind,
  change: SemanticChange,
): "base" | "modified" {
  if (kind === "revertHunk" && change.old_node?.position) {
    return "base";
  }
  return "modified";
}

function semanticActionRange(position: NodePosition | null | undefined): { startLine: number; endLine: number } | undefined {
  if (!position) {
    return undefined;
  }
  const startLine = Math.max(0, Math.floor(position.start_line));
  const endLine = Math.max(startLine, Math.floor(position.end_line));
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return undefined;
  }
  return { startLine, endLine };
}

function semanticModifiedEditRange(
  kind: SemanticReviewActionKind | undefined,
  hunk: SemanticReviewHunkPayloadLike,
): { startLine: number; endLine: number } | undefined {
  const startLine = finiteLine(hunk.newStartLine);
  const endLine = finiteLine(hunk.newEndLine);
  if (startLine !== undefined && endLine !== undefined) {
    return { startLine, endLine: Math.max(startLine, endLine) };
  }
  if (kind === "applyHunk" && hunk.newLines?.length) {
    return { startLine: 1, endLine: hunk.newLines.length };
  }
  return undefined;
}

function finiteLine(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Inline edits can carry embedded line breaks (multiline paste, Enter in a
 * cell). Split them into document lines; the host re-joins with the document's
 * own EOL so CRLF files stay CRLF.
 */
function splitEditedLines(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(/\r\n|\n/u));
}

export interface HunkDocumentLines {
  /**
   * Document lines without terminators, as `TextDocument.lineAt(i).text` reports
   * them: a document ending in an EOL has a trailing empty entry.
   */
  lines: string[];
  eol: "\n" | "\r\n";
}

export interface PlannedHunkTextEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

export interface PlannedHunkTextEditResult {
  edit?: PlannedHunkTextEdit;
  error?: string;
}

/**
 * Verify a hunk edit against the live document and plan the exact text edit.
 *
 * The working-tree range must still contain the reviewed lines byte-for-byte;
 * otherwise the action is stale (the file changed after the panel rendered) and
 * nothing is written. The planned edit keeps the document's EOL style and its
 * final-newline state.
 */
export function planVerifiedHunkTextEdit(
  document: HunkDocumentLines,
  hunkEdit: Pick<SemanticReviewHunkEdit, "editStartLine" | "editEndLine" | "expectedLines" | "replacementLines">,
): PlannedHunkTextEditResult {
  const expected = hunkEdit.expectedLines;
  if (!expected) {
    return { error: "the hunk carries no reviewed source to verify against; refresh the review and retry" };
  }
  const start = hunkEdit.editStartLine - 1;
  const endExclusive = hunkEdit.editEndLine;
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || start < 0 || endExclusive <= start) {
    return { error: "the hunk has an invalid working-tree range" };
  }
  if (expected.length !== endExclusive - start) {
    return { error: "the hunk's reviewed lines do not match its working-tree range" };
  }
  const lines = document.lines;
  const hasFinalEol = lines.length > 0 && lines[lines.length - 1] === "";
  const contentLineCount = hasFinalEol ? lines.length - 1 : lines.length;
  if (endExclusive > contentLineCount) {
    return { error: "the file changed since it was reviewed (hunk range is past the end of the file); refresh the review" };
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (lines[start + index] !== expected[index]) {
      return { error: `the file changed since it was reviewed (line ${start + index + 1} differs); refresh the review` };
    }
  }
  const replacement = hunkEdit.replacementLines;
  const eol = document.eol;
  if (endExclusive < lines.length) {
    // Line `endExclusive` exists (possibly the empty final-EOL entry), so every
    // replaced line was followed by an EOL: replace whole lines including it.
    return {
      edit: {
        startLine: start,
        startCharacter: 0,
        endLine: endExclusive,
        endCharacter: 0,
        text: replacement.map((line) => `${line}${eol}`).join(""),
      },
    };
  }
  // The range runs through the last line, which has no EOL: never add one.
  const lastIndex = endExclusive - 1;
  if (replacement.length === 0 && start > 0) {
    return {
      edit: {
        startLine: start - 1,
        startCharacter: lines[start - 1].length,
        endLine: lastIndex,
        endCharacter: lines[lastIndex].length,
        text: "",
      },
    };
  }
  return {
    edit: {
      startLine: start,
      startCharacter: 0,
      endLine: lastIndex,
      endCharacter: lines[lastIndex].length,
      text: replacement.join(eol),
    },
  };
}

function concreteLines(lines: string[] | undefined): string[] {
  return Array.isArray(lines) ? lines.map((line) => String(line)) : [];
}

function semanticHunkPreviewPatch(
  fsPath: string,
  kind: SemanticReviewActionKind | undefined,
  startLine: number,
  endLine: number,
  oldLines: string[],
  newLines: string[],
  replacementLines: string[],
): string {
  const header = [
    `IntentumDiff semantic hunk ${kind ?? "action"}`,
    `file ${fsPath}`,
    `working lines ${startLine}-${endLine}`,
  ];
  const before = oldLines.length > 0 ? oldLines.map((line) => `- ${line}`) : ["- <empty>"];
  const afterSource = kind === "revertHunk" ? replacementLines : newLines;
  const after = afterSource.length > 0 ? afterSource.map((line) => `+ ${line}`) : ["+ <empty>"];
  return [...header, ...before, ...after].join("\n");
}

export function semanticHunkIndexPatch(
  relativePath: string,
  hunk: SemanticReviewHunkPayloadLike,
  oldLines: string[],
  newLines: string[],
): string | undefined {
  try {
    assertSafeRelativePath(relativePath);
  } catch {
    return undefined;
  }
  const oldStart = finiteLine(hunk.oldStartLine)
    ?? Math.max(1, (finiteLine(hunk.newStartLine) ?? 1) - (oldLines.length === 0 ? 1 : 0));
  const newStart = finiteLine(hunk.newStartLine) ?? oldStart;
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  ];
  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return [...header, ...body, ""].join("\n");
}

function semanticActionPreviewLabel(kind: SemanticReviewActionKind, change: SemanticChange): string {
  const label = change.new_node?.label || change.old_node?.label || change.description || "semantic hunk";
  if (kind === "stageHunk") {
    return `Stage semantic hunk: ${label}`;
  }
  if (kind === "revertHunk") {
    return `Revert semantic hunk: ${label}`;
  }
  return `Apply semantic hunk: ${label}`;
}
