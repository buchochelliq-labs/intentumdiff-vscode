import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

// Exercise compiled production methods without constructing VS Code UI services.
function load(name: string, overrides: Record<string, unknown> = {}, append = ""): any {
  const source = readFileSync(path.join(__dirname, "../src", `${name}.js`), "utf8");
  const exports = {};
  vm.runInNewContext(source + append, {
    exports, require: (id: string) => overrides[id] ?? {},
    setTimeout, clearTimeout, console,
  });
  return exports;
}

function harness() {
  const transports: any[] = [];
  const failures: unknown[] = [];
  class Transport {
    constructor(...args: any[]) { transports.push(this); this.callbacks = args[3]; }
    callbacks: any;
    dispose() { this.callbacks.onExit(null, "SIGTERM"); }
  }
  const { ServerSessionManager } = load("serverSessionManager", {
    "./processTransport": { ProcessLineTransport: Transport },
    "./protocol": { LiveServerClient: class { onEvent() {} } },
    "./extensionSettings": {
      settingsForFolder: () => ({ executable: "intentumdiff" }),
      readLiveServerRawExecutable: () => "intentumdiff",
      readLiveServerEngine: () => "auto",
    },
    "./config": {
      bundledLiveServerPath: () => undefined,
      chooseLiveServerLaunch: () => ({ kind: "python" }),
      buildLiveServerArgs: () => [], buildLiveServerEnv: () => ({}),
    },
  });
  const folder = { uri: { toString: () => "folder", fsPath: "/workspace" } };
  const manager = new ServerSessionManager({
    extensionPath: "/extension", trace() {}, setStatusText() {},
    output: { appendLine() {} }, onFailure: (...args: unknown[]) => failures.push(args),
  });
  return { manager, folder, transports, failures };
}

test("unexpected engine exits notify failure even for exit code zero", () => {
  for (const code of [0, 17]) {
    const h = harness();
    h.manager.ensure(h.folder);
    h.transports[0].callbacks.onExit(code, null);
    assert.equal(h.manager.get("folder"), undefined);
    assert.equal(h.failures.length, 1);
  }
});

test("intentional disposal and old process callbacks cannot remove a replacement", () => {
  const h = harness();
  h.manager.ensure(h.folder);
  h.manager.disposeAll();
  assert.equal(h.failures.length, 0);
  const replacement = h.manager.ensure(h.folder);
  h.transports[0].callbacks.onExit(17, null);
  h.transports[0].callbacks.onError(new Error("late error"));
  assert.equal(h.manager.get("folder"), replacement);
  assert.equal(h.failures.length, 0);
});

test("engine failure clears only its folder requests and permits a manual retry", async (t) => {
  const { Controller } = load("extension", {
    "./reviewAssetDiffs": { reviewKey: (f: string, p: string) => `${f}:${p}`, requestKey: (f: string, s: number) => `${f}:${s}` },
    "./reviewModel": { summarizeReviewWithCrossFile: () => ({ errorCount: 1 }) },
    "./extensionSettings": { readLiveServerSettings: () => ({ debounceMs: 250 }) },
  }, "\nexports.Controller = PysdController;");
  const c = Object.create(Controller.prototype);
  const timer = setTimeout(() => assert.fail("orphaned review timer"), 10000);
  t.after(() => { clearTimeout(timer); clearTimeout(c.reviewRefreshTimer); });
  Object.assign(c, {
    reviewRequests: new Map([["folder:1", { folderUri: "folder", seq: 1 }]]),
    reviewSlowTimers: new Map([["folder:1", timer]]),
    incrementalReviewRequests: new Map([["folder:2", { folderUri: "folder" }]]),
    assetDiffRequests: new Map([["folder:3", { folderUri: "folder" }], ["other:4", { folderUri: "other" }]]),
    streamedReviewFiles: new Map([["folder", new Set()]]),
    reviewSnapshots: new Map([["folder", {}]]),
    reviewFiles: new Map([["folder:file", { folderUri: "folder", status: "pending" }], ["other:file", { folderUri: "other", status: "ready" }]]),
    // Suppress only the notification UI, after cleanup has run.
    liveServerWarningKeys: new Set(["folder::stopped::"]),
    updateReviewTree() {}, setWorkspaceStatus() {},
    telemetry: { recordTimelineSnapshot() {} }, output: { appendLine() {} },
    reviewCrossFileEntries: [], reviewRefreshQueued: true,
    pendingReviewReason: "save", pendingReviewForceFull: true,
    reviewRefreshRunning: false, reviewDispatching: false, reviewViewVisible: true,
    streakResetRefreshReasons: new Set(), isEnabled: () => true,
  });
  await c.notifyLiveServerFailure({ uri: { toString: () => "folder" } }, { message: "exited", toast: "stopped" });
  assert.equal(c.reviewRequests.size, 0);
  assert.equal(c.reviewSlowTimers.size, 0);
  assert.equal(c.incrementalReviewRequests.size, 0);
  assert.equal(c.assetDiffRequests.size, 1);
  assert.equal(c.reviewFiles.get("folder:file").status, "error");
  assert.equal(c.reviewFiles.get("other:file").status, "ready");
  assert.equal(c.reviewSnapshots.has("folder"), false);
  assert.equal(c.streamedReviewFiles.has("folder"), false);
  assert.equal(c.reviewRefreshQueued, false);
  assert.ok(c.reviewRefreshTimer, "queued refresh is drained after failure");
  c.requestFullReview("manual");
  assert.ok(c.reviewRefreshTimer);
  clearTimeout(c.reviewRefreshTimer);
  assert.notEqual(c.reviewRefreshQueued, true);
});
