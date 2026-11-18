const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  artifactPathFromArgs,
  defaultReviewArtifact,
  loadReviewArtifactFromArgs,
} = require("../out/mainModel.js");
const { modelFromArtifact, renderReviewShell } = require("../out/reviewArtifact.js");

test("review shell model normalizes IntentumDiff review artifacts", () => {
  const model = modelFromArtifact({
    summary: {
      checked_files: 2,
      semantic_changes: 5,
      guardrail_violations: 1,
      cross_file_changes: 3,
    },
    files: [
      {
        path: "src/app.py",
        language: "python",
        changes: [{ id: "change" }, { id: "rename" }],
        guardrail_violations: [{ id: "secret" }],
      },
      {
        path: "README.md",
        language: "markdown",
      },
    ],
    cross_file_groups: [
      {
        title: "API rename",
        kind: "rename",
        files: ["src/app.py", "tests/test_app.py"],
        changes: [{ id: "caller" }, { id: "callee" }],
      },
    ],
  });

  assert.equal(model.checkedFiles, 2);
  assert.equal(model.semanticChanges, 5);
  assert.equal(model.guardrailViolations, 1);
  assert.equal(model.crossFileChanges, 3);
  assert.deepEqual(model.files[0], {
    path: "src/app.py",
    language: "python",
    changeCount: 2,
    guardrailCount: 1,
    fuel: {
      callCount: 0,
      measuredCallCount: 0,
      hotspotCount: 0,
      // No telemetry: unknown, not a measured zero (#135).
      peakFuel: undefined,
      totalFuel: undefined,
      parseErrorCount: 0,
      fallback: false,
    },
    parserCalls: [],
  });
  assert.deepEqual(model.crossFileGroups[0], {
    title: "API rename",
    kind: "rename",
    fileCount: 2,
    changeCount: 2,
  });
});

test("review shell model accepts static file_diffs artifacts", () => {
  const model = modelFromArtifact({
    file_diffs: [
      {
        path: "static.json",
        changes: [{}],
      },
    ],
  });

  assert.equal(model.checkedFiles, 1);
  assert.deepEqual(model.files[0], {
    path: "static.json",
    language: "unknown",
    changeCount: 1,
    guardrailCount: 0,
    fuel: {
      callCount: 0,
      measuredCallCount: 0,
      hotspotCount: 0,
      // No telemetry: unknown, not a measured zero (#135).
      peakFuel: undefined,
      totalFuel: undefined,
      parseErrorCount: 0,
      fallback: false,
    },
    parserCalls: [],
  });
});

test("review shell model and renderer surface fuel telemetry from artifacts", () => {
  const model = modelFromArtifact({
    file_diffs: [{
      new_filename: "apps/review-shell/src/main.ts",
      language: "typescript",
      parse_errors: ["FUEL_EXCEEDED: 10.0M"],
      is_fallback: true,
      metadata: {
        engine_telemetry: {
          calls: [{
            plugin: "src/intentumdiff/wasm/js_ts_parser.wasm",
            function: "process",
            language: "typescript",
            provenance: "first_party_wasm",
            engine: "python_wasmtime_plugin_host",
            fuel_consumed: 25000000,
            total_fuel_consumed: 25000000,
            input_lines: 22,
            input_bytes: 620,
          }],
          fuel_hotspots: [{
            function: "process",
            fuel_consumed: 25000000,
          }],
        },
      },
    }],
  });
  const html = renderReviewShell(model);

  assert.equal(model.fuel.peakFuel, 25000000);
  assert.equal(model.fuel.hotspotCount, 1);
  assert.equal(model.files[0].path, "apps/review-shell/src/main.ts");
  assert.equal(model.files[0].parserCalls[0].provenance, "first_party_wasm");
  assert.match(html, /Fuel diagnostics/u);
  assert.match(html, /data-metric="fuel-peak">25\.0M</u);
  assert.match(html, /class="fuel-row hot"/u);
  assert.match(html, /apps\/review-shell\/src\/main\.ts/u);
  assert.match(html, /first_party_wasm python_wasmtime_plugin_host process/u);
});

test("review shell renderer treats parse-only fallback artifacts as hot diagnostics", () => {
  const model = modelFromArtifact({
    file_diffs: [{
      new_filename: "src/main.ts",
      language: "typescript",
      parse_errors: ["FUEL_EXCEEDED: 10.0M"],
      is_fallback: true,
      changes: [],
    }],
  });
  const html = renderReviewShell(model);

  assert.equal(model.fuel.parseErrorCount, 1);
  assert.equal(model.fuel.fallback, true);
  assert.equal(model.fuel.hotspotCount, 0);
  assert.match(html, /Fuel diagnostics/u);
  assert.match(html, /class="fuel-row hot"/u);
  assert.match(html, /src\/main\.ts/u);
  assert.match(html, /1 parse errors \/ parser fallback/u);
  assert.match(html, /parser identity unavailable/u);
  assert.doesNotMatch(html, /No parser fuel telemetry was attached/u);
});

