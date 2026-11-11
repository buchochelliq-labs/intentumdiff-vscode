import type { CommitDiff, LiveResponse, ReadyMessage, SemanticDiff } from "./types";

export interface LineTransport {
  writeLine(line: string): void;
}

export interface DiffRequestOptions {
  ref?: string;
  stream?: boolean;
  purpose?: DiffRequestPurpose;
}

export type DiffRequestPurpose = "live" | "review";

export interface DiffResultEnvelope {
  path: string;
  seq: number;
  purpose: DiffRequestPurpose;
  response: LiveResponse;
}

export interface ReviewResultEnvelope {
  seq: number;
  commitDiff: CommitDiff;
  response: LiveResponse;
}

export interface ReviewFileEnvelope {
  seq: number;
  fileDiff: SemanticDiff;
  oldFilename: string;
  newFilename: string;
  index: number;
  response: LiveResponse;
}

/** The engine's perceptual manifest for one image, carried through untouched. */
export interface AssetDiffEnvelope {
  seq: number;
  path: string;
  manifest: Record<string, unknown>;
  response: LiveResponse;
}

export type ClientEvent =
  | { kind: "ready"; ready: ReadyMessage }
  | { kind: "diff"; result: DiffResultEnvelope }
  | { kind: "review"; result: ReviewResultEnvelope }
  | { kind: "review_file"; result: ReviewFileEnvelope }
  | { kind: "asset_diff"; result: AssetDiffEnvelope }
  | { kind: "error"; seq: number; error: { code: string; message: string } }
  | { kind: "malformed"; message: string; line: string };

export class JsonLineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/u);
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  }
}

export interface LiveServerClientOptions {
  /**
   * Allocate the next request sequence number. Sessions share one monotonic
   * allocator (see ServerSessionManager) so a replacement session never reuses
   * a sequence number a retired session may still answer.
   */
  allocateSeq?: () => number;
}

/**
 * Metadata for one in-flight request. It lives only while the request is
 * active: a terminal response (success or error), a cancel, or supersession
 * by a newer request for the same lane removes it (issue 128), so a long
 * session retains state proportional to active work.
 */
type PendingRequest =
  | { kind: "diff"; path: string; diffKey: string; purpose: DiffRequestPurpose }
  | { kind: "review" }
  | { kind: "asset_diff"; path: string }
  | { kind: "hello" };

export class LiveServerClient {
  private seq = 0;
  /** Lowest and highest sequence numbers this client has issued (0 = none yet). */
  private firstIssuedSeq = 0;
  private lastIssuedSeq = 0;
  /** Active requests only; see PendingRequest. */
  private readonly pending = new Map<number, PendingRequest>();
  /** Current seq per diff lane (`purpose:path`), only while that request is active. */
  private readonly pathToSeq = new Map<string, number>();
  /** The newest review seq (staleness), and whether it is still active. */
  private latestReviewSeq = 0;
  private readonly listeners: Array<(event: ClientEvent) => void> = [];
  ready: ReadyMessage | undefined;

  constructor(
    private readonly transport: LineTransport,
    private readonly options: LiveServerClientOptions = {},
  ) {}

  /** Number of active requests (bounded by in-flight work, not session lifetime). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Number of active diff lanes. */
  get activeDiffLaneCount(): number {
    return this.pathToSeq.size;
  }

  onEvent(listener: (event: ClientEvent) => void): void {
    this.listeners.push(listener);
  }

  private allocate(): number {
    const seq = this.options.allocateSeq ? this.options.allocateSeq() : this.seq + 1;
    this.seq = seq;
    if (this.firstIssuedSeq === 0) {
      this.firstIssuedSeq = seq;
    }
    this.lastIssuedSeq = seq;
    return seq;
  }

  private start(request: PendingRequest): number {
    const seq = this.allocate();
    this.pending.set(seq, request);
    return seq;
  }

  /** Release every piece of metadata for `seq`. */
  private release(seq: number): void {
    const request = this.pending.get(seq);
    this.pending.delete(seq);
    if (request?.kind === "diff" && this.pathToSeq.get(request.diffKey) === seq) {
      this.pathToSeq.delete(request.diffKey);
    }
    if (request?.kind === "review" && this.latestReviewSeq === seq) {
      this.latestReviewSeq = 0;
    }
  }

  /**
   * True when an error for `seq` does not belong to an active request this
   * client issued (superseded diff, older or cancelled review, a request that
   * already completed, or a seq that predates this client). Such errors are
   * obsolete and must not reach the host.
   */
  private isObsoleteSeq(seq: number): boolean {
    if (seq <= 0 || this.firstIssuedSeq === 0 || seq > this.lastIssuedSeq) {
      return false;
    }
    return !this.pending.has(seq);
  }

