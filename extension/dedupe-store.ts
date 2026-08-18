import { processStartFingerprint } from "../support/feishu-supervisor.mjs";
import { DEDUPE_PATH, ensureRoot, readJson, writeJson } from "./config.js";
import { debugLog } from "./debug.js";
import { acquireFileLease, releaseFileLease } from "./gateway-lock.js";

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESSING_STALE_MS = 15 * 60 * 1000;

type DedupeStatus = "processing" | "replied" | "ignored" | "failed";

type DedupeRecord = {
  status: DedupeStatus;
  firstSeenAt: number;
  updatedAt: number;
  pid: number;
  processStart?: string;
  error?: string;
};

type DedupeStore = {
  messages?: Record<string, DedupeRecord>;
};

export async function claimFeishuMessage(messageId: string): Promise<boolean> {
  if (!messageId) return true;

  return withStoreLock(() => {
    const now = Date.now();
    const store = readStore();
    const messages = store.messages || {};
    pruneExpired(messages, now);

    const existing = messages[messageId];
    if (existing) {
      if (canReclaimProcessing(existing, now)) {
        messages[messageId] = {
          ...existing,
          status: "processing",
          firstSeenAt: now,
          updatedAt: now,
          pid: process.pid,
          processStart: processStartFingerprint(process.pid),
          error: undefined,
        };
        writeStore({ messages });
        debugLog("feishu.dedupe.reclaimed_processing", { messageId, previousPid: existing.pid, currentPid: process.pid });
        return true;
      }
      debugLog("feishu.dedupe.ignored_message", {
        messageId,
        status: existing.status,
        firstSeenAt: new Date(existing.firstSeenAt).toISOString(),
        ownerPid: existing.pid,
        currentPid: process.pid,
      });
      return false;
    }

    messages[messageId] = {
      status: "processing",
      firstSeenAt: now,
      updatedAt: now,
      pid: process.pid,
      processStart: processStartFingerprint(process.pid),
    };
    writeStore({ messages });
    debugLog("feishu.dedupe.claimed_message", { messageId, pid: process.pid });
    return true;
  });
}

export async function markFeishuMessage(messageId: string, status: DedupeStatus, error?: string): Promise<void> {
  if (!messageId) return;

  await withStoreLock(() => {
    const now = Date.now();
    const store = readStore();
    const messages = store.messages || {};
    pruneExpired(messages, now);

    const existing = messages[messageId] || {
      status,
      firstSeenAt: now,
      updatedAt: now,
      pid: process.pid,
      processStart: processStartFingerprint(process.pid),
    };

    messages[messageId] = {
      ...existing,
      status,
      updatedAt: now,
      error: error ? error.slice(0, 500) : undefined,
    };
    writeStore({ messages });
  });
}

function readStore(): DedupeStore {
  return readJson<DedupeStore>(DEDUPE_PATH, {});
}

function writeStore(store: DedupeStore) {
  ensureRoot();
  writeJson(DEDUPE_PATH, store);
}

function canReclaimProcessing(record: DedupeRecord, now: number) {
  if (record.status !== "processing" || !record.updatedAt || now - record.updatedAt <= PROCESSING_STALE_MS) return false;
  try {
    if (process.kill(record.pid, 0) !== undefined) return false;
  } catch {}
  const currentStart = processStartFingerprint(record.pid);
  return !record.processStart || !currentStart || record.processStart !== currentStart;
}

function pruneExpired(messages: Record<string, DedupeRecord>, now: number) {
  for (const [messageId, record] of Object.entries(messages)) {
    if (!record.updatedAt || now - record.updatedAt > MESSAGE_TTL_MS) {
      delete messages[messageId];
    }
  }
}

async function withStoreLock<T>(fn: () => T | Promise<T>): Promise<T> {
  ensureRoot();
  const lease = await acquireFileLease(`${DEDUPE_PATH}.lock`);
  try {
    return await fn();
  } finally {
    releaseFileLease(lease);
  }
}
