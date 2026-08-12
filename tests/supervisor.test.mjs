import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { parseSupervisorArgs, restartDelay } from "../support/feishu-supervisor.mjs";

test("supervisor parses one cross-platform executable and argument array", () => {
  assert.deepEqual(parseSupervisorArgs([
    "--cwd", "C:\\work dir",
    "--log", "C:\\state\\daemon.log",
    "--pid", "C:\\state\\supervisor.pid",
    "--stop", "C:\\state\\supervisor.stop",
    "--",
    "C:\\Program Files\\Bun\\bun.exe",
    "cli.js",
    "--mode",
    "rpc",
  ]), {
    options: { cwd: "C:\\work dir", log: "C:\\state\\daemon.log", pid: "C:\\state\\supervisor.pid", stop: "C:\\state\\supervisor.stop" },
    command: "C:\\Program Files\\Bun\\bun.exe",
    args: ["cli.js", "--mode", "rpc"],
  });
});

test("supervisor restart delay is exponential and capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(restartDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("supervisor keeps daemon stdin open and removes pid file on SIGTERM", async () => {
  const root = join(tmpdir(), `omp-feishu-supervisor-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const childScript = join(root, "child.mjs");
  const childReady = join(root, "child-ready.txt");
  const logPath = join(root, "daemon.log");
  const pidPath = join(root, "supervisor.pid");
  const stopPath = join(root, "supervisor.stop");
  writeFileSync(childScript, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(childReady)}, 'ready');`,
    "process.stdin.resume();",
  ].join("\n"));

  const supervisor = spawn(process.execPath, [
    resolve("support/feishu-supervisor.mjs"),
    "--cwd", root,
    "--log", logPath,
    "--pid", pidPath,
    "--stop", stopPath,
    "--",
    process.execPath,
    childScript,
  ], { stdio: "ignore" });

  await waitFor(() => existsSync(childReady) && existsSync(pidPath), 5000);
  assert.equal(Number(readFileSync(pidPath, "utf8").trim()), supervisor.pid);
  await new Promise((resolveExit) => {
    supervisor.once("exit", resolveExit);
    writeFileSync(stopPath, "stop");
  });
  await waitFor(() => !existsSync(pidPath), 2000);
  assert.match(readFileSync(logPath, "utf8"), /starting daemon/);
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}
