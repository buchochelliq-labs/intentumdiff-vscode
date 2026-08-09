# Changelog

## 0.0.2-beta.1 — 2026-08-09

A beta, because 0.0.1 was published without anyone installing it into a clean editor and using
it. That release was pulled from the Marketplace and Open VSX within a day.

### Fixed

- **Image assets never showed a perceptual diff.** The review panel always reported
  "PERCEPTUAL DIFF PENDING" because the extension synthesised a placeholder instead of asking
  the engine — which had been able to produce overlay, heatmap, mask and difference artifacts
  the whole time.
- **Two notifications reported ordinary states as problems.** "Needs a ready semantic review"
  appeared while a review was simply still running, and a second narrated a fallback that had
  already succeeded. Both are now transient status-bar messages.
- **The image summary starved its own heading**, wrapping the description one word per line.

### Changed

- **Requires the engine.** The extension runs the `intentumdiff` command, so
  `pip install intentumdiff-python` is a prerequisite — now stated first in the listing rather
  than implied. 0.0.1 said the executable must be on `PATH` without saying how to get it.
- The listing no longer carries developer setup instructions; they moved to `CONTRIBUTING.md`.

### Internal

- **CI ran 17 of the repository's 260 unit tests.** A deleted test's stale compiled output kept
  failing, and the fix at the time excluded it by name — silently excluding sixteen healthy
  files too. Those tests all passed; nothing was watching them. The build now clears stale
  output and discovers tests by glob.

### Known limitations

- Perceptual image diff is wired to the engine but the demo scene still needs work
  (buchochelliq-labs/intentumdiff-vscode#25).

## 0.0.1 - 2026-08-04

First stable release, and the first under the **IntentumDiff** name (previously IntentDiff).

- Added natural-language intent explanations ("what + why") on hovers, CodeLens,
  inlay hints, and release notes, with honest no-op/stub detection.
- Added an **opt-in** AI intent explainer (off by default) supporting your
  existing GitHub Copilot (`vscode-lm`), Anthropic, or an OpenAI-compatible /
  local endpoint — Bring-Your-Own-Key, key stored in VS Code SecretStorage.
- **Privacy-first LLM policy:** the explainer sends a locally-derived semantic
  summary, **not your source code**. New `intentumdiff.intent.llm.codeSharing`
  levels (`signatures` default / `facts` / `full`); verbatim source is only ever
  sent to a **local** endpoint — cloud providers and Copilot auto-downgrade. See
  [PRIVACY.md](PRIVACY.md).

## 0.0.1-beta.1 - 2026-06-03

- Added live semantic diff feedback through `intentumdiff live-server --stdio`.
- Added the Source Control **Semantic Changes** tree for saved working-tree
  review.
- Added group-first review entries for moved code, refactorings, meaningful
  changes, ignored style, and suppressed noise.
- Added native VS Code diff navigation with side-aware semantic decorations.
- Added guardrail diagnostics and pinned guardrail review entries.
- Added Marketplace-ready icon, banner metadata, and curated release media.
