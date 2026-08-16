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
  assert.deepEqual(parseBotCommand("/feishu config"), { name: "config" });
});

test("Feishu status passes administrator detail permission to the reporter", async () => {
  const replies = [];
  const detailFlags = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
    status: (detailed) => { detailFlags.push(detailed); return "status report"; },
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu status"), true);
  assert.deepEqual(replies, ["status report"]);
  assert.deepEqual(detailFlags, [false]);
});

test("Feishu doctor and version request sanitized reports for non-administrators", async () => {
  const replies = [];
  const detailFlags = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: (detailed) => { detailFlags.push(["doctor", detailed]); return "doctor report"; },
    version: (detailed) => { detailFlags.push(["version", detailed]); return "version report"; },
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/doctor"), true);
  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/version"), true);
  assert.deepEqual(detailFlags, [["doctor", false], ["version", false]]);
  assert.deepEqual(replies, ["doctor report", "version report"]);
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

test("Feishu config is denied for non-administrators and shown for administrators", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const denied = new FeishuMessageHandler({}, () => transport, undefined, { isAdmin: () => false });
  assert.equal(await denied.handleCommand(message, "p2p:ou_user", "/feishu config"), true);
  assert.match(replies[0], /无权查看远程配置/);

  const allowedReplies = [];
  const allowedTransport = { replyText: async (_messageId, text) => { allowedReplies.push(text); } };
  const allowed = new FeishuMessageHandler({}, () => allowedTransport, undefined, {
    isAdmin: () => true,
    config: () => "config report",
  });
  assert.equal(await allowed.handleCommand(message, "p2p:ou_user", "/feishu config"), true);
  assert.deepEqual(allowedReplies, ["config report"]);
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

test("workspace changes require an administrator in p2p and group chats", async () => {
  const replies = [];
  let switched = false;
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    switchWorkspace: async () => { switched = true; },
  }, () => transport, undefined, {
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/workspace /tmp/project"), true);
  assert.equal(switched, false);
  assert.match(replies[0], /切换工作区需要管理员权限/);
  assert.match(replies[0], /ou_user/);
  const groupMessage = { ...message, chatType: "group" };
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/workspace /tmp/project"), true);
  assert.match(replies[1], /切换工作区需要管理员权限/);
});

test("group resume requires an administrator", async () => {
  const replies = [];
  let listed = false;
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const groupMessage = { ...message, chatType: "group" };
  const handler = new FeishuMessageHandler({
    listResumeSessions: async () => { listed = true; return {}; },
  }, () => transport, undefined, {
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/resume"), true);
  assert.equal(listed, false);
  assert.match(replies[0], /群聊恢复历史会话需要管理员权限/);
});
