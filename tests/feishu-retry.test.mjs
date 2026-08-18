import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableFeishuError, withFeishuRetry } from "../extension/feishu-retry.ts";

test("retries transient Feishu HTTP errors", async () => {
  let calls = 0;
  const result = await withFeishuRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    return "ok";
  }, "test send");
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("retries transient network errors and gives up after the final attempt", async () => {
  let calls = 0;
  await assert.rejects(() => withFeishuRetry(async () => {
    calls += 1;
    throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  }, "test network"));
  assert.equal(calls, 3);
});

test("does not retry permanent Feishu errors", async () => {
  let calls = 0;
  await assert.rejects(() => withFeishuRetry(async () => {
    calls += 1;
    throw Object.assign(new Error("bad request"), { statusCode: 400 });
  }, "test bad request"), /bad request/);
  assert.equal(calls, 1);
});

test("classifies retryable Feishu error shapes", () => {
  assert.equal(isRetryableFeishuError({ statusCode: 502 }), true);
  assert.equal(isRetryableFeishuError({ status: 429 }), true);
  assert.equal(isRetryableFeishuError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableFeishuError({ message: "fetch failed" }), true);
  assert.equal(isRetryableFeishuError({ statusCode: 401 }), false);
  assert.equal(isRetryableFeishuError({ message: "invalid request" }), false);
});
