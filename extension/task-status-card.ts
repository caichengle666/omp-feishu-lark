import { randomUUID } from "node:crypto";
import { debugLog } from "./debug.js";
import { collectArtifactCandidates, isExistingSendableArtifact } from "./artifacts.js";
import { ACTIVE_TASKS_PATH, readJson, writeJson } from "./config.js";

export type TaskStatus = "running" | "done" | "failed" | "stopped" | "inactive";

export type TaskStatusSink = {
  readonly runId: string;
  updateFromEvent(event: unknown): void;
  updateFromSubagentLifecycle?(payload: any): void;
  updateFromSubagentProgress?(payload: any): void;
  setPhase?(phase: string): Promise<void>;
  stopImmediately(phase?: string): Promise<void>;
  finish(status: Exclude<TaskStatus, "running" | "inactive">, phase?: string): Promise<void>;
};

type TaskStatusTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  replyText?(messageId: string, text: string): Promise<void>;
  updateCard(messageId: string, card: object): Promise<void>;
  replyLocalFile(messageId: string, filePath: string): Promise<{ kind: "image" | "file"; fileName: string } | undefined>;
};

type PersistedTask = {
  key: string;
  runId: string;
  replyToMessageId: string;
  cardMessageId: string;
  ownerOpenId?: string;
  chatId?: string;
  startedAt: number;
};

const activeCards = new Set<TaskStatusCard>();

function readActiveTasks(): PersistedTask[] {
  const value = readJson<unknown>(ACTIVE_TASKS_PATH, []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PersistedTask => Boolean(item && typeof item === "object" && typeof (item as any).key === "string" && typeof (item as any).runId === "string" && typeof (item as any).replyToMessageId === "string" && typeof (item as any).cardMessageId === "string" && typeof (item as any).startedAt === "number"));
}

function persistActiveTask(task: PersistedTask) {
  const tasks = readActiveTasks().filter((item) => item.runId !== task.runId);
  tasks.push(task);
  writeJson(ACTIVE_TASKS_PATH, tasks);
}

function removePersistedTask(runId: string) {
  const tasks = readActiveTasks().filter((item) => item.runId !== runId);
  writeJson(ACTIVE_TASKS_PATH, tasks);
}

