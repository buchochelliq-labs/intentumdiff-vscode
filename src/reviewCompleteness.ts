/**
 * Review completeness (core issue 252): the extension renders core's verdict, never derives it.
 *
 * - `complete`: `changes` are the review (render as today).
 * - `equivalent`: the sources differ and core proved them equivalent (style-only, or
 *   `metadata.equivalence_proof` names the rule).
 * - `incomplete`: the sources differ, nothing survived and nothing proved equivalence. This
 *   is NOT a clean review: every surface shows core's `incomplete.message` verbatim.
 * - absent (wheels that predate core issue 252): behave exactly as before.
 *
 * Pure module (no `vscode` import) so the decisions are unit-testable.
 */
import type {
  DecorationLike,
  IncompleteReport,
  IncompleteReview,
  IncompleteSourceRange,
  ReviewCompleteness,
  SemanticDiff,
} from "./types";

export const INCOMPLETE_REVIEW_LABEL = "Incomplete review";
export const EQUIVALENT_REVIEW_LABEL = "Equivalent (style-only)";
export const UNEXPLAINED_RANGE_HOVER = "IntentumDiff: changed but unexplained";
export const REPORT_OPEN_ACTION = "Open GitHub issue";
export const REPORT_COPY_ACTION = "Copy full report";
/** Extension-authored note shown only when core says the issue link carries a shortened body. */
export const REPORT_SHORTENED_NOTICE =
  "The GitHub link carries a shortened report. Use \"Copy full report\" to copy the complete text and paste it into the issue.";

export function reviewCompleteness(diff: SemanticDiff | undefined): ReviewCompleteness | undefined {
  const value = diff?.completeness;
  return value === "complete" || value === "equivalent" || value === "incomplete" ? value : undefined;
}

/** Core's incomplete payload, only when the verdict is `incomplete` and it carries a message. */
export function incompleteReview(diff: SemanticDiff | undefined): IncompleteReview | undefined {
  if (reviewCompleteness(diff) !== "incomplete") {
    return undefined;
  }
  const incomplete = diff?.incomplete;
  if (!incomplete || typeof incomplete !== "object" || typeof incomplete.message !== "string") {
    return undefined;
  }
  return incomplete;
}

export function isIncompleteReview(diff: SemanticDiff | undefined): boolean {
  return reviewCompleteness(diff) === "incomplete";
}

/**
 * The message to show for an incomplete review: core's text verbatim. A malformed payload
 * (verdict `incomplete` without an object) still never reads as clean.
 */
export function incompleteMessage(diff: SemanticDiff | undefined): string | undefined {
  if (!isIncompleteReview(diff)) {
    return undefined;
  }
  return incompleteReview(diff)?.message ?? INCOMPLETE_REVIEW_LABEL;
}

export function isEquivalentReview(diff: SemanticDiff | undefined): boolean {
  return reviewCompleteness(diff) === "equivalent";
}

/** The rule id core used to prove equivalence, when present. */
export function equivalenceProof(diff: SemanticDiff | undefined): string | undefined {
  const proof = diff?.metadata?.equivalence_proof;
  return typeof proof === "string" && proof.trim() ? proof : undefined;
}

export function equivalentDescription(diff: SemanticDiff | undefined): string | undefined {
  const proof = equivalenceProof(diff);
  return proof ? `proof: ${proof}` : undefined;
}

function validRange(range: unknown): range is IncompleteSourceRange {
  if (!range || typeof range !== "object") {
    return false;
  }
  const record = range as Record<string, unknown>;
  return ["old_start_byte", "old_end_byte", "new_start_byte", "new_end_byte",
    "old_start_line", "old_end_line", "new_start_line", "new_end_line"]
    .every((key) => typeof record[key] === "number" && Number.isFinite(record[key] as number) && (record[key] as number) >= 0);
}

export function incompleteSourceRanges(diff: SemanticDiff | undefined): IncompleteSourceRange[] {
  const ranges = incompleteReview(diff)?.source_ranges;
  return Array.isArray(ranges) ? ranges.filter(validRange) : [];
}

/**
 * Zero-based inclusive line span of one side of a core range. Core's `*_end_line` is the
 * line of the exclusive end byte, so a hunk that ends after a newline ends on the previous
 * line; an empty side (pure insertion/deletion) marks its anchor line.
 */
