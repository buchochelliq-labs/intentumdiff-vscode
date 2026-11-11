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
