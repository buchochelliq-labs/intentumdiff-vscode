/** Observe the actual isolated Electron window, never infer UI state from commands. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

interface Target { type: string; webSocketDebuggerUrl?: string; }
interface Reply { id?: number; method?: string; params?: { context?: { id: number } }; result?: { result?: { value?: unknown } }; error?: unknown; }

async function evaluateTarget(url: string, expression: string): Promise<boolean> {
  const socket = new WebSocket(url);
  const contexts = new Set<number>();
  let sequence = 0;
  const pending = new Map<number, (reply: Reply) => void>();
  socket.addEventListener("message", event => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.method === "Runtime.executionContextCreated" && reply.params?.context) contexts.add(reply.params.context.id);
    if (reply.id !== undefined) { pending.get(reply.id)?.(reply); pending.delete(reply.id); }
  });
  const send = (method: string, params: object = {}) => new Promise<Reply>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 3000);
    pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 3000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
    });
    await send("Runtime.enable");
    for (const contextId of contexts) {
      const reply = await send("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
      if (reply.result?.result?.value === true) return true;
    }
    return false;
  } finally { socket.close(); }
}

/** Selectors run against renderer documents, including VS Code's webview frames. */
export async function waitForVisible(selector: string, click = false, requireNoOverflow = false, expectedText?: string, afterClickSelector?: string, expectedSourceLines?: string[]): Promise<void> {
  const profile = process.env.INTENTUMDIFF_REAL_PROFILE;
  if (!profile) throw new Error("Missing isolated desktop profile");
  const deadline = Date.now() + 30000;
  let lastError: unknown;
  const expression = `(async () => {
    if (document.readyState !== "complete" || document.visibilityState === "hidden") return false;
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    ${expectedText === undefined ? "" : `if (element.textContent.trim() !== ${JSON.stringify(expectedText)}) return false;`}
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return false;
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
    ${requireNoOverflow ? "if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) return false;" : ""}
    ${expectedSourceLines === undefined ? "" : `
    // Read only glyphs wholly inside the native editor's scroll viewport.
    // DOM textContent alone would accept clipped/offscreen source.
    let visibleSource = "";
    const sourceLines = [...element.querySelectorAll(".view-lines")].flatMap(container =>
      [...container.querySelectorAll(".view-line")].sort((a, b) =>
        a.getBoundingClientRect().top - b.getBoundingClientRect().top));
    for (const line of sourceLines) {
      const viewport = line.closest(".monaco-scrollable-element");
      if (!viewport) continue;
      const bounds = viewport.getBoundingClientRect();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        // Monaco renders inlay labels as injected text with DynamicCssRules
        // classes. They are visible UI, not source characters; a hint can sit
        // between two tokens in a wrapped SQL source line.
        if (node.parentElement.closest('[class^="dyn-rule-"], [class*=" dyn-rule-"]')) continue;
        for (let index = 0; index < node.textContent.length; index++) {
          const glyph = document.createRange();
          glyph.setStart(node, index); glyph.setEnd(node, index + 1);
          const boxes = [...glyph.getClientRects()];
          if (boxes.length && boxes.every(box => box.width > 0 && box.height > 0 &&
            box.left >= Math.max(0, bounds.left) - 1 &&
            box.right <= Math.min(innerWidth, bounds.right) + 1 &&
            box.top >= Math.max(0, bounds.top) - 1 &&
            box.bottom <= Math.min(innerHeight, bounds.bottom) + 1)) {
            visibleSource += node.textContent[index];
          }
        }
      }
    }
    const compact = value => value.replace(/\\s+/gu, "");
    const visible = compact(visibleSource);
    if (!${JSON.stringify(expectedSourceLines)}.every(line => visible.includes(compact(line)))) return false;
    `}
    ${click ? "element.click();" : ""}
    ${afterClickSelector === undefined ? "" : `await new Promise(resolve => setTimeout(resolve, 750));
    const selected = document.querySelector(${JSON.stringify(afterClickSelector)});
    if (!selected || selected.getBoundingClientRect().height <= 0 || getComputedStyle(selected).display === "none") return false;`}
    return true;
  })()`;
  while (Date.now() < deadline) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid desktop debugging port");
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as Target[];
      for (const target of targets.filter(t => t.type === "page" || t.type === "iframe")) {
        if (target.webSocketDebuggerUrl && await evaluateTarget(target.webSocketDebuggerUrl, expression)) return;
      }
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const evidence = process.env.INTENTUMDIFF_REAL_EVIDENCE;
  if (evidence && process.platform === "linux") {
    try { execFileSync("scrot", [path.join(evidence, "failure.png")]); } catch { /* preserve the readiness error */ }
  }
  throw new Error(`Desktop element never became visible: ${selector}; ${String(lastError ?? "no matching rendered element")}`);
}
