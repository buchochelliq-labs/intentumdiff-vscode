import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as diagnostics from "../src/diagnosticsReport";

test("fuel history records actual zero but never substitutes zero for absent measurements", () => {
  const exports: any = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, "../src/reviewTelemetryService.js"), "utf8"), {
    exports, require: (id: string) => id === "./diagnosticsReport" ? diagnostics
      : id === "./reviewAssetDiffs" ? { reviewKey: (folder: string, file: string) => `${folder}:${file}` } : {},
  });
  const logs: any[] = [];
  let writes = 0;
  const service = new exports.ReviewTelemetryService({
    output: { appendLine: (line: string) => logs.push(JSON.parse(line).fuelTelemetry) },
    workspaceState: { update: () => { writes++; } },
    fuelPolicy: () => ({ peakFuelWarning: 100, fuelPerKbWarning: 100, fuelPerLineWarning: 100 }),
  });
  const emit = (fuel: number | null) => service.recordFuelTelemetry("repo", "file", {
    metadata: { engine_telemetry: { calls: [{ fuel_consumed: fuel }] } },
  });
  emit(null);
  assert.equal(service.fuelHistoryFor("repo", "file").length, 0);
  assert.equal(writes, 0);
  assert.equal(logs[0].peakFuel, null);
  assert.equal(logs[0].totalFuel, null);
  assert.equal(logs[0].fuelMeasured, false);
  emit(0);
  assert.deepEqual(Array.from(service.fuelHistoryFor("repo", "file")), [0]);
  assert.equal(writes, 1);
  assert.equal(logs[1].fuelMeasured, true);
  emit(null);
  assert.deepEqual(Array.from(service.fuelHistoryFor("repo", "file")), [0]);
  assert.equal(writes, 1);
  service.recordFuelTelemetry("repo", "missing", { is_fallback: true, parse_errors: ["incomplete"] });
  assert.equal(service.fuelHistoryFor("repo", "missing").length, 0);
  assert.equal(logs[3].fallback, true);
  assert.equal(logs[3].parseErrors, 1);
  assert.equal(logs[3].fuelMeasured, false);
});
