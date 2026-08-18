import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonSpec } from "../src/daemon-spec.ts";
import { recoverOrphanDaemon } from "../src/orphan-recovery.ts";

const spec = buildDaemonSpec({
  bunBin: "/usr/local/bin/bun",
  ompCliPath: "/home/user/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
  extensionPath: "/home/user/.omp/extensions/feishu/extension/index.ts",
  workspace: "/home/user/work",
  agentDir: "/home/user/.omp/agent",
  runtimeRoot: "/home/user/.omp/agent/feishu",
  pluginVersion: "0.4.40",
});

function fakeChild() {
  return { unref() { this.unrefCalled = true; } };
}

test("orphan recovery does not create a second supervisor when one is alive", async () => {
  let spawnCount = 0;
  let lockCount = 0;
  const recovered = await recoverOrphanDaemon(spec, async (fn) => {
    lockCount += 1;
    return fn();
  }, {
    readRecord: () => ({ pid: 123, token: "live" }),
    isAlive: () => true,
    spawn: () => {
      spawnCount += 1;
      return fakeChild();
    },
    sleep: async () => {},
  });
  assert.equal(recovered, false);
  assert.equal(spawnCount, 0);
  assert.equal(lockCount, 1);
});

test("orphan recovery starts one replacement supervisor after the grace window", async () => {
  let reads = 0;
  let launch;
  const recovered = await recoverOrphanDaemon(spec, async (fn) => fn(), {
    readRecord: () => {
      reads += 1;
      return undefined;
    },
    isAlive: () => false,
    spawn: (command, args, options) => {
      launch = { command, args, options, child: fakeChild() };
      return launch.child;
    },
    sleep: async () => {},
  });
  assert.equal(recovered, true);
  assert.equal(reads, 7);
  assert.equal(launch.command, spec.supervisorCommand[0]);
  assert.deepEqual(launch.args, spec.supervisorCommand.slice(1));
  assert.equal(launch.options.cwd, spec.cwd);
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.env.OMP_CLI_PATH, spec.env.OMP_CLI_PATH);
  assert.equal(launch.child.unrefCalled, true);
});
