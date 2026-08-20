import assert from "node:assert/strict";
import test from "node:test";
import { buildHelpCard, isAuthorizedCardAction, parseHelpActionValue } from "../extension/cards.ts";

const options = {
  key: "group:oc_1",
  ownerOpenId: "ou_owner",
  chatId: "oc_1",
  chatType: "group",
  ompCommands: [{ name: "review", description: "Review current diff" }],
  draft: "/effort ",
};

test("help card uses JSON 2.0 with run, fill, and submit actions", () => {
  const card = buildHelpCard(options);
  const raw = JSON.stringify(card);
  assert.equal(card.schema, "2.0");
  assert.ok(Array.isArray(card.body?.elements));
  assert.match(raw, /"pi_feishu_help_run"/);
  assert.match(raw, /"pi_feishu_help_fill"/);
  assert.match(raw, /"pi_feishu_help_submit"/);
  assert.match(raw, /"help_command_input"/);
  assert.match(raw, /"default_value":"\/effort "/);
  assert.match(raw, /\/feishu doctor/);
  assert.match(raw, /\/workspace PATH/);
  assert.match(raw, /\/review/);
});

test("help action parser extracts run, fill, and submit values", () => {
  const run = parseHelpActionValue({
    action: "pi_feishu_help_run",
    key: options.key,
    chatType: options.chatType,
    command: "model",
    ownerOpenId: options.ownerOpenId,
    chatId: options.chatId,
  });
  assert.equal(run?.action, "pi_feishu_help_run");
  assert.equal(run?.command, "model");

  const fill = parseHelpActionValue({
    action: "pi_feishu_help_fill",
    key: options.key,
    chatType: options.chatType,
    draft: "/workspace ",
    ownerOpenId: options.ownerOpenId,
    chatId: options.chatId,
  });
  assert.equal(fill?.draft, "/workspace ");

  const submit = parseHelpActionValue({
    action: "pi_feishu_help_submit",
    key: options.key,
    chatType: options.chatType,
    inputName: "help_command_input",
    ownerOpenId: options.ownerOpenId,
    chatId: options.chatId,
  });
  assert.equal(submit?.inputName, "help_command_input");
});

test("help card actions are bound to the originating user and chat", () => {
  const value = parseHelpActionValue({
    action: "pi_feishu_help_run",
    key: options.key,
    chatType: options.chatType,
    command: "new",
    ownerOpenId: options.ownerOpenId,
    chatId: options.chatId,
  });
  assert.ok(value);
  assert.equal(isAuthorizedCardAction(value, { operatorOpenId: "ou_owner", chatId: "oc_1" }), true);
  assert.equal(isAuthorizedCardAction(value, { operatorOpenId: "ou_other", chatId: "oc_1" }), false);
  assert.equal(isAuthorizedCardAction(value, { operatorOpenId: "ou_owner", chatId: "oc_other" }), false);
});
