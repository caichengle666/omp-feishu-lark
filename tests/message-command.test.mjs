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
  assert.deepEqual(parseBotCommand("/feishu reset"), { name: "reset" });
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

test("OMP-only lifecycle commands reply with guidance instead of reaching the model", async () => {
  const replies = [];
  const transport = { replyText: async (_messageId, text) => { replies.push(text); } };
  const handler = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
  });
  const message = {
    messageId: "om_lifecycle",
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
  assert.ok(replies.every((text) => text.includes("OMP 后台命令")));
  assert.match(replies[2], /\/feishu restart/);
});
