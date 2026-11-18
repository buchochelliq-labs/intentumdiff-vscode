// Diff-row construction, collapsing, minimap, hunks, and scope trails for the review panel.

import { actionButton, escapeHtml, isRecord } from "./reviewWebviewHtml";
import type { ReviewDiffRow, ReviewWebviewHunkPayload, ReviewWebviewPayload } from "./reviewWebviewModel";
import type { NodePosition, SemanticChange, SemanticDiff, SemanticNode } from "./types";

export interface DiffStats {
  insert: number;
  delete: number;
  change: number;
  semantic: number;
}


export function diffRow(row: ReviewDiffRow, hunkId = "", sourceFallback = false): string {
  if (row.kind === "collapsed") {
    return collapsedDiffRow(row);
  }
  const semantic = row.semantic ? " semantic" : "";
  const intent = row.intent ? ` intent-${row.intent}` : "";
  const oldMissing = row.oldText === undefined;
  const newMissing = row.newText === undefined;
  // Working-tree cells inside a semantic hunk are directly editable; edits are
  // collected per hunk and applied via the git hunk-apply flow. The cell's DOM
  // carries decorative Unicode markers, so the exact source travels separately
  // in data-source (JSON, so control characters survive HTML parsing) and the
  // script serializes that, never the decorated textContent (issue 120).
  const editable = hunkId && !newMissing
    ? ` contenteditable="plaintext-only" spellcheck="false" data-hunk-edit-cell data-hunk-id="${escapeHtml(hunkId)}" data-source="${escapeHtml(JSON.stringify(row.newText ?? ""))}"`
    : "";
  return `<div id="${escapeHtml(row.id ?? "")}" class="diff-row diff-${row.kind}${semantic}${intent}" data-row-kind="${escapeHtml(row.kind)}"${row.semantic ? " data-semantic=\"true\"" : ""}${row.intent ? ` data-intent="${escapeHtml(row.intent)}"` : ""} title="${sourceFallback ? "Source evidence line; semantic equivalence unknown" : row.intent === "refactoring" ? "Refactoring evidence line" : row.semantic ? "Semantic evidence line" : ""}">
    <span class="diff-marker">${row.semantic ? `<span class="semantic-token">i</span>` : escapeHtml(rowMarker(row))}</span>
    <span class="line-no">${row.oldLine ?? ""}</span>
    <code class="${oldMissing ? "empty-code" : "old-code"}">${oldMissing ? `<span class="empty-label">inserted</span>` : renderCodeText(row.oldText)}</code>
    <span class="diff-link-gutter" aria-hidden="true"><span class="diff-link-line"></span></span>
    <span class="line-no">${row.newLine ?? ""}</span>
    <code class="${newMissing ? "empty-code" : "new-code"}"${editable}>${newMissing ? `<span class="empty-label">deleted</span>` : renderCodeText(row.newText)}</code>
  </div>`;
}

export function renderCodeText(text: string | undefined): string {
  if (text === undefined) {
    return "";
  }
  let result = "";
  for (const char of text) {
    const marker = unicodeMarker(char);
    result += marker ?? escapeHtml(char);
  }
  return result;
}

export function unicodeMarker(char: string): string | undefined {
  const code = char.codePointAt(0);
  if (code === undefined) {
    return undefined;
  }
  const labels: Record<number, string> = {
    0x00a0: "NBSP",
    0x200b: "ZERO WIDTH SPACE",
    0x200c: "ZERO WIDTH NON-JOINER",
    0x200d: "ZERO WIDTH JOINER",
    0x2066: "LEFT-TO-RIGHT ISOLATE",
    0x2067: "RIGHT-TO-LEFT ISOLATE",
    0x2068: "FIRST STRONG ISOLATE",
    0x2069: "POP DIRECTIONAL ISOLATE",
    0xfeff: "ZERO WIDTH NO-BREAK SPACE",
  };
  const isHidden = labels[code] !== undefined || (code < 32 && char !== "\t");
  if (!isHidden) {
    return undefined;
  }
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const label = labels[code] ?? "CONTROL";
  return `<span class="unicode-marker" title="${escapeHtml(`${hex} ${label}`)}" aria-label="${escapeHtml(`${hex} ${label}`)}">${escapeHtml(hex)}</span>`;
}

export function collapsedDiffRow(row: ReviewDiffRow): string {
  const blockId = escapeHtml(row.id ?? "");
  const hiddenRows = row.hiddenRows ?? [];
  const count = hiddenRows.length;
  const label = row.collapseReason === "context"
    ? `${count} unchanged context ${count === 1 ? "line" : "lines"} hidden`
    : `${count} blank ${hiddenChangeLabel(hiddenRows)} ${count === 1 ? "line" : "lines"} hidden`;
  return `<div id="${blockId}" class="diff-row diff-collapsed" data-collapse-block="${blockId}" data-collapse-open="false">
    <span class="diff-marker">⋯</span>
    <span class="line-no">${escapeHtml(lineRangeLabel(hiddenRows, "old"))}</span>
    <code class="collapsed-code">${escapeHtml(row.collapseReason === "context" ? "context hidden" : "blank lines hidden")}</code>
    <span class="diff-link-gutter collapse-gutter">
      <button class="collapse-toggle" type="button" data-collapse-toggle="${blockId}" data-count="${count}" aria-expanded="false" title="${escapeHtml(`Expand ${label}`)}">+ ${count}</button>
    </span>
    <span class="line-no">${escapeHtml(lineRangeLabel(hiddenRows, "new"))}</span>
    <code class="collapsed-code collapsed-summary">${escapeHtml(label)}</code>
  </div><div class="collapsed-lines" data-collapse-content="${blockId}" hidden>
    ${hiddenRows.map((hidden) => diffRow(hidden)).join("")}
  </div>`;
}

