Warning: truncated output (original token count: 29187)
Total output lines: 2968

import { statusForOwner, type StatusContext } from "./statusOwnership";
import { panelReviewFile } from "./reviewPanelState";
import * as path from "path";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import * as vscode from "vscode";
import { BaseContentProvider } from "./baseContentProvider";
import { ReviewTelemetryService } from "./reviewTelemetryService";
import { ServerSessionManager, type LiveServerFailureDetails, type ServerSession } from "./serverSessionManager";
import {
  DiffSurfaceController,
  type OpenedDiffContext,
  type OpenFileReviewPayload,
} from "./diffSurfaceController";
import { ReviewPollingService } from "./reviewPollingService";
import { createReviewSnapshot, readWorkingTreeFile } from "./reviewSnapshotSource";
import {
  fallbackDiffEnabled,
  readDiffMode,
  readFuelPolicy,
  readLiveServerSettings,
  readReviewMaxAutoRetries,
  readReviewDiffContextLines,
  readReviewDiffSurface,
  readReviewGroupingMode,
  readSemanticOnlyOptions,
  resolveExecutableForFolder,
  workspaceVenvIntentumDiffCandidates,
  type NativeDiffMode,
} from "./extensionSettings";
import { BASE_SCHEME, assertSafeRelativePath, decodeBaseIdentity } from "./baseUri";
import {
  buildLiveServerArgs,
  buildLiveServerEnv,
  readTrustedExecutable,
  readTrustedSchemaAllowPrivateHosts,
  readTrustedSchemaFetchMode,
} from "./config";
import { EMPTY_SCHEME, EmptyContentProvider } from "./emptyContentProvider";
import {
  buildIntentLenses,
  categoryForKind,
  riskForKind,
  type IntentLensContext,
  type IntentSide,
  type PeekIntentArgs,
} from "./intentCodeLens";
import {
  IntentCodeActionProvider,
  IntentCodeLensProvider,
  IntentHoverProvider,
  IntentInlayHintsProvider,
} from "./intentCodeLensProvider";
import { IntentLlmExplainer } from "./intentLlmExplainer";
import {
  buildReleaseNotes,
  releaseNotesToJson,
  releaseNotesToMarkdown,
} from "./releaseNotes";
import {
  reviewActionTargetForPayload,
  semanticReviewHunkEditForPayload,
  semanticReviewActionTargetForPayload,
  type SemanticReviewActionKind,
  type SemanticReviewHunkEdit,
} from "./reviewActionModel";
import {
  diffToBaseDecorations,
  diffToDiagnostics,
  diffToModifiedDecorations,
  reviewTargetForChange,
  summarizeDiff,
} from "./mapper";
import {
  LiveServerClient,
  type AssetDiffEnvelope,
  type DiffResultEnvelope,
  type ReviewFileEnvelope,
  type ReviewResultEnvelope,
} from "./protocol";
import { ProcessLineTransport } from "./processTransport";
import {
  nextReviewFileGroupingMode,
  normalizeReviewFileGroupingMode,
  isStyleOnlyReviewDiff,
  reviewEntriesForCrossFileChanges,
  summarizeReviewWithCrossFile,
  type ReviewCrossFileEntry,
  type ReviewFile,
  type ReviewFileGroupingMode,
} from "./reviewModel";
import {
  SemanticReviewTreeProvider,
  type OpenReviewPayload,
  type ReviewDiffSurface,
  type ReviewTreeNode,
} from "./reviewTree";
import {
  ReviewDashboardWebviewProvider,
  ReviewPanelWebviewController,
} from "./reviewWebview";
import { registerReviewTimelineProvider, ReviewTimelineProvider } from "./reviewTimeline";
import {
  appendReviewTimelineSnapshot,
  createReviewTimelineSnapshot,
  type ReviewTimelineSnapshot,
} from "./reviewTimelineModel";
import {
  buildReviewDashboardModel,
  buildReviewPanelModel,
  DEFAULT_REVIEW_FUEL_POLICY,
  type ReviewFuelHistory,
  type ReviewFuelPolicy,
  type ReviewWebviewMessage,
  type ReviewWebviewPayload,
} from "./reviewWebviewModel";
import {
  createReviewRefreshSnapshot,
  planReviewRefresh,
  type ReviewRefreshFile,
  type ReviewRefreshSnapshot,
} from "./reviewRefresh";
import {
  discoverWorkingTreeFilesForFolder,
  resolveGitRef,
  type WorkingTreeFile,
} from "./scm";
import { selectionTargetForDocument } from "./selectionRange";
import {
  decodeSemanticOnlyIdentity,
  SEMANTIC_BASE_SCHEME,
  SEMANTIC_MODIFIED_SCHEME,
  SemanticOnlyContentProvider,
} from "./semanticOnlyContentProvider";
import {
  projectDecorations,
  projectPosition,
  selectedChanges,
  type SemanticOnlyOptions,
  type SemanticOnlyProjection,
} from "./semanticOnlyDiff";
import type { CommitDiff, DecorationLike, DiagnosticLike, LiveServerSettings, NodePosition, SemanticDiff } from "./types";
import {
  DiagnosticsParserCall,
  DiagnosticsReport,
  DiagnosticsReportFile,
  FuelSummary,
  arrayRecords,
  createDiagnosticsNonce,
  diagnosticsReportMarkdown,
  emptyFuelSummary,
  escapeHtml,
  formatFuel,
  fuelSummaryForDiff,
  numberField,
  parserCallsForDiff,
  recordField,
  renderDiagnosticsReportHtml,
  statusSummary,
  stringField,
  uniqueStrings,
} from "./diagnosticsReport";
import {
  applyGitIndexPatch,
  delay,
  existingOrEmptyModifiedUri,
  fileUriExists,
  fileUriFromGitPath,
  findVisibleTextEditor,
  gitUriPathCandidates,
  isOldOnlyChange,
  isReviewTreeNode,
  isTextDiffTabInput,
  messageOf,
  nonNegativeNumber,
  normalizeOpenReviewPayload,
  readFuelSetting,
  safeDecodeURIComponent,
  samePosition,
  semanticLineHintDecorations,
  shouldRevealBaseSide,
  toDecorationOption,
  toRange,
  toSeverity,
  toVsDiagnostic,
  wordRangeForInlineDeletion,
  workspaceFileUriFromGitUri,
} from "./extensionEditorUtils";
import {
  imageAssetReviewDiff,
  isImageLikePath,
  nonTextAssetReviewDiff,
  normalizeReviewDiffFilenames,
  pendingMessageFor,
  requestKey,
  reviewGroupingModeLabel,
  reviewKey,
  withAssetDiffFailure,
  withEngineAssetDiff,
} from "./reviewAssetDiffs";

interface IncrementalReviewRequest {
  folderUri: string;
  relativePath: string;
  seq: number;
  generation: number;
  stamp: string;
  status: ReviewRefreshFile["status"];
}

/** The pre-rebrand extension id. Kept as a literal: it is history, not configuration. */
const RETIRED_EXTENSION_ID = "buchochelliq-labs.intentdiff";

