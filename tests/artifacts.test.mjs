import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "bun:test";
import { collectSendableArtifacts } from "../extension/artifacts.ts";
import { TaskStatusCard } from "../extension/task-status-card.ts";

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "feishu-artifacts-"));
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "tmp"));
  return root;
}

function imageEvent(toolName, imagePaths) {
  return {
    type: "tool_execution_end",
    toolName,
    isError: false,
    result: { details: { imagePaths } },
  };
}

test("collectSendableArtifacts accepts generated images outside the workspace", () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const imagePath = join(root, "tmp", "omp-image.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const paths = collectSendableArtifacts(imageEvent("generate_image", [imagePath]), workspace);
    assert.deepEqual(paths, [imagePath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSendableArtifacts accepts generated workspace files and skips code, missing, and outside paths", () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const report = join(workspace, "report.pdf");
    const source = join(workspace, "index.ts");
    const outside = join(root, "outside.zip");
    writeFileSync(report, "pdf");
    writeFileSync(source, "export const a = 1;");
    writeFileSync(outside, "zip");

    const paths = collectSendableArtifacts({
      type: "tool_execution_end",
      toolName: "write",
      isError: false,
      result: { details: { resolvedPath: report } },
    }, workspace);
    assert.deepEqual(paths, [report]);

    assert.deepEqual(collectSendableArtifacts({
      type: "tool_execution_end",
      toolName: "write",
      isError: false,
      result: { details: { resolvedPath: source } },
    }, workspace), []);

    assert.deepEqual(collectSendableArtifacts({
      type: "tool_execution_end",
      toolName: "write",
      isError: false,
      result: { details: { resolvedPath: outside } },
    }, workspace), []);

    assert.deepEqual(collectSendableArtifacts({
      type: "tool_execution_end",
      toolName: "write",
      isError: false,
      result: { details: { resolvedPath: join(workspace, "missing.pdf") } },
    }, workspace), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSendableArtifacts resolves tts output_path relative to the workspace", () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const audio = join(workspace, "voice.wav");
    writeFileSync(audio, "wav");

    const paths = collectSendableArtifacts({
      type: "tool_execution_start",
      toolName: "tts",
      args: { output_path: "voice.wav" },
    }, workspace);
    assert.deepEqual(paths, [audio]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact validation rejects workspace symlinks that resolve outside the workspace", () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.pdf"), "secret");
    symlinkSync(outside, join(workspace, "linked"), "junction");
    const linked = join(workspace, "linked", "secret.pdf");

    assert.deepEqual(collectSendableArtifacts({
      type: "tool_execution_end",
      toolName: "write",
      isError: false,
      result: { details: { resolvedPath: linked } },
    }, workspace), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary file tools are collected only after a successful end event", () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const existing = join(workspace, "existing.pdf");
    writeFileSync(existing, "old");
    assert.deepEqual(collectSendableArtifacts({
      type: "tool_execution_start",
      toolName: "write",
      args: { path: existing },
    }, workspace), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskStatusCard sends collected artifacts only when the task finishes as done", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const imagePath = join(root, "tmp", "chart.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const sent = [];
    const transport = {
      replyCard: async () => "card_1",
      updateCard: async () => {},
      replyLocalFile: async (_messageId, filePath) => {
        sent.push(filePath);
        return { kind: "image", fileName: basename(filePath) };
      },
    };

    const card = new TaskStatusCard("p2p:ou_test", "om_1", transport, workspace);
    card.updateFromEvent(imageEvent("generate_image", [imagePath]));
    await card.start();
    await card.finish("done");
    assert.deepEqual(sent, [imagePath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskStatusCard sends TTS output when the file is created after the start event", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const audioPath = join(workspace, "voice.wav");
    const sent = [];
    const transport = {
      replyCard: async () => "card_1",
      updateCard: async () => {},
      replyLocalFile: async (_messageId, filePath) => {
        sent.push(filePath);
        return { kind: "file", fileName: basename(filePath) };
      },
    };

    const card = new TaskStatusCard("p2p:ou_test", "om_3", transport, workspace);
    card.updateFromEvent({ type: "tool_execution_start", toolName: "tts", args: { output_path: "voice.wav" } });
    writeFileSync(audioPath, "wav");
    await card.start();
    await card.finish("done");
    assert.deepEqual(sent, [audioPath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskStatusCard does not send artifacts when the task fails", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const imagePath = join(root, "tmp", "broken.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    let sent = false;
    const transport = {
      replyCard: async () => "card_1",
      updateCard: async () => {},
      replyLocalFile: async () => {
        sent = true;
        return { kind: "image", fileName: "broken.png" };
      },
    };

    const card = new TaskStatusCard("p2p:ou_test", "om_2", transport, workspace);
    card.updateFromEvent(imageEvent("generate_image", [imagePath]));
    await card.start();
    await card.finish("failed", "模型调用失败");
    assert.equal(sent, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskStatusCard limits automatic artifact delivery to ten files", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "workspace");
    const sent = [];
    const transport = {
      replyCard: async () => "card_1",
      updateCard: async () => {},
      replyLocalFile: async (_messageId, filePath) => {
        sent.push(filePath);
        return { kind: "file", fileName: basename(filePath) };
      },
    };
    const card = new TaskStatusCard("p2p:ou_test", "om_limit", transport, workspace);
    for (let index = 0; index < 12; index += 1) {
      const filePath = join(workspace, `report-${index}.pdf`);
      writeFileSync(filePath, "pdf");
      card.updateFromEvent({ type: "tool_execution_end", toolName: "write", isError: false, result: { details: { resolvedPath: filePath } } });
    }
    await card.start();
    await card.finish("done");
    assert.equal(sent.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
