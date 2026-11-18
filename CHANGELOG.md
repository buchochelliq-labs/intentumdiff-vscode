# Changelog

## 0.0.3 — pre-release (unreleased)

Ships on the Marketplace and Open VSX **pre-release channel**, like 0.0.2: install it with
"Switch to Pre-Release Version" on the extension page.

### Which engine runs your reviews

- **The Python runtime is still the default on every platform.** Install it with
  `pip install --pre intentumdiff-python` (0.0.3b1 is a pre-release).
- 0.0.3 publishes **no native binaries**. The native Rust runtime (`intentumdiff-live-server`)
  can be built from source and selected with `intentumdiff.liveServer.engine: native`;
  `auto` does not select it.

### Incomplete and equivalent reviews

The engine now says how complete each review is. The extension shows that instead of
deciding it:

- **Incomplete reviews are never shown as "no changes".** Sometimes the engine finds that
  the old and new file differ but cannot explain the change. The review panel, the Semantic
  Changes tree, the semantic-only diff and the status bar tooltip then show the engine's own
  message word for word. The lines it could not explain are marked as "changed but
  unexplained" in the native diff editor, using their line positions only.
- **Report a bug, with a preview first.** "Report bug…" in the review panel, the inline
  action on the tree entry, or *IntentumDiff: Report Incomplete Review…* shows the engine's
  issue title and body in a dialog. The GitHub issue opens only when you choose "Open GitHub
  issue". If the link holds a shortened report, the dialog says so and offers "Copy full
  report" to copy the whole text. Nothing is sent automatically. The report holds only the
  text the engine wrote: no file names, paths or source code.
- **Equivalent changes** (for example JSON keys that were only reordered) are shown as
  "Equivalent (style-only)", with the name of the rule that proved them when the engine
  gives one.
- A Python runtime that does not report completeness yet behaves exactly as before.

### Building from source

- **Packaging and publishing now need Node 22.** The VSIX is built with `@vscode/vsce` 4
  (was 3.9) and published to Open VSX with `ovsx` 1.4 (was 1.0). Both require Node 22 or
  newer, which CI and `.nvmrc` already use. The extension itself is unchanged and still
  supports VS Code 1.90 and later. See `docs/BUILDING.md`.
- The upgrade clears the glob and minimatch advisories in the packaging tools. One picomatch
  advisory has no fixed release yet. It affects only the build tools, never the installed
  extension.

## 0.0.2 — 2026-11-05 (pre-release)

Published on the Marketplace and Open VSX **pre-release channel**: install it with
"Switch to Pre-Release Version" on the extension page. It stays a pre-release until it has
been used in anger; the next stable release will be a later version, as the Marketplace
does not let a pre-release version be re-published as stable.

### Which engine runs your reviews

- **The Python runtime is the default on every platform** (`intentumdiff.liveServer.engine:
  auto`). Install it with `pip install --pre intentumdiff-python` (0.0.2b2 is a pre-release).
  A native Rust runtime (`intentumdiff-live-server`) exists, but 0.0.2 publishes no native
  release, so `auto` does not select it. To use a native build anyway, set `intentumdiff.liveServer.engine` to
  `native`.
- With `auto` or `python`, a runtime installed in the workspace's `.venv` is found without
  adding it to `PATH`.
- Both runtimes now use the same Rust engine for every semantic judgement, so the extension,
  the CLI and the native server give the same answer for the same change.

### Fixed: changes that were shown as formatting-only

These change behaviour, but could appear as "style only" with nothing to review. They are now
shown as real changes:

- operator changes (`a + b` → `a - b`, `<` → `>`, `and` → `or`);
- `for await (…)` → `for (…)` and `for (k in o)` → `for (k of o)` in JavaScript and TypeScript;
- dropping `async` from a Python `async for`, `async with` or async comprehension.

Comment-only and whitespace-only edits are still shown as formatting-only.

### Release process

- The published VSIX is the exact package that passed the installed-extension acceptance tests
  on both runtimes. It is promoted, not rebuilt from the tag, and is scanned for malware
  before upload.

## 0.0.2-beta.1 — 2026-08-09

A beta. 0.0.1 was pulled from the Marketplace and Open VSX the same day it went up: it had
faults that only appear once the extension is packaged and installed, not while running from
a source checkout, so they survived local testing and showed up immediately on a real install.

0.0.2 fixes those and adds a release gate that tests the packaged artifact rather than the
source tree. It stays a beta until it has been used in anger.

### Upgrading from 0.0.1 — action required

**The extension ID changed**, from `buchochelliq-labs.intentdiff` to
`buchochelliq-labs.intentumdiff`. VS Code treats those as two different extensions, so
installing this version does **not** replace the old one — you end up with both installed at
once, each registering its own commands, status-bar items and providers. The symptom is
confusing rather than obvious: whichever loads first wins, and the other appears broken.

Uninstall the old one:

```bash
code --uninstall-extension buchochelliq-labs.intentdiff
```

The extension now detects the old one and says so on startup, rather than leaving you to work
out why two copies are fighting.

Or find "IntentDiff" (no *um*) in the Extensions view and remove it. Only people who installed
0.0.1 during the short window it was published are affected — it has since been removed from
both marketplaces, so it cannot be installed fresh.

### Fixed

- **Image assets never showed a perceptual diff.** The review panel always reported
  "PERCEPTUAL DIFF PENDING" because the extension synthesised a placeholder instead of asking
  the engine — which had been able to produce overlay, heatmap, mask and difference artifacts
  the whole time.
- **Two notifications reported ordinary states as problems.** "Needs a ready semantic review"
  appeared while a review was simply still running, and a second narrated a fallback that had
  already succeeded. Both are now transient status-bar messages.
- **The image summary starved its own heading**, wrapping the description one word per line.
- **Every chrome icon was blank once installed.** The packaged extension excluded the codicon
  font it links at runtime, so the stylesheet 404'd in any Marketplace install. It looked
  correct in every source checkout, because there the font sits exactly where the code expects
  — which is why it survived the whole test suite. The packaging step now checks that every
  asset the interface loads is actually in the artefact.

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
