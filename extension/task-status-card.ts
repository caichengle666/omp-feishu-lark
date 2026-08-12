import { randomUUID } from "node:crypto";
import { debugLog } from "./debug.js";

export type TaskStatus = "running" | "done" | "failed" | "stopped" | "inactive";

export type TaskStatusSink = {
  readonly runId: string;
  updateFromEvent(event: unknown): void;
  stopImmediately(phase?: string): Promise<void>;
  finish(status: Exclude<TaskStatus, "running" | "inactive">, phase?: string): Promise<void>;
};

type TaskStatusTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
};

const STOP_ACTION = "pi_feishu_stop_task";
const MAX_PHASE_CHARS = 96;
const STILL_RUNNING_MS = 25_000;
const RUNNING_UPDATE_INTERVAL_MS = 3_000;

export class TaskStatusCard implements TaskStatusSink {
  readonly runId = randomUUID();
  private cardMessageId: string | undefined;
  private phase = "开始处理";
  private status: TaskStatus = "running";
  private heartbeat: NodeJS.Timeout | undefined;
  private lastUpdateAt = 0;
  private lastRunningUpdateAt = 0;
  private pendingRunningTimer: NodeJS.Timeout | undefined;
  private pendingRunningPhase: string | undefined;
  private runningUpdateInFlight = false;
  private patchQueue: Promise<void> = Promise.resolve();
  private version = 0;

  constructor(
    private readonly key: string,
    private readonly replyToMessageId: string,
    private readonly transport: TaskStatusTransport,
  ) {}

  async start() {
    try {
      this.cardMessageId = await this.transport.replyCard(
        this.replyToMessageId,
        buildTaskStatusCard({ key: this.key, runId: this.runId, status: "running", phase: this.phase }),
      );
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
    const phase = describePiEvent(event);
    if (!phase) return;
    void this.updateRunningPhase(phase);
  }

  async stopImmediately(phase = "用户已停止任务") {
    await this.finishFinal("stopped", phase, true);
  }

  async finish(status: Exclude<TaskStatus, "running" | "inactive">, phase?: string) {
    await this.finishFinal(status, phase, false);
  }

  private async finishFinal(status: Exclude<TaskStatus, "running" | "inactive">, phase: string | undefined, force: boolean) {
    if (this.status !== "running") return;
    this.status = status;
    this.version += 1;
    this.stopHeartbeat();
    this.clearPendingRunningUpdate();
    const finalPhase = phase ? normalizePhase(phase) : defaultFinalPhase(status);
    await this.patch(buildTaskStatusCard({ key: this.key, runId: this.runId, status, phase: finalPhase }), { final: true, force });
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
      await this.patch(buildTaskStatusCard({ key: this.key, runId: this.runId, status: "running", phase: this.phase }), { version });
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
      void this.updateRunningPhase("仍在处理");
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
}

export function buildTaskStatusCard(input: { key: string; status: TaskStatus; phase?: string; runId?: string }) {
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
      ...(running ? [{
        tag: "action",
        actions: [{
          tag: "button",
          text: { tag: "plain_text", content: "停止任务" },
          type: "danger",
          value: { action: STOP_ACTION, key: input.key, runId: input.runId },
        }],
      }] : []),
    ],
  };
}

export function parseStopTaskActionValue(value: unknown): { key: string; runId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== STOP_ACTION || typeof raw.key !== "string") return undefined;
  return {
    key: raw.key,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
  };
}

export function describePiEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const raw = event as any;
  switch (raw.type) {
    case "agent_start":
      return "agent_start";
    case "turn_start":
      return typeof raw.turnIndex === "number" ? `turn_start: ${raw.turnIndex + 1}` : "turn_start";
    case "message_start":
      return raw.message?.role ? `message_start: ${raw.message.role}` : "message_start";
    case "message_update":
      return describeAssistantEvent(raw.assistantMessageEvent);
    case "tool_execution_start":
      return withBriefJson(`tool_execution_start: ${raw.toolName || "tool"}`, raw.args);
    case "tool_execution_end":
      return `tool_execution_end: ${raw.toolName || "tool"} ${raw.isError ? "error" : "done"}`;
    case "compaction_start":
      return raw.reason ? `compaction_start: ${raw.reason}` : "compaction_start";
    case "auto_retry_start":
      return typeof raw.attempt === "number" ? `auto_retry_start: ${raw.attempt}/${raw.maxAttempts || "?"}` : "auto_retry_start";
    case "auto_retry_end":
      return raw.success === false ? "auto_retry_end: failed" : "auto_retry_end";
    default:
      return undefined;
  }
}

function describeAssistantEvent(event: any) {
  if (!event?.type) return "message_update";
  if (event.type === "toolcall_end" && event.toolCall?.name) return `toolcall_end: ${event.toolCall.name}`;
  if (event.type === "done" && event.reason) return `message_update: done ${event.reason}`;
  if (event.type === "error" && event.reason) return `message_update: error ${event.reason}`;
  if (event.type.endsWith("_delta")) return undefined;
  return `message_update: ${event.type}`;
}

function withBriefJson(prefix: string, value: unknown) {
  if (value === undefined || value === null) return prefix;
  return normalizePhase(`${prefix} ${JSON.stringify(value)}`);
}

function normalizePhase(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_PHASE_CHARS) return compact;
  return `${compact.slice(0, MAX_PHASE_CHARS - 1)}…`;
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

function defaultFinalPhase(status: Exclude<TaskStatus, "running" | "inactive">): string | undefined {
  if (status === "done") return undefined;
  if (status === "failed") return "处理失败";
  return "用户已停止任务";
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
