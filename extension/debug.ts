import { appendFile, readFile, writeFile } from "node:fs/promises";
import { DEBUG_LOG_PATH, ensureRoot } from "./config.js";

const MAX_VALUE_LENGTH = 1200;
const MAX_LOG_LINES = 1000;
const TRIM_TRIGGER_LINES = 1200;
const FLUSH_DELAY_MS = 25;
const pending: string[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let flushing: Promise<void> | undefined;
let batchesSinceTrimCheck = 0;

export function debugLog(event: string, details?: Record<string, unknown>) {
  try {
    pending.push(JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...(details ? { details: truncate(details) } : {}),
    }));
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = undefined; void flushDebugLog(); }, FLUSH_DELAY_MS);
      flushTimer.unref?.();
    }
  } catch {
    // Debug logging must never break message handling.
  }
}

export async function flushDebugLog() {
  if (flushing) await flushing;
  if (!pending.length) return;
  const lines = pending.splice(0, pending.length);
  flushing = writeBatch(lines);
  try { await flushing; } finally { flushing = undefined; }
  if (pending.length) await flushDebugLog();
}

async function writeBatch(lines: string[]) {
  try {
    ensureRoot();
    await appendFile(DEBUG_LOG_PATH, `${lines.join("\n")}\n`, "utf8");
    batchesSinceTrimCheck += 1;
    if (batchesSinceTrimCheck < 40) return;
    batchesSinceTrimCheck = 0;
    const content = await readFile(DEBUG_LOG_PATH, "utf8");
    const allLines = content.trimEnd().split("\n");
    if (allLines.length > TRIM_TRIGGER_LINES) {
      await writeFile(DEBUG_LOG_PATH, `${allLines.slice(-MAX_LOG_LINES).join("\n")}\n`, "utf8");
    }
  } catch {
    // Debug logging must never break message handling.
  }
}

function truncate(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
  if (Array.isArray(value)) return value.map((item) => truncate(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = truncate(item);
    return out;
  }
  return value;
}
