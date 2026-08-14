import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("debug logging batches writes and flushes complete JSON lines", () => {
  const root = join(tmpdir(), `omp-feishu-debug-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const script = [
    'import { debugLog, flushDebugLog } from "./extension/debug.ts";',
    'debugLog("test.one", { value: 1 });',
    'debugLog("test.two", { value: 2 });',
    'await flushDebugLog();',
  ].join(" ");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, OMP_FEISHU_ROOT: root },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(join(root, "debug.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((entry) => entry.event), ["test.one", "test.two"]);
  rmSync(root, { recursive: true, force: true });
});
