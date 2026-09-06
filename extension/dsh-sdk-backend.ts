import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentBackend, AgentPromptOptions, AgentPromptResult } from "./agent-backend.js";
import { debugLog } from "./debug.js";

type JsonRpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type DshNotification = { method?: string; params?: Record<string, unknown> };

type DshSession = {
  process: ChildProcessWithoutNullStreams;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sessionId: string;
  latestText: string;
  idleWaiters: Array<() => void>;
  onEvent?: (sessionId: string, event: unknown) => void;
  closed: boolean;
  provider: string;
  model: string;
};

/** DSH SDK JSON-RPC backend. One child runtime owns one Feishu conversation. */
export class DshSdkBackend implements AgentBackend {
  readonly name = "dsh";
  private readonly sessions = new Map<string, DshSession>();

  constructor(
    private readonly command = process.env.FEISHU_DSH_COMMAND || "dsh",
    private readonly args = parseArgs(process.env.FEISHU_DSH_ARGS || "--profile sdk"),
    private readonly provider = process.env.FEISHU_DSH_PROVIDER || "deepseek-official",
    private readonly model = process.env.FEISHU_DSH_MODEL || "deepseek-v4-flash",
  ) {}

  async prompt(key: string, options: AgentPromptOptions): Promise<AgentPromptResult> {
    const session = await this.ensureSession(key, options);
    const provider = options.model?.provider || this.provider;
    const model = options.model?.id || this.model;
    if (session.provider !== provider || session.model !== model) {
      await this.request(session, "session/config", { sessionId: session.sessionId, provider, model });
      session.provider = provider;
      session.model = model;
    }
    session.onEvent = options.onSessionEvent
    options.onSessionReady?.(session.sessionId);
    const result = await this.request(session, "session/prompt", {
      sessionId: session.sessionId,
      contentBlocks: [
        { type: "text", text: options.text },
        ...options.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
      ],
    });
    if (!isRecord(result) || typeof result.messageId !== "string") {
      throw new Error("DSH session/prompt returned no message id");
    }
    await this.waitForIdle(session, options.timeoutMs);
    return { text: session.latestText };
  }

  async abort(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session) return false;
    await this.request(session, "session/cancel", { sessionId: session.sessionId });
    return true;
  }

  async compact(key: string, options: { instructions?: string }): Promise<unknown> {
    const session = this.sessions.get(key);
    if (!session) return null;
    return this.request(session, "session/compact", {
      sessionId: session.sessionId,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    });
  }

  async availableCommands(key: string): Promise<unknown[]> {
    const session = this.sessions.get(key);
    if (!session) return [];
    const result = await this.request(session, "session/commands", { sessionId: session.sessionId });
    return Array.isArray(result) ? result : [];
  }

  async reset(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session) await this.closeSession(key, session);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions].map(([key, session]) => this.closeSession(key, session)));
  }

  private async ensureSession(key: string, options: AgentPromptOptions): Promise<DshSession> {
    const current = this.sessions.get(key);
    if (current && !current.closed) return current;
    const child = spawn(this.command, this.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const session: DshSession = {
      process: child,
      nextId: 1,
      pending: new Map(),
      sessionId: `feishu-${stableId(key)}`,
      latestText: "",
      idleWaiters: [],
      closed: false,
      provider: options.model?.provider || this.provider,
      model: options.model?.id || this.model,
    };
    this.sessions.set(key, session);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(session, line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => debugLog("feishu.dsh.stderr", { key, text: String(chunk).slice(-2000) }));
    child.once("error", (error) => this.failSession(session, error instanceof Error ? error : new Error(String(error))));
    child.once("exit", (code) => this.failSession(session, new Error(`DSH runtime exited (${code ?? "unknown"})`)));
    try {
      await this.request(session, "initialize", {
        cwd: options.cwd,
        provider: options.model?.provider || this.provider,
        model: options.model?.id || this.model,
      });
      return session;
    } catch (error) {
      await this.closeSession(key, session);
      throw error;
    }
  }

  private handleLine(session: DshSession, line: string) {
    let frame: JsonRpcResponse & DshNotification;
    try { frame = JSON.parse(line) as JsonRpcResponse & DshNotification; } catch { return; }
    if (typeof frame.id === "number") {
      const pending = session.pending.get(frame.id);
      if (!pending) return;
      session.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || "DSH JSON-RPC request failed"));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method !== "session.event" && frame.method !== "session.status") return;
    const params = frame.params || {};
    if (frame.method === "session.status" && params.status === "idle") {
      for (const resolve of session.idleWaiters.splice(0)) resolve();
    }
    if (frame.method === "session.event") {
      const event = params.event;
      session.onEvent?.(session.sessionId, event);
      const text = extractAssistantText(event);
      if (text !== undefined) session.latestText = text;
    }
  }

  private request(session: DshSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
      session.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private async waitForIdle(session: DshSession, timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= 2_147_483_647) {
      await new Promise<void>((resolve) => session.idleWaiters.push(resolve));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DSH agent wait timed out")), timeoutMs);
      session.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  private async closeSession(key: string, session: DshSession) {
    session.closed = true;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    try { await this.request(session, "shutdown", {}); } catch {}
    try { session.process.stdin.end(); } catch {}
    if (!session.process.killed) session.process.kill();
    for (const pending of session.pending.values()) pending.reject(new Error("DSH runtime closed"));
    session.pending.clear();
  }

  private failSession(session: DshSession, error: Error) {
    if (session.closed) return;
    session.closed = true;
    for (const pending of session.pending.values()) pending.reject(error);
    session.pending.clear();
    for (const resolve of session.idleWaiters.splice(0)) resolve();
  }
}

function parseArgs(value: string): string[] {
  return value.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\S+/g)?.map((item) => item.replace(/^['"]|['"]$/g, "")) || [];
}

function stableId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractAssistantText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const eventType = value.type;
  const data = value.data;
  if (eventType !== "assistant/message" || !isRecord(data)) return undefined;
  const message = data.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return text;
}