export function diffRows(rows: ReviewDiffRow[], payload?: ReviewWebviewPayload, sourceFallback = false): string {
  let result = "";
  let inHunk = false;
  let hunkId = "";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const important = row.kind !== "equal" && row.kind !== "collapsed" || row.semantic === true;
    if (important && !inHunk) {
      hunkId = `hunk-${index}`;
      result += hunkHeader(rows, index, payload, hunkId, sourceFallback);
      inHunk = true;
    }
    if (!important) {
      inHunk = false;
      hunkId = "";
    }
    result += diffRow(row, inHunk ? hunkId : "", sourceFallback);
  }
  return result;
}

export function hunkHeader(rows: ReviewDiffRow[], startIndex: number, payload: ReviewWebviewPayload | undefined, hunkId: string, sourceFallback = false): string {
  let count = 0;
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "equal" && row.semantic !== true) {
      break;
    }
    count += 1;
  }
  const row = rows[startIndex];
  const oldLabel = row.oldLine === undefined ? "base -" : `base L${row.oldLine}`;
  const newLabel = row.newLine === undefined ? "working -" : `working L${row.newLine}`;
  const scopeTrail = hunkScopeTrail(rows, startIndex);
  const actions = payload ? hunkActionButtons(payload, row, rows.slice(startIndex, startIndex + count), hunkId, { rows, start: startIndex }) : "";
  return `<div class="diff-hunk">
    <span class="hunk-glyph">${sourceFallback ? "source" : "intent"}</span>
    <span class="hunk-title"><strong>${sourceFallback ? "Source" : "Semantic"} hunk</strong><small>${escapeHtml(oldLabel)} -> ${escapeHtml(newLabel)}</small>${scopeTrailHtml(scopeTrail, row.id)}</span>
    <span class="hunk-connector" aria-hidden="true"></span>
    <span class="hunk-count">${count} evidence ${count === 1 ? "line" : "lines"}</span>
    ${actions}
  </div>`;
}

export function hunkActionButtons(
  payload: ReviewWebviewPayload,
  row: ReviewDiffRow,
  hunkRows: ReviewDiffRow[],
  hunkId: string,
  surrounding?: { rows: ReviewDiffRow[]; start: number },
): string {
  const change = hunkSyntheticChange(row, hunkRows);
  const hunk = surrounding
    ? hunkTextPayloadAt(surrounding.rows, surrounding.start, surrounding.start + hunkRows.length)
    : hunkTextPayload(hunkRows);
  const hunkPayload = { ...payload, change, hunk };
  // "Apply edits" is disabled until a working cell in this hunk is edited; on
  // click the script collects the hunk's contenteditable cells into newLines and
  // routes through the git hunk-apply flow (editHunk → applyHunk).
  const applyEdits = `<button class="action accept hunk-apply-btn" type="button" data-command="editHunk" data-hunk-id="${escapeHtml(hunkId)}" data-payload="${escapeHtml(JSON.stringify({ ...hunkPayload, actionKind: "applyHunk" }))}" disabled title="Apply your inline edits to the working tree"><span>Apply edits</span></button>`;
  // "Edit in native" opens VS Code's native diff editor at this hunk's line for
  // free-form live editing (add/remove lines) with the engine recomputing intent
  // as you type — the recommended live-edit surface.
  const hunkNewLine = hunkRows.find((item) => item.newLine !== undefined)?.newLine ?? row.newLine;
  const nativeLine = hunkNewLine !== undefined ? Math.max(hunkNewLine - 1, 0) : undefined;
  const editInNativePayload: ReviewWebviewPayload = {
    folderUri: payload.folderUri,
    relativePath: payload.relativePath,
    positionSide: "modified",
    ...(nativeLine !== undefined
      ? { position: { start_line: nativeLine, start_col: 0, end_line: nativeLine, end_col: 0 } }
      : {}),
  };
  return `<span class="hunk-actions" aria-label="Hunk actions">
    ${actionButton("Edit in native", "openNativeDiff", editInNativePayload, "native")}
    ${actionButton("Stage hunk", "stageHunk", { ...hunkPayload, actionKind: "stageHunk" }, "accept")}
    ${actionButton("Revert hunk", "revertHunk", { ...hunkPayload, actionKind: "revertHunk" }, "risk")}
    ${actionButton("Preview apply", "previewHunk", { ...hunkPayload, actionKind: "applyHunk" }, "detail")}
    ${applyEdits}
  </span>`;
}

