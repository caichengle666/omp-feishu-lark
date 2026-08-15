import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { debugLog } from "./debug.js";
import type { TaskStatusSink } from "./task-status-card.js";

export type RpcWorkerClient = Pick<RpcClient,
  "start" | "stop" | "promptAndWait" | "abort" | "getState" | "getLastAssistantText" | "getMessages" | "setModel" | "switchSession" | "onSessionEvent"
>;

export type RpcWorkerFactory = (options: { cwd: string }) => RpcWorkerClient;

type WorkerSlot = {
  client: RpcWorkerClient;
  cwd: string;
  startPromise?: Promise<void>;
  busy: boolean;
  lastUsedAt: number;
};

export type RpcPromptOptions = {
  cwd: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  timeoutMs: number;
  status?: TaskStatusSink;
  onSessionReady?: (sessionId: string) => void;
  onSessionEvent?: (sessionId: string, event: any) => void;
};

export type RpcPromptResult = {
  text: string;
  error?: string;
  sessionFile?: string;
};

export class FeishuRpcWorkerPool {
  private readonly workers = new Map<string, WorkerSlot>();
  private readonly activePromptKeys = new Set<string>();
  private readonly abortRequested = new Set<string>();
  private readonly capacityWaiters: Array<() => void> = [];
  private workerReservations = 0;

  constructor(
    private readonly createClient: RpcWorkerFactory,
    private readonly limits: { maxWorkers?: number; idleTtlMs?: number } = {},
  ) {}

  async prompt(key: string, options: RpcPromptOptions): Promise<RpcPromptResult> {
    this.activePromptKeys.add(key);
    let slot: WorkerSlot;
    try {
      slot = await this.ensureWorker(key, options.cwd, options.sessionFile);
    } catch (error) {
      this.activePromptKeys.delete(key);
      this.abortRequested.delete(key);
      throw error;
    }
    slot.busy = true;
    let unsubscribe = () => {};
    try {
      const initialState = await slot.client.getState();
      options.onSessionReady?.(initialState.sessionId);
      unsubscribe = slot.client.onSessionEvent((event) => {
        options.status?.updateFromEvent(event);
        options.onSessionEvent?.(initialState.sessionId, event);
      });
      if (options.model) await slot.client.setModel(options.model.provider, options.model.id);
      if (this.abortRequested.has(key)) throw new Error("Prompt cancelled before submission");
      await slot.client.promptAndWait(options.text, options.images.length ? options.images : undefined, options.timeoutMs);
      const [text, state, messages] = await Promise.all([
        slot.client.getLastAssistantText(),
        slot.client.getState(),
        slot.client.getMessages(),
      ]);
      const result: RpcPromptResult = {
        text: text?.trim() || "",
        sessionFile: state.sessionFile,
      };
      const error = extractLastAssistantError(messages);
      if (error) result.error = error;
      return result;
    } catch (error) {
      // Once prompt() has been accepted, never replay it automatically: tools may
      // already have produced side effects. A later user turn will create a new worker.
      await this.dropWorker(key, slot);
      throw error;
    } finally {
      unsubscribe();
      slot.busy = false;
      slot.lastUsedAt = Date.now();
      this.activePromptKeys.delete(key);
      this.abortRequested.delete(key);
      this.releaseCapacityWaiter();
    }
  }

  async abort(key: string): Promise<boolean> {
    if (!this.activePromptKeys.has(key)) return false;
    this.abortRequested.add(key);
    const slot = this.workers.get(key);
    if (slot?.busy) {
      try {
        await slot.client.abort();
      } catch {
        await this.dropWorker(key, slot);
      }
    }
    return true;
  }

  async reset(key: string): Promise<void> {
    const slot = this.workers.get(key);
    if (slot) await this.dropWorker(key, slot);
  }

  async disposeAll(): Promise<void> {
    const slots = [...this.workers.entries()];
    this.workers.clear();
    while (this.capacityWaiters.length) this.capacityWaiters.shift()?.();
    await Promise.allSettled(slots.map(([, slot]) => slot.client.stop()));
  }

  private async ensureWorker(key: string, cwd: string, sessionFile?: string): Promise<WorkerSlot> {
    await this.reapExpiredWorkers();
    let slot = this.workers.get(key);
    if (slot && slot.cwd !== cwd) {
      await this.dropWorker(key, slot);
      slot = undefined;
    }
    if (!slot) {
      await this.waitForCapacity();
      try {
        slot = { client: this.createClient({ cwd }), cwd, busy: true, lastUsedAt: Date.now() };
        this.workers.set(key, slot);
      } finally {
        this.workerReservations -= 1;
        this.releaseCapacityWaiter();
      }
    }

    try {
      if (!slot.startPromise) {
        slot.startPromise = slot.client.start().then(async () => {
          if (sessionFile) await slot!.client.switchSession(sessionFile);
        });
      }
      await slot.startPromise;
      return slot;
    } catch (error) {
      await this.dropWorker(key, slot);
      debugLog("feishu.rpc_worker.start_failed", { key, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async dropWorker(key: string, slot: WorkerSlot): Promise<void> {
    if (this.workers.get(key) === slot) this.workers.delete(key);
    try { await slot.client.stop(); } catch {}
    this.releaseCapacityWaiter();
  }

  private async reapExpiredWorkers() {
    const ttl = this.limits.idleTtlMs ?? 15 * 60 * 1000;
    const now = Date.now();
    const expired = [...this.workers.entries()]
      .filter(([, slot]) => !slot.busy && now - slot.lastUsedAt >= ttl);
    await Promise.all(expired.map(([key, slot]) => this.dropWorker(key, slot)));
  }

  private async waitForCapacity(): Promise<void> {
    const maxWorkers = Math.max(1, this.limits.maxWorkers ?? 4);
    while (this.workers.size + this.workerReservations >= maxWorkers) {
      const idle = [...this.workers.entries()]
        .filter(([, slot]) => !slot.busy)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (idle) {
        await this.dropWorker(idle[0], idle[1]);
        continue;
      }
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    this.workerReservations += 1;
  }

  private releaseCapacityWaiter() {
    this.capacityWaiters.shift()?.();
  }
}

function extractLastAssistantError(messages: readonly any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  }
  return undefined;
}
