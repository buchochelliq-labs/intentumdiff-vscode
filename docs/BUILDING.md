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
