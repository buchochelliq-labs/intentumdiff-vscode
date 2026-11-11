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
  /**
   * Zero-length-side anchors (issue 125): the number of lines on each side that
   * precede the hunk. A pure insertion has no old lines, a pure deletion no new
   * lines; the anchor says where that empty side sits (0 = beginning of file),
   * which is distinct from an unavailable range.
   */
  oldLinesBefore?: number;
  newLinesBefore?: number;
  /**
   * Unchanged lines immediately around the hunk (identical on both sides). They
   * anchor and verify zero-length edits in the working tree and give index
   * patches real context so `git apply --cached` validates against the index.
   */
  contextBefore?: string[];
  contextAfter?: string[];
  /**
   * The side's last line is inside the hunk or its context and has no final
   * newline (`\ No newline at end of file` in a patch).
   */
  oldMissingFinalNewline?: boolean;
  newMissingFinalNewline?: boolean;
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
  /** For an insertion into an empty document: false when the text must not end with an EOL. */
  replacementFinalNewline?: boolean;
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
  const preferred = semanticActionSide(kind, change);
  // A zero-length side (pure insertion/deletion) has no node position of its
  // own; anchor on the other side's node instead of reporting no range.
  const preferredPosition = preferred === "base" ? change.old_node?.position : change.new_node?.position;
  const side = preferredPosition ? preferred : preferred === "base" ? "modified" : "base";
  const position = preferredPosition ?? (side === "base" ? change.old_node?.position : change.new_node?.position);
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
  const kind = payload.actionKind;
  if (kind === "applyHunk" && newLines.length === 0) {
    return { error: "semantic review hunk apply has no modified-side lines" };
  }
  const modifiedRange = semanticModifiedEditRange(kind, hunk, newLines.length);
  if (!modifiedRange) {
    return { error: "semantic review hunk action has no modified-side edit range" };
  }
  const reviewedNewLines = Array.isArray(hunk.reviewedNewLines) ? concreteLines(hunk.reviewedNewLines) : undefined;
  let editStartLine = modifiedRange.startLine;
  let editEndLine = modifiedRange.endLine;
  let replacementLines = splitEditedLines(kind === "revertHunk" ? oldLines : newLines);
  // Revert replaces the rendered working lines, so the rendered lines are the
  // precondition. Apply writes user-edited lines, so only the untouched reviewed
  // copy can serve as the precondition.
  let expectedLines = kind === "revertHunk" ? (reviewedNewLines ?? newLines) : reviewedNewLines;
  if (kind === "revertHunk" && newLines.length === 0) {
    // Reverting a pure deletion re-inserts the base lines at the anchor. An empty
    // range verifies nothing, so widen it to the unchanged neighbours, which the
    // live document must still hold byte-for-byte.
    const before = concreteLines(hunk.contextBefore);
    const after = concreteLines(hunk.contextAfter);
    editStartLine = modifiedRange.startLine - before.length;
    editEndLine = modifiedRange.endLine + after.length;
    replacementLines = [...before, ...replacementLines, ...after];
    expectedLines = [...before, ...after];
  }
  const edit: SemanticReviewHunkEdit = {
    target: targetResult.target,
    relativePath: payload?.relativePath ?? "",
    editStartLine,
    editEndLine,
    replacementLines,
    replacementText: replacementLines.join("\n"),
    expectedLines,
    replacementFinalNewline: kind === "revertHunk" ? hunk.oldMissingFinalNewline !== true : hunk.newMissingFinalNewline !== true,
    previewPatch: semanticHunkPreviewPatch(
      targetResult.target.fsPath,
      kind,
      editStartLine,
      editEndLine,
      oldLines,
      newLines,
      replacementLines,
    ),
    indexPatch: kind === "stageHunk"
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

/**
 * The 1-based working-tree line range a hunk edits. A zero-length modified side
 * (pure deletion) is an EMPTY range `{ startLine: n + 1, endLine: n }` at its
 * anchor `n` (`newLinesBefore`), not a missing one.
 */
function semanticModifiedEditRange(
  kind: SemanticReviewActionKind | undefined,
  hunk: SemanticReviewHunkPayloadLike,
  newLineCount: number,
): { startLine: number; endLine: number } | undefined {
  if (newLineCount === 0) {
    const anchor = linesBefore(hunk.newLinesBefore);
    return anchor === undefined ? undefined : { startLine: anchor + 1, endLine: anchor };
  }
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

function linesBefore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
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
  hunkEdit: Pick<SemanticReviewHunkEdit, "editStartLine" | "editEndLine" | "expectedLines" | "replacementLines" | "replacementFinalNewline">,
): PlannedHunkTextEditResult {
  const expected = hunkEdit.expectedLines;
  if (!expected) {
    return { error: "the hunk carries no reviewed source to verify against; refresh the review and retry" };
  }
  const start = hunkEdit.editStartLine - 1;
  const endExclusive = hunkEdit.editEndLine;
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || start < 0 || endExclusive < start) {
    return { error: "the hunk has an invalid working-tree range" };
  }
  if (expected.length !== endExclusive - start) {
    return { error: "the hunk's reviewed lines do not match its working-tree range" };
  }
  const lines = document.lines;
  const hasFinalEol = lines.length > 0 && lines[lines.length - 1] === "";
  const contentLineCount = hasFinalEol ? lines.length - 1 : lines.length;
  if (endExclusive === start) {
    // An empty range has no reviewed neighbours to verify; it is only safe in a
    // document that is still exactly as empty as it was reviewed.
    if (start !== 0 || contentLineCount !== 0) {
      return { error: "the hunk's insertion point cannot be verified against the file; refresh the review" };
    }
    const replacement = hunkEdit.replacementLines;
    return {
      edit: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
        text: replacement.length === 0
          ? ""
          : replacement.join(document.eol) + (hunkEdit.replacementFinalNewline === false ? "" : document.eol),
      },
    };
  }
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
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  // Anchors: lines preceding the hunk on each side (0 = beginning of file).
  const oldBefore = linesBefore(hunk.oldLinesBefore)
    ?? (oldCount > 0 ? (finiteLine(hunk.oldStartLine) ?? 1) - 1 : undefined)
    ?? Math.max(0, (finiteLine(hunk.newStartLine) ?? 1) - 1);
  const newBefore = linesBefore(hunk.newLinesBefore)
    ?? (newCount > 0 ? (finiteLine(hunk.newStartLine) ?? oldBefore + 1) - 1 : oldBefore);
  const before = concreteLines(hunk.contextBefore).slice(-Math.min(oldBefore, newBefore));
  const after = concreteLines(hunk.contextAfter);
  const oldTotal = before.length + oldCount + after.length;
  const newTotal = before.length + newCount + after.length;
  // Unified-diff convention: an empty side's start is the line before it.
  const oldStart = oldTotal === 0 ? oldBefore : oldBefore - before.length + 1;
  const newStart = newTotal === 0 ? newBefore : newBefore - before.length + 1;
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldTotal} +${newStart},${newTotal} @@`,
  ];
  if (oldTotal === 0 && newTotal === 0) {
    return undefined;
  }
  const noEol = "\\ No newline at end of file";
  const oldNoEol = hunk.oldMissingFinalNewline === true;
  const newNoEol = hunk.newMissingFinalNewline === true;
  const body = [
    ...before.map((line) => ` ${line}`),
    ...oldLines.map((line) => `-${line}`),
  ];
  // A side's last line without a final newline is followed by the marker; when
  // context follows the hunk the shared last line carries it for both sides.
  if (after.length === 0 && oldNoEol && oldLines.length > 0) body.push(noEol);
  body.push(...newLines.map((line) => `+${line}`));
  if (after.length === 0 && newNoEol && newLines.length > 0) body.push(noEol);
  body.push(...after.map((line) => ` ${line}`));
  if (after.length > 0 && (oldNoEol || newNoEol)) body.push(noEol);
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
