import assert from "node:assert/strict";
import { test } from "bun:test";
import { FeishuMessageHandler } from "../extension/message-handler.ts";
import { parseBotCommand } from "../extension/messages.ts";

test("bot parser recognizes /feishu setup as a plugin command", () => {
  assert.deepEqual(parseBotCommand("/feishu setup"), { name: "setup" });
  assert.deepEqual(parseBotCommand("/FEISHU SETUP"), { name: "setup" });
  assert.deepEqual(parseBotCommand("/feishu setup 0.4.30"), undefined);
  assert.deepEqual(parseBotCommand("/send report.png"), { name: "send", path: "report.png" });
  assert.deepEqual(parseBotCommand("/feishu config"), { name: "config" });
  assert.deepEqual(parseBotCommand("/feishu start"), { name: "pluginStart" });
  assert.deepEqual(parseBotCommand("/FEISHU STOP"), { name: "pluginStop" });
  assert.deepEqual(parseBotCommand("/feishu restart"), { name: "pluginRestart" });
  assert.deepEqual(parseBotCommand("/feishu autostart"), { name: "autostart" });
  assert.deepEqual(parseBotCommand("/feishu skills on"), { name: "skills", enabled: "on" });
  assert.deepEqual(parseBotCommand("/FEISHU SKILLS OFF"), { name: "skills", enabled: "off" });
  assert.deepEqual(parseBotCommand("/feishu reset"), { name: "reset" });
});

test("skills lifecycle commands require admin and restart with the selected state", async () => {
  const replies = [];
  const calls = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    isAdmin: () => true,
    lifecycle: {
      skills: async (enabled, target) => {
        calls.push({ enabled, target });
        return "Skill 已切换";
      },
    },
  });
  const message = { messageId: "om_skills", chatId: "oc_chat", chatType: "p2p", senderOpenId: "ou_admin", msgType: "text", content: "" };
  assert.equal(await handler.handleCommand(message, "p2p:ou_admin", "/feishu skills on"), true);
  assert.equal(calls[0].enabled, true);
  assert.equal(await handler.handleCommand(message, "p2p:ou_admin", "/feishu skills"), true);
  assert.match(replies.at(-1), /用法/);
});

test("bot parser recognizes /effort with or without a level", () => {
  assert.deepEqual(parseBotCommand("/effort"), { name: "effort", level: undefined });
  assert.deepEqual(parseBotCommand("/effort high"), { name: "effort", level: "high" });
  assert.deepEqual(parseBotCommand("/EFFORT max"), { name: "effort", level: "max" });
});

test("bot parser recognizes compact and autocompact commands", () => {
  assert.deepEqual(parseBotCommand("/compact"), { name: "compact", instructions: undefined });
  assert.deepEqual(parseBotCommand("/compact keep model details"), { name: "compact", instructions: "keep model details" });
  assert.deepEqual(parseBotCommand("/autocompact"), { name: "autocompact", enabled: undefined });
  assert.deepEqual(parseBotCommand("/autocompact on"), { name: "autocompact", enabled: "on" });
  assert.deepEqual(parseBotCommand("/autocompact off"), { name: "autocompact", enabled: "off" });
  assert.equal(parseBotCommand("/autocompact maybe"), undefined);
  assert.deepEqual(parseBotCommand("/commands"), { name: "commands" });
  assert.deepEqual(parseBotCommand("/feishu commands"), { name: "commands" });
});

test("duplicate help deliveries within the content window produce one card", async () => {
  const cards = [];
  const transport = {
    getBotOpenId: () => undefined,
    replyCard: async (_messageId, card) => { cards.push(card); },
  };
  const handler = new FeishuMessageHandler({
    listOmpCommands: async () => [],
  }, () => transport);
  const message = (messageId) => ({
    messageId,
    chatId: "oc_help_dedupe",
    chatType: "p2p",
    senderOpenId: "ou_help_dedupe",
    msgType: "text",
    content: JSON.stringify({ text: "/help" }),
  });

  const suffix = `${process.pid}_${Date.now()}_${Math.random()}`;
  await handler.handle(message(`om_help_1_${suffix}`));
  await handler.handle(message(`om_help_2_${suffix}`));
  assert.equal(cards.length, 1);
});

test("effort without a level reports the current thinking level", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    getSelectedThinkingLevel: () => "high",
  }, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_effort",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/effort"), true);
  assert.deepEqual(replies, ["当前思考强度：high"]);
});

test("effort rejects unsupported levels with the available list", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_effort_invalid",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/effort turbo"), true);
  assert.match(replies[0], /不支持的思考强度：turbo/);
  assert.match(replies[0], /inherit \/ off \/ minimal/);
});

