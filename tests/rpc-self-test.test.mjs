import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyRpcWorkerReady } from "../src/rpc-self-test.ts";

test("installer RPC self-test accepts a ready worker", async () => {
  const root = tempRoot();
  const cli = join(root, "ready.mjs");
  writeFileSync(cli, 'process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1 }) + "\\n");\nprocess.stdin.resume();\n');
  await verifyRpcWorkerReady({ bunBin: process.execPath, ompCliPath: cli, workspace: root, timeoutMs: 2_000 });
  rmSync(root, { recursive: true, force: true });
});

test("installer RPC self-test reports a worker that exits before ready", async () => {
  const root = tempRoot();
  const cli = join(root, "broken.mjs");
  writeFileSync(cli, 'process.stderr.write("broken worker\\n");\nprocess.exit(7);\n');
  await assert.rejects(
    verifyRpcWorkerReady({ bunBin: process.execPath, ompCliPath: cli, workspace: root, timeoutMs: 2_000 }),
    /exited before ready.*broken worker/,
  );
  rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = join(tmpdir(), `omp-feishu-rpc-self-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

