import assert from "node:assert/strict";
import test from "node:test";
import { buildHelpCard, isAuthorizedCardAction, parseHelpActionValue } from "../extension/cards.ts";
import { parseBotCommand } from "../extension/messages.ts";

const options = {
  key: "group:oc_1",
  ownerOpenId: "ou_owner",
  chatId: "oc_1",
  chatType: "group",
  isAdmin: true,
  draft: "/effort ",
};

test("help card uses JSON 2.0 with categorized run, fill, and submit actions", () => {
  const card = buildHelpCard(options);
  const raw = JSON.stringify(card);
  assert.equal(card.schema, "2.0");
  assert.ok(Array.isArray(card.body?.elements));
  assert.match(raw, /"pi_feishu_help_run"/);
  assert.match(raw, /"pi_feishu_help_fill"/);
  assert.match(raw, /"pi_feishu_help_submit"/);
  assert.match(raw, /"help_command_input"/);
  assert.match(raw, /"default_value":"\/effort "/);
  assert.match(raw, /"command":"doctor"/);
  assert.match(raw, /"draft":"\/workspace "/);
  assert.match(raw, /会话管理：/);
  assert.match(raw, /上下文管理：/);
  assert.match(raw, /思考强度：/);
  assert.match(raw, /查询与状态：/);
  assert.match(raw, /插件管理（管理员）：/);
  assert.match(raw, /Skill 与模型管理（管理员）：/);
  assert.match(raw, /指定版本升\/降级/);
  assert.match(raw, /添加 Provider/);
  assert.match(raw, /测试 Provider/);
  assert.match(raw, /同步 Provider/);
  assert.match(raw, /删除 Provider（需确认）/);
  assert.match(raw, /\/feishu provider add openai https:\/\/api\.example\.com\/v1 sk-your-api-key auto/);
  assert.match(raw, /`\/feishu provider test openai`/);
  assert.match(raw, /`\/feishu provider sync openai`/);
  assert.match(raw, /`\/feishu provider remove openai confirm`/);
  assert.match(raw, /`\/workspace \/srv\/project`/);
  assert.match(raw, /`\/send report\.pdf`/);
  assert.match(raw, /确认重置插件/);
  assert.match(raw, /Skill 开启/);
  assert.match(raw, /Skill 关闭/);
  assert.doesNotMatch(raw, /\/review/);
});

test("non-admin help cards hide administrator-only actions", () => {
  const raw = JSON.stringify(buildHelpCard({ ...options, isAdmin: false }));
  assert.doesNotMatch(raw, /插件管理（管理员）/);
  assert.doesNotMatch(raw, /Skill 与模型管理（管理员）/);
  assert.doesNotMatch(raw, /配置/);
  assert.doesNotMatch(raw, /日志/);
  assert.doesNotMatch(raw, /刷新模型/);
  assert.doesNotMatch(raw, /添加 Provider/);
  assert.doesNotMatch(raw, /Provider 列表/);
  assert.doesNotMatch(raw, /Skill 开启/);
  assert.doesNotMatch(raw, /Skill 关闭/);
  assert.match(raw, /诊断/);
  assert.match(raw, /版本/);
  assert.match(raw, /状态/);
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

test("every help card run/fill value parses through parseBotCommand", () => {
  const card = buildHelpCard(options);
  const values = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.action === "string" && node.action.startsWith("pi_feishu_help_")) {
      values.push(node);
    }
    for (const item of Object.values(node)) walk(item);
  };
  walk(card);
  assert.ok(values.length > 10);
  for (const value of values) {
    if (typeof value.command === "string") {
      assert.ok(parseBotCommand(`/${value.command}`), `unparsable command: /${value.command}`);
    }
    if (typeof value.draft === "string") {
      assert.ok(parseBotCommand(value.draft), `unparsable draft: ${value.draft}`);
    }
  }
});