test("effort switches the conversation thinking level", async () => {
  const replies = [];
  const selected = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    selectThinkingLevel: async (_key, level, onReply) => {
      selected.push(level);
      await onReply(`已切换思考强度为 ${level}，后续任务生效。`);
    },
  }, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_effort_switch",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/effort off"), true);
  assert.deepEqual(selected, ["off"]);
  assert.deepEqual(replies, ["已切换思考强度为 off，后续任务生效。"]);
});

test("autocompact without a value reports the current setting", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    getAutoCompaction: () => true,
  }, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_autocompact",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/autocompact"), true);
  assert.deepEqual(replies, ["当前自动上下文压缩：开启"]);
});

test("autocompact on switches the conversation setting", async () => {
  const replies = [];
  const selected = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    setAutoCompaction: async (_key, enabled, onReply) => {
      selected.push(enabled);
      await onReply(`已${enabled ? "开启" : "关闭"}自动上下文压缩，后续任务生效。`);
    },
  }, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_autocompact_on",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/autocompact on"), true);
  assert.deepEqual(selected, [true]);
  assert.deepEqual(replies, ["已开启自动上下文压缩，后续任务生效。"]);
});

test("compact passes focus instructions to the conversation manager", async () => {
  const replies = [];
  const calls = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    compactConversation: async (_key, instructions, onReply) => {
      calls.push(instructions);
      await onReply("上下文已压缩。");
    },
  }, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_compact",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/compact keep API details"), true);
  assert.deepEqual(calls, ["keep API details"]);
  assert.deepEqual(replies, ["上下文已压缩。"]);
});

test("commands explains OMP commands are terminal-only", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({
    listOmpCommands: async () => [
      { name: "compact", description: "Manually compact the session context", source: "builtin" },
      { name: "review", description: "Review current diff", source: "builtin" },
    ],
  }, () => transport, undefined, { isAdmin: () => false });
  const message = {
    messageId: "om_commands",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/commands"), true);
  assert.match(replies[0], /OMP 自带命令/);
});

test("Feishu setup replies with OMP guidance instead of sending the text to the model", async () => {
  const replies = [];
  const transport = {
    replyText: async (_messageId, text) => {
      replies.push(text);
    },
  };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
  });
  const message = {
    messageId: "om_setup",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };

  assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/feishu setup"), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /OMP 后台/);
});

test("non-administrators cannot execute lifecycle commands remotely", async () => {
  const replies = [];
  const calls = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    isAdmin: () => false,
    lifecycle: {
      start: async () => { calls.push("start"); return "started"; },
      stop: async () => { calls.push("stop"); return "stopped"; },
      restart: async () => { calls.push("restart"); return "restarted"; },
      autostart: async () => { calls.push("autostart"); return "autostart on"; },
      reset: async () => { calls.push("reset"); return "reset"; },
    },
  });
  const message = {
    messageId: "om_lifecycle_denied",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };
  for (const command of ["/feishu start", "/feishu stop", "/feishu restart", "/feishu autostart", "/feishu reset"]) {
    assert.equal(await handler.handleCommand(message, "p2p:ou_user", command), true);
  }
  assert.equal(replies.length, 5);
  assert.ok(replies.every((text) => text.includes("无权执行远程")));
  assert.equal(calls.length, 0);
});

test("administrators can execute lifecycle commands remotely", async () => {
  const replies = [];
  const calls = [];
  const restartTargets = [];
  const transport = {
    replyText: async (_messageId, text) => { replies.push(text); },
    isRunning: () => true,
  };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    isAdmin: () => true,
    lifecycle: {
      start: async () => { calls.push("start"); return "started"; },
      stop: async () => { calls.push("stop"); return "stopped"; },
      restart: async (target) => { calls.push("restart"); restartTargets.push(target); return "restarted"; },
      autostart: async () => { calls.push("autostart"); return "autostart on"; },
      reset: async () => { calls.push("reset"); return "resetted"; },
    },
  });
  const message = {
    messageId: "om_lifecycle_admin",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
  };
  for (const command of ["/feishu start", "/feishu stop", "/feishu restart", "/feishu autostart", "/feishu reset"]) {
    assert.equal(await handler.handleCommand(message, "p2p:ou_user", command), true);
  }
  assert.deepEqual(calls, ["start", "stop", "restart", "autostart", "reset"]);
  assert.equal(replies.length, 10);
  assert.ok(replies.some((text) => text === "已收到 /feishu restart，正在执行…"));
  assert.ok(replies.some((text) => text === "restarted"));
  assert.deepEqual(restartTargets, [{
    chatId: "oc_chat",
    messageId: "om_lifecycle_admin",
    sessionKey: "p2p:ou_user",
    chatType: "p2p",
  }]);
});
