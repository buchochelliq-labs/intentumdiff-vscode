export type WorkingTreeStatus = "added" | "modified" | "renamed" | "untracked" | "deleted" | "unknown";

export interface ParsedGitStatusEntry {
  relativePath: string;
  status: WorkingTreeStatus;
  /** Source path of a rename or copy (`R`/`C` status); undefined otherwise. */
  originalPath?: string;
}

/**
 * `git status` arguments whose output `parseGitStatusPorcelainZ` parses:
 * NUL-delimited porcelain v1 (paths verbatim — no quoting, no escaping, no
 * ambiguity for arrows, tabs, newlines or backslashes) with every nested
 * untracked file listed individually.
 */
export const GIT_STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;

/**
 * Parse `git status --porcelain=v1 -z` output losslessly. Each record is
 * `XY <path>\0`; a rename or copy (`R`/`C` in X or Y) is followed by one more
 * `\0`-terminated field holding the original path. Paths are kept exactly as
 * Git reports them (a POSIX backslash stays a backslash).
 */
export function parseGitStatusPorcelainZ(output: string): ParsedGitStatusEntry[] {
  const entries: ParsedGitStatusEntry[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4 || record[2] !== " ") {
      continue;
    }
    const statusCode = record.slice(0, 2);
    const relativePath = record.slice(3);
    const isRenameOrCopy = /[RC]/u.test(statusCode);
    const originalPath = isRenameOrCopy ? fields[index + 1] : undefined;
    if (isRenameOrCopy) {
      index += 1;
    }
    if (!relativePath || relativePath.endsWith("/")) {
      continue;
    }
    entries.push({
      relativePath,
      status: statusFromCode(statusCode),
      ...(originalPath ? { originalPath } : {}),
    });
  }
  return entries;
}

/**
 * Parse line-oriented `git status --porcelain=v1` output (kept for callers that
 * cannot request `-z`). Quoted paths are C-unquoted to their exact UTF-8 text,
 * ` -> ` splits a path only for rename/copy statuses, and backslashes are kept.
 */
export function parseGitStatusPorcelain(output: string): ParsedGitStatusEntry[] {
  const entries: ParsedGitStatusEntry[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    if (rawLine.length < 4) {
      continue;
    }
    const statusCode = rawLine.slice(0, 2);
    const rawPath = rawLine.slice(3);
    if (!rawPath) {
      continue;
    }
    const paths = /[RC]/u.test(statusCode) ? splitRenamePaths(rawPath) : { path: rawPath };
    const relativePath = unquoteGitPath(paths.path);
    // `git status --porcelain` collapses an untracked directory into a single
    // trailing-slash entry (e.g. `?? .claude/`). A directory is not a reviewable
    // file — `git show <ref>:.claude/` fails — so skip it. Tracked changes are
    // always individual files, never trailing-slash paths.
    if (!relativePath || relativePath.endsWith("/")) {
      continue;
    }
    entries.push({
      relativePath,
      status: statusFromCode(statusCode),
      ...(paths.original !== undefined ? { originalPath: unquoteGitPath(paths.original) } : {}),
    });
  }
  return entries;
}

function splitRenamePaths(rawPath: string): { path: string; original?: string } {
  // Quoted halves cannot contain an unescaped quote, so split outside quotes.
  let inQuote = false;
  for (let index = 0; index < rawPath.length; index += 1) {
    const char = rawPath[index];
    if (char === "\\" && inQuote) {
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && rawPath.startsWith(" -> ", index)) {
      return { original: rawPath.slice(0, index), path: rawPath.slice(index + 4) };
    }
  }
  return { path: rawPath };
}

/** Undo Git's C-style path quoting (`"caf\303\251.js"` → `café.js`). */
export function unquoteGitPath(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[index + 1];
    const octal = /^[0-7]{3}$/u.test(body.slice(index + 1, index + 4)) ? body.slice(index + 1, index + 4) : undefined;
    if (octal) {
      bytes.push(parseInt(octal, 8));
      index += 3;
    } else if (next !== undefined && escapes[next] !== undefined) {
      bytes.push(escapes[next]);
      index += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function statusFromCode(code: string): WorkingTreeStatus {
  if (code === "??") {
    return "untracked";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("A") || code.includes("C")) {
    return "added";
  }
  if (code.includes("M") || code.includes("T") || code.includes("U")) {
    return "modified";
  }
  return "unknown";
}