export function hunkTextPayload(hunkRows: ReviewDiffRow[]): ReviewWebviewHunkPayload {
  const oldRows = hunkRows.filter((item) => item.oldLine !== undefined);
  const newRows = hunkRows.filter((item) => item.newLine !== undefined);
  const oldLines = oldRows.map((item) => item.oldText ?? "");
  const newLines = newRows.map((item) => item.newText ?? "");
  const oldNumbers = oldRows.map((item) => item.oldLine as number);
  const newNumbers = newRows.map((item) => item.newLine as number);
  return {
    oldLines,
    newLines,
    // Exact reviewed working-tree lines; the host verifies the live document
    // against these before any write (issue 119).
    reviewedNewLines: [...newLines],
    oldStartLine: minLine(oldNumbers),
    oldEndLine: maxLine(oldNumbers),
    newStartLine: minLine(newNumbers),
    newEndLine: maxLine(newNumbers),
  };
}

/** Unchanged lines of context recorded around a hunk for anchoring/verification. */
export const HUNK_CONTEXT_LINES = 3;

/**
 * Hunk payload for `rows[start, end)` with explicit zero-length-side anchors
 * (issue 125): `oldLinesBefore`/`newLinesBefore` count the lines preceding the
 * hunk on each side (0 = beginning of file), and up to HUNK_CONTEXT_LINES
 * unchanged neighbours on each side are recorded as context.
 */
export function hunkTextPayloadAt(rows: ReviewDiffRow[], start: number, end: number): ReviewWebviewHunkPayload {
  const flat: ReviewDiffRow[] = [];
  let flatStart = 0;
  let flatEnd = 0;
  rows.forEach((row, index) => {
    if (index === start) flatStart = flat.length;
    if (index === end) flatEnd = flat.length;
    if (row.kind === "collapsed") {
      flat.push(...(row.hiddenRows ?? []));
    } else {
      flat.push(row);
    }
  });
  if (end >= rows.length) flatEnd = flat.length;
  // splitLines() turns a final EOL into a trailing empty "line" on that side.
  // It is not a file line: strip it from the hunk and context, and record
  // instead whether the side ends WITHOUT a final newline.
  const oldMax = Math.max(0, ...flat.map((row) => row.oldLine ?? 0));
  const newMax = Math.max(0, ...flat.map((row) => row.newLine ?? 0));
  const oldEolLine = flat.some((row) => row.oldLine === oldMax && row.oldText === "") ? oldMax : undefined;
  const newEolLine = flat.some((row) => row.newLine === newMax && row.newText === "") ? newMax : undefined;
  const isEolArtifact = (row: ReviewDiffRow) =>
    (row.oldLine === undefined || row.oldLine === oldEolLine)
    && (row.newLine === undefined || row.newLine === newEolLine);
  const hunkRows = flat.slice(flatStart, flatEnd).map((row) => ({
    ...row,
    oldLine: row.oldLine === oldEolLine ? undefined : row.oldLine,
    newLine: row.newLine === newEolLine ? undefined : row.newLine,
  }));
  const hunk = hunkTextPayload(hunkRows);
  let oldLinesBefore = 0;
  let newLinesBefore = 0;
  for (let index = flatStart - 1; index >= 0; index -= 1) {
    if (oldLinesBefore === 0 && flat[index].oldLine !== undefined) oldLinesBefore = flat[index].oldLine as number;
    if (newLinesBefore === 0 && flat[index].newLine !== undefined) newLinesBefore = flat[index].newLine as number;
    if (oldLinesBefore !== 0 && newLinesBefore !== 0) break;
  }
  const contextBefore: string[] = [];
  for (let index = flatStart - 1; index >= 0 && contextBefore.length < HUNK_CONTEXT_LINES; index -= 1) {
    const row = flat[index];
    if (row.kind !== "equal" || row.oldText !== row.newText) break;
    contextBefore.unshift(row.newText ?? "");
  }
  const contextAfter: string[] = [];
  for (let index = flatEnd; index < flat.length && contextAfter.length < HUNK_CONTEXT_LINES; index += 1) {
    const row = flat[index];
    if (row.kind !== "equal" || row.oldText !== row.newText || isEolArtifact(row)) break;
    contextAfter.push(row.newText ?? "");
  }
  const oldLastReal = oldEolLine === undefined ? oldMax : oldMax - 1;
  const newLastReal = newEolLine === undefined ? newMax : newMax - 1;
  const oldReachesEnd = oldLinesBefore + hunk.oldLines.length + contextAfter.length === oldLastReal;
  const newReachesEnd = newLinesBefore + hunk.newLines.length + contextAfter.length === newLastReal;
  return {
    ...hunk,
    oldLinesBefore,
    newLinesBefore,
    contextBefore,
    contextAfter,
    oldMissingFinalNewline: oldLastReal > 0 && oldEolLine === undefined && oldReachesEnd,
    newMissingFinalNewline: newLastReal > 0 && newEolLine === undefined && newReachesEnd,
  };
}

export function minLine(lines: number[]): number | undefined {
  return lines.length === 0 ? undefined : Math.min(...lines);
}

export function maxLine(lines: number[]): number | undefined {
  return lines.length === 0 ? undefined : Math.max(...lines);
}

