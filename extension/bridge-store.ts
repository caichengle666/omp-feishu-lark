import { BRIDGE_PATH, readJson, writeJson } from "./config.js";
import type { FeishuBridgeState, FeishuJobRoute, FeishuMessage, FeishuRoute } from "./types.js";

const DEFAULT_STATE: FeishuBridgeState = { version: 1, routes: {}, jobs: {}, sent: {} };
const ROUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROUTES = 1_000;
const MAX_JOBS = 1_000;
const MAX_SENT = 5_000;

export class FeishuBridgeStore {
  bindConversation(sessionKey: string, msg: FeishuMessage, sessionId?: string) {
    const state = this.read();
    const previous = state.routes[sessionKey];
    const route: FeishuRoute = {
      sessionKey,
      sessionId: sessionId || previous?.sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadMessageId: routeThreadMessageId(msg, previous),
      lastMessageId: msg.messageId,
      updatedAt: Date.now(),
    };
    state.routes[sessionKey] = route;
    this.write(state);
    return route;
  }

  attachSession(sessionKey: string, sessionId: string) {
    const state = this.read();
    const route = state.routes[sessionKey];
    if (!route || route.sessionId === sessionId) return;
    state.routes[sessionKey] = { ...route, sessionId, updatedAt: Date.now() };
    this.write(state);
  }

  getRoute(sessionKey: string): FeishuRoute | undefined {
    return this.read().routes[sessionKey];
  }

  bindJob(sessionKey: string, jobId: string, jobName?: string, sessionId?: string): FeishuJobRoute | undefined {
    const state = this.read();
    const route = state.routes[sessionKey];
    if (!route) return undefined;
    const jobRoute: FeishuJobRoute = {
      ...route,
      sessionId: sessionId || route.sessionId,
      jobId,
      jobName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.jobs[jobId] = jobRoute;
    this.write(state);
    return jobRoute;
  }

  getJob(jobId: string): FeishuJobRoute | undefined {
    return this.read().jobs[jobId];
  }

  markSent(deliveryKey: string) {
    const state = this.read();
    state.sent[deliveryKey] = Date.now();
    this.write(state);
  }

  hasSent(deliveryKey: string) {
    return Boolean(this.read().sent[deliveryKey]);
  }

  private read(): FeishuBridgeState {
    const raw = readJson<FeishuBridgeState>(BRIDGE_PATH, DEFAULT_STATE);
    const state: FeishuBridgeState = {
      version: 1,
      routes: recordOrEmpty<FeishuRoute>(raw.routes),
      jobs: recordOrEmpty<FeishuJobRoute>(raw.jobs),
      sent: recordOrEmpty<number>(raw.sent),
    };
    pruneState(state, Date.now());
    return state;
  }

  private write(state: FeishuBridgeState) {
    writeJson(BRIDGE_PATH, state);
  }
}

function recordOrEmpty<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, T>) } : {};
}

function pruneState(state: FeishuBridgeState, now: number) {
  pruneEntries(state.routes, (route) => route.updatedAt, now - ROUTE_TTL_MS, MAX_ROUTES);
  pruneEntries(state.jobs, (job) => job.updatedAt, now - JOB_TTL_MS, MAX_JOBS);
  pruneEntries(state.sent, (sentAt) => sentAt, now - SENT_TTL_MS, MAX_SENT);
}

function pruneEntries<T>(entries: Record<string, T>, timestamp: (value: T) => unknown, oldest: number, limit: number) {
  const current = Object.entries(entries).filter(([, value]) => {
    const at = timestamp(value);
    return typeof at === "number" && Number.isFinite(at) && at >= oldest;
  });
  const keep = new Set(current.sort(([, left], [, right]) => Number(timestamp(right)) - Number(timestamp(left))).slice(0, limit).map(([key]) => key));
  for (const key of Object.keys(entries)) if (!keep.has(key)) delete entries[key];
}

function routeThreadMessageId(msg: FeishuMessage, previous?: FeishuRoute) {
  if (msg.rootId || msg.parentId) return msg.rootId || msg.parentId;
  if (previous?.threadMessageId) return previous.threadMessageId;
  if (msg.threadId || msg.chatMode === "topic") return msg.messageId;
  return undefined;
}
