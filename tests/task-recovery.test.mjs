import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = join(process.cwd(), `.tmp-task-recovery-${process.pid}`);
process.env.OMP_FEISHU_ROOT = root;

const { ACTIVE_TASKS_PATH } = await import("../extension/config.ts");
const { TaskStatusCard, recoverInterruptedTaskCards } = await import("../extension/task-status-card.ts");

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("task cards persist while running and clear after a normal finish", async () => {
  const updates = [];
  const card = new TaskStatusCard("p2p:test", "source", {
    replyCard: async () => "card-1",
    updateCard: async (_id, value) => updates.push(value),
    replyLocalFile: async () => undefined,
  });
  await card.start();
  const active = JSON.parse(readFileSync(ACTIVE_TASKS_PATH, "utf8"));
  assert.equal(active.length, 1);
  assert.equal(active[0].cardMessageId, "card-1");
  await card.finish("done");
  assert.deepEqual(JSON.parse(readFileSync(ACTIVE_TASKS_PATH, "utf8")), []);
  assert.equal(updates.at(-1).header.title.content, "任务完成");
});

test("recovery marks an orphaned card interrupted", async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(ACTIVE_TASKS_PATH, JSON.stringify([{
    key: "p2p:test",
    runId: "orphan-run",
    replyToMessageId: "source",
    cardMessageId: "card-orphan",
    startedAt: Date.now() - 60_000,
  }]));
  const updates = [];
  const recovered = await recoverInterruptedTaskCards({ updateCard: async (id, value) => updates.push([id, value]) });
  assert.equal(recovered, 1);
  assert.equal(updates[0][0], "card-orphan");
  assert.match(JSON.stringify(updates[0][1]), /任务已中断/);
  assert.deepEqual(JSON.parse(readFileSync(ACTIVE_TASKS_PATH, "utf8")), []);
});
