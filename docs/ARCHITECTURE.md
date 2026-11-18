# intentumdiff-vscode architecture

## Topology

The extension renders what an external engine process serves. Rust owns semantic
analysis, protocol handlers and asset processing; the extension renders the engine's
results. Which engine process starts is decided by `chooseLiveServerLaunch`
(`src/config.ts`) and the `intentumdiff.liveServer.engine` setting (default `auto`):

1. An explicit `intentumdiff.executable` path wins (as native, or as the Python CLI when the
   engine is `python`).
2. `python` always launches the Python runtime (`intentumdiff-python`, which hosts the Rust
   core); `native` always launches the Rust `intentumdiff-live-server`.
3. `auto` uses a bundled native server if the VSIX carries one (none does today), else the
   native server only on a platform listed in `VERIFIED_NATIVE_PLATFORMS`. That list is
   **empty** in this release, so `auto` selects the **Python runtime on every platform**.
   Native bundling or per-platform defaults are not a committed decision; a platform is
   added only once its native release asset is published.

The VSIX contains the extension and review assets. It does not bundle Python, a native
live-server binary, or parser components. A native server's verified parser components must
remain next to it in `wasm/`. The selected engine is never silently swapped: if it fails to
start, that is reported as an error (there is no automatic fallback to the other runtime).

## Surfaces (native-first)

- **The native diff editor is primary** — diffs open with `vscode.diff` (left: read-only
  `intentumdiff-base:` from `git show`; right: the real working-tree file). Editing re-runs the
  engine (debounced) and refreshes intent live. No webview diff editors (see "Editing
  boundary" below for the review panel's verified hunk actions). An open comparison
  records its identity (baseline ref + working-tree right side); every live or review result
  for the same file and baseline reconciles it in place (CodeLens, status, navigation and the
  semantic-only projection read the same current diff). A full refresh keeps contexts whose
  tabs are still open instead of orphaning them.
- **Intent** surfaces as CodeLens (`CATEGORY · why`), a Peek command, and semantic decorations
  bound to the contributed `intentumdiff.semanticChanges.*` colors. Risk derives from category.
- **One review webview** (dashboard, Intent/Risk/Evidence/Notes/Release-Notes tabs, per-hunk
  staging, the perceptual image diff) — all artifacts come from the engine; **no image
  processing in the webview**.

### Editing boundary (decision for #134)

The native diff editor is the only **free-form** editing surface (open, type, add or remove
lines; the engine re-runs live). The review panel is **not a diff editor**: no Monaco, no
open-a-file editing, no line insertion or removal. It keeps a closed set of hunk- or
file-scoped SCM actions that the extension host performs; the panel only sends a message.

| Panel message | Host path | Safety |
|---|---|---|
| `stageFile` | VS Code `git.stage` | Native Git extension. |
| `revertFile` | VS Code `git.clean` | Modal confirmation; native Git extension. |
| `stageHunk` | `git apply --cached` | Patch carries real context, so Git validates it against the actual index (#125). |
| `revertHunk` | `WorkspaceEdit` | Modal confirmation; the reviewed working lines (or, for a deletion, its neighbours) must still match the live document byte-for-byte (#119, #125). |
| `editHunk` ("Apply edits" on an existing hunk's cells) | `WorkspaceEdit` | Verified against the untouched reviewed lines; exact characters, EOL and final-newline state preserved; saved only if the file had no other unsaved edits (#119, #120). |
| `previewHunk` / bare `applyHunk` | none | Shows the patch; never writes. |

`REVIEW_WEBVIEW_WRITE_COMMANDS` in `reviewWebviewModel.ts` is the code copy of this list and
a test keeps both in sync; adding a write path means extending this table and meeting the
same verification bar. "Edit in native" on each hunk hands off to the native diff.

Deep-dive on the diff viewer: [architecture/diff-viewer.md](architecture/diff-viewer.md).

## Invariants

- **Theme-native**: `--vscode-*` variables + contributed color IDs only — no hardcoded chrome
  hex, no bundled fonts; must read natively in Dark+, Light+, High-Contrast. Codicons only.
- **Privacy/BYOK**: no bundled keys; keys in SecretStorage; cloud consent precedes any send;
  default payloads are privacy-safe fact sheets (never raw source to a cloud endpoint).
- **Engine positions**: `start_line`/`end_line` are 0-based lines and `start_col`/`end_col`
  are 0-based **UTF-8 byte offsets within the line** (tree-sitter columns). VS Code columns are
  UTF-16 code units, so every engine position is converted against the exact source of the side
  it addresses (`selectionRange.engineRangeToUtf16`) before it becomes a selection, decoration
  or diagnostic range. Each bound converts on its own line (a multiline end column is never
  widened by the start column); malformed, out-of-document or code-point-splitting bounds are
  reported inexact and are revealed without a selection rather than invented.
- The extension keeps a long-running engine process — after an engine/component rebuild,
  restart it (Reload Window) before re-diagnosing "stale" behavior.

## Responsibility map (engine vs presentation)

The extension is a thin client: it renders what the engine states and never makes a
source-derived semantic claim of its own (#131, #133).

| Fact | Owner | Extension behaviour |
|---|---|---|
| `change_type`, `refactoring_kind`, node positions/facts | Engine (authoritative) | Rendered as given. |
| `change_groups[].kind` (Meaningful / Refactoring / Moved / Style / Noise) | Engine (authoritative) | Label, icon, colour only. Style/noise hidden from lenses because the engine said so. |
| Display bucket of an **ungrouped** change (`kindForChange`) | Presentation | Fixed 1:1 rendering of the engine enums above (ADDITION/DELETION/MODIFICATION → Meaningful, MOVE/REORDER → Moved, REFACTORING or `refactoring_kind` → Refactoring, STYLE_ONLY → Style). Any other or missing `change_type` is **Unclassified**: shown, with no risk. |
| Risk badge (Behavior / Internal / Content) | Presentation, derived | Derived only from the engine kind above plus the content class; an unknown kind has no risk and lands in release-notes "Other", never "Behavior". |
| Content class (code / docs / config / data / text) | Presentation heuristic today | `contentClass.ts` uses the engine's `language`, `metadata.content_type.category` and node types to choose wording and to say "Content" instead of "Behavior" on non-code files. It must only *soften* claims, never add one. |
| Noise / style disposition, guardrails, asset artifacts | Engine (authoritative) | Never decided on the host. |

Open engine-schema gap: the content class and a per-group risk/impact are not engine fields
yet. When Core emits them (proposed: `SemanticDiff.content_class` and `ChangeGroup.impact`),
the extension should render them in place of the heuristic and the derived badge.

`review-shell/` is the shared review-rendering package (also used by the desktop shell);
`release-media/` holds the validated visual-proof set gated by
`.github/workflows/release-media-manifest-gate.yml`.
