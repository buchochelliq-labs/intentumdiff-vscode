import type { ReviewFile } from "./reviewModel";

/** Map review lifecycle state to a panel; never infer semantics from source. */
export function panelReviewFile(identity: Pick<ReviewFile, "folderName" | "folderUri" | "relativePath">,
  file: ReviewFile | undefined, folderError: ReviewFile | undefined, completed: boolean): ReviewFile {
  if (file && file.status !== "pending") return file;
  if (folderError?.status === "error") return { ...identity, status: "error", error: folderError.error };
  if (completed) return { ...identity, status: "ready", diff: { changes: [], change_groups: [] } };
  return { ...identity, status: "pending" };
}
