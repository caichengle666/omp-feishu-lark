import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stale processing dedupe records are reclaimed and fresh ones stay ignored", () => {
  const root = join(tmpdir(), `omp-feishu-dedupe-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const script = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const root = process.env.OMP_FEISHU_ROOT;',
    'mkdirSync(root, { recursive: true });',
    '(async () => {',
    '  const stale = Date.now() - 20 * 60 * 1000;',
    '  writeFileSync(join(root, "dedupe.json"), JSON.stringify({ messages: {',
    '    stale: { status: "processing", firstSeenAt: stale, updatedAt: stale, pid: 2147483647, processStart: "dead-start" },',
    '    fresh: { status: "processing", firstSeenAt: Date.now(), updatedAt: Date.now(), pid: process.pid, processStart: "same-start" }',
    '  } }));',
    '  const { claimFeishuMessage, markFeishuMessage } = await import("./extension/dedupe-store.ts");',
    '  if (!(await claimFeishuMessage("stale"))) process.exit(2);',
    '  await markFeishuMessage("stale", "replied");',
    '  if (await claimFeishuMessage("stale")) process.exit(3);',
    '  if (await claimFeishuMessage("fresh")) process.exit(4);',
    '})().catch((error) => { console.error(error); process.exit(9); });',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, OMP_FEISHU_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