test("review shell renderer surfaces asset diffs and timeline history from artifacts", () => {
  const model = modelFromArtifact({
    timeline_snapshots: [
      {
        id: "snapshot-old",
        timestamp: 1000,
        fileCount: 1,
        semanticChangeCount: 2,
        errorCount: 0,
        fuelHotspotCount: 0,
      },
      {
        id: "snapshot-hot",
        timestamp: 2000,
        fileCount: 2,
        semanticChangeCount: 3,
        errorCount: 1,
        fuelHotspotCount: 2,
      },
    ],
    file_diffs: [{
      new_filename: "media/image.png",
      language: "png",
      metadata: {
        asset_diff: {
          status: "compared",
          summary: "Image changed slightly: 2.40% of pixels differ.",
          changed_pixel_percentage: 2.4,
          hotspots: [{ id: "hotspot-1" }, { id: "hotspot-2" }],
        },
      },
    }],
  });
  const html = renderReviewShell(model);

  assert.equal(model.assetDiffs.length, 1);
  assert.equal(model.assetDiffs[0].file, "media/image.png");
  assert.equal(model.assetDiffs[0].hotspotCount, 2);
  assert.equal(model.timelineSnapshots.length, 2);
  assert.match(html, /Asset diffs/u);
  assert.match(html, /media\/image\.png/u);
  assert.match(html, /2\.40%/u);
  assert.match(html, /Timeline history/u);
  assert.match(html, /snapshot-hot/u);
  assert.match(html, /1970-01-01T00:00:02\.000Z/u);
  assert.match(html, /class="timeline-row warn"/u);
});

test("review shell renderer escapes asset and timeline artifact text", () => {
  const html = renderReviewShell(modelFromArtifact({
    timeline_snapshots: [{
      id: "<script>timeline</script>",
      timestamp: 0,
    }],
    file_diffs: [{
      new_filename: "media/<script>.png",
      metadata: {
        asset_diff: {
          status: "compared",
          summary: "<img src=x onerror=alert(1)>",
        },
      },
    }],
  }));

  assert.match(html, /media\/&lt;script&gt;\.png/u);
  assert.match(html, /&lt;script&gt;timeline&lt;\/script&gt;/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/u);
});

test("review shell renderer escapes artifact text and renders key sections", () => {
  const html = renderReviewShell(modelFromArtifact({
    summary: {
      checked_files: 1,
      semantic_changes: 1,
      guardrail_violations: 0,
      cross_file_changes: 1,
    },
    files: [
      {
        path: "src/<script>.py",
        language: "python",
        changes: [{}],
      },
    ],
    cross_file_groups: [
      {
        title: "Caller & callee",
        kind: "traceability",
        files: ["src/<script>.py"],
        changes: [{}],
      },
    ],
  }));

  assert.match(html, /data-metric="files">1</);
  assert.match(html, /class="files"/);
  assert.match(html, /class="cross-file-groups"/);
  assert.match(html, /src\/&lt;script&gt;.py/);
  assert.match(html, /Caller &amp; callee/);
  assert.doesNotMatch(html, /src\/<script>\.py/);
});

test("electron entrypoint model parses artifact args and defaults to an empty review", () => {
  assert.equal(
    artifactPathFromArgs(["node", "main.js", "--artifact=C:\\tmp\\review.json"]),
    "C:\\tmp\\review.json",
  );
  assert.equal(artifactPathFromArgs(["node", "main.js"]), undefined);
  assert.deepEqual(defaultReviewArtifact(), { summary: {}, files: [] });
});

test("electron entrypoint model loads artifact data through an injected reader", () => {
  const artifact = loadReviewArtifactFromArgs(
    ["node", "main.js", "--artifact=review.json"],
    (path) => {
      assert.equal(path, "review.json");
      return JSON.stringify({
        summary: { checked_files: 1 },
        files: [{ path: "src/app.py", language: "python" }],
      });
    },
  );

  assert.deepEqual(artifact, {
    summary: { checked_files: 1 },
    files: [{ path: "src/app.py", language: "python" }],
  });
});

test("electron entrypoint disables renderer node integration", () => {
  const source = readFileSync(join(__dirname, "..", "src", "main.ts"), "utf8");

  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /contextIsolation:\s*true/);
});