export function hunkSyntheticChange(row: ReviewDiffRow, hunkRows: ReviewDiffRow[]): SemanticChange {
  const oldLines = hunkRows.filter((item) => item.oldLine !== undefined).map((item) => item.oldLine as number);
  const newLines = hunkRows.filter((item) => item.newLine !== undefined).map((item) => item.newLine as number);
  const oldPosition = lineRangePosition(oldLines);
  const newPosition = lineRangePosition(newLines);
  return {
    change_type: row.kind === "delete" ? "DELETION" : row.kind === "insert" ? "ADDITION" : "MODIFICATION",
    description: "Semantic hunk",
    old_node: oldPosition ? { label: "Semantic hunk", position: oldPosition } : null,
    new_node: newPosition ? { label: "Semantic hunk", position: newPosition } : null,
  };
}

export function lineRangePosition(lines: number[]): NodePosition | null {
  if (lines.length === 0) {
    return null;
  }
  const start = Math.min(...lines);
  const end = Math.max(...lines);
  return {
    start_line: start,
    start_col: 0,
    end_line: end,
    end_col: 0,
  };
}

export function hunkScopeTrail(rows: ReviewDiffRow[], startIndex: number): string[] {
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "equal" && row.semantic !== true) {
      break;
    }
    if (row.scopeTrail?.length) {
      return row.scopeTrail;
    }
  }
  return [];
}

export function scopeTrailHtml(scopeTrail: string[], targetId: string | undefined): string {
  if (scopeTrail.length === 0) {
    return "";
  }
  const target = targetId ? ` data-target="${escapeHtml(targetId)}"` : "";
  return `<span class="scope-trail" aria-label="Semantic scope breadcrumb">${scopeTrail.map((scope, index) => `<button class="scope-chip" type="button"${target} data-scope-expand="${index}" title="Expand context for ${escapeHtml(scope)}">${escapeHtml(scope)}</button>`).join(`<span class="scope-separator" aria-hidden="true">›</span>`)}</span>`;
}

export function rowMarker(row: ReviewDiffRow): string {
  if (row.kind === "insert") {
    return "+";
  }
  if (row.kind === "delete") {
    return "-";
  }
  if (row.kind === "change") {
    return "~";
  }
  return row.semantic ? "i" : "";
}

export function diffMinimap(rows: ReviewDiffRow[]): string {
  const total = Math.max(rows.reduce((sum, row) => sum + minimapRowWeight(row), 0), 1);
  let offset = 0;
  const marks = rows
    .map((row) => {
      const weight = minimapRowWeight(row);
      const mark = minimapMark(row);
      const top = Math.round((offset / total) * 1000);
      const height = Math.max(Math.round((weight / total) * 1000), mark.semantic ? 8 : 5);
      offset += weight;
      const target = mark.targetId ? ` data-target="${escapeHtml(mark.targetId)}"` : "";
      const lane = minimapLane(mark);
      return `<button class="overview-hit overview-${mark.kind} overview-lane-${lane}${mark.collapsed ? " overview-collapsed" : ""}${mark.semantic ? " semantic" : ""}${mark.intent ? ` overview-${mark.intent}` : ""}" type="button"${target} style="--overview-top:${top / 10}%;--overview-height:${height / 10}%;" title="${escapeHtml(mark.title)}"><span class="overview-mark"></span></button>`;
    })
    .join("");
  return `<nav class="diff-minimap" aria-label="Diff overview ruler">
    <div class="overview-ruler-track" aria-hidden="true">
      <span class="overview-lane-guide overview-guide-left"></span>
      <span class="overview-lane-guide overview-guide-center"></span>
      <span class="overview-lane-guide overview-guide-right"></span>
      <span class="overview-viewport"></span>
      <span class="overview-active-marker"></span>
    </div>
    <div class="overview-lane">${marks}</div>
  </nav>`;
}

export function minimapRowWeight(row: ReviewDiffRow): number {
  return row.kind === "collapsed" ? Math.max(row.hiddenRows?.length ?? 1, 1) : 1;
}

export function minimapMark(row: ReviewDiffRow): {
  kind: Exclude<ReviewDiffRow["kind"], "collapsed">;
  semantic: boolean;
  intent?: ReviewDiffRow["intent"];
  targetId?: string;
  title: string;
  collapsed: boolean;
} {
  if (row.kind !== "collapsed") {
    return {
      kind: row.kind,
      semantic: row.semantic === true,
      intent: row.intent,
      targetId: row.id,
      title: row.intent === "refactoring" ? "refactoring" : row.kind,
      collapsed: false,
    };
  }
  const hiddenRows = row.hiddenRows ?? [];
  const kind = minimapHiddenKind(hiddenRows);
  const count = hiddenRows.length;
  return {
    kind,
    semantic: hiddenRows.some((hiddenRow) => hiddenRow.semantic === true),
    intent: hiddenRows.find((hiddenRow) => hiddenRow.intent)?.intent,
    targetId: row.id,
    title: row.collapseReason === "context"
      ? `${count} hidden context ${count === 1 ? "line" : "lines"}`
      : `${count} hidden blank ${hiddenChangeLabel(hiddenRows)} ${count === 1 ? "line" : "lines"}`,
    collapsed: true,
  };
}

