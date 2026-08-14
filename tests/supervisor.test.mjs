import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { EventEmitter } from "node:events";
import { appendRotatingLog, parseSupervisorArgs, readSupervisorRecord, restartDelay, shouldStopRequested, stopChild, writeStopRequest, writeSupervisorRecord } from "../support/feishu-supervisor.mjs";

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

test("supervisor rotates daemon logs at the configured size", () => {
  const root = join(tmpdir(), `omp-feishu-log-${process.pid}-${Date.now()}`);
  const logPath = join(root, "daemon.log");
  mkdirSync(root, { recursive: true });
  appendRotatingLog(logPath, "12345678", 10);
  appendRotatingLog(logPath, "abcd", 10);
  assert.equal(readFileSync(`${logPath}.1`, "utf8"), "12345678");
  assert.equal(readFileSync(logPath, "utf8"), "abcd");
  rmSync(root, { recursive: true, force: true });
});

test("supervisor stops cleanly while the daemon exits during stop", async () => {
  const root = join(tmpdir(), `omp-feishu-supervisor-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const childScript = join(root, "child.mjs");
  const childReady = join(root, "child-ready.txt");
  const logPath = join(root, "daemon.log");
  const pidPath = join(root, "supervisor.pid");
  const stopPath = join(root, "supervisor.stop");
  writeFileSync(childScript, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(childReady)}, 'ready');`,
    "process.stdin.resume();",
    `const timer = setInterval(() => { if (existsSync(${JSON.stringify(stopPath)})) process.exit(0); }, 10);`,
    "timer.unref?.();",
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
  const pidRecord = readSupervisorRecord(pidPath);
  assert.equal(pidRecord?.pid, supervisor.pid);
  assert.equal(typeof pidRecord?.token, "string");
  const exitCode = await new Promise((resolveExit) => {
    supervisor.once("exit", resolveExit);
    writeFileSync(stopPath, "stop");
  });
  assert.equal(exitCode, 0);
  await waitFor(() => !existsSync(pidPath), 2000);
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /starting daemon/);
  assert.match(log, /supervisor stopped/);
  rmSync(root, { recursive: true, force: true });
});

test("supervisor stop keeps a local daemon reference across async stop waits", () => {
  const source = readFileSync(resolve("support/feishu-supervisor.mjs"), "utf8");
  const start = source.indexOf("const stop = async");
  const end = source.indexOf("process.on(\"SIGINT\"", start);
  assert.ok(start >= 0 && end > start);
  const stopSource = source.slice(start, end);
  assert.match(stopSource, /await stopChild\(child, log, signal\)/);
  assert.doesNotMatch(stopSource, /child\.exitCode/);
  assert.doesNotMatch(stopSource, /child\.kill/);
  assert.doesNotMatch(stopSource, /child\.pid/);
});

test("stopChild still waits on the captured daemon after the caller clears its reference", async () => {
  let child = new EventEmitter();
  child.exitCode = null;
  child.pid = 42_001;
  child.stdin = { end() { this.ended = true; } };
  const daemon = child;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setTimeout(() => {
      daemon.exitCode = 0;
      daemon.emit("exit", 0, null);
    }, 1);
  };
  const stopPromise = stopChild(child, () => {});
  child = undefined;
  await stopPromise;
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(daemon.stdin.ended, true);
});

test("supervisor stop requests are scoped by token and pid file stores metadata", () => {
  const root = join(tmpdir(), `omp-feishu-supervisor-record-${process.pid}-${Date.now()}`);
  const pidPath = join(root, "supervisor.pid");
  const stopPath = join(root, "supervisor.stop");
  mkdirSync(root, { recursive: true });
  const record = { pid: 1_234, token: "current-token", processStart: "start-1", startedAt: new Date().toISOString(), command: ["bun", "feishu-supervisor.mjs"] };
  writeSupervisorRecord(pidPath, record);
  assert.deepEqual(readSupervisorRecord(pidPath), record);
  writeStopRequest(stopPath, record);
  assert.equal(shouldStopRequested(stopPath, record), true);
  writeStopRequest(stopPath, { pid: record.pid, token: "stale-token" });
  assert.equal(shouldStopRequested(stopPath, record), false);
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
