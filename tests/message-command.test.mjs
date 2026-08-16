import assert from "node:assert/strict";
import { test } from "bun:test";
import { FeishuMessageHandler } from "../extension/message-handler.ts";
import { parseBotCommand } from "../extension/messages.ts";

test("bot parser recognizes /feishu setup as a plugin command", () => {
  assert.deepEqual(parseBotCommand("/feishu setup"), { name: "setup" });
  assert.deepEqual(parseBotCommand("/FEISHU SETUP"), { name: "setup" });
  assert.deepEqual(parseBotCommand("/feishu setup 0.4.30"), undefined);
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