export function minimapLane(mark: {
  kind: Exclude<ReviewDiffRow["kind"], "collapsed">;
  semantic: boolean;
  intent?: ReviewDiffRow["intent"];
}): "left" | "center" | "right" {
  if (mark.intent === "refactoring" || mark.semantic) {
    return "right";
  }
  if (mark.kind === "delete") {
    return "left";
  }
  if (mark.kind === "change") {
    return "center";
  }
  return "right";
}

export function minimapHiddenKind(rows: ReviewDiffRow[]): Exclude<ReviewDiffRow["kind"], "collapsed"> {
  const changedRows = rows.filter((row) => row.kind !== "equal" && row.kind !== "collapsed");
  if (!changedRows.length) {
    return "equal";
  }
  if (changedRows.every((row) => row.kind === "insert")) {
    return "insert";
  }
  if (changedRows.every((row) => row.kind === "delete")) {
    return "delete";
  }
  return "change";
}

export function hiddenChangeLabel(rows: ReviewDiffRow[]): string {
  if (rows.every((row) => row.kind === "insert")) {
    return "inserted";
  }
  if (rows.every((row) => row.kind === "delete")) {
    return "deleted";
  }
  return "changed";
}

export function lineRangeLabel(rows: ReviewDiffRow[], side: "old" | "new"): string {
  const lines = rows
    .map((row) => side === "old" ? row.oldLine : row.newLine)
    .filter((line): line is number => line !== undefined);
  if (!lines.length) {
    return "";
  }
  const first = Math.min(...lines);
  const last = Math.max(...lines);
  return first === last ? String(first) : `${first}-${last}`;
}

export function diffStats(rows: ReviewDiffRow[]): DiffStats {
  return rows.reduce<DiffStats>((stats, row) => {
    if (row.kind === "insert") {
      stats.insert += 1;
    } else if (row.kind === "delete") {
      stats.delete += 1;
    } else if (row.kind === "change") {
      stats.change += 1;
    }
    if (row.semantic) {
      stats.semantic += 1;
    }
    return stats;
  }, { insert: 0, delete: 0, change: 0, semantic: 0 });
}

export function buildDiffRows(
  oldText: string,
  newText: string,
  diff: SemanticDiff | undefined,
  contextLines = DEFAULT_DIFF_CONTEXT_LINES,
): ReviewDiffRow[] {
  return buildDiffRowsResult(oldText, newText, diff, contextLines).rows;
}

/** Rows plus whether the source alignment is precise (see `lineAlignment`). */
export function buildDiffRowsResult(
  oldText: string,
  newText: string,
  diff: SemanticDiff | undefined,
  contextLines = DEFAULT_DIFF_CONTEXT_LINES,
): { rows: ReviewDiffRow[]; exact: boolean } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const semanticOld = semanticLineSet(diff, "old");
  const semanticNew = semanticLineSet(diff, "new");
  const refactoringOld = refactoringLineSet(diff, "old");
  const refactoringNew = refactoringLineSet(diff, "new");
  const scopeOld = scopeTrailLineMap(diff, "old");
  const scopeNew = scopeTrailLineMap(diff, "new");
  const alignment = lineAlignment(oldLines, newLines);
  const operations = alignment.operations;
  const rows: ReviewDiffRow[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.type === "equal") {
      rows.push({
        kind: "equal",
        oldLine: operation.oldIndex + 1,
        newLine: operation.newIndex + 1,
        oldText: oldLines[operation.oldIndex],
        newText: newLines[operation.newIndex],
        semantic: semanticOld.has(operation.oldIndex) || semanticNew.has(operation.newIndex),
        intent: rowIntent(refactoringOld, operation.oldIndex, refactoringNew, operation.newIndex),
        scopeTrail: mergedScopeTrail(scopeOld.get(operation.oldIndex), scopeNew.get(operation.newIndex)),
      });
      continue;
    }
    if (operation.type === "delete") {
      const next = operations[index + 1];
      if (
        next?.type === "insert"
        && shouldPairChangedLines(oldLines[operation.oldIndex], newLines[next.newIndex])
      ) {
        rows.push({
          kind: "change",
          oldLine: operation.oldIndex + 1,
          newLine: next.newIndex + 1,
          oldText: oldLines[operation.oldIndex],
          newText: newLines[next.newIndex],
          semantic: semanticOld.has(operation.oldIndex) || semanticNew.has(next.newIndex),
          intent: rowIntent(refactoringOld, operation.oldIndex, refactoringNew, next.newIndex),
          scopeTrail: mergedScopeTrail(scopeOld.get(operation.oldIndex), scopeNew.get(next.newIndex)),
        });
        index += 1;
        continue;
      }
      rows.push({
        kind: "delete",
        oldLine: operation.oldIndex + 1,
        oldText: oldLines[operation.oldIndex],
        semantic: semanticOld.has(operation.oldIndex),
        intent: rowIntent(refactoringOld, operation.oldIndex),
        scopeTrail: scopeOld.get(operation.oldIndex),
      });
      continue;
    }
    rows.push({
      kind: "insert",
      newLine: operation.newIndex + 1,
      newText: newLines[operation.newIndex],
      semantic: semanticNew.has(operation.newIndex),
      intent: rowIntent(undefined, undefined, refactoringNew, operation.newIndex),
      scopeTrail: scopeNew.get(operation.newIndex),
    });
  }
  return {
    rows: collapseUninterestingRows(withRowIds(compactRows(rows)), contextLines),
    exact: alignment.exact,
  };
}

