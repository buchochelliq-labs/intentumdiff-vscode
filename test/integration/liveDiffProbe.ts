import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Exercise the same wire request with either supported runtime executable. */
export async function liveDiffProbe(
  executable: string, repo: string, relativePath: string, content: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["live-server", repo, "--stdio", "--ref", "HEAD", "--debounce", "0"],
      { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let result: string | undefined;
    let stderr = "";
    let sent = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else {
        resolve(result!);
      }
    };
    const timer = setTimeout(() => finish(new Error(`Live diff probe timed out after 60000ms: ${stderr}`)), 60000);
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-32768); });
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    lines.on("line", line => {
      if (!line.trim() || settled) return;
      try {
        const response = JSON.parse(line);
        if (response.op === "ready" && !sent) {
          if (response.ok !== true || response.protocol_version !== 2) {
            throw new Error(`Unsupported live-server handshake: ${line}`);
          }
          sent = true;
          child.stdin.write(JSON.stringify({ op: "diff", seq: 1, path: relativePath,
            content, ref: "HEAD", stream: false }) + "\n");
        } else if (response.seq === 1) {
          if (response.ok !== true || response.op !== "diff" || !response.diff) {
            throw new Error(`Live diff probe failed: ${line}`);
          }
          result = JSON.stringify(response.diff);
          child.stdin.end();
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("close", (code, signal) => {
      if (code !== 0 || result === undefined) {
        finish(new Error(`Live diff probe exited before clean completion (${code ?? signal}): ${stderr}`));
      } else {
        finish();
      }
    });
  });
}
