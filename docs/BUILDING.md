# Building intentumdiff-vscode

Toolchain: **Node 20** (see `.nvmrc`). This is not a preference: it is the Node the
VS Code 1.90 extension host provides, and `engines.vscode: ^1.90.0` promises to
support that host. CI pins the same version explicitly in the workflows.

## Extension

```bash
npm ci
npm run lint      # tsc -p ./ --noEmit
npm run test      # compiles then runs the node:test suite (260 tests)
```

## Review shell

```bash
cd review-shell
npm ci
npm run test      # builds (tsc) then runs its suite
```

(Its tsconfig pins `typeRoots` locally so the extension's `@types` don't leak into the nested
package.)

## Release media gate

`release-media/manifest.json` declares the visual proof surfaces; validate with:

```bash
python scripts/validate_release_media_manifest.py
```

The recorder (`scripts/record-release-demo.ps1`) regenerates screenshots; the CI gate
(`release-media-manifest-gate.yml`) enforces manifest validity on every change.

## VSIX packaging

The current generic VSIX includes the compiled extension and UI assets. It does not
bundle a Python interpreter, native engine or parser component set. Configure an external
IntentumDiff executable for real-runtime testing. Future runtime bundling is separate work.

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
Python/core commits and verifies the two parser component checksums before building.
It covers Python and JavaScript partial-signature changes, native diff tabs, CodeLens,
review-panel creation and recovery after committing valid source. Rust-only mode is
required. It records VSIX/wheel identity, test results and actual X-display captures under
`artifacts/real-runtime`; screenshots are evidence of the exercised windows, not a
complete theme/layout/accessibility audit. Remaining #48 media criteria stay open.

The automated panel check verifies the current file's active panel, not DOM rendering.
Inspect the uploaded captures before claiming visual acceptance. Local runs record unknown
Python/core commits unless supplied by the verified build; CI obtains these from the actual
checked-out build inputs. The local executable alone does not prove its source commit.
