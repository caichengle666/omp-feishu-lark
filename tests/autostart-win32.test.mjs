import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonSpec } from "../src/daemon-spec.ts";
import { buildWinTaskXml, ensure, inspect } from "../src/autostart/win32-task.ts";

const spec = buildDaemonSpec({
  bunBin: "C:\\Program Files\\Bun\\bun.exe",
  ompCliPath: "C:\\Users\\Feishu\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js",
  extensionPath: "C:\\Users\\Feishu\\.omp\\extensions\\feishu\\extension\\index.ts",
  workspace: "C:\\Users\\Feishu\\work dir",
  agentDir: "C:\\Users\\Feishu\\.omp\\agent",
  runtimeRoot: "C:\\Users\\Feishu\\.omp\\agent\\feishu",
  pluginVersion: "0.4.40",
});

function makeDeps(overrides = {}) {
  const calls = [];
  const writes = [];
  const renames = [];
  const removed = [];
  const deps = {
    platform: "win32",
    env: { USERDOMAIN: "DESKTOP", USERNAME: "Feishu" },
    homeDir: "C:\\Users\\Feishu",
    uid: "feishu",
    isRoot: () => true,
    exists: () => true,
    readFile: () => JSON.stringify(spec.env),
    writeFile: (path, content) => writes.push([path, content]),
    rename: (from, to) => renames.push([from, to]),
    removeFile: (path) => removed.push(path),
    mkdir: () => {},
    run: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "/Query") {
        return overrides.queryResult || { status: 0, stdout: overrides.xml || "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    ...overrides.deps,
  };
  return { deps, calls, writes, renames, removed };
}

test("Windows task XML registers the supervisor at logon", () => {
  const xml = buildWinTaskXml(spec);
  assert.match(xml, /encoding="UTF-16"/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<Enabled>true<\/Enabled>/);
  assert.match(xml, /--env-json/);
  assert.match(xml, new RegExp(spec.envPath.replace(/[\\"']/g, "\\$&")));
  assert.match(xml, /<WorkingDirectory>/);
  assert.match(xml, new RegExp(spec.bunBin.replace(/[\\"']/g, "\\$&")));
  assert.match(xml, new RegExp(spec.supervisorPath.replace(/[\\"']/g, "\\$&")));
  assert.match(xml, new RegExp(spec.extensionPath.replace(/[\\"']/g, "\\$&")));
});

test("Windows task inspect reports missing, healthy, disabled, and foreign states", async () => {
  const missing = makeDeps({ queryResult: { status: 1, stdout: "", stderr: "task not found" } });
  assert.equal((await inspect(spec, missing.deps)).state, "missing");

  const healthy = makeDeps({ xml: buildWinTaskXml(spec) });
  const status = await inspect(spec, healthy.deps);
  assert.equal(status.state, "healthy");
  assert.equal(status.enabled, true);

  const disabled = makeDeps({ xml: buildWinTaskXml(spec).replaceAll("<Enabled>true</Enabled>", "<Enabled>false</Enabled>") });
  assert.equal((await inspect(spec, disabled.deps)).state, "disabled");

  const missingEnv = makeDeps({
    xml: buildWinTaskXml(spec),
    deps: {
      exists: (path) => path !== spec.envPath,
    },
  });
  assert.equal((await inspect(spec, missingEnv.deps)).state, "misconfigured");

  const staleEnv = makeDeps({
    xml: buildWinTaskXml(spec),
    deps: {
      readFile: () => JSON.stringify({ ...spec.env, FEISHU_PLUGIN_VERSION: "0.4.39" }),
    },
  });
  assert.equal((await inspect(spec, staleEnv.deps)).state, "misconfigured");

  const foreign = makeDeps({ xml: `<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>C:\\Other\\app.exe</Command></Exec></Actions></Task>` });
  assert.equal((await inspect(spec, foreign.deps)).state, "foreign");
});

test("Windows task ensure creates and runs the task", async () => {
  const { deps, calls, writes, renames, removed } = makeDeps({
    queryResult: { status: 1, stdout: "", stderr: "task not found" },
  });
  const result = await ensure(spec, true, deps, { start: true });
  assert.equal(result.status.state, "healthy");
  assert.equal(writes.length, 2);
  assert.equal(renames.length, 1);
  assert.equal(removed.length, 1);
  assert.ok(writes.some(([path]) => path.includes("supervisor.env.json")));
  assert.ok(calls.some((call) => call.includes("/Create")));
  assert.ok(calls.some((call) => call.includes("/Change") && call.includes("/ENABLE")));
  assert.ok(calls.some((call) => call.includes("/Run")));
});

test("Windows task ensure disables and re-enables without deleting task state", async () => {
  const xml = buildWinTaskXml(spec);
  const disable = makeDeps({ xml });
  const disabledResult = await ensure(spec, false, disable.deps, {});
  assert.equal(disabledResult.status.state, "disabled");
  assert.ok(disable.calls.some((call) => call.includes("/DISABLE")));
  assert.match(disabledResult.message, /不会自动停止/);

  const disabledXml = xml.replaceAll("<Enabled>true</Enabled>", "<Enabled>false</Enabled>");
  const enable = makeDeps({ xml: disabledXml });
  const enabledResult = await ensure(spec, true, enable.deps, { start: true });
  assert.equal(enabledResult.status.state, "healthy");
  assert.ok(enable.calls.some((call) => call.includes("/ENABLE")));
  assert.ok(enable.calls.some((call) => call.includes("/Run")));
});

test("Windows task ensure refuses a foreign task", async () => {
  const { deps } = makeDeps({
    xml: `<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>C:\\Other\\app.exe</Command></Exec></Actions></Task>`,
  });
  const result = await ensure(spec, true, deps, {});
  assert.equal(result.status.state, "foreign");
  assert.match(result.message, /拒绝覆盖/);
});
