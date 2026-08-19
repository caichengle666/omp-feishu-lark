import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { buildDaemonSpec } from "../src/daemon-spec.ts";
import { buildLaunchdPlist, ensure, inspect } from "../src/autostart/darwin-launchd.ts";

const homeDir = "/Users/feishu";
const plistPath = join(homeDir, "Library", "LaunchAgents", "com.caichengle.omp-feishu.plist");
const spec = buildDaemonSpec({
  bunBin: "/opt/homebrew/bin/bun",
  ompCliPath: "/Users/feishu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
  extensionPath: "/Users/feishu/.omp/extensions/feishu/extension/index.ts",
  workspace: "/Users/feishu/work",
  agentDir: "/Users/feishu/.omp/agent",
  runtimeRoot: "/Users/feishu/.omp/agent/feishu",
  pluginVersion: "0.4.40",
});

function makeDeps(overrides = {}) {
  const calls = [];
  const writes = [];
  const renames = [];
  const removed = [];
  const deps = {
    platform: "darwin",
    env: {},
    homeDir,
    uid: 501,
    isRoot: () => false,
    exists: (path) => overrides.exists === undefined ? Boolean(overrides.plist) && path === plistPath : overrides.exists(path),
    readFile: () => overrides.plist || "",
    writeFile: (path, content) => writes.push([path, content]),
    rename: (from, to) => renames.push([from, to]),
    removeFile: (path) => {
      removed.push(path);
      assert.equal(path, plistPath);
    },
    mkdir: () => {},
    run: (command, args) => {
      calls.push([command, ...args]);
      return overrides.run ? overrides.run(command, args) : { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, calls, writes, renames, removed };
}

test("launchd plist starts the shared supervisor at login", () => {
  const plist = buildLaunchdPlist(spec);
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /<true\/>/);
  assert.match(plist, /KeepAlive/);
  assert.match(plist, new RegExp(spec.supervisorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(plist, /OMP_CLI_PATH/);
  assert.match(plist, /PI_FEISHU_DAEMON/);
  assert.match(plist, /<key>PATH<\/key><string>.*<\/string>/);
});

test("launchd inspect reports missing, healthy, misconfigured, and foreign states", async () => {
  const missing = makeDeps();
  assert.equal((await inspect(spec, missing.deps)).state, "missing");

  const healthy = makeDeps({ plist: buildLaunchdPlist(spec) });
  const status = await inspect(spec, healthy.deps);
  assert.equal(status.state, "healthy");
  assert.equal(status.enabled, true);

  const old = makeDeps({ plist: buildLaunchdPlist(spec).replace(spec.supervisorPath, "/Users/feishu/old/feishu-supervisor.mjs") });
  assert.equal((await inspect(spec, old.deps)).state, "misconfigured");

  const foreign = makeDeps({ plist: `<plist version="1.0"><dict><key>Label</key><string>com.example.other</string></dict></plist>` });
  assert.equal((await inspect(spec, foreign.deps)).state, "foreign");
});

test("launchd ensure writes and loads a missing plist", async () => {
  const { deps, calls, writes, renames } = makeDeps();
  const result = await ensure(spec, true, deps, { start: true });
  assert.equal(result.status.state, "healthy");
  assert.equal(writes.length, 1);
  assert.equal(renames.length, 1);
  assert.ok(calls.some((call) => call[0] === "launchctl" && (call.includes("bootstrap") || call.includes("load"))));
  assert.ok(calls.some((call) => call[0] === "launchctl" && (call.includes("kickstart") || call.includes("start"))));
});

test("launchd ensure reports bootstrap/load failures instead of claiming success", async () => {
  const { deps } = makeDeps({
    run: (_command, args) => {
      if (args[0] === "bootstrap" || args[0] === "load") return { status: 1, stdout: "", stderr: "load failed" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const result = await ensure(spec, true, deps, {});
  assert.equal(result.status.state, "unreadable");
  assert.match(result.message, /加载 launchd 配置失败/);
});

test("launchd ensure disables by unloading and removing the plist", async () => {
  const { deps, calls, removed } = makeDeps({ plist: buildLaunchdPlist(spec) });
  const result = await ensure(spec, false, deps, {});
  assert.equal(result.status.state, "disabled");
  assert.ok(calls.some((call) => call[0] === "launchctl" && call.includes("bootout")));
  assert.deepEqual(removed, [plistPath]);
  assert.match(result.message, /不会自动停止/);
});

test("launchd ensure refuses a foreign plist", async () => {
  const { deps } = makeDeps({ plist: `<plist version="1.0"><dict><key>Label</key><string>com.example.other</string></dict></plist>` });
  const result = await ensure(spec, true, deps, {});
  assert.equal(result.status.state, "foreign");
  assert.match(result.message, /拒绝覆盖/);
});
