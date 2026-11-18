// Explanations render engine facts; they never reconstruct arity, visibility,
// body shape or body contents from the pruned tree or from naming conventions
// (issue 132). Each case pairs a "facts missing" fixture (no claim allowed) with
// a "facts present" fixture (the engine's value is used). Expected values are
// judged from the source each fixture stands for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { explainChange, extractFacts } from "../src/intentExplain";
import type { NodeFacts, SemanticChange, SemanticNode } from "../src/types";

const pos = (start: number, end: number) => ({ start_line: start, start_col: 0, end_line: end, end_col: 0 });

/** `def <label>(a, b): <statements>` as a pruned tree with no engine facts. */
function treeOnly(label: string, statements: SemanticNode[], facts?: NodeFacts): SemanticNode {
  return {
    label,
    node_type: "function_definition",
    position: pos(1, 2),
    children: [
      { node_type: "parameters", children: [{ node_type: "identifier", label: "a" }, { node_type: "identifier", label: "b" }] },
      { node_type: "block", children: statements },
    ],
    ...(facts ? { facts } : {}),
  };
}

const PASS = [{ node_type: "pass_statement", label: "pass" }];
const RETURN_SUM = [{ node_type: "return_statement", label: "return a + b" }];
const CALL = [{ node_type: "expression_statement", label: "charge(x)", children: [{ node_type: "call", label: "charge(x)" }] }];

const added = (node: SemanticNode): SemanticChange => ({ change_type: "ADDITION", new_node: node, old_node: null });

test("missing param_count: no arity is fabricated from the parameter subtree", () => {
  assert.equal(extractFacts(added(treeOnly("f", RETURN_SUM))).arity, undefined);
  assert.equal(extractFacts(added(treeOnly("f", RETURN_SUM, { param_count: 2 }))).arity, 2);
});

test("missing body fact: no stub/substantive claim is fabricated from the tree", () => {
  const stubTree = added(treeOnly("ccc", PASS));
  assert.equal(extractFacts(stubTree).bodyKind, undefined);
  assert.equal(extractFacts(stubTree).stubSentinel, undefined);
  assert.doesNotMatch(explainChange(stubTree).why, /stub/iu);

  const stubFacts = added(treeOnly("ccc", PASS, { body: "stub" }));
  assert.equal(extractFacts(stubFacts).bodyKind, "stub");
  assert.equal(explainChange(stubFacts).why, "Empty stub — no implementation yet.");
});

test("missing visibility fact: naming conventions do not become visibility claims", () => {
  for (const label of ["_helper", "__init__", "MAX_SIZE"]) {
    const why = explainChange(added(treeOnly(label, RETURN_SUM, { returns: "value" }))).why;
    assert.doesNotMatch(why, /Internal helper|Special method|Constant|Public/u, label);
    assert.equal(why, "Returns a value.", label);
  }
  assert.equal(explainChange(added(treeOnly("_helper", RETURN_SUM))).why, "Newly added.");
});

test("body contents are not mined from tree labels into claims", () => {
  assert.doesNotMatch(explainChange(added(treeOnly("add", RETURN_SUM))).why, /a \+ b/u);
  assert.doesNotMatch(explainChange(added(treeOnly("pay", CALL))).why, /charge/u);
});

test("a stub flip needs engine body facts on both sides", () => {
  const treeFlip: SemanticChange = {
    change_type: "MODIFICATION",
    old_node: treeOnly("f", RETURN_SUM),
    new_node: treeOnly("f", PASS),
  };
  assert.doesNotMatch(explainChange(treeFlip).why, /Gutted|Implemented/u);

  const factFlip: SemanticChange = {
    change_type: "MODIFICATION",
    old_node: treeOnly("f", RETURN_SUM, { body: "substantive" }),
    new_node: treeOnly("f", PASS, { body: "stub" }),
  };
  assert.equal(explainChange(factFlip).why, "Gutted to a stub — implementation removed.");
  const implemented: SemanticChange = {
    change_type: "MODIFICATION",
    old_node: treeOnly("f", PASS, { body: "empty" }),
    new_node: treeOnly("f", RETURN_SUM, { body: "substantive" }),
  };
  assert.equal(explainChange(implemented).why, "Implemented (was an empty stub).");
});

test("no tree-reconstruction helpers remain in the explainer", () => {
  const source = readFileSync(path.join(__dirname, "..", "src", "intentExplain.js"), "utf8");
  assert.doesNotMatch(source, /function (arity|bodyKind|bodyFact|visibility|stubPhrase|stubSentinelToken)\(/u);
});
