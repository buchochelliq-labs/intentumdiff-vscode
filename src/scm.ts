import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import {
  GIT_STATUS_ARGS,
  parseGitStatusPorcelain,
  parseGitStatusPorcelainZ,
  type ParsedGitStatusEntry,
  type WorkingTreeStatus,
} from "./gitStatus";

export { parseGitStatusPorcelain, parseGitStatusPorcelainZ, type ParsedGitStatusEntry, type WorkingTreeStatus };

export interface WorkingTreeFile {
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  relativePath: string;
  status: WorkingTreeStatus;
  /** Source path of a rename/copy, when Git reports one. */
  originalPath?: string;
}

/** Discovery for every workspace folder; a folder whose Git state is unavailable throws. */
export async function discoverWorkingTreeFiles(): Promise<WorkingTreeFile[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const byKey = new Map<string, WorkingTreeFile>();
  for (const folder of folders) {
    for (const file of await discoverWorkingTreeFilesForFolder(folder)) {
      byKey.set(file.uri.toString(), file);
    }
  }
  return [...byKey.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Working-tree changes for one folder: `git status` first, then the VS Code
 * Git extension as the documented fallback. A failure is never reported as a
 * clean repository: if Git fails and the extension cannot answer either, the
 * Git error propagates (the snapshot is then unavailable, not empty).
 */
export async function discoverWorkingTreeFilesForFolder(
  folder: vscode.WorkspaceFolder,
  deps: { status?: (folder: vscode.WorkspaceFolder) => Promise<WorkingTreeFile[]>; gitApi?: (folder: vscode.WorkspaceFolder) => Promise<WorkingTreeFile[] | undefined> } = {},
): Promise<WorkingTreeFile[]> {
  try {
    return await (deps.status ?? discoverFromGitStatus)(folder);
  } catch (gitStatusError) {
    const apiFiles = await (deps.gitApi ?? discoverFromGitApi)(folder);
    if (apiFiles !== undefined) {
      return apiFiles;
    }
    throw gitStatusError;
  }
}

export async function resolveGitRef(
  folder: vscode.WorkspaceFolder,
  ref: string,
): Promise<string | undefined> {
  try {
    const output = await execGit(folder.uri.fsPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The Git extension's view, or undefined when it cannot answer (missing, inactive repo, error). */
async function discoverFromGitApi(folder: vscode.WorkspaceFolder): Promise<WorkingTreeFile[] | undefined> {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) {
    return undefined;
  }
  try {
    const extension = gitExtension.isActive ? gitExtension : await gitExtension.activate();
    const api = extension.getAPI?.(1);
    const repository = api?.repositories?.find(
      (item: { rootUri?: vscode.Uri }) => item.rootUri?.toString() === folder.uri.toString(),
    );
    if (!repository?.state) {
      return undefined;
    }
    const resources = [
      ...(repository.state.indexChanges ?? []),
      ...(repository.state.workingTreeChanges ?? []),
      ...(repository.state.mergeChanges ?? []),
    ];
    const files: WorkingTreeFile[] = [];
    for (const item of resources as Array<{
      resourceUri?: vscode.Uri;
      originalResourceUri?: vscode.Uri;
      type?: string | number;
      status?: string | number;
      state?: string | number;
    }>) {
      const uri = item.resourceUri;
      if (!uri || uri.scheme !== "file") {
        continue;
      }
      const relativePath = relativePathFor(folder, uri);
      if (!relativePath) {
        continue;
      }
      const originalPath = item.originalResourceUri?.scheme === "file"
        ? relativePathFor(folder, item.originalResourceUri)
        : undefined;
      files.push({
        folder,
        uri,
        relativePath,
        status: statusFromGitResource(item),
        ...(originalPath && originalPath !== relativePath ? { originalPath } : {}),
      });
    }
    return files;
  } catch {
    return undefined;
  }
}

async function discoverFromGitStatus(folder: vscode.WorkspaceFolder): Promise<WorkingTreeFile[]> {
  // Failures propagate so the Git-extension fallback runs (never a false "clean").
  const output = await execGit(folder.uri.fsPath, [...GIT_STATUS_ARGS]);
  return parseGitStatusPorcelainZ(output).map((entry) => ({
    folder,
    uri: vscode.Uri.file(path.join(folder.uri.fsPath, entry.relativePath)),
    relativePath: entry.relativePath,
    status: entry.status,
    ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
  }));
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", `safe.directory=${cwd}`, ...args],
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function relativePathFor(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | undefined {
  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function statusFromGitResource(item: {
  originalResourceUri?: vscode.Uri;
  type?: string | number;
  status?: string | number;
  state?: string | number;
}): WorkingTreeStatus {
  if (item.originalResourceUri) {
    return "renamed";
  }
  const statusText = String(item.type ?? item.status ?? item.state ?? "").toLowerCase();
  if (statusText.includes("untracked")) {
    return "untracked";
  }
  if (statusText.includes("delete")) {
    return "deleted";
  }
  if (statusText.includes("rename")) {
    return "renamed";
  }
  if (statusText.includes("add")) {
    return "added";
  }
  if (statusText.includes("mod")) {
    return "modified";
  }
  return "modified";
}
