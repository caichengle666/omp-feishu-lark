import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildUpgradeProgressCard, FeishuMessageHandler, formatUpgradeRemaining } from "../extension/message-handler.ts";
import { feishuHelpText, formatOmpCommands } from "../extension/help.ts";
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

test("group state-changing commands require an administrator", async () => {
  const replies = [];
  let newConversation = false;
  let listed = false;
  let stopped = false;
  let listedModels = false;
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const groupMessage = { ...message, chatType: "group" };
  const handler = new FeishuMessageHandler({
    newConversation: async () => { newConversation = true; },
    listResumeSessions: async () => { listed = true; return {}; },
    stopConversation: async () => { stopped = true; },
    getAvailableModels: async () => { listedModels = true; return []; },
  }, () => transport, undefined, {
    isAdmin: () => false,
  });

  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/new"), true);
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/model"), true);
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/resume"), true);
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/stop"), true);
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/effort high"), true);
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/compact"), true);
  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/autocompact on"), true);
  assert.equal(newConversation, false);
  assert.equal(listedModels, false);
  assert.equal(listed, false);
  assert.equal(stopped, false);
  assert.equal(replies.length, 7);
  assert.deepEqual(replies.map((text) => text.includes("管理员权限")), [true, true, true, true, true, true, true]);
});

test("feishu help documents the effort command", () => {
  const help = feishuHelpText([{ name: "compact", description: "Manually compact the session context", source: "builtin" }]);
  assert.match(help, /\/effort/);
  assert.match(help, /inherit\/off\/minimal/);
  assert.match(help, /\/compact/);
  assert.match(help, /\/autocompact/);
  assert.match(help, /\/commands/);
  assert.match(help, /飞书端不能执行/);
  assert.match(help, /指定版本可升级或降级/);
  assert.match(formatOmpCommands([
    { name: "review", aliases: ["code-review"], description: "Review the current diff", input: { hint: "depth" } },
  ]), /\/review、\/code-review depth - Review the current diff/);
});

test("remote upgrade displays a countdown card and updates its phase", async () => {
  const cards = [];
  const updates = [];
  const replies = [];
  const transport = {
    replyCard: async (_messageId, card) => { cards.push(card); return "om_upgrade_progress"; },
    updateCard: async (messageId, card) => { updates.push([messageId, card]); },
    replyText: async (_messageId, text) => { replies.push(text); },
  };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    isAdmin: () => true,
    upgradeTimeoutSeconds: 90,
    upgrade: async (_version, _target, onProgress) => {
      onProgress?.("正在下载并安装 v0.4.37");
      return "升级文件已就绪，正在重启服务…";
    },
  });

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu upgrade"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(JSON.stringify(cards[0]), /飞书插件升级中/);
  assert.match(JSON.stringify(cards[0]), /预计剩余：1 分 30 秒/);
  assert.ok(updates.some(([, card]) => JSON.stringify(card).includes("正在下载并安装 v0.4.37")));
  assert.match(JSON.stringify(updates.at(-1)?.[1]), /正在重启飞书服务/);
  assert.deepEqual(replies, ["升级文件已就绪，正在重启服务…"]);
  assert.equal(formatUpgradeRemaining(61), "1 分 1 秒");
  assert.match(JSON.stringify(buildUpgradeProgressCard({ phase: "测试", remainingSeconds: 0 })), /预计剩余：0 秒/);
});
