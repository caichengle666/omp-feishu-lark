import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { resolveWorkspaceFilePath } from "../extension/conversation-manager.ts";
import { FeishuMessageHandler } from "../extension/message-handler.ts";
import { parseBotCommand } from "../extension/messages.ts";
import { FeishuTransport } from "../extension/transport.ts";

const message = {
  messageId: "om_send",
  chatId: "oc_chat",
  chatType: "p2p",
  senderOpenId: "ou_user",
  msgType: "text",
  content: "",
};

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "feishu-send-"));
  mkdirSync(join(root, "project"));
  return root;
}

test("bot parser recognizes send and config commands", () => {
  assert.deepEqual(parseBotCommand("/send report.pdf"), { name: "send", path: "report.pdf" });
  assert.deepEqual(parseBotCommand("/feishu send ./report.pdf"), { name: "send", path: "./report.pdf" });
  assert.deepEqual(parseBotCommand("/feishu config"), { name: "config" });
});

test("workspace file resolver permits files inside the workspace and rejects outside paths", () => {
  const root = tempWorkspace();
  try {
    const local = join(root, "project", "report.pdf");
    writeFileSync(local, "pdf");
    assert.equal(resolveWorkspaceFilePath(join(root, "project"), "report.pdf"), local);

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    assert.throws(() => resolveWorkspaceFilePath(join(root, "project"), "../outside.txt"), /当前工作区内/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Feishu p2p /send sends a workspace file through the transport", async () => {
  const root = tempWorkspace();
  try {
    const local = join(root, "project", "report.pdf");
    writeFileSync(local, "pdf");
    const replies = [];
    const sent = [];
    const transport = {
      replyText: async (_messageId, text) => { replies.push(text); },
      replyLocalFile: async (_messageId, path) => { sent.push(path); return { kind: "file", fileName: "report.pdf" }; },
    };
    const handler = new FeishuMessageHandler({
      resolveWorkspaceFile: () => local,
    }, () => transport, undefined, {});
    assert.equal(await handler.handleCommand(message, "p2p:ou_user", "/send report.pdf"), true);
    assert.deepEqual(sent, [local]);
    assert.match(replies[0], /report\.pdf 已发送/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("group /send is denied for non-administrators", async () => {
  const replies = [];
  let sent = false;
  const transport = {
    replyText: async (_messageId, text) => { replies.push(text); },
    replyLocalFile: async () => { sent = true; },
  };
  const handler = new FeishuMessageHandler({
    resolveWorkspaceFile: () => "/tmp/project/report.pdf",
  }, () => transport, undefined, {
    isAdmin: () => false,
  });
  const groupMessage = { ...message, chatType: "group" };

  assert.equal(await handler.handleCommand(groupMessage, "group:oc_chat", "/send report.pdf"), true);
  assert.equal(sent, false);
  assert.match(replies[0], /群聊发送文件需要管理员权限/);
});

test("transport uploads a local PDF as a Feishu file", async () => {
  const root = tempWorkspace();
  try {
    const filePath = join(root, "report.pdf");
    writeFileSync(filePath, "pdf-content");
    let reply;
    const transport = new FeishuTransport({ appId: "test", appSecret: "test", domain: "feishu" }, async () => undefined, async () => undefined);
    transport.sdkClient = {
      im: {
        v1: {
          file: { create: async () => ({ file_key: "file_pdf_1" }) },
        },
        message: {
          reply: async ({ data }) => { reply = data; },
        },
      },
    };

    const result = await transport.replyLocalFile("om_1", filePath);
    assert.equal(result.kind, "file");
    assert.equal(reply.msg_type, "file");
    assert.equal(JSON.parse(reply.content).file_key, "file_pdf_1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transport uploads a local PNG as a Feishu image", async () => {
  const root = tempWorkspace();
  try {
    const filePath = join(root, "chart.png");
    const png = Buffer.alloc(12);
    png[0] = 0x89;
    png[1] = 0x50;
    png[2] = 0x4e;
    png[3] = 0x47;
    writeFileSync(filePath, png);
    let reply;
    const transport = new FeishuTransport({ appId: "test", appSecret: "test", domain: "feishu" }, async () => undefined, async () => undefined);
    transport.sdkClient = {
      im: {
        v1: {
          image: { create: async () => ({ image_key: "img_chart_1" }) },
        },
        message: {
          reply: async ({ data }) => { reply = data; },
        },
      },
    };

    const result = await transport.replyLocalFile("om_2", filePath);
    assert.equal(result.kind, "image");
    assert.equal(reply.msg_type, "image");
    assert.equal(JSON.parse(reply.content).image_key, "img_chart_1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
