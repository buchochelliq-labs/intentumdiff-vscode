import assert from "node:assert/strict";
import test from "node:test";
import { LiveServerClient, type ClientEvent } from "../src/protocol";

// #128: completed, failed, cancelled and superseded requests release their metadata.

function client() {
  const sent: any[] = [];
  const events: ClientEvent[] = [];
  const instance = new LiveServerClient({ writeLine: (line) => sent.push(JSON.parse(line)) });
  instance.onEvent((event) => events.push(event));
  return { instance, sent, events };
}

const ok = (seq: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ op: "diff", seq, ok: true, diff: { language: "python", changes: [] }, ...extra });

test("25,000 sequential completed requests for one file retain no per-request state (#128)", () => {
  const { instance, sent, events } = client();
  for (let index = 0; index < 25_000; index += 1) {
    const seq = instance.diff("app.py", String(index));
    instance.handleLine(ok(seq));
  }
  assert.equal(events.length, 25_000);
  assert.equal(instance.pendingCount, 0);
  assert.equal(instance.activeDiffLaneCount, 0);
  // Completed work is never cancelled by the next request.
  assert.equal(sent.filter((message) => message.op === "cancel").length, 0);
});

test("multi-file clients retain state proportional to active work across success, error and cancel (#128)", () => {
  const { instance, events } = client();
  const files = Array.from({ length: 50 }, (_, index) => `f${index}.py`);
  for (let round = 0; round < 200; round += 1) {
    for (const [index, file] of files.entries()) {
      const seq = instance.diff(file, String(round), { purpose: index % 2 === 0 ? "live" : "review" });
      if (index % 3 === 0) instance.handleLine(ok(seq));
      else if (index % 3 === 1) instance.handleLine(JSON.stringify({ op: "diff", seq, ok: false, error: { code: "e", message: "m" } }));
      else instance.cancel(seq);
    }
  }
  assert.equal(instance.pendingCount, 0);
  assert.equal(instance.activeDiffLaneCount, 0);
  assert.ok(events.length > 0);
});

test("superseded predecessors are released and their late answers dropped (#128)", () => {
  const { instance, sent, events } = client();
  const seqs = Array.from({ length: 100 }, (_, index) => instance.diff("app.py", String(index)));
  assert.equal(instance.pendingCount, 1, "only the newest request is active");
  assert.equal(sent.filter((message) => message.op === "cancel").length, 99);
  for (const seq of seqs.slice(0, -1)) {
    instance.handleLine(ok(seq));
    instance.handleLine(JSON.stringify({ op: "diff", seq, ok: false, error: { code: "cancelled", message: "c" } }));
  }
  assert.equal(events.length, 0);
  instance.handleLine(ok(seqs[seqs.length - 1]));
  assert.equal(events.length, 1);
  assert.equal(instance.pendingCount, 0);
});

test("streaming: intermediate frames keep the request active until its terminal frame (#128)", () => {
  const { instance, events } = client();
  const seq = instance.diff("app.py", "x", { stream: true });
  instance.handleLine(ok(seq, { done: false }));
  assert.equal(instance.pendingCount, 1);
  instance.handleLine(ok(seq, { done: true }));
  assert.equal(instance.pendingCount, 0);
  assert.equal(events.length, 2);

  const review = instance.review({ stream: true });
  for (let index = 0; index < 5; index += 1) {
    instance.handleLine(JSON.stringify({ op: "review_file", seq: review, ok: true, file_diff: { changes: [] }, index }));
  }
  assert.equal(instance.pendingCount, 1);
  instance.handleLine(JSON.stringify({ op: "review", seq: review, ok: true, commit_diff: { cross_file_changes: [] } }));
  assert.equal(instance.pendingCount, 0);
  const sentBefore = events.length;
  // A new review after completion does not cancel the completed one.
  const lines: string[] = [];
  const fresh = new LiveServerClient({ writeLine: (line) => lines.push(line) });
  const first = fresh.review();
  fresh.handleLine(JSON.stringify({ op: "review", seq: first, ok: true, commit_diff: {} }));
  fresh.review();
  assert.equal(lines.filter((line) => JSON.parse(line).op === "cancel").length, 0);
  assert.equal(events.length, sentBefore);
});

test("asset and hello requests are released on their outcome (#128)", () => {
  const { instance } = client();
  const asset = instance.assetDiff("logo.png");
  instance.handleLine(JSON.stringify({ op: "asset_diff", seq: asset, ok: true, result: {} }));
  const failed = instance.assetDiff("logo.png");
  instance.handleLine(JSON.stringify({ op: "asset_diff", seq: failed, ok: false, error: { code: "e", message: "m" } }));
  instance.hello();
  instance.handleLine(JSON.stringify({ op: "hello", seq: 3, ok: true }));
  assert.equal(instance.pendingCount, 0);
});
