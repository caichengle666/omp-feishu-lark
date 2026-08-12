import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AgentSession, SessionInfo } from "@oh-my-pi/pi-coding-agent";
import {
  createAgentSession,
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { ensureRoot, readJson, STATE_PATH, writeJson } from "./config.js";
import { debugLog } from "./debug.js";
import { waitForPrompt } from "./prompt-timeout.js";
import type { ResumeScope, ResumeSessionPage } from "./cards.js";
import type { TaskStatusSink } from "./task-status-card.js";
import type { FeishuState } from "./types.js";
import type { FeishuRpcWorkerPool } from "./rpc-worker-pool.js";

type ActiveRun = {
  session?: AgentSession;
  rpcSessionId?: string;
  abort?: () => Promise<void> | void;
  runId?: string;
  stopped: boolean;
  status?: TaskStatusSink;
};

export type ConversationTimeouts = {
  /** Seconds before a long-running task sends a "still working" notice (0 disables). Default 180. */
  promptNotifySec?: number;
  /** Hard prompt timeout in seconds; the session is aborted on expiry (0 disables / wait indefinitely). Default 0. */
  promptTimeoutSec?: number;
};

export type StopConversationResult =
  | { status: "stopped"; message: string }
  | { status: "not_running"; message: string }
  | { status: "stale"; message: string }
  | { status: "failed"; message: string };

const RESUME_PAGE_SIZE = 10;

export class ConversationManager {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private modelRegistryPromise: Promise<ModelRegistry> | undefined;
  private defaultProvider: string | undefined;
  private defaultModelId: string | undefined;
  private state: FeishuState;

  constructor(
    private readonly cwd: string,
    private readonly bridge?: FeishuBridgeRuntime,
    private readonly timeouts: ConversationTimeouts = {},
    private readonly rpcWorkers?: FeishuRpcWorkerPool,
  ) {
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
    this.state.workspaces ||= {};
    this.loadSettingsDefault();
  }

  /** Read global settings default model for fallback in getSelectedModel. */
  private loadSettingsDefault() {
    try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (settings.defaultProvider && settings.defaultModel) {
        this.defaultProvider = settings.defaultProvider;
        this.defaultModelId = settings.defaultModel;
      }
    } catch {}
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>) {
    return this.promptWithImages(key, userText, [], onReply);
  }

  async promptWithImages(
    key: string,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    onReply: (text: string) => Promise<void>,
    status?: TaskStatusSink,
  ) {
    if (this.rpcWorkers) return this.promptWithRpcWorker(key, userText, images, onReply, status);
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      debugLog("feishu.prompt.start", { key, textLength: userText.length, imageCount: images.length });
      const session = await this.getSession(key);
      const run: ActiveRun = { session, runId: status?.runId, stopped: false, status };
      this.activeRuns.set(key, run);
      this.bridge?.beginFeishuInput(session.sessionId);
      try {
        // If a previous turn is still streaming (e.g. the queue advanced while a
        // long task was running), wait for it instead of erroring with
        // "Agent is already processing".
        if (session.isStreaming) {
          debugLog("feishu.prompt.wait_for_idle", { key });
          await session.waitForIdle();
        }
        try {
          await this.runPromptWithTimeouts(session, userText, images, key, onReply);
        } catch (error) {
          if (run.stopped) {
            debugLog("feishu.prompt.stopped", { key });
            return;
          }
          throw error;
        }
      } finally {
        if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
        this.bridge?.endFeishuInput(session.sessionId);
      }
      if (run.stopped) return;
      const { text: answer, error: modelError } = extractLastAssistantOutcome(session);
      debugLog("feishu.prompt.done", { key, answerLength: answer.length, modelError });
      if (!answer && modelError) {
        await onReply(`模型调用失败：${modelError}`);
        await status?.finish("failed", modelError);
        return;
      }
      await onReply(answer || "No response.");
      await status?.finish("done");
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.prompt.error", { key, error: message });
      await status?.finish("failed", message);
      await onReply(`Pi error: ${message}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async stopConversation(key: string, onReply: (text: string) => Promise<void>, runId?: string): Promise<StopConversationResult> {
    const active = this.activeRuns.get(key);
    if (!active) {
      const message = "当前没有进行中的处理。";
      await onReply(message);
      return { status: "not_running", message };
    }
    if (runId && active.runId && active.runId !== runId) {
      const message = "这张任务卡片已不是当前进行中的任务。";
      await onReply(message);
      debugLog("feishu.prompt.stop_stale", { key, runId, activeRunId: active.runId });
      return { status: "stale", message };
    }

    active.stopped = true;
    await active.status?.stopImmediately("用户已停止任务");
    try {
      if (active.abort) await active.abort();
      else await active.session?.abort();
      debugLog("feishu.prompt.abort", { key });
      const message = "已停止当前处理。";
      await onReply(message);
      return { status: "stopped", message };
    } catch (error) {
      active.stopped = false;
      debugLog("feishu.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
      const message = "停止失败，请重试。";
      await onReply(message);
      return { status: "failed", message };
    }
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      await this.rpcWorkers?.reset(key);
      delete this.state.sessions[key];
      writeJson(STATE_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async listResumeSessions(key: string, scope: ResumeScope, page: number): Promise<ResumeSessionPage> {
    const sessions = await this.getResumeSessions(key, scope);
    const normalizedPage = Math.max(0, Math.floor(page));
    const total = sessions.length;
    const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
    const clampedPage = Math.min(normalizedPage, totalPages - 1);
    const currentSessionPath = this.normalizeSessionPath(this.state.sessions[key]);
    const start = clampedPage * RESUME_PAGE_SIZE;
    const items = sessions.slice(start, start + RESUME_PAGE_SIZE).map((session) => {
      const sessionPath = this.normalizeSessionPath(session.path) || session.path;
      return {
        path: session.path,
        title: session.title?.trim() || summarizeFirstMessage(session.firstMessage),
        subtitle: session.title?.trim()
          ? summarizeFirstMessage(session.firstMessage)
          : `消息数：${session.messageCount}`,
        modifiedLabel: formatModifiedLabel(session.modified),
        workspaceLabel: scope === "all" ? formatWorkspaceLabel(session.cwd) : undefined,
        isCurrent: Boolean(currentSessionPath && sessionPath && currentSessionPath === sessionPath),
      };
    });

    return {
      key,
      scope,
      page: clampedPage,
      total,
      totalPages,
      items,
    };
  }

  async resumeConversation(key: string, sessionPathInput: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前还有进行中的处理，请先发送 /stop，再切换历史会话。");
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const sessionPath = this.normalizeExistingSessionPath(sessionPathInput);
      const sessionInfo = await this.findSessionInfo(sessionPath);
      if (!sessionInfo) {
        await onReply("这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。");
        return;
      }

      const currentPath = this.normalizeSessionPath(this.state.sessions[key]);
      if (currentPath === sessionPath) {
        this.state.workspaces![key] = sessionInfo.cwd || this.getWorkspace(key);
        writeJson(STATE_PATH, this.state);
        await onReply(`你已经在这个历史会话里了。\n当前工作区：${this.state.workspaces![key]}`);
        return;
      }

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }

      this.sessions.delete(key);
      await this.rpcWorkers?.reset(key);
      this.state.sessions[key] = sessionPath;
      this.state.workspaces![key] = sessionInfo.cwd || this.cwd;
      writeJson(STATE_PATH, this.state);
      await onReply([
        `已切换到历史会话：${sessionInfo.title?.trim() || summarizeFirstMessage(sessionInfo.firstMessage)}`,
        `工作区：${this.state.workspaces![key]}`,
        "下一条消息会继续接着这个会话往下聊。",
      ].join("\n"));
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const modelRegistry = await this.getModelRegistry();
      const model = modelRegistry.find(provider, modelId);
      if (!model || !modelRegistry.hasConfiguredAuth(model)) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      this.state.models![key] = { provider, id: modelId };
      writeJson(STATE_PATH, this.state);

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  getWorkspace(key: string) {
    return this.state.workspaces?.[key] || this.cwd;
  }

  async switchWorkspace(key: string, workspaceInput: string | undefined, onReply: (text: string) => Promise<void>) {
    if (!workspaceInput) {
      const current = this.getWorkspace(key);
      await onReply([
        `当前工作区：${current}`,
        "用法：/workspace /绝对路径",
        "也支持：/workspace ~/your/project",
      ].join("\n"));
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const workspace = resolveWorkspacePath(workspaceInput);
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      await this.rpcWorkers?.reset(key);
      delete this.state.sessions[key];
      this.state.workspaces![key] = workspace;
      writeJson(STATE_PATH, this.state);
      await onReply(`已切换到工作区：${workspace}\n下一条消息会在这个目录里创建新的 Pi 会话。`);
    }).catch(async (error) => {
      await onReply(error instanceof Error ? error.message : `Pi error: ${String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async getAvailableModels() {
    const modelRegistry = await this.getModelRegistry();
    const available = modelRegistry.getAvailable();
    return [...available].sort((a, b) => {
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return a.id.localeCompare(b.id);
    });
  }

  async getSelectedModel(key: string) {
    return this.resolveSelectedModel(key, true);
  }

  private async resolveSelectedModel(key: string, includeCachedSession: boolean) {
    const modelRegistry = await this.getModelRegistry();
    const selected = this.state.models?.[key];
    if (selected) {
      const model = modelRegistry.find(selected.provider, selected.id);
      if (model && modelRegistry.hasConfiguredAuth(model)) return model;
    }
    if (includeCachedSession) {
      const cached = this.sessions.get(key);
      if (cached) {
        return (await cached).model;
      }
    }
    // Check settings default model before falling back to first available
    if (this.defaultProvider && this.defaultModelId) {
      const defaultModel = modelRegistry.find(this.defaultProvider, this.defaultModelId);
      if (defaultModel && modelRegistry.hasConfiguredAuth(defaultModel)) {
        return defaultModel;
      }
    }
    const available = await this.getAvailableModels();
    return available[0];
  }

  async warmupModels(): Promise<void> {
    await this.getModelRegistry();
  }

  async refreshModels(): Promise<void> {
    if (this.modelRegistryPromise) {
      const registry = await this.modelRegistryPromise;
      await registry.refresh();
    }
  }

  private async getModelRegistry(): Promise<ModelRegistry> {
    if (!this.modelRegistryPromise) {
      this.modelRegistryPromise = (async () => {
        const agentDir = getAgentDir();
        const authStorage = await discoverAuthStorage(agentDir);
        const registry = new ModelRegistry(authStorage);
        await registry.refresh();
        return registry;
      })();
    }
    return this.modelRegistryPromise;
  }

  resetMemory() {
    void this.rpcWorkers?.disposeAll();
    for (const session of this.sessions.values()) {
      void session.then((s) => s.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
    this.queues.clear();
    this.state = { sessions: {}, models: {}, workspaces: {} };
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private previousTurn(key: string) {
    // Wait for the previous message to finish. Long tasks are allowed to run as
    // long as they need; the task card stays "running" and /stop can abort at any
    // time. An arbitrary cap here caused follow-up messages to hit
    // "Agent is already processing" while the previous turn was still running.
    return this.queues.get(key) || Promise.resolve();
  }

  private notifyMs() {
    const sec = this.timeouts?.promptNotifySec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  private hardTimeoutMs() {
    const sec = this.timeouts?.promptTimeoutSec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  /**
   * Run session.prompt with a non-fatal "still working" notice threshold and an
   * opt-in hard timeout. Long-running tasks are never reported as failed just
   * because they take longer than a fixed window; only the configured hard
   * timeout (promptTimeoutSec > 0) fails, and it aborts the session first so the
   * run is not left busy in the background.
   */
  private async runPromptWithTimeouts(
    session: AgentSession,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    key: string,
    onReply: (text: string) => Promise<void>,
  ) {
    const notifyMs = this.notifyMs();
    const hardMs = this.hardTimeoutMs();
    const hardSec = Math.round(hardMs / 1000);
    await waitForPrompt(session.prompt(userText, images.length ? { images } : undefined), {
      notifyMs,
      hardMs,
      hardTimeoutMessage: `Pi 模型处理超时（超过 ${hardSec} 秒）仍未完成，已中止任务。可点击卡片「停止任务」或调大 config.json 中的 promptTimeoutSec。`,
      onStillRunning: () => {
        debugLog("feishu.prompt.notify_still_running", { key, elapsedMs: notifyMs });
        // The task is not failing — it is still running. Tell the user instead
        // of the old behaviour which reported a false failure.
        void onReply("⏳ 任务仍在处理中，没有失败。请耐心等待，也可以点击任务卡片上的「停止任务」中止。")
          .catch(() => undefined);
      },
      onHardTimeout: async () => {
        debugLog("feishu.prompt.hard_timeout", { key, elapsedMs: hardMs });
        // Abort the underlying run so the session is not left processing.
        try {
          await session.abort();
        } catch {}
      },
    });
  }

  private async createSession(key: string): Promise<AgentSession> {
    const workspaceCwd = this.getWorkspace(key);
    ensureWorkspaceExists(workspaceCwd);
    const existingFile = this.state.sessions[key];
    const modelRegistry = await this.getModelRegistry();
    // getSession() caches the createSession() promise before this method runs.
    // Reading that cache here would await the promise currently being created.
    const model = await this.resolveSelectedModel(key, false);
    const sessionManager = existingFile && existsSync(existingFile)
      ? await SessionManager.open(existingFile, undefined, undefined, { initialCwd: workspaceCwd })
      : SessionManager.create(workspaceCwd);

    const { session } = await createAgentSession({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      modelRegistry,
      model,
      sessionManager,
      systemPrompt: (defaultPrompt) => {
        const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
        const base = Array.isArray(defaultPrompt) ? defaultPrompt.join("\n\n") : defaultPrompt;
        return base?.trim() ? `${base}\n\n${extra}` : extra;
      },
    });

    this.bridge?.attachSession(key, session.sessionId);
    session.subscribe((event) => {
      this.activeRuns.get(key)?.status?.updateFromEvent(event);
      if (event.type === "message_end") {
        this.bridge?.handleMessageEnd(session.sessionId, key, event.message);
      }
    });
    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    return session;
  }

  private async promptWithRpcWorker(
    key: string,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    onReply: (text: string) => Promise<void>,
    status?: TaskStatusSink,
  ) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      debugLog("feishu.rpc_prompt.start", { key, textLength: userText.length, imageCount: images.length });
      const run: ActiveRun = { runId: status?.runId, stopped: false, status, abort: async () => { await this.rpcWorkers!.abort(key); } };
      this.activeRuns.set(key, run);
      const model = await this.resolveSelectedModel(key, false);
      let sessionId: string | undefined;
      const result = await this.rpcWorkers!.prompt(key, {
        cwd: this.getWorkspace(key),
        sessionFile: this.state.sessions[key],
        model: model ? { provider: model.provider, id: model.id } : undefined,
        text: userText,
        images,
        timeoutMs: this.hardTimeoutMs() || 24 * 60 * 60 * 1000,
        status,
        onSessionReady: (id) => {
          sessionId = id;
          run.rpcSessionId = id;
          this.bridge?.attachSession(key, id);
          this.bridge?.beginFeishuInput(id);
        },
        onSessionEvent: (id, event) => {
          if (event?.type === "message_end") this.bridge?.handleMessageEnd(id, key, event.message);
        },
      });
      if (sessionId) this.bridge?.endFeishuInput(sessionId);
      if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
      if (run.stopped) return;
      if (result.sessionFile && this.state.sessions[key] !== result.sessionFile) {
        this.state.sessions[key] = result.sessionFile;
        writeJson(STATE_PATH, this.state);
      }
      const answer = result.text;
      debugLog("feishu.rpc_prompt.done", { key, answerLength: answer.length, modelError: result.error });
      if (!answer && result.error) {
        await onReply(`模型调用失败：${result.error}`);
        await status?.finish("failed", result.error);
        return;
      }
      await onReply(answer || "No response.");
      await status?.finish("done");
    }).catch(async (error) => {
      const active = this.activeRuns.get(key);
      if (active?.rpcSessionId) this.bridge?.endFeishuInput(active.rpcSessionId);
      this.activeRuns.delete(key);
      if (active?.stopped) {
        debugLog("feishu.rpc_prompt.stopped", { key });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.rpc_prompt.error", { key, error: message });
      await status?.finish("failed", message);
      await onReply(`Pi error: ${message}`);
    });
    this.queues.set(key, next);
    await next;
  }

  private async getResumeSessions(key: string, scope: ResumeScope) {
    const base = scope === "all"
      ? await SessionManager.listAll()
      : await SessionManager.list(this.getWorkspace(key));
    return [...base].sort((a, b) => toTimeMs(b.modified) - toTimeMs(a.modified));
  }

  private async findSessionInfo(sessionPath: string): Promise<SessionInfo | undefined> {
    const currentWorkspace = await this.getWorkspaceFromSessionFile(sessionPath);
    const localSessions = currentWorkspace ? await SessionManager.list(currentWorkspace) : [];
    const normalizedTarget = this.normalizeSessionPath(sessionPath);
    const fromLocal = localSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
    if (fromLocal) return fromLocal;
    const allSessions = await SessionManager.listAll();
    return allSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
  }

  private async getWorkspaceFromSessionFile(sessionPath: string) {
    try {
      const peeked = await SessionManager.peekSessionInit(sessionPath);
      return peeked?.cwd;
    } catch {
      return undefined;
    }
  }

  private normalizeExistingSessionPath(path: string) {
    if (!path || !existsSync(path)) {
      throw new Error("历史会话不存在，可能已经被删除。");
    }
    return realpathSync(path);
  }

  private normalizeSessionPath(path: string | undefined) {
    if (!path) return undefined;
    try {
      return existsSync(path) ? realpathSync(path) : path;
    } catch {
      return path;
    }
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (!("type" in part) || part.type !== "text") return "";
      return "text" in part && typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();
}

function extractLastAssistantOutcome(session: AgentSession): { text: string; error?: string } {
  return extractLastAssistantOutcomeFromMessages(session.messages);
}

function extractLastAssistantOutcomeFromMessages(messages: readonly any[]): { text: string; error?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    // Provider failures are recorded on the message, not thrown, so an empty
    // turn must surface `errorMessage` instead of a bare "No response.".
    const raw = "errorMessage" in msg ? msg.errorMessage : undefined;
    const error = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    return { text: extractTextContent(msg.content), error };
  }
  return { text: "" };
}

function resolveWorkspacePath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("请在 /workspace 后面带上目录路径，例如：/workspace /Users/ax/project");
  }

  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;

  if (!isAbsolute(expanded)) {
    throw new Error("当前只支持绝对路径或 ~/ 开头的路径。");
  }

  const resolved = resolve(expanded);
  ensureWorkspaceExists(resolved);
  return realpathSync(resolved);
}

function ensureWorkspaceExists(path: string) {
  if (!existsSync(path)) {
    throw new Error(`工作区不存在：${path}`);
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`无法访问工作区：${path}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`工作区不是目录：${path}`);
  }
}

function summarizeFirstMessage(text: string) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "未命名会话";
  return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}

function formatModifiedLabel(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatWorkspaceLabel(cwd: string) {
  if (!cwd) return "(unknown)";
  return `${basename(cwd)} · ${cwd}`;
}

function toTimeMs(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