export async function recoverInterruptedTaskCards(transport: Pick<TaskStatusTransport, "updateCard">) {
  const tasks = readActiveTasks();
  if (!tasks.length) return 0;
  const remaining: PersistedTask[] = [];
  for (const task of tasks) {
    try {
      await transport.updateCard(task.cardMessageId, buildTaskStatusCard({
        key: task.key,
        runId: task.runId,
        status: "failed",
        phase: "任务已中断：Feishu daemon 在任务完成前重启",
        elapsedMs: Math.max(0, Date.now() - task.startedAt),
        ownerOpenId: task.ownerOpenId,
        chatId: task.chatId,
      }));
      debugLog("feishu.task_status.recovered_interrupted", { key: task.key, runId: task.runId, cardMessageId: task.cardMessageId });
    } catch (error) {
      remaining.push(task);
      debugLog("feishu.task_status.recovery_error", { key: task.key, runId: task.runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  writeJson(ACTIVE_TASKS_PATH, remaining);
  return tasks.length - remaining.length;
}

export async function finishActiveTaskCards(status: "failed" | "stopped", phase: string) {
  await Promise.all([...activeCards].map((card) => card.finish(status, phase)));
}

const STOP_ACTION = "pi_feishu_stop_task";
const MAX_PHASE_CHARS = 96;
const MAX_ARTIFACTS_PER_TASK = 10;
const STILL_RUNNING_MS = 25_000;
const RUNNING_UPDATE_INTERVAL_MS = 3_000;

export class TaskStatusCard implements TaskStatusSink {
  readonly runId = randomUUID();
  private cardMessageId: string | undefined;
  private phase = "开始处理";
  private readonly startedAt = Date.now();
  private toolCalls = 0;
  private currentTool: string | undefined;
  private ompStarted = false;
  private status: TaskStatus = "running";
  private heartbeat: NodeJS.Timeout | undefined;
  private lastUpdateAt = 0;
  private lastRunningUpdateAt = 0;
  private pendingRunningTimer: NodeJS.Timeout | undefined;
  private pendingRunningPhase: string | undefined;
  private runningUpdateInFlight = false;
  private patchQueue: Promise<void> = Promise.resolve();
  private version = 0;
  private readonly artifactPaths = new Map<string, boolean>();
  private readonly subagents = new Map<string, string>();

  constructor(
    private readonly key: string,
    private readonly replyToMessageId: string,
    private readonly transport: TaskStatusTransport,
    private readonly workspaceRoot?: string,
    private readonly ownerOpenId?: string,
    private readonly chatId?: string,
  ) {}

  async start() {
    try {
      this.cardMessageId = await this.transport.replyCard(
        this.replyToMessageId,
        this.buildCard("running", this.phase),
      );
      if (this.cardMessageId) {
        activeCards.add(this);
        persistActiveTask({
          key: this.key,
          runId: this.runId,
          replyToMessageId: this.replyToMessageId,
          cardMessageId: this.cardMessageId,
          ownerOpenId: this.ownerOpenId,
          chatId: this.chatId,
          startedAt: this.startedAt,
        });
      }
      debugLog("feishu.task_status.started", {
        key: this.key,
        runId: this.runId,
        cardMessageId: this.cardMessageId,
      });
      this.lastUpdateAt = Date.now();
      this.lastRunningUpdateAt = this.lastUpdateAt;
      this.startHeartbeat();
    } catch (error) {
      debugLog("feishu.task_status.start_error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  updateFromEvent(event: unknown) {
    if (this.status !== "running") return;
    const raw = event as any;
    if (raw?.type === "agent_start") {
      if (this.ompStarted) return;
      this.ompStarted = true;
    }
    if (raw?.type === "tool_execution_start" || raw?.type === "tool_execution_end") {
      for (const candidate of collectArtifactCandidates(event, this.workspaceRoot)) {
        if (this.artifactPaths.size >= MAX_ARTIFACTS_PER_TASK && !this.artifactPaths.has(candidate.path)) break;
        this.artifactPaths.set(candidate.path, candidate.allowOutsideWorkspace);
      }
    }
    if (raw?.type === "tool_execution_start") {
      this.toolCalls += 1;
      this.currentTool = typeof raw.toolName === "string" && raw.toolName ? raw.toolName : "tool";
    } else if (raw?.type === "tool_execution_end") {
      this.currentTool = undefined;
    }
    const phase = describeOmpEvent(event);
    if (!phase) return;
    void this.updateRunningPhase(phase);
  }

  updateFromSubagentLifecycle(payload: any) {
    if (this.status !== "running") return;
    const phase = describeSubagentLifecycle(payload);
    if (!phase) return;
    this.subagents.set(subagentKey(payload), phase);
    this.updateRunningPhase(phase);
  }

  updateFromSubagentProgress(payload: any) {
    if (this.status !== "running") return;
    const phase = describeSubagentProgress(payload);
    if (!phase) return;
    this.subagents.set(subagentKey(payload), phase);
    this.updateRunningPhase(phase);
  }

  async setPhase(phase: string) {
    if (this.status !== "running") return;
    const next = normalizePhase(phase);
    if (!next || next === this.phase) return;
    this.pendingRunningPhase = undefined;
    this.phase = next;
    this.lastRunningUpdateAt = Date.now();
    await this.patch(this.buildCard("running", this.phase), { version: this.version });
  }

  async stopImmediately(phase = "用户已停止任务") {
    await this.finishFinal("stopped", phase, true);
  }

  async finish(status: Exclude<TaskStatus, "running" | "inactive">, phase?: string) {
    await this.finishFinal(status, phase, false);
    if (status === "done") await this.sendArtifacts();
  }

  private async finishFinal(status: Exclude<TaskStatus, "running" | "inactive">, phase: string | undefined, force: boolean) {
    if (this.status !== "running") return;
    this.status = status;
    activeCards.delete(this);
    removePersistedTask(this.runId);
    this.version += 1;
    this.stopHeartbeat();
    this.clearPendingRunningUpdate();
    const finalPhase = phase ? normalizePhase(phase) : defaultFinalPhase(status);
    await this.patch(this.buildCard(status, finalPhase), { final: true, force });
  }

  private async sendArtifacts() {
    if (this.status !== "done") return;
    const filePaths = [...this.artifactPaths]
      .filter(([filePath, allowOutside]) => isExistingSendableArtifact(filePath, this.workspaceRoot, allowOutside))
      .map(([filePath]) => filePath);
    if (!filePaths.length) return;
    let sentCount = 0;
    let failedCount = 0;
    for (const filePath of filePaths) {
      try {
        const sent = await this.transport.replyLocalFile(this.replyToMessageId, filePath);
        if (sent?.fileName) {
          sentCount += 1;
          debugLog("feishu.task_status.artifact_sent", { key: this.key, runId: this.runId, fileName: sent.fileName });
        }
      } catch (error) {
        failedCount += 1;
        debugLog("feishu.task_status.artifact_send_error", {
          key: this.key,
          runId: this.runId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    debugLog("feishu.task_status.artifacts_done", { key: this.key, runId: this.runId, total: filePaths.length, sentCount, failedCount });
    if (failedCount > 0) {
      await this.transport.replyText?.(
        this.replyToMessageId,
        `任务已完成，但有 ${failedCount} 个生成文件未能发送。请检查文件大小和飞书机器人文件权限，必要时使用 /send 文件路径重试。`,
      ).catch((error) => {
        debugLog("feishu.task_status.artifact_failure_notice_error", {
          key: this.key,
          runId: this.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private updateRunningPhase(phase: string) {
    const next = normalizePhase(phase);
    if (!next || next === this.phase || next === this.pendingRunningPhase) return;
    this.pendingRunningPhase = next;
    this.scheduleRunningUpdate();
  }

  private scheduleRunningUpdate() {
    if (this.status !== "running" || this.runningUpdateInFlight || this.pendingRunningTimer) return;
    const now = Date.now();
    const waitMs = Math.max(0, RUNNING_UPDATE_INTERVAL_MS - (now - this.lastRunningUpdateAt));
    if (waitMs > 0) {
      this.pendingRunningTimer = setTimeout(() => {
        this.pendingRunningTimer = undefined;
        void this.flushRunningUpdate();
      }, waitMs);
      this.pendingRunningTimer.unref?.();
      return;
    }
    void this.flushRunningUpdate();
  }

  private async flushRunningUpdate() {
    if (this.status !== "running" || this.runningUpdateInFlight) return;
    const next = this.pendingRunningPhase;
    this.pendingRunningPhase = undefined;
    if (!next || next === this.phase) return;

    this.runningUpdateInFlight = true;
    const version = this.version;
    this.phase = next;
    this.lastRunningUpdateAt = Date.now();
    try {
      await this.patch(this.buildCard("running", this.phase), { version });
    } finally {
      this.runningUpdateInFlight = false;
    }
    if (this.pendingRunningPhase) this.scheduleRunningUpdate();
  }

  private async patch(card: object, options: { final?: boolean; force?: boolean; version?: number } = {}) {
    if (!this.cardMessageId) return;
    const messageId = this.cardMessageId;
    const next = this.patchQueue
      .catch(() => undefined)
      .then(async () => {
        if (!options.final && !options.force) {
          if (this.status !== "running") return;
          if (options.version !== undefined && options.version !== this.version) return;
        }
        try {
          await this.transport.updateCard(messageId, card);
          this.lastUpdateAt = Date.now();
          debugLog("feishu.task_status.update_done", {
            key: this.key,
            runId: this.runId,
            messageId,
            final: Boolean(options.final),
          });
        } catch (error) {
          debugLog("feishu.task_status.update_error", {
            key: this.key,
            runId: this.runId,
            messageId,
            final: Boolean(options.final),
            error: error instanceof Error ? error.message : String(error),
          });
          if (options.final) await this.retryFinalPatch(messageId, card);
        }
      });
    this.patchQueue = next;
    await next;
  }

  private async retryFinalPatch(messageId: string, card: object) {
    await sleep(RUNNING_UPDATE_INTERVAL_MS);
    try {
      await this.transport.updateCard(messageId, card);
      this.lastUpdateAt = Date.now();
      debugLog("feishu.task_status.final_retry_done", { key: this.key, runId: this.runId, messageId });
    } catch (error) {
      debugLog("feishu.task_status.final_retry_error", {
        key: this.key,
        runId: this.runId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.status !== "running") return;
      if (Date.now() - this.lastUpdateAt < STILL_RUNNING_MS) return;
      if (this.phase !== "仍在处理") void this.updateRunningPhase("仍在处理");
      else void this.patch(this.buildCard("running", this.phase), { version: this.version });
    }, STILL_RUNNING_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private clearPendingRunningUpdate() {
    if (this.pendingRunningTimer) {
      clearTimeout(this.pendingRunningTimer);
      this.pendingRunningTimer = undefined;
    }
    this.pendingRunningPhase = undefined;
  }

  private buildCard(status: TaskStatus, phase?: string) {
    return buildTaskStatusCard({
      key: this.key,
      runId: this.runId,
      status,
      phase,
      elapsedMs: Date.now() - this.startedAt,
      toolCalls: this.toolCalls,
      currentTool: this.currentTool,
      subagentCount: this.subagents.size,
      ownerOpenId: this.ownerOpenId,
      chatId: this.chatId,
    });
  }
}

export function buildTaskStatusCard(input: { key: string; status: TaskStatus; phase?: string; runId?: string; elapsedMs?: number; toolCalls?: number; currentTool?: string; subagentCount?: number; ownerOpenId?: string; chatId?: string }) {
  const running = input.status === "running";
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: titleForStatus(input.status) },
    },
    elements: [
      ...(input.phase ? [{
        tag: "div",
        text: {
          tag: "lark_md",
          content: `当前阶段：${normalizePhase(input.phase)}`,
        },
      }] : []),
      ...((input.elapsedMs !== undefined || input.toolCalls !== undefined) ? [{
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `已运行：${formatElapsed(input.elapsedMs || 0)}`,
            `工具调用：${input.toolCalls || 0} 次`,
            ...(input.currentTool ? [`当前工具：${normalizePhase(input.currentTool)}`] : []),
          ].join("\n"),
        },
      }] : []),
      ...(input.subagentCount ? [{
        tag: "div",
        text: {
          tag: "lark_md",
          content: `子代理任务：${input.subagentCount} 个`,
        },
      }] : []),
      ...(running ? [{
        tag: "action",
        actions: [{
          tag: "button",
          text: { tag: "plain_text", content: "停止任务" },
          type: "danger",
          value: { action: STOP_ACTION, key: input.key, runId: input.runId, ownerOpenId: input.ownerOpenId, chatId: input.chatId },
        }],
      }] : []),
    ],
  };
}

export function parseStopTaskActionValue(value: unknown): { key: string; runId?: string; ownerOpenId?: string; chatId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== STOP_ACTION || typeof raw.key !== "string") return undefined;
  return {
    key: raw.key,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
    ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : undefined,
    chatId: typeof raw.chatId === "string" ? raw.chatId : undefined,
  };
}

export function describeOmpEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const raw = event as any;
  switch (raw.type) {
    case "agent_start":
      return "OMP Agent 已启动";
    case "turn_start":
      return typeof raw.turnIndex === "number" ? `开始第 ${raw.turnIndex + 1} 轮处理` : "开始新一轮处理";
    case "message_start":
      return raw.message?.role === "assistant" ? "模型正在生成回复" : undefined;
    case "message_update":
      return describeAssistantEvent(raw.assistantMessageEvent);
    case "tool_execution_start":
      return `正在执行工具：${raw.toolName || "tool"}`;
    case "tool_execution_end":
      return `工具 ${raw.toolName || "tool"}：${raw.isError ? "执行失败" : "执行完成"}`;
    case "compaction_start":
      return "正在压缩会话上下文";
    case "auto_retry_start":
      return typeof raw.attempt === "number" ? `模型请求重试 ${raw.attempt}/${raw.maxAttempts || "?"}` : "正在重试模型请求";
    case "auto_retry_end":
      return raw.success === false ? "模型请求重试失败" : "模型请求重试成功";
    default:
      return undefined;
  }
}

export function describeSubagentLifecycle(payload: any): string | undefined {
  const name = subagentLabel(payload);
  switch (payload?.status) {
    case "started":
      return `子代理 ${name} 已启动`;
    case "completed":
      return `子代理 ${name} 已完成`;
    case "failed":
      return `子代理 ${name} 失败`;
    case "aborted":
      return `子代理 ${name} 已中止`;
    default:
      return undefined;
  }
}

export function describeSubagentProgress(payload: any): string | undefined {
  const progress = payload?.progress || {};
  const statusLabel = progress.status === "pending"
    ? "等待"
    : progress.status === "completed"
      ? "完成"
      : progress.status === "failed"
        ? "失败"
        : progress.status === "aborted"
          ? "中止"
          : "运行中";
  const parts = [`子代理 ${subagentLabel(payload)}：${statusLabel}`];
  if (progress.currentTool) parts.push(`工具 ${progress.currentTool}`);
  if (progress.lastIntent) parts.push(progress.lastIntent);
  return parts.join(" · ");
}

function describeAssistantEvent(event: any) {
  if (!event?.type) return undefined;
  if (event.type === "toolcall_end" && event.toolCall?.name) return `工具调用已生成：${event.toolCall.name}`;
  if (event.type === "done") return "正在整理最终回复";
  if (event.type === "error") return `模型回复失败${event.reason ? `：${event.reason}` : ""}`;
  if (event.type.endsWith("_delta")) return undefined;
  return undefined;
}

function normalizePhase(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_PHASE_CHARS) return compact;
  return `${compact.slice(0, MAX_PHASE_CHARS - 1)}…`;
}

function subagentLabel(payload: any) {
  return payload?.agent || payload?.progress?.agent || payload?.id || "子代理";
}

function subagentKey(payload: any) {
  return payload?.progress?.id || payload?.id || `${payload?.index || 0}:${subagentLabel(payload)}`;
}

function titleForStatus(status: TaskStatus) {
  if (status === "done") return "任务完成";
  if (status === "failed") return "任务失败";
  if (status === "stopped") return "任务已停止";
  if (status === "inactive") return "任务已结束";
  return "任务进行中";
}

function headerTemplate(status: TaskStatus) {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  if (status === "stopped") return "grey";
  if (status === "inactive") return "grey";
  return "blue";
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

function defaultFinalPhase(status: Exclude<TaskStatus, "running" | "inactive">): string | undefined {
  if (status === "done") return undefined;
  if (status === "failed") return "处理失败";
  return "用户已停止任务";
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
