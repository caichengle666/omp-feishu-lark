import { setTimeout as delay } from "node:timers/promises";

const MAX_ATTEMPTS = 3;

export async function withFeishuRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableFeishuError(error)) throw error;
      const waitMs = 250 * 2 ** (attempt - 1);
      // Keep retries short so a failed Feishu request does not block the OMP queue.
      await delay(waitMs);
    }
  }
}

export function isRetryableFeishuError(error: unknown) {
  const raw = error as any;
  const status = Number(raw?.statusCode ?? raw?.status ?? raw?.response?.status ?? raw?.response?.statusCode);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(raw?.code || raw?.cause?.code || "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return true;
  const message = String(raw?.message || error || "").toLowerCase();
  return /(timeout|timed out|network|socket|connection reset|fetch failed|eai_again|enotfound)/i.test(message);
}
