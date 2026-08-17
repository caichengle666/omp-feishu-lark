import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("bridge state discards expired and malformed entries before persisting", () => {
  const root = join(tmpdir(), `omp-feishu-bridge-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const script = [
    'import { writeFileSync, readFileSync } from "node:fs";',
    'import { BRIDGE_PATH } from "./extension/config.ts";',
    'import { FeishuBridgeStore } from "./extension/bridge-store.ts";',
    'const now = Date.now();',
    'writeFileSync(BRIDGE_PATH, JSON.stringify({ version: 1, routes: { old: { updatedAt: now - 91 * 86400000 }, kept: { updatedAt: now } }, jobs: { old: { updatedAt: now - 31 * 86400000 }, kept: { updatedAt: now } }, sent: { old: now - 8 * 86400000, kept: now, malformed: "bad" } }));',
    'const store = new FeishuBridgeStore();',
    'store.markSent("fresh");',
    'const state = JSON.parse(readFileSync(BRIDGE_PATH, "utf8"));',
    'if (state.routes.old || state.jobs.old || state.sent.old || state.sent.malformed) process.exit(2);',
    'if (!state.routes.kept || !state.jobs.kept || !state.sent.kept || !state.sent.fresh) process.exit(3);',
  ].join(" ");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, OMP_FEISHU_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(join(root, "bridge.json"), "utf8"));
    assert.deepEqual(Object.keys(state.routes), ["kept"]);
    assert.deepEqual(Object.keys(state.jobs), ["kept"]);
    assert.deepEqual(Object.keys(state.sent).sort(), ["fresh", "kept"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
