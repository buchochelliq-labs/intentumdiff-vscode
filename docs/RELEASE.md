# Extension release runbook

- **Identity**: package `intentumdiff`, publisher `buchochelliq-labs`; publish only under the
  IntentumDiff identity (never a legacy name unless the brand decision is explicitly reversed).
- **Rebrand gate before live publishing**: confirm/reserve the publisher namespace on VS
  Marketplace AND Open VSX; confirm the repo URL resolves; keep `intentumdiff.*` command/setting
  compatibility for the first public release; re-run the release dry run after any manifest or
  README changes.
- **VSIX contents**: compiled extension and review assets. The current package uses an
  externally installed IntentumDiff Python/CLI runtime backed by Rust. It does not bundle
  Python, a native live-server binary, or parser components. Verify setup and recovery
  against the external candidate runtime; future runtime bundling is separate work.
- **Gates before any publish**: lint + both test suites green, the release-media manifest
  gate valid, and the listing preflight (catches marketplace name collisions).
- Marketplace collateral (icon, banner, demo media, changelog, support, license) ships from
  this repo; the release-media set is the validated proof source.

## Installed-VSIX certification (0.0.3, issue #137)

Unit, JSDOM and VM tests are not desktop acceptance. A candidate is certified only by
`real-runtime.yml` running the **one packaged VSIX** (single `package-vsix` job, SHA-256
checked in every leg) in a clean profile on real runners.

| Contract | Where it is checked | Runs where |
|---|---|---|
| `src/` uses no VS Code API newer than `engines.vscode` | `npm run lint:min-engine` (typechecks against `@types/vscode` at the engine minimum) | CI, any machine with npm |
| Installed VSIX on the current stable pin, Python + native, capabilities + 4 language shards | `acceptance` legs, `profile: current` | GitHub runner + Xvfb |
| Installed VSIX on the **minimum** VS Code (`1.90.0`), Python + native | `acceptance` legs, `profile: min-engine` | GitHub runner + Xvfb |
| Hunk actions: stale apply rejected, Preview never writes or saves, CRLF / no-final-newline kept, unrelated unsaved edits not saved | `test/integration/hunkActionAcceptance.ts` (from `realSuite.ts`) | GitHub runner + Xvfb |
| Full / semantic-only native diff, CodeLens + Peek, images, evidence/intent/dashboard/diagnostics, parse-error recovery | `test/integration/realSuite.ts` | GitHub runner + Xvfb |
| Dark Modern, Light Modern, Dark+, Light+, High Contrast, High Contrast Light, narrow (zoom 2) captures | `realSuite.ts` captures + `capture-manifest.json` | GitHub runner + Xvfb |

Still a **human** step for each candidate, and not claimed by any automated job:

- inspect the theme captures, including fixed `rgba()` chrome tints in
  `reviewWebviewStyles.ts`, for legibility in every theme family and at narrow width;
- keyboard-only and screen-reader pass over the review panel and hunk actions;
- clicking the webview hunk buttons and typing inside an editable cell (the automated
  hunk acceptance drives the host commands, not webview clicks);
- staged + unstaged edits on the same file, and restart/error recovery after killing the
  server mid-review;
- independent review of the exact-candidate media. Historical media in `docs/evidence/`
  is not acceptance for a new candidate. Record failures and limitations next to the
  candidate's evidence instead of dropping them.

If a `min-engine` leg fails because of a missing API, either stop using that API or raise
`engines.vscode` to the lowest version that passes. Then update the leg's `vscode` value
(`test/certificationContract.test.ts` keeps them in sync).

## Two ways to release

`publish.yml` starts with a **Release mode** job (`scripts/release_mode.py`, shared with
`intentumdiff-python`). Its decision is in the run name and the job summary:

| Mode | How it starts | Pins from | Publishes |
|---|---|---|---|
| `repo` | a `v*` tag pushed here, or a dispatch on that tag with `dry_run: false` | the `INTENTUMDIFF_VSIX_*` variables or inputs, as before | yes |
| `orchestrated` | `buchochelliq-labs/intentumdiff-release` creates an annotated tag with a `Release-Orchestrator: <run URL>` line and dispatches `publish.yml` on it | dispatch inputs only; variables are never read | yes |
| `deferred` | the tag push that an orchestrated tag also fires | nothing | no: the orchestrated dispatch publishes |
| `orchestrated-dry-run` | the orchestrator rehearsing (`dry_run: true`) | dispatch inputs | no |
| `rehearsal` | a dispatch with `dry_run: true`, as before | inputs or variables | no |