  diff(path: string, content: string, options: DiffRequestOptions = {}): number {
    const purpose = options.purpose ?? "live";
    const diffKey = diffRequestKey(path, purpose);
    const previousSeq = this.pathToSeq.get(diffKey);
    const nextSeq = this.start({ kind: "diff", path, diffKey, purpose });
    if (previousSeq !== undefined) {
      this.send({
        op: "cancel",
        seq: previousSeq,
        path,
      });
      this.release(previousSeq);
    }
    this.pathToSeq.set(diffKey, nextSeq);
    this.send({
      op: "diff",
      seq: nextSeq,
      path,
      content,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.stream !== undefined ? { stream: options.stream } : {}),
    });
    return nextSeq;
  }

  hello(): void {
    this.send({ op: "hello", seq: this.start({ kind: "hello" }) });
  }

  review(options: { oldRef?: string; newRef?: string; stream?: boolean } = {}): number {
    const previous = this.latestReviewSeq;
    const nextSeq = this.start({ kind: "review" });
    if (previous > 0 && this.pending.has(previous)) {
      // Cancel only a review that is still running, never completed work.
      this.send({ op: "cancel", seq: previous });
      this.release(previous);
    }
    this.latestReviewSeq = nextSeq;
    this.send({
      op: "review",
      seq: nextSeq,
      ...(options.oldRef ? { old_ref: options.oldRef } : {}),
      ...(options.newRef !== undefined ? { new_ref: options.newRef } : {}),
      ...(options.stream !== undefined ? { stream: options.stream } : {}),
    });
    return nextSeq;
  }

  /**
   * Ask the engine for one image's perceptual diff against `ref`.
   *
   * Only the path and the ref go over the wire: the *before* bytes live in git's object
   * store, and materialising them is the engine's job. The extension never opens an image.
   */
  assetDiff(path: string, options: { ref?: string } = {}): number {
    const nextSeq = this.start({ kind: "asset_diff", path });
    this.send({
      op: "asset_diff",
      seq: nextSeq,
      path,
      ...(options.ref ? { ref: options.ref } : {}),
    });
    return nextSeq;
  }

  /** Forget an asset request once its outcome (result or error) has been handled. */
  forgetAssetDiff(seq: number): void {
    if (this.pending.get(seq)?.kind === "asset_diff") {
      this.release(seq);
    }
  }

  /**
   * Cancel an active request by seq, or the active diff(s) for a path. Work
   * that already completed (or was never issued) is not cancelled again; the
   * cancelled request's metadata is released so its late answer is dropped.
   */
  cancel(pathOrSeq: string | number): void {
    if (typeof pathOrSeq === "number") {
      if (!this.pending.has(pathOrSeq)) {
        return;
      }
      this.send({ op: "cancel", seq: pathOrSeq });
      this.release(pathOrSeq);
      return;
    }
    for (const purpose of ["live", "review"] as const) {
      const seq = this.pathToSeq.get(diffRequestKey(pathOrSeq, purpose));
      if (seq !== undefined) {
        this.send({ op: "cancel", seq, path: pathOrSeq });
        this.release(seq);
      }
    }
  }

  handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit({
        kind: "malformed",
        line,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!isRecord(parsed)) {
      this.emit({ kind: "malformed", line, message: "protocol line is not an object" });
      return;
    }

    if (parsed.op === "ready") {
      if (parsed.ok !== true || parsed.protocol_version !== 2) {
        this.emit({
          kind: "error",
          seq: 0,
          error: {
            code: "unsupported_protocol",
            message: "IntentumDiff live-server did not report protocol version 2",
          },
        });
        return;
      }
      this.ready = parsed as unknown as ReadyMessage;
      this.emit({ kind: "ready", ready: this.ready });
      return;
    }

    const response = parsed as LiveResponse;
    const seq = typeof response.seq === "number" ? response.seq : 0;
    if (response.ok === false || response.error) {
      if (this.isObsoleteSeq(seq)) {
        // An obsolete request's error (typically its cancellation) is not the
        // current request's outcome; ownership is checked before emitting.
        return;
      }
      // An error is terminal for its request.
      this.release(seq);
      this.emit({
        kind: "error",
        seq,
        error: response.error ?? {
          code: "protocol_error",
          message: "IntentumDiff returned an unsuccessful response",
        },
      });
      return;
    }

    const request = this.pending.get(seq);
    if (request?.kind === "hello") {
      this.release(seq);
      return;
    }

    if (response.op === "diff" && response.diff) {
      if (request?.kind !== "diff" || this.pathToSeq.get(request.diffKey) !== seq) {
        return;
      }
      // `done: false` marks an intermediate stream frame; anything else is terminal.
      if (response.done !== false) {
        this.release(seq);
      }
      this.emit({ kind: "diff", result: { path: request.path, seq, purpose: request.purpose, response } });
      return;
    }

    if (response.op === "asset_diff" && response.result) {
      if (request?.kind !== "asset_diff") {
        return;
      }
      this.release(seq);
      this.emit({
        kind: "asset_diff",
        result: { seq, path: request.path, manifest: response.result, response },
      });
      return;
    }

    if (response.op === "review" && response.commit_diff) {
      if (request?.kind !== "review" || this.latestReviewSeq !== seq) {
        return;
      }
      // The commit-level result is the review's terminal frame.
      this.release(seq);
      this.emit({
        kind: "review",
        result: {
          seq,
          commitDiff: response.commit_diff,
          response,
        },
      });
      return;
    }

    if (response.op === "review_file" && response.file_diff) {
      // Intermediate stream frame: the review stays active.
      if (request?.kind !== "review" || this.latestReviewSeq !== seq) {
        return;
      }
      this.emit({
        kind: "review_file",
        result: {
          seq,
          fileDiff: response.file_diff,
          oldFilename: typeof response.old_filename === "string" ? response.old_filename : "",
          newFilename: typeof response.new_filename === "string" ? response.new_filename : "",
          index: typeof response.index === "number" ? response.index : 0,
          response,
        },
      });
    }
  }

  private send(payload: Record<string, unknown>): void {
    this.transport.writeLine(JSON.stringify(payload));
  }

  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffRequestKey(path: string, purpose: DiffRequestPurpose = "live"): string {
  return `${purpose}:${path}`;
}
