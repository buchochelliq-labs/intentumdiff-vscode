import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffRows, shouldPairChangedLines } from "../src/reviewDiffRows";

test("review pairs genuinely related line edits", () => {
  assert.equal(shouldPairChangedLines("return getUser(id);", "return getUser(userId);"), true);
});

test("review does not pair unrelated source lines as one modification", () => {
  assert.equal(
    shouldPairChangedLines("async function getUser(id: string) {", "interface User {"),
    false,
  );

  const rows = buildDiffRows(
    "async function getUser(id: string) {\n  return db.get(id);\n}\n",
    "interface User {\n  id: string;\n}\n",
    undefined,
    10,
  ).filter((row) => row.kind !== "equal" && row.kind !== "collapsed");

  assert.equal(rows.some((row) =>
    row.kind === "change"
    && row.oldText?.includes("getUser")
    && row.newText?.includes("interface User")), false);
  assert.equal(rows.some((row) => row.kind === "delete" && row.oldText?.includes("getUser")), true);
  assert.equal(rows.some((row) => row.kind === "insert" && row.newText?.includes("interface User")), true);
});
