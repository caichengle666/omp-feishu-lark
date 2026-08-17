import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { configureSdkRestTimeout, createWsReadyGate, FeishuTransport } from "../extension/transport.ts";

test("configures a finite timeout for every SDK REST request", () => {
  const client = { httpInstance: { defaults: { timeout: 0 } } };
  configureSdkRestTimeout(client, 15_000);
  assert.equal(client.httpInstance.defaults.timeout, 15_000);
});

test("direct notification delivery applies the same SDK REST timeout", () => {
  const source = readFileSync(new URL("../extension/delivery.ts", import.meta.url), "utf8");
  assert.match(source, /configureSdkRestTimeout\(this\.sdkClient\)/);
});

test("SDK REST timeout aborts a real stalled HTTP request", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late"), 500);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = defaultHttpInstance.defaults.timeout;
  try {
    configureSdkRestTimeout({ httpInstance: defaultHttpInstance }, 50);
    await assert.rejects(defaultHttpInstance.get(`http://127.0.0.1:${address.port}/stall`), /timeout/i);
  } finally {
    defaultHttpInstance.defaults.timeout = previous;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WebSocket readiness waits for onReady and rejects on connection failure", async () => {
  const ready = createWsReadyGate(1_000);
  ready.resolve();
  await ready.promise;

  const failed = createWsReadyGate(1_000);
  failed.reject(new Error("connect failed"));
  await assert.rejects(failed.promise, /connect failed/);
});

test("replays a Feishu message event through the transport callback", async () => {
  let received;
  const transport = new FeishuTransport({
    appId: "test-app",
    appSecret: "test-secret",
    domain: "feishu",
    groupPolicy: "open",
  }, async (message) => {
    received = message;
  }, async () => undefined);

  transport.sdkClient = {
    im: { v1: { chat: { get: async () => ({ data: { chat_mode: "group" } }) } } },
  };

  await transport.handleRawMessage({
    event: {
      message: {
        message_id: "om_replay_1",
        message_type: "text",
        chat_id: "oc_replay",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
      },
      sender: { sender_type: "user", sender_id: { open_id: "ou_replay" } },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, {
    messageId: "om_replay_1",
    chatId: "oc_replay",
    chatType: "group",
    chatMode: "group",
    senderOpenId: "ou_replay",
    msgType: "text",
    content: JSON.stringify({ text: "hello" }),
    rootId: undefined,
    parentId: undefined,
    threadId: undefined,
    mentions: undefined,
  });
});

test("does not dispatch bot-authored replay events", async () => {
  let calls = 0;
  const transport = new FeishuTransport({ appId: "test-app", appSecret: "test-secret", domain: "feishu", groupPolicy: "open" }, async () => { calls += 1; }, async () => undefined);
  await transport.handleRawMessage({ event: { message: { message_id: "om_bot", chat_id: "oc", chat_type: "p2p", message_type: "text", content: "{}" }, sender: { sender_type: "bot" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("WS card actions return a card update without issuing a second update request", async () => {
  let updateCalls = 0;
  const transport = new FeishuTransport({ appId: "test-app", appSecret: "test-secret", domain: "feishu", groupPolicy: "open" }, async () => undefined, async () => ({ header: { title: "updated" } }));
  transport.updateCard = async () => { updateCalls += 1; };

  const result = await transport.handleCardAction({
    context: { open_message_id: "om_card", open_chat_id: "oc_card" },
    operator: { open_id: "ou_user" },
    action: { value: { action: "test" } },
  });

  assert.deepEqual(result, { card: { type: "raw", data: { header: { title: "updated" } } } });
  assert.equal(updateCalls, 0);
});
