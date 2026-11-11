# Building intentumdiff-vscode

Toolchain policy (one source of truth, matching CI): build and test with **Node 22**
(`.nvmrc`; every workflow pins `node-version: 22`). That is separate from the **runtime**
target: the shipped JavaScript must run in the extension host of the oldest supported VS Code
(`engines.vscode: ^1.90.0`, whose host is Node 20). That target is enforced by
`@types/node` ^20 in `package.json` and by `npm run lint:min-engine` (no VS Code API newer
than the engines floor), not by the build Node version.

## Extension

```bash
npm ci
npm run lint      # tsc -p ./ --noEmit
npm run test      # compiles then runs the node:test suite
```

## Review shell

```bash
cd review-shell
npm ci
npm run test      # builds (tsc) then runs its suite
npm start         # builds, then launches Electron on the compiled out/main.js
```

`package.json` `main` is the compiled CommonJS entrypoint `out/main.js` (what `build:web`
emits); the shell registers its initial window exactly once on `app.whenReady()`. Open a
review artifact with `npm start -- --artifact=<path/to/review.json>`.

(Its tsconfig pins `typeRoots` locally so the extension's `@types` don't leak into the nested
package.)

## Historical media inventory

`release-media/manifest.json` declares the visual proof surfaces; validate with:

```bash
python scripts/validate_release_media_manifest.py --historical-inventory
```

The historical inventory workflow (`release-media-manifest-gate.yml`) checks the old files and runs provenance-validator regressions. Its success is not approval to publish those captures. The current real-runtime acceptance workflow records the exact installed candidate.

## VSIX packaging

The current generic VSIX includes the compiled extension and UI assets. It does not
bundle a Python interpreter, native engine or parser component set. Configure an external
Rust `intentumdiff-live-server` with matching verified components for real-runtime testing.
With no bundled server, `auto` selects the Python runtime on every platform (see
`docs/ARCHITECTURE.md` "Topology"); runtime bundling is separate work.

## Standalone integration runner

```bash
npm run test:integration
```

This downloads VS Code and runs **fake-server contract coverage** using the checked-in
`test/fixtures/contract-languages.json` catalogue. It needs no parent monorepo or Python
checkout. The catalogue describes test scenarios, not a certified runtime language list.
Keep it outside the mutable workspace fixtures so repeated runs cannot shrink coverage.
A desktop session (or Xvfb on Linux) and access to the VS Code download service are required.

Optionally set `INTENTUMDIFF_TEST_PYTHON` to an external Python executable with the candidate
IntentumDiff package and Rust library installed. The runner queries its supported languages
with a bounded subprocess; an unavailable or invalid runtime fails explicitly instead of
silently substituting fixture coverage. This option changes the language list only: the
suite still uses its fake server and is **not real-engine acceptance**. Paths with spaces
are passed as a single executable argument, without a shell.

Issue #53 also tracks the separate real-runtime acceptance path. Issue #48 requires the
exact VSIX installed in a clean profile with real engine output, artifact identities and
recorded UI evidence. Unit tests, development-host contract tests and successful packaging
do not satisfy that gate.

### Real external-runtime acceptance

Build the VSIX and install the reviewed wheel into a separate environment. Set
`INTENTUMDIFF_TEST_VSIX` and `INTENTUMDIFF_TEST_CLI` to their absolute paths, then run
`node out/test/integration/runRealTests.js` (under `xvfb-run -a` on headless Linux).
The runner installs the VSIX into a temporary clean profile and loads those installed
bytes in VS Code's test host; test-only observation commands are enabled by that host.
It does not run the source checkout as the extension or replace the real CLI with a stub.

The `Packaged extension real-runtime acceptance` workflow pins the candidate wheel's
Python/core commits and reuses the exact Linux wheel from Python #98's four-platform
run 37511241359 (artifact 11435893665). Archive and wheel SHA-256 checks run before
installation; embedded tested commits must match. Parser provenance is retained with
the captures. Missing or expired artifacts fail explicitly and require a reviewed
replacement pin; the workflow never silently substitutes a different runtime.
It covers Python and JavaScript partial-signature changes, native diff tabs, CodeLens,
review-panel creation and recovery after committing valid source. Rust-only mode is
required. It records VSIX/wheel identity, test results and actual X-display captures under
`artifacts/real-runtime`; screenshots are evidence of the exercised windows, not a
complete theme/layout/accessibility audit. Remaining #48 media criteria stay open.

The automated panel check verifies the current file's active panel, not DOM rendering.
Inspect the uploaded captures before claiming visual acceptance. Local runs record unknown
Python/core commits unless supplied by the verified build; CI obtains these from the actual
checksum-verified wheel evidence. The Python identity is the tested synthetic merge
commit, whose parents include PR #95 head `15279ef334bc6aa08da9f8f7503cec3ee0fb5f5b`. The local executable alone does not prove its source commit.

The real-runtime suite deliberately requests its first review before opening the review
view. This guards #55: manual refresh must retain its explicit hidden-view permission
through both timer scheduling and draining behind in-flight work. Automatic background
refreshes still require a visible review view. Failed runs retain the last review state,
a failure screenshot when available, and VS Code logs alongside the original test error.

### Source fallback visual checks