export function rangeLines(range: IncompleteSourceRange, side: "old" | "new"): { start: number; end: number } {
  const startLine = side === "old" ? range.old_start_line : range.new_start_line;
  const endLine = side === "old" ? range.old_end_line : range.new_end_line;
  const startByte = side === "old" ? range.old_start_byte : range.new_start_byte;
  const endByte = side === "old" ? range.old_end_byte : range.new_end_byte;
  const end = endByte > startByte && endLine > startLine ? endLine - 1 : startLine;
  return { start: startLine, end: Math.max(startLine, end) };
}

/**
 * Whole-line "changed but unexplained" decorations from core's ranges: positions only, never
 * source text. `side` is `new` for the working file, `old` for the base document.
 */
export function unexplainedDecorations(diff: SemanticDiff | undefined, side: "old" | "new"): DecorationLike[] {
  return incompleteSourceRanges(diff).map((range) => {
    const lines = rangeLines(range, side);
    return {
      kind: "unexplained" as const,
      message: UNEXPLAINED_RANGE_HOVER,
      position: { start_line: lines.start, start_col: 0, end_line: lines.end, end_col: 0 },
    };
  });
}

export interface BugReportPreview {
  title: string;
  body: string;
  truncated: boolean;
  issueUrl: string;
}

/** Core's report, ready to preview; undefined unless every field core promises is present. */
export function bugReportPreview(incomplete: IncompleteReview | undefined): BugReportPreview | undefined {
  const report: IncompleteReport | undefined = incomplete?.report;
  if (!report || typeof report !== "object") {
    return undefined;
  }
  if (typeof report.title !== "string" || typeof report.body_markdown !== "string"
    || typeof report.issue_url !== "string" || !/^https:\/\//iu.test(report.issue_url)) {
    return undefined;
  }
  return {
    title: report.title,
    body: report.body_markdown,
    truncated: report.truncated === true,
    issueUrl: report.issue_url,
  };
}

/** The preview modal's detail: core's body, plus the fixed shortened-link note when truncated. */
export function bugReportPreviewDetail(preview: BugReportPreview): string {
  return preview.truncated ? `${preview.body}\n\n${REPORT_SHORTENED_NOTICE}` : preview.body;
}

/** The UI a report flow needs; the vscode adapter lives in `incompleteReport.ts`. */
export interface BugReportUi {
  /** Modal preview of exactly `title` + `detail`; resolves to the chosen action or undefined (Cancel). */
  confirm(title: string, detail: string, actions: string[]): Promise<string | undefined>;
  /** Non-modal follow-up after copying; resolves to the chosen action or undefined. */
  notify(message: string, actions: string[]): Promise<string | undefined>;
  openExternal(url: string): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
}

export type BugReportOutcome = "opened" | "copied" | "cancelled" | "unavailable";

export const REPORT_COPIED_MESSAGE = "IntentumDiff: full report copied. Paste it into the GitHub issue.";
export const REPORT_UNAVAILABLE_MESSAGE = "IntentumDiff: this review has no bug report to preview.";

/**
 * Preview core's report and act only on an explicit choice. Nothing is sent or opened
 * without the user pressing "Open GitHub issue"; only core-provided text is shown, copied or
 * opened (no file paths, file contents or other local data).
 */
export async function runBugReportFlow(
  incomplete: IncompleteReview | undefined,
  ui: BugReportUi,
): Promise<BugReportOutcome> {
  const preview = bugReportPreview(incomplete);
  if (!preview) {
    return "unavailable";
  }
  const actions = preview.truncated ? [REPORT_OPEN_ACTION, REPORT_COPY_ACTION] : [REPORT_OPEN_ACTION];
  const choice = await ui.confirm(preview.title, bugReportPreviewDetail(preview), actions);
  if (choice === REPORT_OPEN_ACTION) {
    await ui.openExternal(preview.issueUrl);
    return "opened";
  }
  if (choice === REPORT_COPY_ACTION && preview.truncated) {
    await ui.writeClipboard(preview.body);
    const next = await ui.notify(REPORT_COPIED_MESSAGE, [REPORT_OPEN_ACTION]);
    if (next === REPORT_OPEN_ACTION) {
      await ui.openExternal(preview.issueUrl);
      return "opened";
    }
    return "copied";
  }
  return "cancelled";
}