The repo release below is unchanged and still supported. A dispatch that names an
orchestrator run must carry the run, artifact, SHA-256 and source pins, must run on a tag
whose message names a run of `intentumdiff-release`, and fails closed otherwise.

## Before tagging 0.0.3: human steps

These cannot be done by CI and must be ticked by a person for the exact candidate:

- **Vanilla VS Code, every claimed platform.** Install the reviewed VSIX into a clean profile
  (`code --user-data-dir <empty> --extensions-dir <empty> --install-extension <vsix>`), with no
  workspace settings and no other extensions, on Windows x64, Windows arm64, macOS arm64 and
  Linux x64. Confirm the extension host log is clean (no errors, no missing-file warnings),
  run a real review, open an incomplete review and walk the "Report bug…" preview to the
  dialog without opening the issue (#137, #48).
- **Point publish at the reviewed run.** After `real-runtime.yml` succeeds on the 0.0.3
  candidate, set these repository variables to that run:
  - `INTENTUMDIFF_VSIX_RUN_ID`: the successful "Packaged extension real-runtime acceptance" run ID;
  - `INTENTUMDIFF_VSIX_ARTIFACT_ID`: that run's `rc-candidate-vsix` artifact ID
    (it must contain `intentumdiff-0.0.3.vsix`);
  - `INTENTUMDIFF_VSIX_SHA256`: the SHA-256 of that VSIX;
  - `INTENTUMDIFF_VSIX_SOURCE_SHA`: the run's head commit. The tagged commit's tree must equal
    this commit's tree, or publish fails closed.

  `INTENTUMDIFF_MEDIA_ARTIFACT_ID` / `INTENTUMDIFF_MEDIA_SHA256` stay optional for 0.0.3:
  the release-media gate is deferred to 0.0.4 (#103). Run `publish.yml` by `workflow_dispatch`
  with `dry_run: true` first.
- **Credentials.** In the `marketplace` environment, confirm `VSCE_PAT` (Azure DevOps PAT with
  Marketplace *Manage* scope for the `buchochelliq-labs` publisher) and `OVSX_PAT` (Open VSX
  token for the `buchochelliq-labs` namespace) are present, valid and not about to expire.
  Confirm who holds them, because the same people own the rollback below.
- **Listings.** Check by hand that 0.0.2 is listed as a pre-release on both registries. The
  0.0.2 publish run uploaded to both, but its Open VSX check never saw the version served
  within ten minutes.

## Rollback

Publishing cannot be undone, so a rollback means *stop new installs and ship a fix*,
never *replace the bytes*. A version number that has been published is burned on both
registries, even after it is removed.

**VS Code Marketplace**

- A published version cannot be deleted or overwritten, and the same version cannot be
  published again. The fix is a **superseding version**: bump `package.json` (for example
  `0.0.3` → `0.0.4`), take it through the RC and real-runtime acceptance, and publish it on
  the same pre-release channel. Users on the pre-release channel are updated automatically.
- If the broken version must stop being installable before a fix is ready, a publisher
  owner can **unpublish** the extension, or mark it deprecated, from the publisher portal
  (`https://marketplace.visualstudio.com/manage/publishers/buchochelliq-labs`).
  - Unpublishing hides the **whole listing**, not one version: the page, install count,
    ratings and reviews stop being visible until it is published again, and nobody can
    install it in the meantime. Use it only for a defect that harms users.
  - Deprecation keeps the listing visible with a warning, and can point at a replacement.

**Open VSX**

- A single version **can** be deleted. A namespace owner can do it from the namespace
  settings on open-vsx.org; otherwise ask an Open VSX admin to delete that version
  (open an issue at `https://github.com/EclipseFdn/open-vsx.org`). The version number stays
  burned: publish the superseding version as on the Marketplace.

**Announce it**

- Edit the GitHub release for the broken tag: state the problem, the affected version,
  which registries it was removed from, and the superseding version. Add the same note
  to `CHANGELOG.md` under the broken version.
- If the problem is in the Python runtime rather than the extension, roll back the
  runtime instead (see the python repo's `docs/PYPI_RELEASE.md`): the extension does not bundle
  it.
