import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupLegacyInstallations,
  findLegacyPluginDirectories,
  ompRegistryNeedsUpgrade,
  systemdServiceReferencesFeishuPlugin,
} from "../src/legacy-cleanup.ts";

test("recognizes only legacy systemd services that launch this plugin", () => {
  assert.equal(systemdServiceReferencesFeishuPlugin("ExecStart=omp -e /root/omp/feishu-plugin/extension/index.ts\n# omp-feishu"), true);
  assert.equal(systemdServiceReferencesFeishuPlugin("ExecStart=/srv/unrelated/index.ts\n# omp-feishu"), false);
});

test("finds verified legacy directories but preserves the active target", () => {
  const home = tempHome();
  const legacy = join(home, "omp", "feishu-plugin");
  const unrelated = join(home, ".pi", "extensions", "feishu");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(legacy, "package.json"), JSON.stringify({ name: "@caichengle/omp-feishu-lark" }));
  writeFileSync(join(unrelated, "package.json"), JSON.stringify({ name: "unrelated" }));
  assert.deepEqual(findLegacyPluginDirectories(home, join(home, ".omp", "extensions", "feishu")), [legacy]);
  rmSync(home, { recursive: true, force: true });
});

test("cleans verified legacy installs and upgrades an old OMP registration", () => {
  const home = tempHome();
  const legacy = join(home, "omp", "feishu-plugin");
  const registry = join(home, ".omp", "plugins");
  const installed = join(registry, "node_modules", "@caichengle", "omp-feishu-lark");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(legacy, "package.json"), JSON.stringify({ name: "omp-feishu-runtime" }));
  writeFileSync(join(registry, "package.json"), JSON.stringify({ dependencies: { "@caichengle/omp-feishu-lark": "^0.3.1" } }));
  writeFileSync(join(registry, "omp-plugins.lock.json"), JSON.stringify({ plugins: { "@caichengle/omp-feishu-lark": { version: "0.3.1", enabled: true } } }));
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@caichengle/omp-feishu-lark", version: "0.3.1" }));

  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "systemctl" && args[0] === "cat") {
      return { status: 0, stdout: "# omp-feishu\nExecStart=omp -e /root/omp/feishu-plugin/extension/index.ts" };
    }
    return { status: 0, stdout: "" };
  };
  const messages = cleanupLegacyInstallations({
    homeDir: home,
    pluginDir: join(home, ".omp", "extensions", "feishu"),
    bunBin: "bun",
    version: "0.4.1",
    platform: "linux",
    run,
  });

  assert.equal(findLegacyPluginDirectories(home, join(home, ".omp", "extensions", "feishu")).length, 0);
  assert.equal(ompRegistryNeedsUpgrade(home, "0.4.1"), true);
  assert.deepEqual(calls.map(([command, args]) => [command, args.slice(0, 2)]), [
    ["systemctl", ["cat", "omp-feishu.service"]],
    ["systemctl", ["stop", "omp-feishu.service"]],
    ["systemctl", ["disable", "omp-feishu.service"]],
    ["bun", ["add", "@caichengle/omp-feishu-lark@0.4.1"]],
  ]);
  assert.equal(messages.length, 3);
  assert.equal(JSON.parse(readFileSync(join(registry, "omp-plugins.lock.json"), "utf8")).plugins["@caichengle/omp-feishu-lark"].version, "0.4.1");
  rmSync(home, { recursive: true, force: true });
});

test("stops and removes Windows watcher launch artifacts", () => {
  const home = tempHome();
  const runtime = join(home, ".omp", "agent", "feishu");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "watcher.pid"), "4312\n");
  writeFileSync(join(runtime, "start-daemon.cmd"), "@echo off\r\n");
  mkdirSync(join(home, ".omp"), { recursive: true });
  writeFileSync(join(home, ".omp", "feishu-watcher.mjs"), "// legacy\n");
  const calls = [];
  cleanupLegacyInstallations({
    homeDir: home,
    pluginDir: join(home, ".omp", "extensions", "feishu"),
    bunBin: "bun.exe",
    version: "0.4.1",
    platform: "win32",
    run: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: "" };
    },
  });
  assert.deepEqual(calls, [["taskkill", ["/PID", "4312", "/T", "/F"]]]);
  assert.equal(existsSync(join(runtime, "watcher.pid")), false);
  assert.equal(existsSync(join(runtime, "start-daemon.cmd")), false);
  assert.equal(existsSync(join(home, ".omp", "feishu-watcher.mjs")), false);
  rmSync(home, { recursive: true, force: true });
});

test("stops a macOS legacy watcher with SIGTERM", () => {
  const home = tempHome();
  const runtime = join(home, ".omp", "agent", "feishu");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "watcher.pid"), "9087\n");
  const calls = [];
  cleanupLegacyInstallations({
    homeDir: home,
    pluginDir: join(home, ".omp", "extensions", "feishu"),
    bunBin: "bun",
    version: "0.4.1",
    platform: "darwin",
    run: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: "" };
    },
  });
  assert.deepEqual(calls, [["kill", ["-TERM", "9087"]]]);
  rmSync(home, { recursive: true, force: true });
});

function tempHome() {
  const path = join(tmpdir(), `omp-feishu-legacy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

