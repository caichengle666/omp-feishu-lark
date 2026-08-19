import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonSpec } from "../src/daemon-spec.ts";
import { buildSystemdUnit, ensure, inspect, parseEnvironmentMap, parseExecStartArgs, systemdUnitMatches } from "../src/autostart/linux-systemd.ts";

const spec = buildDaemonSpec({
  bunBin: "/usr/local/bin/bun",
  ompCliPath: "/home/user/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
  extensionPath: "/home/user/.omp/extensions/feishu/extension/index.ts",
  workspace: "/home/user/work",
  agentDir: "/home/user/.omp/agent",
  runtimeRoot: "/home/user/.omp/agent/feishu",
  pluginVersion: "0.4.40",
});
const systemdOnly = { skip: process.platform !== "linux" };

test("parses systemd ExecStart arguments without requiring exact quoting", () => {
  const args = parseExecStartArgs("\"/usr/local/bin/bun\" \"/home/user/.omp/extensions/feishu/support/feishu-supervisor.mjs\" --cwd \"/home/user/work dir\"");
  assert.deepEqual(args, [
    "/usr/local/bin/bun",
    "/home/user/.omp/extensions/feishu/support/feishu-supervisor.mjs",
    "--cwd",
    "/home/user/work dir",
  ]);
});

test("parses environment values and keeps version drift visible as data", () => {
  const env = parseEnvironmentMap([
    "Environment=OMP_CLI_PATH=\"/opt/omp/cli.js\"",
    "Environment=PATH=\"/opt/bin:/usr/bin\"",
    "Environment=FEISHU_PLUGIN_VERSION=\"0.4.45\"",
  ].join("\n"));
  assert.equal(env.OMP_CLI_PATH, "/opt/omp/cli.js");
  assert.equal(env.PATH, "/opt/bin:/usr/bin");
  assert.equal(env.FEISHU_PLUGIN_VERSION, "0.4.45");
});

test("systemd semantic comparison ignores version drift but catches real mismatches", () => {
  const expected = [
    "[Service]",
    "ExecStart=\"/opt/bin/bun\" \"/opt/omp/feishu-supervisor.mjs\" --cwd \"/root\"",
    "WorkingDirectory=/root",
    "Environment=OMP_CLI_PATH=\"/opt/omp/cli.js\"",
    "Environment=PI_FEISHU_DAEMON=\"1\"",
    "Environment=PATH=\"/opt/bin:/usr/bin\"",
    "Environment=FEISHU_PLUGIN_VERSION=\"0.4.44\"",
  ].join("\n");
  const versionDrift = expected.replace("0.4.44", "0.4.45");
  assert.equal(systemdUnitMatches(versionDrift, expected, "/opt/bin/bun"), true);
  assert.equal(systemdUnitMatches(expected + "\nEnvironment=UNRELATED=1", expected, "/opt/bin/bun"), true);
  assert.equal(systemdUnitMatches(expected.replace("/opt/omp/cli.js", "/opt/wrong/cli.js"), expected, "/opt/bin/bun"), false);
  assert.equal(systemdUnitMatches(expected.replace("/opt/bin:/usr/bin", "/usr/bin"), expected, "/opt/bin/bun"), false);
});
function makeDeps(overrides = {}) {
  const calls = [];
  const writes = [];
  const renames = [];
  const existsPaths = new Set(overrides.existsPaths || []);
  const unit = overrides.unit;
  const deps = {
    platform: "linux",
    env: {},
    homeDir: "/root",
    uid: 0,
    isRoot: () => overrides.isRoot ?? true,
    exists: (path) => existsPaths.has(path),
    readFile: () => unit || "",
    writeFile: (path, content) => writes.push([path, content]),
    rename: (from, to) => renames.push([from, to]),
    removeFile: (path) => {},
    mkdir: () => {},
    run: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "cat") return overrides.catResult || { status: 0, stdout: unit || "", stderr: "" };
      if (args[0] === "is-enabled") return { status: 0, stdout: "enabled", stderr: "" };
      if (args[0] === "is-active") return { status: 0, stdout: overrides.active || "inactive", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    ...overrides.deps,
  };
  return { deps, calls, writes, renames };
}

