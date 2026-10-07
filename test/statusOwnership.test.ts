import assert from "node:assert/strict";
import test from "node:test";
import { statusForOwner } from "../src/statusOwnership";
import type { SemanticDiff } from "../src/types";
const meaningful: SemanticDiff = { language: "dockerfile", changes: [{ change_type: "MODIFICATION", description: "Change base image" }], is_style_only: false };
const style: SemanticDiff = { language: "dockerfile", changes: [], is_style_only: true };

test("late live style-only result cannot replace an active Git comparison", () => {
  const review = { relativePath: "Dockerfile", baseline: "HEAD", diff: meaningful };
  const live = { relativePath: "Dockerfile", baseline: "live", diff: style };
  const status = statusForOwner("IntentumDiff: style-only", review, live);
  assert.equal(status.text, "IntentumDiff: 1 changes");
  assert.match(status.tooltip, /Dockerfile/);
  assert.match(status.tooltip, /HEAD/);
});
test("active comparison retains ownership while a live request is pending", () => {
  assert.equal(statusForOwner("IntentumDiff: diffing", { relativePath: "a", baseline: "HEAD", diff: meaningful }, { relativePath: "b", baseline: "live", pending: true }).text, "IntentumDiff: 1 changes");
});
test("switching to a live editor uses its own status and switching away uses workspace status", () => {
  assert.equal(statusForOwner("IntentumDiff: review 8 changes", undefined, { relativePath: "a", baseline: "live", diff: style }).text, "IntentumDiff: style-only");
  assert.equal(statusForOwner("IntentumDiff: review 8 changes").text, "IntentumDiff: review 8 changes");
});
test("comparison without a result is pending or error, never another file's success", () => {
  assert.equal(statusForOwner("IntentumDiff: clean", { relativePath: "a", baseline: "HEAD" }).text, "IntentumDiff: review pending");
  assert.equal(statusForOwner("IntentumDiff: clean", { relativePath: "a", baseline: "HEAD", error: true }).text, "IntentumDiff: review error");
});