The real-runtime acceptance captures incomplete Python and JavaScript source using the installed VSIX and external Rust-backed CLI. For issues #56/#57, verify that every hunk action fits or wraps with Explorer and Chat open, and the panel prominently identifies source fallback with unknown semantic equivalence. Source-fallback presentation uses the Rust `semantic_contract` metadata; Python and the extension do not reclassify the comparison. Valid-source recovery must restore normal semantic labels. Static captures do not certify every theme or action.

### Current acceptance media versus historical demos

The real-runtime workflow now exercises a tracked PNG through the Rust image engine, checks that all six returned artifacts exist, and records dark, light, high-contrast and constrained-editor captures. It records an actual 16-second source/CodeLens → native diff → review workflow. The constrained editor is produced with VS Code zoom level 2 and is labelled accordingly; it is not a claimed 760px window capture.

`artifacts/real-runtime/capture-manifest.json` binds each PNG/MP4 checksum to the installed VSIX version, SHA256 and tested checkout commit in `provenance.json`. PR builds record the synthetic merge commit. The harness removes old capture files first and validates identity/checksums; captures remain awaiting independent visual review until a reviewer checks the actual bytes. A successful capture is not itself visual approval.

The older `release-media/manifest.json` captures lack recoverable build provenance. Its dimension check is a historical inventory check, not certification of the current candidate. Do not relabel those files with today's identity or advertise the current unpublished candidate as a released build. Use immutable commit URLs for reviewed repository media, and repeat acceptance after an authorized publication.

Current legacy-format capture approval requires `python scripts/validate_release_media_manifest.py <manifest> --expected-version <candidate-version> --expected-commit <tested-build-commit>`. Missing identity, mismatched version, or mismatched commit fails. Omitting the candidate commit also fails. The historical inventory workflow runs the identity regression tests but does not certify those old images for publication. Current real-runtime captures use their own installed-VSIX identity and per-file checksum manifest.


### Language and capability capture batches

The real-runtime workflow runs the existing acceptance journey plus four disjoint language
batches against the same checksum-pinned #98 wheel. `languageExamples.json` contains the 74
public examples already used by the docs language gallery, with source-review expectations
and caveats. Each example produces native-diff and custom-review PNGs. No parser override
is imposed: the recorded `observed.language` is the runtime's actual automatic routing.
An ambiguous extension or source fallback must be documented as observed, not labelled as
successful coverage of the requested parser.

The suite commits the old source, saves the new source through VS Code, waits for the real
review, captures both views, and restores the baseline before the next case. Errors are
retained and the batch fails after collecting the remaining cases. Output includes the
independent source expectation and observed status; a passing collection run is not semantic
correctness approval. All output and images require independent inspection before publication.

The capability batch additionally captures Peek, semantic-only diff, expanded context,
Evidence view, Intent view, dashboard and diagnostics. The current UI has Evidence and Intent
tabs; the legacy drawer/rail commands have no corresponding rendered panels and are not
captured as those capabilities.
Peek and Evidence captures wait for visible DOM in the isolated Electron desktop. Language
captures reject binary, empty and style-only results for these meaningful edits, then wait
for the rendered text review. A command returning does not prove its rendered result:
inspect each image before marking the capability covered. Existing clean
profile, installed VSIX, real external engine, capture hash and provenance rules still apply.

Artifacts use `real-runtime-{python,native}-capabilities` and
`real-runtime-{python,native}-languages-0` through `-3` names.
Test sources and raw logs remain CI evidence; publish only reviewed documentation examples,
media and public candidate identities. Git actions, all image modes and remaining transitions
still need dedicated interaction evidence.


## Native runtime candidate

The current Linux x64 test artifact comes from [native-server run 41802218429](https://github.com/buchochelliq-labs/intentumdiff-live-server/actions/runs/41802218429)
(release head `235cf4b`, Core `726fd07`), the same candidate the packaged-VSIX acceptance
gate tests. It is a CI candidate, not a published release, so 0.0.2's `auto` engine does
not select it; set `intentumdiff.liveServer.engine` to `native` to use it. Run these commands from this checkout
with authenticated GitHub CLI access; expired or unavailable artifacts must fail.
Python is used here to verify the download, not to run the extension's engine.

```sh
gh api /repos/buchochelliq-labs/intentumdiff-live-server/actions/artifacts/13308991709/zip > native-candidate.zip
python3 scripts/verify_candidate_native.py native-candidate.zip native-runtime \
  --expected-archive-sha256 e7b2f2f54ad589ad53a719c844e49ebe5f8162d48aae66d72ba9c9a926646f6b \
  --expected-server-commit 235cf4bdd789aefc2b9eaf0a76b465ccec14742a \
  --expected-core-commit 726fd07c77a83d2554d3eca68b6469e9461b87bc
export PATH="$PWD/native-runtime:$PATH"
```

Keep the executable and adjacent `wasm/` directory together. Start VS Code from
that environment, or set the trusted user setting `intentumdiff.executable` to
the executable's absolute path. This candidate does not establish Windows,
ARM64 or macOS native acceptance. Desktop before/after acceptance remains a
separate gate from the native server's protocol tests.

The capability test requires measured JavaScript parser fuel and recorded history
after recovery. Native protocol tests also cover JSON and malformed JavaScript.
Missing measurements must display as unavailable or unmetered, not a measured zero
or a policy pass. The native candidate records successful parser process calls;
failed-call telemetry and auxiliary-call accounting are not yet equivalent to
the Python runtime. Explicit low-fuel requests must still fail visibly.
