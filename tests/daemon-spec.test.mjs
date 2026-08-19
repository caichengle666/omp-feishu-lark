import assert from "node:assert/strict";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { buildDaemonSpec } from "../src/daemon-spec.ts";

const home = join("/home/user");
const baseInput = {
  bunBin: join("/usr/local/bin", "bun"),
  ompCliPath: join(home, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
  extensionPath: join(home, ".omp", "extensions", "feishu", "extension", "index.ts"),
  workspace: join(home, "work"),
  agentDir: join(home, ".omp", "agent"),
  runtimeRoot: join(home, ".omp", "agent", "feishu"),
  pluginVersion: "0.4.40",
};

test("builds one supervisor to daemon launch spec for extension and installer", () => {
  const spec = buildDaemonSpec(baseInput);
  assert.equal(spec.pluginDir, join(home, ".omp", "extensions", "feishu"));
  assert.equal(spec.supervisorPath, join(home, ".omp", "extensions", "feishu", "support", "feishu-supervisor.mjs"));
  assert.deepEqual(spec.daemonArgs, [
    baseInput.ompCliPath,
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--allow-home",
    "--cwd", baseInput.workspace,
    "-e", baseInput.extensionPath,
  ]);
  assert.equal(spec.supervisorCommand[0], baseInput.bunBin);
  assert.equal(spec.supervisorCommand[1], spec.supervisorPath);
  assert.equal(spec.supervisorCommand.at(-1), baseInput.extensionPath);
  assert.equal(spec.logPath, join(home, ".omp", "agent", "feishu", "daemon.log"));
  assert.equal(spec.pidPath, join(home, ".omp", "agent", "feishu", "supervisor.pid"));
  assert.equal(spec.stopPath, join(home, ".omp", "agent", "feishu", "supervisor.stop"));
  assert.equal(spec.envPath, join(home, ".omp", "agent", "feishu", "supervisor.env.json"));
  assert.equal(spec.env.OMP_CLI_PATH, baseInput.ompCliPath);
  assert.equal(spec.env.PI_CODING_AGENT_DIR, baseInput.agentDir);
  assert.equal(spec.env.PI_FEISHU_DAEMON, "1");
  assert.equal(spec.env.FEISHU_PLUGIN_VERSION, "0.4.40");
  assert.ok((spec.env.PATH || "").split(delimiter).includes(dirname(baseInput.bunBin)));
});

test("adds the Bun directory ahead of inherited PATH", () => {
  const inherited = ["/opt/bin", "/usr/bin"].join(delimiter);
  const spec = buildDaemonSpec({ ...baseInput, path: inherited });
  const entries = (spec.env.PATH || "").split(delimiter);
  assert.equal(entries[0], dirname(baseInput.bunBin));
  assert.ok(entries.includes("/opt/bin"));
  assert.ok(entries.includes("/usr/bin"));
});

test("keeps runtime paths aligned when a custom OMP agent profile is used", () => {
  const agentDir = join("/srv", "omp-profiles", "team");
  const runtimeRoot = join(agentDir, "feishu");
  const spec = buildDaemonSpec({
    ...baseInput,
    agentDir,
    runtimeRoot,
  });
  assert.equal(spec.cwd, baseInput.workspace);
  assert.equal(spec.logPath, join(runtimeRoot, "daemon.log"));
  assert.equal(spec.supervisorArgs[0], "--cwd");
  assert.equal(spec.supervisorArgs[1], baseInput.workspace);
  assert.equal(spec.env.PI_CODING_AGENT_DIR, agentDir);
});

test("omits plugin version env when the version is not known", () => {
  const spec = buildDaemonSpec({ ...baseInput, pluginVersion: undefined });
  assert.equal("FEISHU_PLUGIN_VERSION" in spec.env, false);
});

test("preserves Windows paths with spaces as a spawn argument array", { skip: process.platform !== "win32" }, () => {
  const spec = buildDaemonSpec({
    bunBin: "C:\\Program Files\\Bun\\bun.exe",
    ompCliPath: "C:\\Users\\User\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js",
    extensionPath: "C:\\Users\\User\\.omp\\extensions\\feishu\\extension\\index.ts",
    workspace: "C:\\Users\\User\\work dir",
    agentDir: "C:\\Users\\User\\.omp\\agent",
    runtimeRoot: "C:\\Users\\User\\.omp\\agent\\feishu",
  });
  assert.equal(spec.supervisorCommand[0], "C:\\Program Files\\Bun\\bun.exe");
  assert.equal(spec.supervisorCommand[1], "C:\\Users\\User\\.omp\\extensions\\feishu\\support\\feishu-supervisor.mjs");
  assert.equal(spec.supervisorCommand[spec.supervisorCommand.indexOf("C:\\Users\\User\\work dir")], "C:\\Users\\User\\work dir");
});
