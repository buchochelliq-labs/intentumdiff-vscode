import * as vscode from "vscode";
import {
  REPORT_UNAVAILABLE_MESSAGE,
  runBugReportFlow,
  type BugReportOutcome,
  type BugReportUi,
} from "./reviewCompleteness";
import type { IncompleteReview } from "./types";

/** The VS Code side of the report-a-bug flow: a modal preview, then explicit actions only. */
export function vscodeBugReportUi(): BugReportUi {
  return {
    confirm: (title, detail, actions) => Promise.resolve(
      vscode.window.showWarningMessage(title, { modal: true, detail }, ...actions),
    ),
    notify: (message, actions) => Promise.resolve(vscode.window.showInformationMessage(message, ...actions)),
    openExternal: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url, true))),
    writeClipboard: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
  };
}

export async function reportIncompleteReview(
  incomplete: IncompleteReview | undefined,
  ui: BugReportUi = vscodeBugReportUi(),
): Promise<BugReportOutcome> {
  const outcome = await runBugReportFlow(incomplete, ui);
  if (outcome === "unavailable") {
    void vscode.window.showInformationMessage(REPORT_UNAVAILABLE_MESSAGE);
  }
  return outcome;
}