/**
 * Warn when the pre-rebrand extension is still installed alongside this one.
 *
 * VS Code treats a renamed id as a DIFFERENT extension, so installing this version does not
 * replace `intentdiff` — both stay enabled, both register the same commands, providers and
 * status-bar items, and whichever activates first wins. The symptom is not "two extensions
 * installed"; it is commands that do nothing, or results from a version the user thought they
 * had replaced. That is unattributable from the outside, so say it plainly.
 *
 * The changelog documents this, but a changelog only reaches people who read one.
 */
function warnAboutRetiredExtension(): void {
  if (!vscode.extensions.getExtension(RETIRED_EXTENSION_ID)) {
    return;
  }
  const uninstall = "Show me how";
  void vscode.window
    .showWarningMessage(
      "The older 'IntentDiff' extension is still installed. It registers the same commands as " +
        "IntentumDiff, so results may come from whichever loads first. Uninstall it to avoid " +
        "confusing behaviour.",
      uninstall,
    )
    .then((choice) => {
      if (choice !== uninstall) {
        return;
      }
      void vscode.commands.executeCommand(
        "workbench.extensions.search",
        `@installed ${RETIRED_EXTENSION_ID}`,
      );
    });
}

export function activate(context: vscode.ExtensionContext): void {
  warnAboutRetiredExtension();
  const controller = new PysdController(context);
  context.subscriptions.push(controller);
  controller.activate();
}

export function deactivate(): void {
  // VS Code disposes subscriptions from activate().
}

