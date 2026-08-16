import { test } from "bun:test";
import assert from "node:assert/strict";
import { FeishuMessageHandler } from "../extension/message-handler.ts";

const message = {
  messageId: "om_upgrade",
  chatId: "oc_chat",
  chatType: "p2p",
  senderOpenId: "ou_admin",
  msgType: "text",
  content: "",
};

test("remote upgrade is denied unless the sender is an explicit administrator", async () => {
  const replies = [];
  let upgrades = 0;
  let upgradeTarget;
  const transport = { replyText: async (_messageId, text) => replies.push(text) };
  const denied = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
    upgrade: async () => { upgrades += 1; return "upgraded"; },
    isAdmin: () => false,
  });

  assert.equal(await denied.handleCommand(message, "p2p:ou_admin", "/feishu upgrade"), true);
  assert.equal(upgrades, 0);
  assert.match(replies[0], /ou_admin/);

  const allowed = new FeishuMessageHandler({}, () => transport, undefined, {
    doctor: () => "",
    version: () => "",
    upgrade: async (_version, target) => { upgrades += 1; upgradeTarget = target; return "upgraded"; },
    isAdmin: (openId) => openId === "ou_admin",
  });
  assert.equal(await allowed.handleCommand(message, "p2p:ou_admin", "/feishu upgrade"), true);
  assert.equal(upgrades, 1);
  assert.deepEqual(upgradeTarget, {
    chatId: "oc_chat",
    messageId: "om_upgrade",
    sessionKey: "p2p:ou_admin",
    chatType: "p2p",
  });
  assert.equal(replies.at(-1), "upgraded");
});
