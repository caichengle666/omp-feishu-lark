import assert from "node:assert/strict";
import { test } from "bun:test";
import { FeishuMessageHandler } from "../extension/message-handler.ts";
import { parseBotCommand } from "../extension/messages.ts";

const message = {
  messageId: "om_command",
  chatId: "oc_chat",
  chatType: "p2p",
  senderOpenId: "ou_user",
  msgType: "text",
  content: "",
};

test("bot parser recognizes status, debug, and refresh commands", () => {
  assert.deepEqual(parseBotCommand("/feishu status"), { name: "status" });
  assert.deepEqual(parseBotCommand("/status"), { name: "status" });
  assert.deepEqual(parseBotCommand("/feishu debug"), { name: "debug" });
  assert.deepEqual(parseBotCommand("/feishu refresh"), { name: "refresh" });
});

test("Feishu status is available without administrator permission", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
    status: () => "status report",
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu status"), true);
  assert.deepEqual(replies, ["status report"]);
});

test("Feishu debug and refresh are denied for non-administrators", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
    debug: () => "debug report",
    refresh: () => "refresh report",
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu debug"), true);
  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu refresh"), true);
  assert.equal(replies.length, 2);
  assert.match(replies[0], /无权执行远程 debug/);
  assert.match(replies[0], /ou_user/);
  assert.match(replies[1], /无权执行远程 refresh/);
  assert.match(replies[1], /ou_user/);
});

test("Feishu debug and refresh run for an administrator", async () => {
  const replies = [];
  const calls = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
    debug: () => { calls.push("debug"); return "debug report"; },
    refresh: () => { calls.push("refresh"); return "refresh report"; },
    isAdmin: () => true,
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu debug"), true);
  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu refresh"), true);
  assert.deepEqual(calls, ["debug", "refresh"]);
  assert.deepEqual(replies, ["debug report", "refresh report"]);
});