test("systemd unit starts bun supervisor then the OMP daemon", systemdOnly, () => {
  const unit = buildSystemdUnit(spec);
  assert.match(unit, /ExecStart=/);
  assert.match(unit, new RegExp(spec.supervisorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /OMP_CLI_PATH/);
  assert.match(unit, /Environment=PATH=/);
});

test("systemd unit writes an escaped absolute WorkingDirectory without surrounding quotes", systemdOnly, () => {
  const unit = buildSystemdUnit(buildDaemonSpec({
    ...spec,
    bunBin: "/usr/local/bin/bun",
    ompCliPath: "/home/user/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
    extensionPath: "/home/user/.omp/extensions/feishu/extension/index.ts",
    workspace: "/home/user/work dir",
    agentDir: "/home/user/.omp/agent",
    runtimeRoot: "/home/user/.omp/agent/feishu",
  }));
  assert.match(unit, /WorkingDirectory=\/home\/user\/work\\ dir/);
  assert.doesNotMatch(unit, /WorkingDirectory="\/home\/user\/work/);
});

test("systemd unit escapes percent specifiers in paths and environment values", systemdOnly, () => {
  const unit = buildSystemdUnit(buildDaemonSpec({
    bunBin: "/usr/local/bin/bun",
    ompCliPath: "/home/user/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
    extensionPath: "/home/user/.omp/extensions/feishu/extension/index.ts",
    workspace: "/home/user/work%u",
    agentDir: "/home/user/.omp/agent",
    runtimeRoot: "/home/user/.omp/agent/feishu",
  }));
  assert.doesNotMatch(unit, /work%u/);
  assert.match(unit, /work%%u/);
});

test("systemd inspect reports missing, healthy, disabled, and foreign states", systemdOnly, async () => {
  const missing = makeDeps({ catResult: { status: 1, stdout: "", stderr: "No such file" } });
  assert.equal((await inspect(spec, missing.deps)).state, "missing");

  const healthyUnit = buildSystemdUnit(spec);
  const healthy = makeDeps({ unit: healthyUnit, active: "active" });
  const status = await inspect(spec, healthy.deps);
  assert.equal(status.state, "healthy");
  assert.equal(status.enabled, true);

  const disabled = makeDeps({
    unit: healthyUnit.replace("WantedBy=multi-user.target", "WantedBy=multi-user.target"),
    deps: {
      run: (command, args) => {
        if (args[0] === "is-enabled") return { status: 0, stdout: "disabled", stderr: "" };
        if (args[0] === "is-active") return { status: 0, stdout: "inactive", stderr: "" };
        return { status: 0, stdout: healthyUnit, stderr: "" };
      },
    },
  });
  assert.equal((await inspect(spec, disabled.deps)).state, "disabled");

  const stale = makeDeps({
    unit: buildSystemdUnit(spec).replace('FEISHU_PLUGIN_VERSION="0.4.40"', 'FEISHU_PLUGIN_VERSION="0.4.39"'),
  });
  assert.equal((await inspect(spec, stale.deps)).state, "healthy");

  const extraEnv = makeDeps({
    unit: healthyUnit + "\nEnvironment=UNRELATED=1",
  });
  assert.equal((await inspect(spec, extraEnv.deps)).state, "healthy");

  const missingBunPath = makeDeps({
    unit: healthyUnit.replace(/Environment=PATH="[^"]*"/, 'Environment=PATH="/usr/bin"'),
  });
  assert.equal((await inspect(spec, missingBunPath.deps)).state, "misconfigured");

  const wrongOmp = makeDeps({
    unit: healthyUnit.replace(spec.ompCliPath, "/opt/wrong/omp/cli.js"),
  });
  assert.equal((await inspect(spec, wrongOmp.deps)).state, "misconfigured");

  const foreignUnit = `[Service]\nExecStart=/opt/other/feishu-supervisor.mjs --cwd /tmp\n`;
  const foreign = makeDeps({ unit: foreignUnit });
  assert.equal((await inspect(spec, foreign.deps)).state, "foreign");
});

test("systemd ensure writes the unit and starts the service when no supervisor is running", systemdOnly, async () => {
  const { deps, calls, writes, renames } = makeDeps({
    catResult: { status: 1, stdout: "", stderr: "not found" },
  });
  const result = await ensure(spec, true, deps, { start: true });
  assert.equal(result.status.state, "healthy");
  assert.equal(writes.length, 1);
  assert.equal(renames.length, 1);
  assert.ok(calls.some((call) => call.includes("daemon-reload")));
  assert.ok(calls.some((call) => call.includes("enable")));
  assert.ok(calls.some((call) => call.includes("start")));
});

test("systemd ensure disables without stopping a running connection", systemdOnly, async () => {
  const unit = buildSystemdUnit(spec);
  const { deps, calls } = makeDeps({ unit });
  const result = await ensure(spec, false, deps, {});
  assert.equal(result.status.state, "disabled");
  assert.ok(calls.some((call) => call.includes("disable")));
  assert.match(result.message, /不会自动停止/);
});

test("systemd ensure refuses foreign services and requires root for writes", systemdOnly, async () => {
  const foreign = makeDeps({ unit: `[Service]\nExecStart=/opt/other/feishu-supervisor.mjs\n` });
  const foreignResult = await ensure(spec, true, foreign.deps, {});
  assert.equal(foreignResult.status.state, "foreign");
  assert.match(foreignResult.message, /拒绝覆盖/);

  const notRoot = makeDeps({ catResult: { status: 1, stdout: "", stderr: "not found" }, isRoot: false });
  const permission = await ensure(spec, true, notRoot.deps, {});
  assert.equal(permission.status.state, "permission");
  assert.match(permission.message, /root 权限/);
});
