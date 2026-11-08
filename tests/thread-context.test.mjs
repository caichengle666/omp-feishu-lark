import { describe, expect, test } from "bun:test";
import { formatThreadContext, THREAD_CONTEXT_MAX_CHARS } from "../extension/thread-context.ts";
import { buildPrompt } from "../extension/message-handler.ts";

const m = (messageId, text, createTime = Date.UTC(2026, 10, 6, 7, 22), fromBot = false) => ({
  messageId,
  senderId: fromBot ? "cli_bot" : "ou_user",
  fromBot,
  createTime,
  msgType: "text",
  text,
});

describe("formatThreadContext", () => {
  test("空历史返回空串", () => {
    expect(formatThreadContext([], "cur")).toBe("");
  });

  test("原帖在前，当前消息不重复出现", () => {
    const out = formatThreadContext([m("root", "原帖需求"), m("cur", "审查代码")], "cur");
    expect(out.startsWith("## 话题上下文")).toBe(true);
    expect(out).toContain("原帖需求");
    expect(out).not.toContain("审查代码");
  });

  test("bot 自己的旧答复不注入", () => {
    const out = formatThreadContext([m("root", "原帖"), m("bot1", "上轮错误结论", Date.UTC(2026, 10, 6, 8), true), m("u1", "人工补充", Date.UTC(2026, 10, 6, 9))], "cur");
    expect(out).toContain("原帖");
    expect(out).toContain("人工补充");
    expect(out).not.toContain("上轮错误结论");
  });

  test("超长单条截断保留开头，不整条丢弃", () => {
    const rows = [m("root", "原帖"), m("huge", "需求".repeat(THREAD_CONTEXT_MAX_CHARS)), m("early", "更早的人工评论", Date.UTC(2026, 10, 6, 8))];
    const out = formatThreadContext(rows, "cur");
    expect(out).toContain("更早的人工评论");
    expect(out).toContain("需求需求");
    expect(out).toContain("本条已截断");
  });

  test("createTime 缺失不炸且不渲染 1970", () => {
    expect(formatThreadContext([m("root", "原帖", 0)], "cur")).toContain("??-?? ??:??");
  });

  test("超预算时保留原帖+最新若干条并标注省略数", () => {
    const rows = [m("root", "原帖")];
    for (let i = 0; i < 100; i += 1) rows.push(m(`n${i}`, "长".repeat(200), Date.UTC(2026, 10, 6, 8, i % 60)));
    const out = formatThreadContext(rows, "cur");
    expect(out).toContain("原帖");
    expect(out).toMatch(/省略了 \d+ 条/);
    expect(out).toContain("长".repeat(200));
  });
});

describe("buildPrompt", () => {
  const msg = {
    messageId: "om_cur", chatId: "oc_1", chatType: "group", chatMode: "topic",
    senderOpenId: "ou_1", msgType: "text", content: "{}", threadId: "omt_1",
  };

  test("有上下文时分节，且本条消息在末尾", () => {
    const prompt = buildPrompt(msg, "审查代码", [], [], 0, true, [], "## 话题上下文\n[11-06 07:22 user] 原帖");
    expect(prompt.startsWith("[飞书话题] ")).toBe(true);
    expect(prompt).toContain("## 本条消息（需要处理的消息）");
    expect(prompt.trimEnd().endsWith("审查代码")).toBe(true);
  });

  test("无上下文时保持原样", () => {
    expect(buildPrompt(msg, "审查代码", [], [], 0, true, [])).toBe("[飞书话题] 审查代码");
  });
});
