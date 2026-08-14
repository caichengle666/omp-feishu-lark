import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskStatusCard, describePiEvent } from "../extension/task-status-card.ts";

test("task status card shows truthful runtime and tool usage", () => {
  const card = buildTaskStatusCard({
    key: "group:test",
    runId: "run-1",
    status: "running",
    phase: "正在执行工具：read",
    elapsedMs: 83_000,
    toolCalls: 4,
    currentTool: "read",
  });
  const text = JSON.stringify(card);
  assert.match(text, /当前阶段：正在执行工具：read/);
  assert.match(text, /已运行：1分23秒/);
  assert.match(text, /工具调用：4 次/);
  assert.match(text, /当前工具：read/);
});

test("OMP events are translated into readable Chinese phases", () => {
  assert.equal(describePiEvent({ type: "agent_start" }), "正在启动 OMP Agent");
  assert.equal(describePiEvent({ type: "turn_start", turnIndex: 1 }), "开始第 2 轮处理");
  assert.equal(describePiEvent({ type: "tool_execution_start", toolName: "bash" }), "正在执行工具：bash");
  assert.equal(describePiEvent({ type: "tool_execution_end", toolName: "bash", isError: true }), "工具 bash：执行失败");
  assert.equal(describePiEvent({ type: "compaction_start" }), "正在压缩会话上下文");
});
