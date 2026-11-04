import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildReviewDashboardModel, buildReviewPanelModel, renderDashboardHtml, renderPanelHtml } from "../src/reviewWebviewModel";
import type { ReviewFile } from "../src/reviewModel";

function surfaces(calls: unknown[]) {
  const file: ReviewFile = { folderName: "repo", folderUri: "repo", relativePath: "f.py", status: "ready", diff: { language: "python", metadata: { engine_telemetry: { calls } } } };
  const options = { nonce: "test", cspSource: "test" };
  const panel = new JSDOM(renderPanelHtml(buildReviewPanelModel(file, "", "", "HEAD"), options));
  const dashboard = new JSDOM(renderDashboardHtml(buildReviewDashboardModel([file], []), options));
  return [panel.window.document.querySelector('[data-review-page="diagnostics"]')!, dashboard.window.document.querySelector('.dashboard-fuel-panel')!];
}
test("file and dashboard fuel panels distinguish absence from measured zero", () => {
  for (const [calls, label] of [[[], "No fuel measurement"], [[{ fuel_consumed: null, function: "finalize", fuel_budget: 100 }], "Unmetered"]] as const) {
    for (const el of surfaces([...calls])) {
      assert.match(el.textContent!, new RegExp(label));
      assert.doesNotMatch(el.innerHTML, /within policy|0 fuel|0\.00% budget/i);
      assert.equal(el.querySelector('.fuel-bar'), null);
    }
  }
  for (const el of surfaces([{ fuel_consumed: 0, fuel_budget: 100 }])) {
    assert.match(el.innerHTML, /within policy/);
    assert.doesNotMatch(el.textContent!, /Unmetered|No fuel measurement/);
  }
});
