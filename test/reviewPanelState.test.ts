import assert from "node:assert/strict";
import test from "node:test";
import { panelReviewFile } from "../src/reviewPanelState";
const identity = { folderName: "repo", folderUri: "file:///repo", relativePath: "a.py" };
test("panel lifecycle distinguishes pending, clean completion and folder failure", () => {
  assert.equal(panelReviewFile(identity, undefined, undefined, false).status, "pending");
  assert.deepEqual(panelReviewFile(identity, undefined, undefined, true).diff?.changes, []);
  const failure = { ...identity, status: "error" as const, error: "engine failed" };
  assert.equal(panelReviewFile(identity, undefined, failure, true).error, "engine failed");
  assert.equal(panelReviewFile(identity, { ...identity, status: "pending" }, failure, true).status, "error");
  const ready = { ...identity, status: "ready" as const, diff: { changes: [] } };
  assert.equal(panelReviewFile(identity, ready, failure, true), ready);
});
