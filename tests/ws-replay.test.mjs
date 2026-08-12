import assert from "node:assert/strict";
import test from "node:test";
import { FeishuTransport } from "../extension/transport.ts";

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
