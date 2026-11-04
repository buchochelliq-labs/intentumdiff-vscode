import * as assert from "node:assert/strict";

/** Require actual Wasm work; rendering an empty diagnostics page is insufficient. */
export function assertMeasuredWasmTelemetry(telemetry: unknown, native: boolean): void {
  const value = telemetry as { calls?: Record<string, unknown>[] } | undefined;
  assert.ok(Array.isArray(value?.calls), "Missing engine telemetry calls");
  const measured = value.calls.filter(call => call.function === "process"
    && typeof call.fuel_consumed === "number" && call.fuel_consumed > 0);
  assert.ok(measured.length > 0, "Wasm parser calls must report measured fuel");
  for (const call of measured) {
    assert.ok(typeof call.fuel_budget === "number" && call.fuel_budget > 0, "Missing fuel budget");
    assert.ok((call.fuel_consumed as number) <= call.fuel_budget, "Fuel exceeds its budget");
    assert.ok(typeof call.elapsed_ms === "number" && call.elapsed_ms >= 0, "Missing elapsed time");
    assert.ok(typeof call.input_bytes === "number" && call.input_bytes > 0, "Missing input size");
    const statuses = call.statuses as Record<string, unknown> | undefined;
    assert.ok(typeof statuses?.ok === "number" && statuses.ok > 0, "No successful parser call");
    if (native) assert.equal(call.engine_owner, "rust", "Native parser metering must belong to Rust");
  }
}