test("electron entrypoint registers startup once: one ready event creates one window (#130)", async () => {
  const Module = require("node:module");
  const windows = [];
  const readyCallbacks = [];
  const electron = {
    app: {
      whenReady: () => ({ then: (callback) => { readyCallbacks.push(callback); return Promise.resolve(); } }),
      on() {},
    },
    BrowserWindow: class {
      constructor(options) { this.options = options; windows.push(this); }
      loadURL() { return Promise.resolve(); }
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    return request === "electron" ? electron : originalLoad.call(this, request, ...rest);
  };
  const entry = require.resolve("../out/main.js");
  delete require.cache[entry];
  try {
    require(entry);
  } finally {
    Module._load = originalLoad;
    delete require.cache[entry];
  }
  assert.equal(readyCallbacks.length, 1, "startup is registered exactly once");
  await readyCallbacks[0]();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
});

test("package main points at the compiled CommonJS entrypoint that build emits (#130)", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(manifest.main, "out/main.js");
  assert.ok(require("node:fs").existsSync(join(__dirname, "..", manifest.main)), "build:web emits the entrypoint");
  assert.match(manifest.scripts.start, /build:web/u);
});

// #135: unknown/unmetered fuel is never rendered as zero or "within policy".
function fuelArtifact(calls) {
  return {
    file_diffs: [{
      new_filename: "src/a.ts",
      language: "typescript",
      metadata: { engine_telemetry: { calls, fuel_hotspots: [] } },
    }],
  };
}

test("missing fuel telemetry stays 'No fuel measurement', never numeric zero (#135)", () => {
  const model = modelFromArtifact({ file_diffs: [{ new_filename: "src/a.ts", language: "typescript" }] });
  assert.equal(model.fuel.peakFuel, undefined);
  assert.equal(model.fuel.totalFuel, undefined);
  const html = renderReviewShell(model);
  assert.match(html, /data-metric="fuel-peak">No fuel measurement</u);
  assert.doesNotMatch(html, /within policy/u);
});

test("unmetered calls render 'Unmetered' and cannot imply policy compliance (#135)", () => {
  const model = modelFromArtifact(fuelArtifact([{ function: "process", provenance: "p", engine: "e" }]));
  assert.equal(model.files[0].fuel.measuredCallCount, 0);
  assert.equal(model.files[0].parserCalls[0].fuelConsumed, undefined);
  assert.equal(model.files[0].parserCalls[0].fuelPerLine, undefined);
  const html = renderReviewShell(model);
  assert.match(html, /data-metric="fuel-peak">Unmetered</u);
  assert.match(html, /<span>Unmetered<\/span>/u);
  assert.doesNotMatch(html, /within policy/u);
  assert.doesNotMatch(html, />0 peak</u);
});

test("a measured zero is a real measurement and is within policy (#135)", () => {
  const model = modelFromArtifact(fuelArtifact([{ function: "process", fuel_consumed: 0, total_fuel_consumed: 0 }]));
  assert.equal(model.fuel.peakFuel, 0);
  assert.equal(model.fuel.totalFuel, 0);
  const html = renderReviewShell(model);
  assert.match(html, /data-metric="fuel-peak">0</u);
  assert.match(html, /<span>0 peak<\/span>/u);
  assert.match(html, /<span>within policy<\/span>/u);
});

test("positive and mixed calls keep uncertainty in summaries (#135)", () => {
  const positive = modelFromArtifact(fuelArtifact([{ fuel_consumed: 1200, total_fuel_consumed: 1500 }]));
  assert.equal(positive.fuel.peakFuel, 1200);
  assert.equal(positive.fuel.totalFuel, 1500);
  const mixed = modelFromArtifact(fuelArtifact([{ fuel_consumed: 300 }, { function: "unmetered" }]));
  assert.equal(mixed.fuel.callCount, 2);
  assert.equal(mixed.fuel.measuredCallCount, 1);
  assert.equal(mixed.fuel.peakFuel, 300);
  const html = renderReviewShell(mixed);
  assert.match(html, /within policy for measured calls; other calls unmetered/u);
  // Across files, an unmeasured file does not drag the aggregate to zero or erase it.
  const across = modelFromArtifact({
    file_diffs: [
      { new_filename: "a.ts", metadata: { engine_telemetry: { calls: [{ function: "x" }] } } },
      { new_filename: "b.ts", metadata: { engine_telemetry: { calls: [{ fuel_consumed: 42 }] } } },
    ],
  });
  assert.equal(across.fuel.peakFuel, 42);
  assert.equal(across.fuel.measuredCallCount, 1);
});
