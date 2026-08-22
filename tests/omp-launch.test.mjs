import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { buildDaemonSpec, buildOmpLaunchArgs } from "../src/daemon-spec.ts";
import { normalizeOmpLaunch } from "../extension/config.ts";

const baseInput = {
  bunBin: "/usr/local/bin/bun",
  ompCliPath: "/home/user/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
  extensionPath: "/home/user/.omp/extensions/feishu/extension/index.ts",
  workspace: "/home/user/work",
  agentDir: "/home/user/.omp/agent",
  runtimeRoot: "/home/user/.omp/agent/feishu",
  pluginVersion: "0.4.51",
};

test("daemon launch keeps the default --no-skills order", () => {
  const spec = buildDaemonSpec(baseInput);
  assert.deepEqual(spec.daemonArgs, [
    baseInput.ompCliPath,
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--allow-home",
    "--cwd", baseInput.workspace,
    "-e", baseInput.extensionPath,
  ]);
});

test("daemon launch applies ompLaunch options after the extension path", () => {
  const spec = buildDaemonSpec({
    ...baseInput,
    ompLaunch: {
      enableSkills: true,
      skills: ["git-*", "docker"],
      tools: ["read", "bash", "edit", "write"],
      approvalMode: "write",
      maxTime: "30m",
      appendSystemPrompt: "keep tests green",
      addDirs: ["/srv/project"],
    },
  });
  const suffix = spec.daemonArgs.slice(spec.daemonArgs.indexOf(baseInput.extensionPath) + 1);
  assert.deepEqual(suffix, [
    "--skills", "git-*,docker",
    "--tools", "read,bash,edit,write",
    "--approval-mode", "write",
    "--max-time", "30m",
    "--append-system-prompt", "keep tests green",
    "--add-dir", "/srv/project",
  ]);
  assert.equal(spec.daemonArgs.includes("--no-skills"), false);
});

test("normalizeOmpLaunch accepts valid fields and drops invalid ones", () => {
  const launch = normalizeOmpLaunch({
    enableSkills: true,
    skills: ["git-*", " docker "],
    tools: [],
    approvalMode: "bogus",
    maxTime: "abc",
    addDirs: ["/tmp/a"],
  });
  assert.deepEqual(launch, {
    enableSkills: true,
    skills: ["git-*", "docker"],
    tools: undefined,
    approvalMode: undefined,
    maxTime: undefined,
    appendSystemPrompt: undefined,
    addDirs: ["/tmp/a"],
  });
});

test("normalizeOmpLaunch treats an empty object as unset", () => {
  assert.equal(normalizeOmpLaunch({}), undefined);
});

test("a configured skill list enables skills unless explicitly disabled", () => {
  assert.equal(normalizeOmpLaunch({ skills: ["git-*"] })?.enableSkills, true);
  assert.deepEqual(buildOmpLaunchArgs({ enableSkills: false, skills: ["git-*"] }), ["--no-skills"]);
});

test("RPC and daemon launch share the same OMP policy arguments", () => {
  const launch = {
    enableSkills: true,
    skills: ["git-*"],
    tools: ["read", "bash"],
    approvalMode: "write",
    maxTime: "30m",
    appendSystemPrompt: "keep tests green",
    addDirs: ["/srv/project"],
  };
  assert.deepEqual(buildOmpLaunchArgs(launch), [
    "--skills", "git-*",
    "--tools", "read,bash",
    "--approval-mode", "write",
    "--max-time", "30m",
    "--append-system-prompt", "keep tests green",
    "--add-dir", "/srv/project",
  ]);
});
