import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("gateway locks.json is written atomically and recovers from corruption", () => {
  const root = join(tmpdir(), `omp-feishu-gateway-lock-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const script = [
    'import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const root = process.env.PI_CODING_AGENT_DIR;',
    'mkdirSync(root, { recursive: true });',
    '(async () => {',
    '  const { acquireGatewayLock } = await import("./extension/gateway-lock.ts");',
    '  const first = await acquireGatewayLock(root);',
    '  if (first.status !== "acquired") process.exit(2);',
    '  await first.handle.release();',
    '  const locksPath = join(root, "locks.json");',
    '  if (!existsSync(locksPath)) process.exit(3);',
    '  JSON.parse(readFileSync(locksPath, "utf8"));',
    '  if (readdirSync(root).some((name) => name.includes(".tmp-"))) process.exit(4);',
    '  writeFileSync(locksPath, "{invalid");',
    '  const second = await acquireGatewayLock(root);',
    '  if (second.status !== "acquired") process.exit(5);',
    '  await second.handle.release();',
    '  JSON.parse(readFileSync(locksPath, "utf8"));',
    '  if (!readdirSync(root).some((name) => name.startsWith("locks.json.corrupt-"))) process.exit(6);',
    '})().catch((error) => { console.error(error); process.exit(9); });',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PI_CODING_AGENT_DIR: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
