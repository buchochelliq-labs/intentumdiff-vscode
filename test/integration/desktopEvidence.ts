/** Observe the actual isolated Electron window, never infer UI state from commands. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

interface Target { type: string; webSocketDebuggerUrl?: string; }
interface Reply { id?: number; method?: string; params?: { context?: { id: number } }; result?: { result?: { value?: unknown } }; error?: unknown; }

type Listener = (event: { data?: unknown }) => void;
interface CdpSocket {
  addEventListener(type: "open" | "message" | "error", listener: Listener, options?: { once?: boolean }): void;
  send(text: string): void;
  close(): void;
}

/**
 * Minimal RFC 6455 client for the local DevTools endpoint, used when the extension host has
 * no global WebSocket (VS Code builds before Node 22, e.g. the 1.90 minimum engine). It only
 * needs what CDP uses here: one text-message stream, masked client frames, unmasked server
 * frames with fragmentation and 16/64-bit lengths. Test-only; never shipped in the VSIX.
 */
class NodeCdpSocket implements CdpSocket {
  private readonly listeners: { type: string; listener: Listener; once: boolean }[] = [];
  private conn?: import("node:net").Socket;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];

  constructor(url: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require("node:http") as typeof import("node:http");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const target = new URL(url);
    const request = http.request({
      host: target.hostname, port: target.port, path: target.pathname + target.search,
      headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      },
    });
    request.on("upgrade", (_res, conn, head) => {
      this.conn = conn;
      conn.on("data", chunk => this.receive(chunk));
      conn.on("error", () => this.emit("error", {}));
      if (head.length) this.receive(head);
      this.emit("open", {});
    });
    request.on("response", () => this.emit("error", {}));
    request.on("error", () => this.emit("error", {}));
    request.end();
  }

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    this.listeners.push({ type, listener, once: options?.once === true });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const entry of [...this.listeners]) {
      if (entry.type !== type) continue;
      if (entry.once) this.listeners.splice(this.listeners.indexOf(entry), 1);
      entry.listener(event);
    }
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      this.fragments.push(Buffer.from(payload));
      if (fin) {
        const data = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.emit("message", { data });
      }
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    if (!this.conn) throw new Error("CDP socket is not open");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mask = (require("node:crypto") as typeof import("node:crypto")).randomBytes(4);
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.conn.write(Buffer.concat([header, mask, masked]));
  }

  send(text: string): void { this.frame(0x1, Buffer.from(text, "utf8")); }

  close(): void { this.conn?.destroy(); this.conn = undefined; }
}

function openCdpSocket(url: string): CdpSocket {
  const native = (globalThis as { WebSocket?: new (url: string) => CdpSocket }).WebSocket;
  return native ? new native(url) : new NodeCdpSocket(url);
}

async function evaluateTarget(url: string, expression: string): Promise<boolean> {
  const socket = openCdpSocket(url);
  const contexts = new Set<number>();
  let sequence = 0;
  const pending = new Map<number, (reply: Reply) => void>();
  socket.addEventListener("message", event => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.method === "Runtime.executionContextCreated" && reply.params?.context) contexts.add(reply.params.context.id);
    // Only call a handler this socket registered: a numeric id we issued, and a function.
    if (typeof reply.id === "number") {
      const handler = pending.get(reply.id);
      pending.delete(reply.id);
      if (typeof handler === "function") handler(reply);
    }
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