export function shouldPairChangedLines(oldText: string, newText: string): boolean {
  const oldTrimmed = oldText.trim();
  const newTrimmed = newText.trim();
  if (!oldTrimmed || !newTrimmed) {
    return false;
  }
  if (oldTrimmed === newTrimmed) {
    return true;
  }

  const tokens = (value: string): Set<string> =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []);
  const oldTokens = tokens(oldTrimmed);
  const newTokens = tokens(newTrimmed);
  if (oldTokens.size === 0 || newTokens.size === 0) {
    return false;
  }

  let shared = 0;
  for (const token of oldTokens) {
    if (newTokens.has(token)) {
      shared += 1;
    }
  }
  const union = new Set([...oldTokens, ...newTokens]).size;
  return shared > 0 && shared / union >= 0.25;
}

export type LineOperation =
  | { type: "equal"; oldIndex: number; newIndex: number }
  | { type: "delete"; oldIndex: number }
  | { type: "insert"; newIndex: number };

/** Cell budget for the exact LCS table (oldLines × newLines). */
export const LCS_CELL_BUDGET = 120_000;
/** Edit-distance budget for the bounded Myers fallback (memory ~ D² ints). */
export const MYERS_MAX_EDITS = 1_000;

export interface LineAlignment {
  operations: LineOperation[];
  /**
   * False when the lines could not be aligned within the budgets: the
   * operations are then a positional pairing that must not be presented as
   * precise source evidence (issue 127).
   */
  exact: boolean;
}

/**
 * Align two line arrays. Small inputs use the exact LCS table; larger ones
 * strip the common prefix/suffix and use the LCS table on the remainder when
 * it fits, else a bounded Myers O(ND) diff. Only when the edit distance itself
 * exceeds MYERS_MAX_EDITS is the result marked inexact.
 */
export function lineAlignment(oldLines: string[], newLines: string[]): LineAlignment {
  if (oldLines.length * newLines.length <= LCS_CELL_BUDGET) {
    return { operations: lcsOperations(oldLines, newLines), exact: true };
  }
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  let middle: LineOperation[] | undefined = oldMiddle.length * newMiddle.length <= LCS_CELL_BUDGET
    ? lcsOperations(oldMiddle, newMiddle)
    : myersOperations(oldMiddle, newMiddle, MYERS_MAX_EDITS);
  const exact = middle !== undefined;
  middle ??= positionalOperations(oldMiddle, newMiddle);
  const operations: LineOperation[] = [];
  for (let index = 0; index < prefix; index += 1) {
    operations.push({ type: "equal", oldIndex: index, newIndex: index });
  }
  for (const operation of middle) {
    if (operation.type === "equal") {
      operations.push({ type: "equal", oldIndex: operation.oldIndex + prefix, newIndex: operation.newIndex + prefix });
    } else if (operation.type === "delete") {
      operations.push({ type: "delete", oldIndex: operation.oldIndex + prefix });
    } else {
      operations.push({ type: "insert", newIndex: operation.newIndex + prefix });
    }
  }
  for (let index = 0; index < suffix; index += 1) {
    operations.push({
      type: "equal",
      oldIndex: oldLines.length - suffix + index,
      newIndex: newLines.length - suffix + index,
    });
  }
  return { operations, exact };
}

export function lineOperations(oldLines: string[], newLines: string[]): LineOperation[] {
  return lineAlignment(oldLines, newLines).operations;
}

/**
 * Myers' greedy O(ND) shortest edit script, keeping only the 2d+1 live
 * diagonals per step. Returns undefined when more than `maxEdits` edits are
 * needed. Within each changed run deletions precede insertions, matching the
 * LCS path so delete/insert pairs still render as changes.
 */
export function myersOperations(oldLines: string[], newLines: string[], maxEdits: number): LineOperation[] | undefined {
  const n = oldLines.length;
  const m = newLines.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(maxEdits, n + m); d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) {
      break;
    }
  }
  if (found < 0) {
    return undefined;
  }
  const reversed: LineOperation[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d - 1];
    const at = (k: number) => previous[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const midX = prevK === k + 1 ? prevX : prevX + 1;
    const midY = prevK === k + 1 ? prevY + 1 : prevY;
    while (x > midX && y > midY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: "equal", oldIndex: x, newIndex: y });
    }
    reversed.push(prevK === k + 1 ? { type: "insert", newIndex: prevY } : { type: "delete", oldIndex: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ type: "equal", oldIndex: x, newIndex: y });
  }
  const operations = reversed.reverse();
  // Stable reorder: deletions before insertions inside each changed run.
  const ordered: LineOperation[] = [];
  let run: LineOperation[] = [];
  const flush = () => {
    ordered.push(...run.filter((op) => op.type === "delete"), ...run.filter((op) => op.type === "insert"));
    run = [];
  };
  for (const operation of operations) {
    if (operation.type === "equal") {
      flush();
      ordered.push(operation);
    } else {
      run.push(operation);
    }
  }
  flush();
  return ordered;
}

