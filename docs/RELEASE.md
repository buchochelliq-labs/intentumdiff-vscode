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
