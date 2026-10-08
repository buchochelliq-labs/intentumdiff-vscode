import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsReportMarkdown, fuelSummaryForDiff, parserCallsForDiff, renderDiagnosticsReportHtml, type DiagnosticsReport } from "../src/diagnosticsReport";

const policy = { peakFuelWarning: 100, fuelPerKbWarning: 100, fuelPerLineWarning: 100 };
function report(calls?: unknown[], hotspots: unknown[] = []): DiagnosticsReport {
  const diff = { metadata: { engine_telemetry: { calls, fuel_hotspots: hotspots } } };
  const summary = fuelSummaryForDiff(diff, policy);
  return { generatedAt: "test", policy, aggregate: summary, files: [{ folderName: "repo", folderUri: "repo", relativePath: "file", language: "python", summary, history: [], parserCalls: parserCallsForDiff(diff) }] };
}
test("missing and unmetered telemetry never renders a measured policy pass", () => {
  for (const [calls, label] of [[undefined, "No fuel measurement"], [[{ function: "finalize", fuel_consumed: null }], "Unmetered"]] as const) {
    const r = report(calls ? [...calls] : undefined);
    for (const output of [diagnosticsReportMarkdown(r), renderDiagnosticsReportHtml(r, { nonce: "x", cspSource: "x" })]) {
      assert.match(output, new RegExp(label));
      assert.doesNotMatch(output, /within policy/i);
      assert.doesNotMatch(output, /0 fuel/);
    }
  }
});
test("measured zero remains a valid measurement and exceeded policy remains a warning", () => {
  const zero = diagnosticsReportMarkdown(report([{ fuel_consumed: 0 }]));
  assert.match(zero, /Peak fuel: 0/);
  assert.match(zero, /within policy/);
  assert.match(zero, /0 fuel/);
  const exceeded = report([{ fuel_consumed: 101 }]);
  assert.equal(exceeded.aggregate.policyExceeded, true);
  assert.match(diagnosticsReportMarkdown(exceeded), /Policy: peak/);
  assert.doesNotMatch(diagnosticsReportMarkdown(report(undefined, [{}])), /within policy/i);
});
test("mixed measured and unmetered calls qualify the policy result", () => {
  const r = report([{ fuel_consumed: 0 }, { fuel_consumed: null }]);
  assert.equal(r.files[0].parserCalls[1].fuelConsumed, undefined);
  assert.equal(r.files[0].parserCalls[1].fuelPerKb, undefined);
  for (const output of [diagnosticsReportMarkdown(r), renderDiagnosticsReportHtml(r, { nonce: "x", cspSource: "x" })]) {
    assert.match(output, /within policy for measured calls; other calls unmetered/);
  }
});
