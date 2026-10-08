import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as ts from "typescript";

test("changing the runtime engine disposes the old server and schedules a fresh review", () => {
  const source = readFileSync(path.join(__dirname, "../src/extension.js"), "utf8");
  const parsed = ts.createSourceFile("extension.js", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  let callback: string | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "onDidChangeConfiguration") {
      callback = node.arguments[0].getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(callback, "use the configuration callback actually registered by activate()");
  const exports: any = {};
  vm.runInNewContext(source + "\nexports.Controller = PysdController;", {
    exports, require: (name: string) => name === "vscode" ? { window: {} } : {},
  });
  const calls: string[] = [];
  const controller = Object.create(exports.Controller.prototype);
  Object.assign(controller, {
    clearTimers: () => calls.push("timers"),
    serverSessions: { disposeAll: () => calls.push("dispose") },
    clearVisuals() {}, liveServerWarningKeys: new Set(),
    clearReview: () => calls.push("clear review"),
    baseContentProvider: { clear() {} }, emptyContentProvider: { clear() {} },
    status: {}, scheduleDocument() {},
    scheduleReviewRefresh: (reason: string, options: { forceFull: boolean }) => {
      assert.equal(reason, "restart");
      assert.equal(options.forceFull, true);
      calls.push("refresh");
    },
  });
  // Both directions produce the same VS Code configuration event.
  for (const transition of ["auto to python", "python to native"]) {
    calls.length = 0;
    vm.runInNewContext(`(function () { return ${callback}; }).call(controller)(event);`, {
      controller, event: { affectsConfiguration: (key: string) => key === "intentumdiff.liveServer.engine" },
    });
    assert.deepEqual(calls, ["timers", "dispose", "clear review", "refresh"], transition);
    assert.equal(controller.status.text, "IntentumDiff: restarting");
  }
});