function lcsOperations(oldLines: string[], newLines: string[]): LineOperation[] {
  const table = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const operations: LineOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ type: "equal", oldIndex, newIndex });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      operations.push({ type: "delete", oldIndex });
      oldIndex += 1;
    } else {
      operations.push({ type: "insert", newIndex });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    operations.push({ type: "delete", oldIndex });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    operations.push({ type: "insert", newIndex });
    newIndex += 1;
  }
  return operations;
}

export function positionalOperations(oldLines: string[], newLines: string[]): LineOperation[] {
  const operations: LineOperation[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    if (index < oldLines.length && index < newLines.length && oldLines[index] === newLines[index]) {
      operations.push({ type: "equal", oldIndex: index, newIndex: index });
    } else {
      if (index < oldLines.length) {
        operations.push({ type: "delete", oldIndex: index });
      }
      if (index < newLines.length) {
        operations.push({ type: "insert", newIndex: index });
      }
    }
  }
  return operations;
}

export function compactRows(rows: ReviewDiffRow[]): ReviewDiffRow[] {
  if (rows.length <= 220) {
    return rows;
  }
  // The last row always survives: it tells hunk payloads whether each side
  // ends with a final newline (see hunkTextPayloadAt).
  const important = new Set<number>([rows.length - 1]);
  rows.forEach((row, index) => {
    if (row.kind !== "equal" || row.semantic) {
      for (let offset = -3; offset <= 3; offset += 1) {
        important.add(index + offset);
      }
    }
  });
  return rows.filter((_, index) => important.has(index));
}

export function withRowIds(rows: ReviewDiffRow[]): ReviewDiffRow[] {
  return rows.map((row, index) => ({
    ...row,
    id: `row-${index}`,
  }));
}

// Collapse everything that isn't a semantic hunk (or its ±CONTEXT window) into
// expandable blocks, collapsed by default — mirroring VS Code's native
// hideUnchangedRegions but keyed on semantic importance so only the semantic
// hunks stay open. When a file has no semantic rows we fall back to the native
// behaviour (keep changed lines, collapse unchanged) so a purely non-semantic
// diff is not hidden wholesale. Blank runs always collapse.
export const DEFAULT_DIFF_CONTEXT_LINES = 1;
export const MIN_COLLAPSE_RUN = 2;

export function collapseUninterestingRows(rows: ReviewDiffRow[], contextLines = DEFAULT_DIFF_CONTEXT_LINES): ReviewDiffRow[] {
  const context = Math.max(0, Math.floor(contextLines));
  const hasSemantic = rows.some((row) => row.semantic === true);
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    const isAnchor = row.semantic === true
      || (!hasSemantic && row.kind !== "equal" && row.kind !== "collapsed" && !isBlankRow(row));
    if (!isAnchor) {
      return;
    }
    keep[index] = true;
    // Keep a few non-blank context lines around each anchor for readability.
    for (const direction of [-1, 1]) {
      let kept = 0;
      for (let step = 1; step <= rows.length && kept < context; step += 1) {
        const j = index + direction * step;
        if (j < 0 || j >= rows.length) {
          break;
        }
        if (isBlankRow(rows[j])) {
          continue;
        }
        keep[j] = true;
        kept += 1;
      }
    }
  });

  const result: ReviewDiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (keep[index]) {
      result.push(rows[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && !keep[end]) {
      end += 1;
    }
    const run = rows.slice(index, end);
    if (run.length >= MIN_COLLAPSE_RUN) {
      result.push(collapsedRow(run, run.every(isBlankChangedRow) ? "blank" : "context"));
    } else {
      result.push(...run);
    }
    index = end;
  }
  return result.map((row, index) => row.kind === "collapsed" ? { ...row, id: `collapse-${index}` } : row);
}

export function isBlankRow(row: ReviewDiffRow): boolean {
  const oldBlank = row.oldText === undefined || row.oldText.trim().length === 0;
  const newBlank = row.newText === undefined || row.newText.trim().length === 0;
  return oldBlank && newBlank;
}

export function collectRun(
  rows: ReviewDiffRow[],
  startIndex: number,
  predicate: (row: ReviewDiffRow) => boolean,
): ReviewDiffRow[] {
  const run: ReviewDiffRow[] = [];
  for (let index = startIndex; index < rows.length && predicate(rows[index]); index += 1) {
    run.push(rows[index]);
  }
  return run;
}

export function collapsedRow(
  hiddenRows: ReviewDiffRow[],
  collapseReason: "blank" | "context",
): ReviewDiffRow {
  return {
    kind: "collapsed",
    hiddenRows,
    collapseReason,
  };
}

export function isBlankChangedRow(row: ReviewDiffRow): boolean {
  if (row.kind === "equal" || row.kind === "collapsed" || row.intent) {
    return false;
  }
  const oldBlank = row.oldText === undefined || row.oldText.trim().length === 0;
  const newBlank = row.newText === undefined || row.newText.trim().length === 0;
  return oldBlank && newBlank;
}

export function isPlainContextRow(row: ReviewDiffRow): boolean {
  return row.kind === "equal" && row.semantic !== true && !row.intent;
}


