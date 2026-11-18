import type { NodePosition } from "./types";

export interface TextDocumentLineLike {
  text: string;
}

export interface TextDocumentLike {
  lineCount: number;
  lineAt(line: number): TextDocumentLineLike;
}

export interface DocumentSelectionTarget {
  position: NodePosition;
  shouldSelect: boolean;
  exact: boolean;
}

/**
 * Protocol coordinate unit (see docs/ARCHITECTURE.md "Engine positions"):
 * engine `start_line`/`end_line` are 0-based line indexes and
 * `start_col`/`end_col` are 0-based **UTF-8 byte offsets within that line**
 * (tree-sitter `Point.column`). VS Code `Position.character` is a UTF-16 code
 * unit offset, so every engine position must be converted against the exact
 * source text of the side it addresses before it becomes a VS Code range.
 */
export interface Utf16Conversion {
  position: NodePosition;
  /** False when a bound was malformed, outside the document or split a code point. */
  exact: boolean;
}

/** True for finite, non-negative integer bounds in (line, col) order. */
export function isWellFormedPosition(position: NodePosition | null | undefined): position is NodePosition {
  if (!position) {
    return false;
  }
  const values = [position.start_line, position.start_col, position.end_line, position.end_col];
  return values.every((value) => Number.isInteger(value) && value >= 0) && isOrderedRange(position);
}

/**
 * Convert one UTF-8 byte column to a UTF-16 column on `lineText`. A byte
 * offset inside a multi-byte code point snaps to the code point start
 * (`round: "down"`) or end (`round: "up"`); an offset past the line end clamps
 * to the line end. Either case reports `exact: false`.
 */
export function utf8ColumnToUtf16(
  lineText: string,
  byteColumn: number,
  round: "down" | "up" = "down",
): { column: number; exact: boolean } {
  let bytes = 0;
  let units = 0;
  for (const char of lineText) {
    if (bytes === byteColumn) {
      return { column: units, exact: true };
    }
    const codePoint = char.codePointAt(0) ?? 0;
    const width = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (byteColumn < bytes + width) {
      return { column: round === "up" ? units + char.length : units, exact: false };
    }
    bytes += width;
    units += char.length;
  }
  return { column: units, exact: bytes === byteColumn };
}

/**
 * Convert an engine (UTF-8 byte column) position into a UTF-16 position on
 * `document`. Lines are clamped into the document; columns are converted on
 * each bound's own line, so a multiline end column is never widened by the
 * start column. Malformed input is reported inexact, never invented.
 */
export function engineRangeToUtf16(
  position: NodePosition,
  document: TextDocumentLike,
): Utf16Conversion {
  const wellFormed = isWellFormedPosition(position);
  const lastLine = Math.max(document.lineCount - 1, 0);
  const startLine = clamp(finiteOr(position.start_line, 0), 0, lastLine);
  const endLine = clamp(finiteOr(position.end_line, startLine), startLine, lastLine);
  const lineText = (line: number) => (line < document.lineCount ? document.lineAt(line).text : "");
  const start = utf8ColumnToUtf16(lineText(startLine), Math.max(finiteOr(position.start_col, 0), 0), "down");
  const end = utf8ColumnToUtf16(lineText(endLine), Math.max(finiteOr(position.end_col, 0), 0), "up");
  const endCol = endLine === startLine ? Math.max(end.column, start.column) : end.column;
  const linesInside = position.start_line === startLine && position.end_line === endLine;
  return {
    position: { start_line: startLine, start_col: start.column, end_line: endLine, end_col: endCol },
    exact: wellFormed && linesInside && start.exact && end.exact && endCol === end.column,
  };
}

/**
 * Normalise already-converted bounds for a VS Code range: non-finite or
 * negative values clamp to 0, the end line never precedes the start line,
 * and the end column is held >= the start column **only on the same line**.
 */
export function rangeBounds(position: NodePosition): [number, number, number, number] {
  const startLine = Math.max(finiteOr(position.start_line, 0), 0);
  const startCol = Math.max(finiteOr(position.start_col, 0), 0);
  let endLine = Math.max(finiteOr(position.end_line, startLine), 0);
  let endCol = Math.max(finiteOr(position.end_col, startCol), 0);
  if (endLine < startLine) {
    endLine = startLine;
    endCol = startCol;
  } else if (endLine === startLine) {
    endCol = Math.max(endCol, startCol);
  }
  return [startLine, startCol, endLine, endCol];
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * Selection target for an **engine** position (UTF-8 byte columns) on the
 * document it addresses. The result is in VS Code UTF-16 columns.
 */
export function selectionTargetForDocument(
  enginePosition: NodePosition,
  document: TextDocumentLike,
): DocumentSelectionTarget {
  const converted = engineRangeToUtf16(enginePosition, document);
  if (converted.exact) {
    return {
      position: converted.position,
      shouldSelect: !isEmptyRange(converted.position),
      exact: true,
    };
  }
  return {
    position: pointPosition(converted.position.start_line, converted.position.start_col),
    shouldSelect: false,
    exact: false,
  };
}

function isOrderedRange(position: NodePosition): boolean {
  return (position.end_line > position.start_line)
    || (position.end_line === position.start_line && position.end_col >= position.start_col);
}

function isEmptyRange(position: NodePosition): boolean {
  return position.start_line === position.end_line && position.start_col === position.end_col;
}

function pointPosition(line: number, col: number): NodePosition {
  return {
    start_line: line,
    start_col: col,
    end_line: line,
    end_col: col,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
