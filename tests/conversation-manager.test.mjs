import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = join(tmpdir(), `omp-feishu-conversation-tests-${process.pid}`);
mkdirSync(testRoot, { recursive: true });
process.env.OMP_AGENT_DIR = testRoot;
const { ConversationManager } = await import("../extension/conversation-manager.ts");

function managerWithRun(run) {
  const manager = new ConversationManager(process.cwd());
  manager.activeRuns = new Map([["chat", run]]);
  return manager;
}

test.after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("stopConversation reports when no run is active", async () => {
  const manager = new ConversationManager(process.cwd());
  const replies = [];
  const result = await manager.stopConversation("chat", async (text) => replies.push(text));
  assert.deepEqual(result, { status: "not_running", message: "当前没有进行中的处理。" });
  assert.deepEqual(replies, ["当前没有进行中的处理。"]);
});

test("stopConversation rejects a stale task card", async () => {
  const manager = managerWithRun({ runId: "current", stopped: false, session: {} });
  const replies = [];
  const result = await manager.stopConversation("chat", async (text) => replies.push(text), "old");
  assert.equal(result.status, "stale");
  assert.equal(manager.activeRuns.get("chat").stopped, false);
  assert.match(replies[0], /不是当前进行中的任务/);
});

test("stopConversation aborts the active session and stops its status card", async () => {
  let aborted = 0;
  let stopped = 0;
  const manager = managerWithRun({
    runId: "current",
    stopped: false,
    session: { abort: async () => { aborted += 1; } },
    status: { stopImmediately: async () => { stopped += 1; } },
  });
  const replies = [];
  const result = await manager.stopConversation("chat", async (text) => replies.push(text), "current");
  assert.deepEqual(result, { status: "stopped", message: "已停止当前处理。" });
  assert.equal(aborted, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(replies, ["已停止当前处理。"]);
});

test("stopConversation reports abort failures and restores the run state", async () => {
  const manager = managerWithRun({
    stopped: false,
    session: { abort: async () => { throw new Error("abort failed"); } },
  });
  const replies = [];
  const result = await manager.stopConversation("chat", async (text) => replies.push(text));
  assert.deepEqual(result, { status: "failed", message: "停止失败，请重试。" });
  assert.equal(manager.activeRuns.get("chat").stopped, false);
  assert.deepEqual(replies, ["停止失败，请重试。"]);
});

test("new session model resolution does not await its own cached creation promise", async () => {
  const manager = new ConversationManager(process.cwd());
  const defaultModel = { provider: "oc2", id: "deepseek-v4-flash-free" };
  manager.defaultProvider = defaultModel.provider;
  manager.defaultModelId = defaultModel.id;
  manager.modelRegistryPromise = Promise.resolve({
    find: (provider, id) => provider === defaultModel.provider && id === defaultModel.id ? defaultModel : undefined,
    hasConfiguredAuth: (model) => model === defaultModel,
    getAvailable: () => [defaultModel],
  });
  manager.sessions.set("chat", new Promise(() => {}));

  const result = await Promise.race([
    manager.resolveSelectedModel("chat", false),
    new Promise((_, reject) => setTimeout(() => reject(new Error("model resolution deadlocked")), 250)),
  ]);

  assert.equal(result, defaultModel);
});