class PysdController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("IntentumDiff");
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("IntentumDiff");
  private readonly status = vscode.window.createStatusBarItem("intentumdiff.comparisonStatus", vscode.StatusBarAlignment.Left, 20);
  private workspaceStatus = "IntentumDiff";
  private readonly pendingLiveStatus = new Set<string>();
  private readonly diffStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  private readonly reviewTree = new SemanticReviewTreeProvider();
  private readonly reviewTimeline = new ReviewTimelineProvider();
  private readonly baseContentProvider = new BaseContentProvider(this.output);
  private readonly emptyContentProvider = new EmptyContentProvider();
  private readonly semanticOnlyContentProvider = new SemanticOnlyContentProvider();
  private readonly intentCodeLens = new IntentCodeLensProvider((uri) => this.intentLensContext(uri));
  private readonly intentInlayHints = new IntentInlayHintsProvider((uri) => this.intentLensContext(uri));
  private intentLlmExplainer!: IntentLlmExplainer;
  private readonly serverSessions: ServerSessionManager;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly decorationCache = new Map<string, DecorationLike[]>();
  private readonly semanticLineHintCache = new Map<string, vscode.DecorationOptions[]>();
  private readonly diffSurfaces: DiffSurfaceController;
  // Live diffs keyed by working-file URI so intent CodeLens appears on the
  // editing buffer (not only inside the diff editor).
  private readonly liveIntentContexts = new Map<string, { diff: SemanticDiff; folderUri: string; relativePath: string }>();
  private readonly navigationIndexes = new Map<string, number>();
  private readonly reviewFiles = new Map<string, ReviewFile>();
  private readonly reviewRequests = new Map<string, {
    folderUri: string;
    seq: number;
    snapshot?: ReviewRefreshSnapshot;
  }>();
  private readonly reviewSlowTimers = new Map<string, NodeJS.Timeout>();
  private readonly incrementalReviewRequests = new Map<string, IncrementalReviewRequest>();
  /** In-flight perceptual asset requests, keyed like every other protocol request. */
  private readonly assetDiffRequests = new Map<string, {
    folderUri: string;
    relativePath: string;
    generation: number;
  }>();
  private readonly streamedReviewFiles = new Map<string, Set<string>>();
  private readonly reviewSnapshots = new Map<string, ReviewRefreshSnapshot>();
  private readonly telemetry: ReviewTelemetryService;
  private readonly liveServerWarningKeys = new Set<string>();
  private reviewCrossFileEntries: ReviewCrossFileEntry[] = [];
  private reviewView: vscode.TreeView<ReviewTreeNode> | undefined;
  private scmReviewView: vscode.TreeView<ReviewTreeNode> | undefined;
  private reviewDashboardProvider: ReviewDashboardWebviewProvider | undefined;
  private reviewPanelController: ReviewPanelWebviewController | undefined;
  private reviewPanelPayload: OpenFileReviewPayload | undefined;
  private reviewViewVisible = false;
  private reviewWasVisible = false;
  private reviewRefreshTimer: NodeJS.Timeout | undefined;
  private reviewDispatching = false;
  private reviewRefreshRunning = false;
  // Auto-retry guard (issue 123): a failing review must not hot-loop. Deterministic failures
  // (same input -> same error) are never auto-retried; transient ones retry up to the
  // configurable cap. Any real input change or explicit user action resets the streak.
  private reviewFailureStreak = 0;
  private reviewFailureGeneration = -1;
  private lastReviewFailure: { code?: string; message: string } | undefined;
  private reviewRetrySuppressedLogged = false;
  private readonly nonRetryableReviewCodes = new Set([
    "native_fallback",
    "invalid_request",
    "invalid_ref",
    "invalid_path",
    "invalid_content",
    "invalid_stream",
    "invalid_deltas",
    "invalid_seq",
    "invalid_json",
    "invalid_op",
    "unsupported_protocol",
    "line_too_large",
    "content_too_large",
    "too_many_deltas",
  ]);
  private readonly streakResetRefreshReasons = new Set([
    "document save",
    "file change",
    "file create",
    "file delete",
    "file rename",
    "manual refresh",
    "restart",
    "enabled",
  ]);
  private reviewRefreshQueued = false;
  private pendingReviewForceFull = false;
  private pendingReviewAllowHidden = false;
  private pendingReviewReason = "refresh";
  private reviewGeneration = 0;
  private readonly reviewPolling: ReviewPollingService;
  private paused = false;
  private overlaysVisible = true;
  private hideComments = false;

  // Category accents (overview-ruler ticks, borders, inline markers) use the
  // contributed intentumdiff.semanticChanges.* tokens so the live overlay shares
  // one palette with every other surface. Line backgrounds keep the
  // theme-native translucent diffEditor.* tokens (the contributed tokens are
  // vivid foregrounds, unsuitable as a full-strength background).
  private readonly decorationTypes = {
    addition: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.addition"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    deletion: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.deletion"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    modification: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("diffEditor.changedTextBackground"),
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.modification"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    move: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      border: "1px dashed",
      borderColor: new vscode.ThemeColor("intentumdiff.semanticChanges.movedCode"),
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.movedCode"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    refactoring: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      border: "1px solid",
      borderColor: new vscode.ThemeColor("intentumdiff.semanticChanges.refactoring"),
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.refactoring"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    style: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: "0.65",
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.muted"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    inlineDeletionWord: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("diffEditor.changedTextBackground"),
      border: "1px dotted",
      borderColor: new vscode.ThemeColor("intentumdiff.semanticChanges.deletion"),
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.deletion"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    inlineDeletionGap: vscode.window.createTextEditorDecorationType({
      textDecoration: "none; border-left: 1px dotted; border-right: 1px dotted;",
      after: {
        color: new vscode.ThemeColor("intentumdiff.semanticChanges.deletion"),
        backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
        margin: "0 0 0 0.25em",
      },
      overviewRulerColor: new vscode.ThemeColor("intentumdiff.semanticChanges.deletion"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
  };

  private readonly semanticLineHintDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor("editorLineNumber.foreground"),
      margin: "0 1.5em 0 0",
    },
  });

  constructor(private readonly context: vscode.ExtensionContext) {
    this.diffSurfaces = new DiffSurfaceController({
      output: this.output,
      baseContentProvider: this.baseContentProvider,
      emptyContentProvider: this.emptyContentProvider,
      semanticOnlyContentProvider: this.semanticOnlyContentProvider,
      hideComments: () => this.hideComments,
      reviewFileFor: (folderUri, relativePath) => this.reviewFiles.get(reviewKey(folderUri, relativePath)),
      resolvedCommitFor: (folderUri) => this.reviewSnapshots.get(folderUri)?.resolvedCommit,
      openReviewPanel: (payload) => this.openReviewPanel(payload),
      applyDiffVisuals: (uri, diff) => this.applyDiffVisuals(uri, diff),
      applyBaseDiffVisuals: (uri, diff) => this.applyBaseDiffVisuals(uri, diff),
      setDecorationsForUri: (uri, decorations) => this.setDecorationsForUri(uri, decorations),
      setSemanticLineHintsForUri: (uri, options) => this.setSemanticLineHintsForUri(uri, options),
      onContextsChanged: () => {
        this.updateEditorContext();
        this.intentCodeLens.refresh();
        this.intentInlayHints.refresh();
      },
    });
    this.reviewPolling = new ReviewPollingService({
      output: this.output,
      subscribe: (disposable) => this.context.subscriptions.push(disposable),
      onRefreshNeeded: (reason) => this.scheduleReviewRefresh(reason),
    });
    this.serverSessions = new ServerSessionManager({
      output: this.output,
      extensionPath: context.extensionPath,
      trace: (message) => this.trace(message),
      setStatusText: (text) => { this.status.text = text; },
      onDiff: (folder, result) => this.handleDiff(folder, result),
      onReviewResult: (folder, result) => this.handleReviewResult(folder, result),
      onReviewFile: (folder, result) => this.handleReviewFile(folder, result),
      onAssetDiff: (folder, result) => this.handleAssetDiff(folder, result),
      onReviewError: (folder, seq, message, code) => this.handleReviewError(folder, seq, message, code),
      onIncrementalReviewError: (folder, seq, message, code) =>
        this.handleIncrementalReviewError(folder, seq, message, code),
      onAssetDiffError: (folder, seq, message) => this.handleAssetDiffError(folder, seq, message),
      onProtocolError: (error) => this.handleProtocolError(error),
      onFailure: (folder, details) => this.notifyLiveServerFailure(folder, details),
    });
    this.telemetry = new ReviewTelemetryService({
      output: this.output,
      workspaceState: context.workspaceState,
      reviewFiles: () => [...this.reviewFiles.values()],
      fuelPolicy: () => readFuelPolicy(),
      setTimelineSnapshots: (snapshots) => this.reviewTimeline.setReviewSnapshots(snapshots),
    });
    this.status.command = "intentumdiff.showOutput";
    this.status.text = "IntentumDiff";
    this.status.tooltip = "IntentumDiff";
    this.diffStatus.name = "IntentumDiff mode";
  }

  activate(): void {
    this.status.show();
    this.closeStaleBaseDirectoryTabs();
    this.intentLlmExplainer = new IntentLlmExplainer(this.context.secrets, this.context.globalState);
    this.telemetry.restore();
    this.reviewTree.setGroupingMode(readReviewGroupingMode());
    this.reviewTree.setDiffSurface(readReviewDiffSurface());
    const reviewView = vscode.window.createTreeView("intentumdiff.review", {
      treeDataProvider: this.reviewTree,
      showCollapseAll: true,
    });
    const scmReviewView = vscode.window.createTreeView("intentumdiff.semanticChanges", {
      treeDataProvider: this.reviewTree,
      showCollapseAll: true,
    });
    const reviewDashboardProvider = new ReviewDashboardWebviewProvider(
      () => buildReviewDashboardModel(
        [...this.reviewFiles.values()],
        this.reviewCrossFileEntries,
        readReviewGroupingMode(),
        this.telemetry.fuelHistorySnapshot(),
        readFuelPolicy(),
        [...this.telemetry.timeline()],
      ),
      (message) => this.handleReviewWebviewMessage(message),
      () => this.syncReviewViewVisibility("dashboard visibility"),
      this.context.extensionUri,
    );
    const reviewPanelController = new ReviewPanelWebviewController(
      this.context.extensionUri,
      (message) => this.handleReviewWebviewMessage(message),
      () => this.refreshComparisonStatus(),
    );
    const workspaceFileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.reviewView = reviewView;
    this.scmReviewView = scmReviewView;
    this.reviewDashboardProvider = reviewDashboardProvider;
    this.reviewPanelController = reviewPanelController;
    this.context.subscriptions.push(
      this.output,
      this.diagnostics,
      this.status,
      this.diffStatus,
      this.reviewTree,
      this.baseContentProvider,
      this.emptyContentProvider,
      this.semanticOnlyContentProvider,
      vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, this.baseContentProvider),
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, this.emptyContentProvider),
      vscode.workspace.registerTextDocumentContentProvider(SEMANTIC_BASE_SCHEME, this.semanticOnlyContentProvider),
      vscode.workspace.registerTextDocumentContentProvider(SEMANTIC_MODIFIED_SCHEME, this.semanticOnlyContentProvider),
      reviewDashboardProvider,
      reviewPanelController,
      vscode.window.registerWebviewViewProvider("intentumdiff.dashboard", reviewDashboardProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      registerReviewTimelineProvider(vscode.workspace, this.reviewTimeline),
      this.intentCodeLens,
      vscode.languages.registerCodeLensProvider(
        [{ scheme: "file" }, { scheme: BASE_SCHEME }, { scheme: EMPTY_SCHEME }],
        this.intentCodeLens,
      ),
      vscode.languages.registerHoverProvider(
        [{ scheme: "file" }, { scheme: BASE_SCHEME }, { scheme: EMPTY_SCHEME }],
        new IntentHoverProvider((uri) => this.intentLensContext(uri), this.intentLlmExplainer),
      ),
      vscode.commands.registerCommand("intentumdiff.setIntentExplainerKey", () => this.intentLlmExplainer.setKey()),
      vscode.commands.registerCommand("intentumdiff.clearIntentExplainerKey", () => this.intentLlmExplainer.clearKey()),
      vscode.languages.registerCodeActionsProvider(
        [{ scheme: "file" }, { scheme: BASE_SCHEME }, { scheme: EMPTY_SCHEME }],
        new IntentCodeActionProvider((uri) => this.intentLensContext(uri)),
        { providedCodeActionKinds: IntentCodeActionProvider.kinds },
      ),
      this.intentInlayHints,
      vscode.languages.registerInlayHintsProvider(
        [{ scheme: "file" }, { scheme: BASE_SCHEME }, { scheme: EMPTY_SCHEME }],
        this.intentInlayHints,
      ),
      vscode.commands.registerCommand(
        "intentumdiff.peekIntent",
        (args?: PeekIntentArgs) => this.peekIntent(args),
      ),
      reviewView,
      scmReviewView,
      reviewView.onDidChangeVisibility(() => this.syncReviewViewVisibility("view visibility")),
      scmReviewView.onDidChangeVisibility(() => this.syncReviewViewVisibility("view visibility")),
      vscode.commands.registerCommand("intentumdiff.toggle", () => this.toggle()),
      vscode.commands.registerCommand("intentumdiff.toggleEditorDiff", () => this.toggleEditorDiff()),
      vscode.commands.registerCommand("intentumdiff.showEditorDiff", () => this.setEditorDiffVisible(true)),
      vscode.commands.registerCommand("intentumdiff.hideEditorDiff", () => this.setEditorDiffVisible(false)),
      vscode.commands.registerCommand("intentumdiff.toggleHideComments", () => this.toggleHideComments()),
      vscode.commands.registerCommand("intentumdiff.showCommentChanges", () => this.setHideComments(false)),
      vscode.commands.registerCommand("intentumdiff.hideCommentChanges", () => this.setHideComments(true)),
      vscode.commands.registerCommand("intentumdiff.configureVisibleChangeTypes", () => this.configureVisibleChangeTypes()),
      vscode.commands.registerCommand("intentumdiff.restartServer", () => this.restartAll()),
      vscode.commands.registerCommand("intentumdiff.diffActiveFile", () => this.diffActiveEditorNow()),
      vscode.commands.registerCommand("intentumdiff.showOutput", () => this.output.show()),
      vscode.commands.registerCommand("intentumdiff.refreshReview", () => this.requestFullReview("manual refresh")),
      vscode.commands.registerCommand("intentumdiff.openReviewDashboard", () => this.openReviewDashboard()),
      vscode.commands.registerCommand("intentumdiff.openDiagnostics", () => this.telemetry.openDiagnosticsReport()),
      vscode.commands.registerCommand("intentumdiff.exportDiagnostics", () => this.telemetry.exportDiagnosticsReport()),
      vscode.commands.registerCommand("intentumdiff.cycleReviewGrouping", () => this.cycleReviewGrouping()),
      vscode.commands.registerCommand(
        "intentumdiff.openReviewPanel",
        (payload?: OpenReviewPayload | ReviewTreeNode | ReviewWebviewPayload) => this.openReviewPanel(payload),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.openNativeDiff",
        () => this.openReviewPanelNativeDiff("full"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.openSemanticOnlyDiff",
        () => this.openReviewPanelNativeDiff("semanticOnly"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.stageFile",
        async (payload?: OpenReviewPayload | ReviewWebviewPayload) => {
          const uri = this.reviewPayloadUri(payload);
          if (!uri) {
            void vscode.window.showInformationMessage("IntentumDiff: no reviewed file is available to stage.");
            return;
          }
          await vscode.commands.executeCommand("git.stage", uri);
        },
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.revertFile",
        async (payload?: OpenReviewPayload | ReviewWebviewPayload) => {
          const uri = this.reviewPayloadUri(payload);
          if (!uri) {
            void vscode.window.showInformationMessage("IntentumDiff: no reviewed file is available to revert.");
            return;
          }
          const choice = await vscode.window.showWarningMessage(
            "Revert this file through VS Code Git?",
            { modal: true },
            "Revert File",
          );
          if (choice === "Revert File") {
            await vscode.commands.executeCommand("git.clean", uri);
          }
        },
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.stageHunk",
        async (payload?: ReviewWebviewPayload) => this.handleSemanticHunkAction("stageHunk", payload),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.revertHunk",
        async (payload?: ReviewWebviewPayload) => this.handleSemanticHunkAction("revertHunk", payload),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.applyHunk",
        async (payload?: ReviewWebviewPayload) => this.handleSemanticHunkAction("applyHunk", payload),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.previousChange",
        () => this.reviewPanelController?.postPanelCommand("previousChange"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.nextChange",
        () => this.reviewPanelController?.postPanelCommand("nextChange"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.toggleRail",
        () => this.reviewPanelController?.postPanelCommand("toggleRail"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.toggleEvidenceDrawer",
        () => this.reviewPanelController?.postPanelCommand("toggleEvidenceDrawer"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.reviewPanel.setView",
        (reviewView?: string) => this.reviewPanelController?.postPanelCommand("setReviewView", reviewView),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.openSemanticDiff",
        (payload: OpenReviewPayload | ReviewTreeNode) => this.diffSurfaces.open(payload),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.openChange",
        (payload: OpenReviewPayload | ReviewTreeNode) => this.diffSurfaces.open(payload),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.openSemanticOnlyDiff",
        (payload?: OpenReviewPayload | ReviewTreeNode) => this.diffSurfaces.open(payload, "semanticOnly"),
      ),
      vscode.commands.registerCommand(
        "intentumdiff.openFullDiff",
        (payload?: OpenReviewPayload | ReviewTreeNode) => this.diffSurfaces.open(payload, "full"),
      ),
      vscode.commands.registerCommand("intentumdiff.nextSemanticChange", () => this.navigateSemanticChange(1)),
      vscode.commands.registerCommand("intentumdiff.previousSemanticChange", () => this.navigateSemanticChange(-1)),
      vscode.commands.registerCommand("intentumdiff.expandSemanticDiffContext", () => this.adjustSemanticContextLines(1)),
      vscode.commands.registerCommand("intentumdiff.collapseSemanticDiffContext", () => this.adjustSemanticContextLines(-1)),
      vscode.commands.registerCommand("intentumdiff.clearReview", () => this.clearReview()),
      vscode.commands.registerCommand("intentumdiff.revealActiveFileInReview", () => this.revealActiveFileInReview()),
      vscode.workspace.onDidOpenTextDocument((document) => this.scheduleDocument(document)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.scheduleDocument(document);
        this.scheduleReviewRefresh("document save");
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.scheduleDocument(event.document)),
      workspaceFileWatcher,
      workspaceFileWatcher.onDidChange((uri) => this.scheduleReviewRefreshForKnownFileChange(uri)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.pendingLiveStatus.delete(document.uri.toString());
        this.clearDocumentVisuals(document.uri);
      }),
      vscode.workspace.onDidCreateFiles(() => this.scheduleReviewRefresh("file create")),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleReviewRefresh("file delete")),
      vscode.workspace.onDidRenameFiles(() => this.scheduleReviewRefresh("file rename", …14187 tokens truncated…      if (counterpart) {
        const counterpartUri = otherSide === "base" ? context.baseUri : context.modifiedUri;
        await vscode.commands.executeCommand(
          "editor.action.showReferences",
          sourceUri,
          sourcePosition,
          [new vscode.Location(counterpartUri, new vscode.Position(Math.max(counterpart.line, 0), 0))],
        );
        return;
      }
    }
    // No counterpart line (pure addition/deletion) or live-only buffer: reveal
    // and surface the derived category/risk.
    const editor = await vscode.window.showTextDocument(sourceUri, { preview: false });
    editor.selection = new vscode.Selection(sourcePosition, sourcePosition);
    editor.revealRange(new vscode.Range(sourcePosition, sourcePosition), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (group) {
      const risk = riskForKind(group.kind);
      const label = categoryForKind(group.kind)?.label ?? group.kind;
      void vscode.window.showInformationMessage(
        `IntentumDiff${risk ? ` · ${risk === "behavior" ? "Behavior" : "Internal"}` : ""}: ${label}`,
      );
    }
  }

  private async navigateSemanticChange(direction: 1 | -1): Promise<void> {
    const context = this.diffSurfaces.active();
    if (!context?.diff) {
      void vscode.window.showInformationMessage("IntentumDiff: no semantic diff is active.");
      return;
    }
    const targets = selectedChanges(context.diff, readSemanticOnlyOptions(this.hideComments))
      .map(({ change, index }) => ({
        change,
        index,
        target: reviewTargetForChange(change),
      }))
      .filter((item): item is {
        change: NonNullable<typeof item.change>;
        index: number;
        target: NonNullable<ReturnType<typeof reviewTargetForChange>>;
      } => item.target !== undefined);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage("IntentumDiff: no visible semantic changes to navigate.");
      return;
    }
    const key = `${context.folderUri}::${context.relativePath}::${context.mode}`;
    const current = this.navigationIndexes.get(key) ?? (direction > 0 ? -1 : targets.length);
    const next = (current + direction + targets.length) % targets.length;
    this.navigationIndexes.set(key, next);
    const target = targets[next];
    await this.diffSurfaces.reveal(context, {
      ...context.payload,
      position: target.target.position,
      positionSide: target.target.side,
      change: target.change,
    });
  }

  private async adjustSemanticContextLines(delta: 1 | -1): Promise<void> {
    const config = vscode.workspace.getConfiguration("intentumdiff");
    const current = Math.max(0, config.get("diff.contextLines", 3));
    const next = Math.max(0, current + delta);
    if (next === current) {
      void vscode.window.showInformationMessage("IntentumDiff: semantic-only context is already collapsed.");
      return;
    }
    await config.update("diff.contextLines", next, vscode.ConfigurationTarget.Workspace);
    this.status.text = `IntentumDiff: semantic context ${next}`;
    this.updateEditorContext();
    await this.diffSurfaces.refreshOpenSemanticOnly();
  }

  private async revealActiveFileInReview(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      return;
    }
    const target = this.resolveDocument(document);
    if (!target) {
      return;
    }
    const node = this.reviewTree.revealFile(target.relativePath);
    if (node) {
      const targetView = this.reviewView?.visible
        ? this.reviewView
        : this.scmReviewView?.visible
          ? this.scmReviewView
          : this.reviewView ?? this.scmReviewView;
      await targetView?.reveal(node, { focus: true, select: true, expand: true });
    }
  }

  private handleReviewResult(folder: vscode.WorkspaceFolder, result: ReviewResultEnvelope): void {
    const request = this.reviewRequests.get(requestKey(folder.uri.toString(), result.seq));
    if (!request) {
      return;
    }
    this.resetReviewFailureStreak();
    this.completeReviewRequest(folder.uri.toString(), result.seq);
    this.applyCommitReview(folder, result.commitDiff);
    // The engine skips binary/image assets (they are not text-diffable), so they
    // never appear in commit_diff.file_diffs. Reconcile any snapshot file still
    // "pending" here, or it would hang the review at "Refreshing...".
    this.reconcileSkippedReviewFiles(folder, request.snapshot);
    if (request.snapshot) {
      this.reviewSnapshots.set(folder.uri.toString(), request.snapshot);
    } else {
      void this.recordReviewSnapshot(folder);
    }
    this.updateReviewTree();
    this.output.appendLine(JSON.stringify({
      review: {
        files: result.commitDiff.file_diffs?.length ?? 0,
        guardrails: result.commitDiff.guardrail_violations?.length ?? 0,
        crossFileChanges: result.commitDiff.cross_file_changes?.length ?? 0,
        parseErrors: result.commitDiff.parse_errors?.length ?? 0,
        fileNames: (result.commitDiff.file_diffs ?? [])
          .map((diff) => diff.new_filename || diff.old_filename || "unknown")
          .slice(0, 25),
      },
      workspace: folder.name,
    }, null, 2));
    this.finishReviewIfIdle();
  }

  private handleReviewFile(folder: vscode.WorkspaceFolder, result: ReviewFileEnvelope): void {
    const request = this.reviewRequests.get(requestKey(folder.uri.toString(), result.seq));
    if (!request) {
      return;
    }
    const folderUri = folder.uri.toString();
    const relativePath = result.newFilename || result.oldFilename || "unknown";
    if (relativePath === ".intentumdiff-review" || relativePath === "unknown") {
      return;
    }
    const reviewFile: ReviewFile = {
      folderName: folder.name,
      folderUri,
      relativePath,
      status: "ready",
      diff: result.fileDiff,
    };
    this.reviewFiles.set(reviewKey(folderUri, relativePath), reviewFile);
    let streamed = this.streamedReviewFiles.get(folderUri);
    if (!streamed) {
      streamed = new Set();
      this.streamedReviewFiles.set(folderUri, streamed);
    }
    streamed.add(relativePath);
    this.telemetry.recordFuelTelemetry(folderUri, relativePath, result.fileDiff);
    this.updateReviewTree();
    this.output.appendLine(JSON.stringify({
      streamedReviewFile: {
        path: relativePath,
        index: result.index,
      },
      workspace: folder.name,
    }, null, 2));
  }

  /** Count at most ONE failure per review generation so ten per-file errors in a single
   *  dispatch don't exhaust the retry budget in one cycle. */
  private recordReviewFailure(message: string, code?: string): void {
    this.lastReviewFailure = { code, message };
    if (this.reviewFailureGeneration !== this.reviewGeneration) {
      this.reviewFailureGeneration = this.reviewGeneration;
      this.reviewFailureStreak += 1;
    }
  }

  private resetReviewFailureStreak(): void {
    this.reviewFailureStreak = 0;
    this.reviewFailureGeneration = -1;
    this.lastReviewFailure = undefined;
    this.reviewRetrySuppressedLogged = false;
  }

  /** Non-empty reason when automatic review dispatch should pause (issue 123): the last failure is
   *  deterministic (retrying the same input cannot help), or the configurable retry budget is
   *  spent. Manual refresh / restart / any file change resets the streak and resumes. */
  private autoReviewRetrySuppression(): string | undefined {
    if (this.reviewFailureStreak === 0) {
      return undefined;
    }
    const code = this.lastReviewFailure?.code;
    if (code && this.nonRetryableReviewCodes.has(code)) {
      return "last review failed with non-retryable '" + code + "'";
    }
    const maxRetries = readReviewMaxAutoRetries();
    if (this.reviewFailureStreak > maxRetries) {
      return "review failed " + this.reviewFailureStreak
        + " times (intentumdiff.review.maxAutoRetries = " + maxRetries + ")";
    }
    return undefined;
  }

  private handleReviewError(
    folder: vscode.WorkspaceFolder,
    seq: number,
    message: string,
    code?: string,
  ): boolean {
    const key = requestKey(folder.uri.toString(), seq);
    const request = this.reviewRequests.get(key);
    if (!request) {
      return false;
    }
    this.recordReviewFailure(message, code);
    this.completeReviewRequest(folder.uri.toString(), seq);
    this.reviewFiles.set(reviewKey(folder.uri.toString(), ".intentumdiff-review"), {
      folderName: folder.name,
      folderUri: folder.uri.toString(),
      relativePath: ".intentumdiff-review",
      status: "error",
      error: message,
    });
    this.updateReviewTree();
    this.finishReviewIfIdle();
    return true;
  }

  private handleIncrementalReviewError(
    folder: vscode.WorkspaceFolder,
    seq: number,
    message: string,
    code?: string,
  ): boolean {
    const key = requestKey(folder.uri.toString(), seq);
    const request = this.incrementalReviewRequests.get(key);
    if (!request) {
      return false;
    }
    this.incrementalReviewRequests.delete(key);
    if (request.generation !== this.reviewGeneration) {
      return true;
    }
    this.recordReviewFailure(message, code);
    this.reviewFiles.set(reviewKey(request.folderUri, request.relativePath), {
      folderName: folder.name,
      folderUri: request.folderUri,
      relativePath: request.relativePath,
      status: "error",
      error: message,
    });
    this.updateReviewTree();
    this.finishReviewIfIdle();
    return true;
  }

  /**
   * Ask the engine to compare one image against the review ref.
   *
   * Only a repo-relative path and the ref go over the wire — the base version lives in git's
   * object store and the engine materialises it. Nothing here opens, decodes, or describes an
   * image; the panel shows a comparison only once `handleAssetDiff` has one to show.
   */
  private requestAssetDiff(folder: vscode.WorkspaceFolder, relativePath: string): void {
    const folderUri = folder.uri.toString();
    for (const [key, request] of this.assetDiffRequests.entries()) {
      if (request.folderUri === folderUri && request.relativePath === relativePath) {
        this.assetDiffRequests.delete(key);
      }
    }
    try {
      const session = this.serverSessions.ensure(folder);
      const seq = session.client.assetDiff(relativePath, { ref: readLiveServerSettings().ref });
      this.assetDiffRequests.set(requestKey(folderUri, seq), {
        folderUri,
        relativePath,
        generation: this.reviewGeneration,
      });
    } catch (error) {
      this.applyAssetDiffOutcome(folderUri, relativePath, (diff) =>
        withAssetDiffFailure(diff, messageOf(error)));
    }
  }

  private handleAssetDiff(folder: vscode.WorkspaceFolder, result: AssetDiffEnvelope): void {
    const key = requestKey(folder.uri.toString(), result.seq);
    const request = this.assetDiffRequests.get(key);
    if (!request) {
      return;
    }
    this.assetDiffRequests.delete(key);
    if (request.generation !== this.reviewGeneration) {
      return;
    }
    this.applyAssetDiffOutcome(request.folderUri, request.relativePath, (diff) =>
      withEngineAssetDiff(diff, result.manifest));
    this.output.appendLine(JSON.stringify({
      assetDiff: {
        path: request.relativePath,
        status: result.manifest.status ?? "unknown",
        artifacts: Object.keys((result.manifest.artifacts as Record<string, unknown>) ?? {}),
      },
      workspace: folder.name,
    }, null, 2));
  }

  private handleAssetDiffError(folder: vscode.WorkspaceFolder, seq: number, message: string): boolean {
    const key = requestKey(folder.uri.toString(), seq);
    const request = this.assetDiffRequests.get(key);
    if (!request) {
      return false;
    }
    this.assetDiffRequests.delete(key);
    if (request.generation === this.reviewGeneration) {
      // A failed perceptual compare does not fail the file's review — the image is still a
      // reviewable change. Only the perceptual half is unavailable, and it says so.
      this.applyAssetDiffOutcome(request.folderUri, request.relativePath, (diff) =>
        withAssetDiffFailure(diff, message));
    }
    return true;
  }

  /** Rewrite a ready image entry's diff in place and refresh whatever is showing it. */
  private applyAssetDiffOutcome(
    folderUri: string,
    relativePath: string,
    apply: (diff: SemanticDiff) => SemanticDiff,
  ): void {
    const key = reviewKey(folderUri, relativePath);
    const existing = this.reviewFiles.get(key);
    if (!existing?.diff) {
      return;
    }
    this.reviewFiles.set(key, { ...existing, diff: apply(existing.diff) });
    this.updateReviewTree();
    void this.refreshOpenReviewPanel();
  }

  private applyCommitReview(folder: vscode.WorkspaceFolder, commitDiff: CommitDiff): void {
    const folderUri = folder.uri.toString();
    const streamed = this.streamedReviewFiles.get(folderUri);
    this.streamedReviewFiles.delete(folderUri);
    this.reviewFiles.delete(reviewKey(folderUri, ".intentumdiff-review"));
    for (const diff of commitDiff.file_diffs ?? []) {
      const relativePath = diff.new_filename || diff.old_filename || "unknown";
      this.reviewFiles.set(reviewKey(folderUri, relativePath), {
        folderName: folder.name,
        folderUri,
        relativePath,
        status: "ready",
        diff,
      });
      if (!streamed?.has(relativePath)) {
        this.telemetry.recordFuelTelemetry(folderUri, relativePath, diff);
      }
    }
    if ((commitDiff.parse_errors?.length ?? 0) > 0) {
      this.reviewFiles.set(reviewKey(folderUri, ".intentumdiff-review"), {
        folderName: folder.name,
        folderUri,
        relativePath: ".intentumdiff-review",
        status: "error",
        error: commitDiff.parse_errors?.slice(0, 5).join("\n"),
      });
    }
    this.reviewCrossFileEntries.push(...reviewEntriesForCrossFileChanges(
      commitDiff.cross_file_changes ?? [],
      folderUri,
    ));
    const hasReviewContent = (commitDiff.file_diffs?.length ?? 0) > 0
      || (commitDiff.parse_errors?.length ?? 0) > 0
      || (commitDiff.cross_file_changes?.length ?? 0) > 0;
    if (!hasReviewContent) {
      this.reviewFiles.set(reviewKey(folderUri, ".intentumdiff-review"), {
        folderName: folder.name,
        folderUri,
        relativePath: ".intentumdiff-review",
        status: "ready",
        diff: {
          old_filename: ".intentumdiff-review",
          new_filename: ".intentumdiff-review",
          language: "generic",
          changes: [],
          change_groups: [],
          guardrail_violations: [],
          parse_errors: [],
          has_semantic_changes: false,
          is_style_only: false,
        },
      });
    }
  }

  /**
   * Mark any snapshot file the engine skipped (binary/image assets the semantic
   * text engine does not diff) as `ready`, so the streaming review can finish.
   * Images get the perceptual asset preview; other binaries get a non-text-asset
   * entry. Files the engine did report are left untouched.
   */
  private reconcileSkippedReviewFiles(
    folder: vscode.WorkspaceFolder,
    snapshot: ReviewRefreshSnapshot | undefined,
  ): void {
    if (!snapshot) {
      return;
    }
    const folderUri = folder.uri.toString();
    for (const file of snapshot.files) {
      const key = reviewKey(folderUri, file.relativePath);
      const existing = this.reviewFiles.get(key);
      if (!existing || existing.status !== "pending") {
        continue;
      }
      const isImage = isImageLikePath(file.relativePath);
      const diff = isImage
        ? imageAssetReviewDiff(folder, file)
        : nonTextAssetReviewDiff(file);
      this.reviewFiles.set(key, {
        folderName: folder.name,
        folderUri,
        relativePath: file.relativePath,
        status: "ready",
        diff,
      });
      if (isImage) {
        this.requestAssetDiff(folder, file.relativePath);
      }
    }
  }

  private setReviewPlaceholder(folder: vscode.WorkspaceFolder, pendingMessage: string): void {
    this.reviewFiles.set(reviewKey(folder.uri.toString(), ".intentumdiff-review"), {
      folderName: folder.name,
      folderUri: folder.uri.toString(),
      relativePath: ".intentumdiff-review",
      status: "pending",
      pendingMessage,
    });
  }

  private completeReviewRequest(folderUri: string, seq: number): void {
    const key = requestKey(folderUri, seq);
    this.reviewRequests.delete(key);
    const timer = this.reviewSlowTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.reviewSlowTimers.delete(key);
    }
  }

  private updateReviewTree(): void {
    const roots = new Map<string, string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.set(folder.uri.toString(), folder.name);
    }
    this.reviewTree.setReview([...this.reviewFiles.values()], this.reviewCrossFileEntries, roots);
    this.reviewTimeline.setReviewFiles([...this.reviewFiles.values()]);
    this.refreshReviewWebviews();
  }

  private finishReviewIfIdle(): void {
    const pendingCount = this.reviewRequests.size + this.incrementalReviewRequests.size;
    if (pendingCount > 0) {
      this.setWorkspaceStatus(`IntentumDiff: reviewing ${pendingCount} pending`);
      return;
    }
    this.updateReviewTree();
    this.telemetry.recordTimelineSnapshot();
    const summary = summarizeReviewWithCrossFile(
      [...this.reviewFiles.values()],
      this.reviewCrossFileEntries.map((entry) => entry.change),
    );
    if (summary.guardrailCount > 0) {
      this.setWorkspaceStatus(`IntentumDiff: review ${summary.guardrailCount} guardrail`);
    } else if (summary.errorCount > 0) {
      this.setWorkspaceStatus(`IntentumDiff: review ${summary.errorCount} error`);
    } else if (summary.crossFileChangeCount > 0) {
      this.setWorkspaceStatus(`IntentumDiff: review ${summary.crossFileChangeCount} cross-file`);
    } else {
      this.setWorkspaceStatus(`IntentumDiff: review ${summary.semanticChangeCount} changes`);
    }
    this.output.appendLine(JSON.stringify({ reviewSummary: summary }, null, 2));
    this.drainQueuedReviewRefresh();
  }

  private drainQueuedReviewRefresh(): void {
    if (!this.reviewRefreshQueued) {
      return;
    }
    const reason = this.pendingReviewReason;
    const forceFull = this.pendingReviewForceFull;
    const allowHidden = this.pendingReviewAllowHidden;
    this.reviewRefreshQueued = false;
    this.pendingReviewForceFull = false;
    this.pendingReviewAllowHidden = false;
    this.scheduleReviewRefresh(reason, { forceFull, allowHidden });
  }

  private applyCachedDecorations(editor: vscode.TextEditor): void {
    this.applyDecorations(
      editor,
      this.filterDecorations(this.decorationCache.get(editor.document.uri.toString()) ?? []),
    );
    this.applySemanticLineHints(editor);
  }

  private applyDecorations(editor: vscode.TextEditor, decorations: DecorationLike[]): void {
    const byKind = new Map<DecorationLike["kind"], vscode.DecorationOptions[]>();
    for (const decoration of decorations) {
      const options = toDecorationOption(decoration);
      if (decoration.kind === "inlineDeletionWord") {
        options.range = wordRangeForInlineDeletion(editor, options.range);
      }
      const current = byKind.get(decoration.kind) ?? [];
      current.push(options);
      byKind.set(decoration.kind, current);
    }
    for (const [kind, decorationType] of Object.entries(this.decorationTypes)) {
      editor.setDecorations(
        decorationType,
        byKind.get(kind as DecorationLike["kind"]) ?? [],
      );
    }
  }

  private resolveDocument(document: vscode.TextDocument):
    | { folder: vscode.WorkspaceFolder; relativePath: string }
    | undefined {
    if (document.uri.scheme !== "file" || document.isUntitled) {
      return undefined;
    }
    return this.resolveWorkspaceUri(document.uri);
  }

  private resolveWorkspaceLikeUri(uri: vscode.Uri):
    | { folder: vscode.WorkspaceFolder; relativePath: string }
    | undefined {
    if (uri.scheme === "file") {
      return this.resolveWorkspaceUri(uri);
    }
    if (uri.scheme === "git") {
      const candidate = workspaceFileUriFromGitUri(uri);
      return candidate ? this.resolveWorkspaceUri(candidate) : undefined;
    }
    return undefined;
  }

  private resolveWorkspaceUri(uri: vscode.Uri):
    | { folder: vscode.WorkspaceFolder; relativePath: string }
    | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return {
      folder,
      relativePath: relative.split(path.sep).join("/"),
    };
  }

  private isEnabled(): boolean {
    return !this.paused && readLiveServerSettings().enabled;
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.reviewRefreshTimer) {
      clearTimeout(this.reviewRefreshTimer);
      this.reviewRefreshTimer = undefined;
    }
    this.reviewPolling.stopPolling();
  }

  private clearVisuals(): void {
    this.diagnostics.clear();
    this.decorationCache.clear();
    this.semanticLineHintCache.clear();
    this.liveIntentContexts.clear();
    this.pendingLiveStatus.clear();
    this.intentCodeLens.refresh();
    this.intentInlayHints.refresh();
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorations(editor, []);
      editor.setDecorations(this.semanticLineHintDecoration, []);
    }
  }

  private applyDiffVisuals(uri: vscode.Uri, diff: SemanticDiff): void {
    if (diff.is_fallback === true && !fallbackDiffEnabled()) {
      this.diagnostics.set(uri, [new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        "IntentumDiff fallback diff is disabled for this file.",
        vscode.DiagnosticSeverity.Warning,
      )]);
      this.setDecorationsForUri(uri, []);
      return;
    }
    this.diagnostics.set(uri, this.overlaysVisible ? diffToDiagnostics(diff).map(toVsDiagnostic) : []);
    this.setDecorationsForUri(uri, diffToModifiedDecorations(diff));
  }

  private applyBaseDiffVisuals(uri: vscode.Uri, diff: SemanticDiff): void {
    this.setDecorationsForUri(uri, diffToBaseDecorations(diff));
  }

  private filterDecorations(decorations: DecorationLike[]): DecorationLike[] {
    if (!this.overlaysVisible) {
      return [];
    }
    const config = vscode.workspace.getConfiguration("intentumdiff");
    const showAdditions = config.get("visualization.showAdditions", true);
    const showDeletions = config.get("visualization.showDeletions", true);
    const showModifications = config.get("visualization.showModifications", true);
    const inlineDeletionMarkers = config.get("visualization.inlineDeletionMarkers", true);
    const movedCode = config.get("visualization.movedCode", true);
    return decorations.filter((decoration) => {
      if (this.hideComments && decoration.isComment === true) {
        return false;
      }
      if (!showAdditions && decoration.kind === "addition") {
        return false;
      }
      if (!showDeletions && (
        decoration.kind === "deletion"
        || decoration.kind === "inlineDeletionWord"
        || decoration.kind === "inlineDeletionGap"
      )) {
        return false;
      }
      if (!showModifications && decoration.kind === "modification") {
        return false;
      }
      if (!inlineDeletionMarkers && (
        decoration.kind === "inlineDeletionWord"
        || decoration.kind === "inlineDeletionGap"
      )) {
        return false;
      }
      if (!movedCode && (
        decoration.kind === "move"
        || decoration.kind === "refactoring"
      )) {
        return false;
      }
      return true;
    });
  }

  private readVisualSettings(): void {
    const config = vscode.workspace.getConfiguration("intentumdiff");
    this.hideComments = config.get("diff.hideComments", false);
  }

  private setWorkspaceStatus(text: string): void {
    this.workspaceStatus = text;
    this.refreshComparisonStatus();
  }

  private refreshComparisonStatus(): void {
    if (!this.isEnabled()) return;
    const panel = this.reviewPanelController?.activeModel;
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const native = !panel && activeTab?.input instanceof vscode.TabInputTextDiff
      ? this.diffSurfaces.active() : undefined;
    const comparison: StatusContext | undefined = panel
      ? { relativePath: panel.file.relativePath, baseline: panel.ref, diff: panel.diff,
          pending: panel.file.status === "pending", error: panel.file.status === "error" }
      : native ? { relativePath: native.relativePath, baseline: "Git review", diff: native.diff } : undefined;
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    const context = uri ? this.liveIntentContexts.get(uri) : undefined;
    const live: StatusContext | undefined = context
      ? { ...context, baseline: "live file", pending: this.pendingLiveStatus.has(uri!) }
      : uri && this.pendingLiveStatus.has(uri) ? { relativePath: vscode.window.activeTextEditor!.document.uri.fsPath, baseline: "live file", pending: true } : undefined;
    const presentation = statusForOwner(this.workspaceStatus, comparison, live);
    this.status.text = presentation.text;
    this.status.tooltip = presentation.tooltip;
  }

  private updateEditorContext(): void {
    const activeContext = this.diffSurfaces.active();
    void vscode.commands.executeCommand("setContext", "intentumdiff.editorDiffVisible", this.overlaysVisible);
    void vscode.commands.executeCommand("setContext", "intentumdiff.hideComments", this.hideComments);
    void vscode.commands.executeCommand("setContext", "intentumdiff.inSemanticDiff", activeContext !== undefined);
    void vscode.commands.executeCommand("setContext", "intentumdiff.semanticOnlyDiffVisible", activeContext?.mode === "semanticOnly");
    this.updateDiffStatus(activeContext);
    this.refreshComparisonStatus();
  }

  private updateDiffStatus(activeContext: OpenedDiffContext | undefined): void {
    if (!activeContext) {
      this.diffStatus.hide();
      return;
    }
    const options = readSemanticOnlyOptions(this.hideComments);
    const visibleFilters = [
      options.showAdditions ? "additions" : undefined,
      options.showDeletions ? "deletions" : undefined,
      options.showModifications ? "modifications" : undefined,
      options.movedCode ? "moves" : undefined,
      !options.hideComments ? "comments" : undefined,
    ].filter((item): item is string => item !== undefined);
    if (activeContext.mode === "semanticOnly") {
      this.diffStatus.text = `$(filter) IntentumDiff semantic-only (${options.contextLines} ctx)`;
      this.diffStatus.command = "intentumdiff.openFullDiff";
      this.diffStatus.tooltip = [
        "IntentumDiff semantic-only native diff",
        `Context lines: ${options.contextLines}`,
        `Visible: ${visibleFilters.join(", ") || "none"}`,
        "Click to switch to the full VS Code diff.",
      ].join("\n");
    } else {
      this.diffStatus.text = "$(diff) IntentumDiff full diff";
      this.diffStatus.command = "intentumdiff.openSemanticOnlyDiff";
      this.diffStatus.tooltip = [
        "IntentumDiff full VS Code diff",
        `Semantic-only context lines: ${options.contextLines}`,
        `Semantic-only visible filters: ${visibleFilters.join(", ") || "none"}`,
        "Click to switch to semantic-only diff.",
      ].join("\n");
    }
    this.diffStatus.show();
  }

  private refreshVisibleDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyCachedDecorations(editor);
      if (!this.overlaysVisible) {
        this.diagnostics.delete(editor.document.uri);
      }
    }
  }

  private applySemanticLineHints(editor: vscode.TextEditor): void {
    editor.setDecorations(
      this.semanticLineHintDecoration,
      this.semanticLineHintCache.get(editor.document.uri.toString()) ?? [],
    );
  }

  private setDecorationsForUri(uri: vscode.Uri, decorations: DecorationLike[]): void {
    this.decorationCache.set(uri.toString(), decorations);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.applyDecorations(editor, this.filterDecorations(decorations));
      }
    }
  }

  private setSemanticLineHintsForUri(uri: vscode.Uri, decorations: vscode.DecorationOptions[]): void {
    this.semanticLineHintCache.set(uri.toString(), decorations);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.applySemanticLineHints(editor);
      }
    }
  }

  private clearDocumentVisuals(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
    this.decorationCache.delete(uri.toString());
    this.semanticLineHintCache.delete(uri.toString());
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.applyDecorations(editor, []);
        editor.setDecorations(this.semanticLineHintDecoration, []);
      }
    }
  }

  private handleProtocolError(error: { code: string; message: string }): void {
    this.status.text = "IntentumDiff: error";
    this.output.appendLine(`IntentumDiff error: ${error.code}: ${error.message}`);
    if (error.code === "unsupported_protocol") {
      void vscode.window.showWarningMessage(
        "IntentumDiff LiveServer protocol v2 is required. Update IntentumDiff or check intentumdiff.executable.",
      );
    }
  }

  private trace(message: string): void {
    if (readLiveServerSettings().trace) {
      this.output.appendLine(message);
    }
  }
}
