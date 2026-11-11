import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { LiveServerClient, type ClientEvent } from "../src/protocol";

// #122: every protocol event must be gated by the current session and request generation.

function load(name: string, overrides: Record<string, unknown> = {}): any {
  const source = readFileSync(path.join(__dirname, "../src", `${name}.js`), "utf8");
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id: string) => overrides[id] ?? {}, setTimeout, clearTimeout, console });
  return exports;
}

function harness() {
  const transports: any[] = [];
  const received: Array<{ kind: string; seq: number }> = [];
  const written: string[][] = [];
  class Transport {
    callbacks: any;
    lines: string[] = [];
    constructor(...args: any[]) { transports.push(this); this.callbacks = args[3]; written.push(this.lines); }
    writeLine(line: string) { this.lines.push(line); }
    dispose() { this.callbacks.onExit(null, "SIGTERM"); }
  }
  const protocol = load("protocol");
  const { ServerSessionManager } = load("serverSessionManager", {
    "./processTransport": { ProcessLineTransport: Transport },
    "./protocol": protocol,
    "./extensionSettings": {
      settingsForFolder: () => ({ executable: "intentumdiff" }),
      readLiveServerRawExecutable: () => "intentumdiff",
      readLiveServerEngine: () => "auto",
      resolveExecutableForFolder: (executable: string) => executable,
    },
    "./config": {
      bundledLiveServerPath: () => undefined,
      chooseLiveServerLaunch: () => ({ kind: "python" }),
      buildLiveServerArgs: () => [], buildLiveServerEnv: () => ({}),
    },
  });
  const statuses: string[] = [];
  const manager = new ServerSessionManager({
    extensionPath: "/extension", trace() {}, setStatusText: (text: string) => statuses.push(text),
    output: { appendLine() {} }, onFailure() {},
    onDiff: (_folder: unknown, result: any) => received.push({ kind: "diff", seq: result.seq }),
    onReviewResult: (_folder: unknown, result: any) => received.push({ kind: "review", seq: result.seq }),
    onReviewFile: (_folder: unknown, result: any) => received.push({ kind: "review_file", seq: result.seq }),
    onAssetDiff: (_folder: unknown, result: any) => received.push({ kind: "asset_diff", seq: result.seq }),
    onReviewError: () => false, onIncrementalReviewError: () => false, onAssetDiffError: () => false,
    onProtocolError: (error: any) => received.push({ kind: `error:${error.code}`, seq: -1 }),
  });
  const folder = { uri: { toString: () => "folder", fsPath: "/workspace" } };
  return { manager, folder, transports, received, statuses, written };
}

const diffLine = (seq: number) => JSON.stringify({ op: "diff", seq, ok: true, diff: { language: "python", changes: [] } });
const readyLine = JSON.stringify({ op: "ready", ok: true, protocol_version: 2, repo_path: "/r", ref: "HEAD", transport: "stdio" });

test("a retired session's delayed stdout, ready and error cannot reach the replacement (#122)", () => {
  const h = harness();
  const a = h.manager.ensure(h.folder);
  const seqA = a.client.diff("app.py", "a");
  h.manager.disposeAll();
  const b = h.manager.ensure(h.folder);
  const seqB = b.client.diff("app.py", "b");
  assert.notEqual(seqA, seqB, "sequence numbers are never reused across sessions");

  const statusesBefore = h.statuses.length;
  h.transports[0].callbacks.onLine(readyLine);
  h.transports[0].callbacks.onLine(diffLine(seqA));
  h.transports[0].callbacks.onLine(diffLine(seqB));
  h.transports[0].callbacks.onLine(JSON.stringify({ op: "diff", seq: seqA, ok: false, error: { code: "boom", message: "late" } }));
  assert.deepEqual(h.received, []);
  assert.equal(h.statuses.length, statusesBefore);

  h.transports[1].callbacks.onLine(diffLine(seqB));
  assert.deepEqual(h.received, [{ kind: "diff", seq: seqB }]);
});

test("the replacement session does not accept the retired session's sequence numbers (#122)", () => {
  const h = harness();
  const a = h.manager.ensure(h.folder);
  const seqA = a.client.review();
  h.manager.disposeAll();
  const b = h.manager.ensure(h.folder);
  b.client.review();
  // Even if the replacement process echoed the old seq, it is not B's request.
  h.transports[1].callbacks.onLine(JSON.stringify({ op: "review", seq: seqA, ok: true, commit_diff: { cross_file_changes: [] } }));
  h.transports[1].callbacks.onLine(JSON.stringify({ op: "review", seq: seqA, ok: false, error: { code: "x", message: "y" } }));
  assert.deepEqual(h.received, []);
});

test("a restart during dispatch drops the rest of the retired session's events (#122)", () => {
  const h = harness();
  const a = h.manager.ensure(h.folder);
  const seq = a.client.diff("app.py", "a");
  // The session is retired while its line is being read/dispatched.
  h.manager.disposeAll();
  a.client.handleLine(diffLine(seq));
  assert.deepEqual(h.received, []);
});

test("an obsolete request's error is suppressed before ownership checks; the current one's is not (#122)", () => {
  const lines: string[] = [];
  const client = new LiveServerClient({ writeLine: (line) => lines.push(line) });
  const events: ClientEvent[] = [];
  client.onEvent((event) => events.push(event));
  const first = client.diff("app.py", "1");
  const second = client.diff("app.py", "2");
  client.handleLine(JSON.stringify({ op: "diff", seq: first, ok: false, error: { code: "cancelled", message: "cancelled" } }));
  assert.deepEqual(events, []);
  client.handleLine(JSON.stringify({ op: "diff", seq: second, ok: false, error: { code: "parse", message: "bad" } }));
  assert.deepEqual(events, [{ kind: "error", seq: second, error: { code: "parse", message: "bad" } }]);

  const oldReview = client.review();
  client.review();
  client.handleLine(JSON.stringify({ op: "review", seq: oldReview, ok: false, error: { code: "cancelled", message: "c" } }));
  assert.equal(events.length, 1);
});