export function scopeTrailLineMap(diff: SemanticDiff | undefined, side: "old" | "new"): Map<number, string[]> {
  const lines = new Map<number, string[]>();
  const add = (position: NodePosition | null | undefined, trail: string[]) => {
    if (!position || trail.length === 0) {
      return;
    }
    for (let line = position.start_line; line <= Math.max(position.start_line, position.end_line); line += 1) {
      lines.set(line, mergedScopeTrail(lines.get(line), trail));
    }
  };
  for (const [line, trail] of scopeTrailLineMapFromDiffMetadata(diff, side)) {
    lines.set(line, mergedScopeTrail(lines.get(line), trail));
  }
  for (const change of diff?.changes ?? []) {
    const node = side === "old" ? change.old_node : change.new_node;
    add(node?.position, scopeTrailForChange(change, side));
  }
  for (const group of diff?.change_groups ?? []) {
    const trail = scopeTrailFromMetadata(group.metadata);
    if (trail.length === 0) {
      continue;
    }
    for (const index of group.raw_change_indices ?? []) {
      const change = diff?.changes?.[index];
      const node = side === "old" ? change?.old_node : change?.new_node;
      add(node?.position, trail);
    }
  }
  return lines;
}

export function scopeTrailLineMapFromDiffMetadata(diff: SemanticDiff | undefined, side: "old" | "new"): Map<number, string[]> {
  const lines = new Map<number, string[]>();
  const scopeTrails = diff?.metadata?.scope_trails;
  if (!isRecord(scopeTrails)) {
    return lines;
  }
  const entries = scopeTrails[side];
  if (!Array.isArray(entries)) {
    return lines;
  }
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const line = typeof entry.line === "number" ? entry.line : Number.NaN;
    const trail = scopeTrailFromRaw(entry.trail);
    if (Number.isFinite(line) && trail.length > 0) {
      lines.set(line, mergedScopeTrail(lines.get(line), trail));
    }
  }
  return lines;
}

export function scopeTrailForChange(change: SemanticChange, side: "old" | "new"): string[] {
  const metadataTrail = scopeTrailFromMetadata((change as { metadata?: Record<string, unknown> }).metadata);
  if (metadataTrail.length > 0) {
    return metadataTrail;
  }
  const node = side === "old" ? change.old_node : change.new_node;
  return scopeTrailForNode(node);
}

export function scopeTrailFromMetadata(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }
  const raw = metadata.scope_trail ?? metadata.scopeTrail ?? metadata.scope_path ?? metadata.scopePath;
  return scopeTrailFromRaw(raw);
}

export function scopeTrailFromRaw(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean).slice(0, 5);
  }
  if (typeof raw === "string") {
    return raw.split(/[>/.]/u).map((item) => item.trim()).filter(Boolean).slice(0, 5);
  }
  return [];
}

export function scopeTrailForNode(node: SemanticNode | null | undefined): string[] {
  if (!node?.label) {
    return [];
  }
  const type = (node.node_type ?? "").toLowerCase();
  if (type.includes("class")) {
    return [`class ${node.label}`];
  }
  if (type.includes("method") || type.includes("function") || type.includes("routine")) {
    return [`function ${node.label}`];
  }
  if (type.includes("module")) {
    return [`module ${node.label}`];
  }
  if (type.includes("block")) {
    return [`block ${node.label}`];
  }
  return [];
}

export function mergedScopeTrail(left: string[] | undefined, right: string[] | undefined): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])].filter(Boolean))].slice(0, 5);
}

export function semanticLineSet(diff: SemanticDiff | undefined, side: "old" | "new"): Set<number> {
  const lines = new Set<number>();
  const add = (position: NodePosition | null | undefined) => {
    if (!position) {
      return;
    }
    for (let line = position.start_line; line <= Math.max(position.start_line, position.end_line); line += 1) {
      lines.add(line);
    }
  };
  for (const change of diff?.changes ?? []) {
    add(side === "old" ? change.old_node?.position : change.new_node?.position);
  }
  if (side === "new") {
    for (const violation of diff?.guardrail_violations ?? []) {
      add(violation.position);
    }
  }
  return lines;
}

export function refactoringLineSet(diff: SemanticDiff | undefined, side: "old" | "new"): Set<number> {
  const lines = new Set<number>();
  const add = (position: NodePosition | null | undefined) => {
    if (!position) {
      return;
    }
    for (let line = position.start_line; line <= Math.max(position.start_line, position.end_line); line += 1) {
      lines.add(line);
    }
  };
  for (const change of diff?.changes ?? []) {
    if (change.change_type !== "REFACTORING" && !change.refactoring_kind) {
      continue;
    }
    add(side === "old" ? change.old_node?.position : change.new_node?.position);
  }
  return lines;
}

export function rowIntent(
  oldRefactoring?: Set<number>,
  oldIndex?: number,
  newRefactoring?: Set<number>,
  newIndex?: number,
): ReviewDiffRow["intent"] {
  if (
    (oldRefactoring && oldIndex !== undefined && oldRefactoring.has(oldIndex))
    || (newRefactoring && newIndex !== undefined && newRefactoring.has(newIndex))
  ) {
    return "refactoring";
  }
  return undefined;
}


export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split("\n");
}

