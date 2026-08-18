import { dirname, join } from "node:path";

export type DaemonSpecInput = {
  bunBin: string;
  ompCliPath: string;
  extensionPath: string;
  workspace: string;
  agentDir: string;
  runtimeRoot?: string;
  pluginVersion?: string;
};

export type DaemonSpec = {
  bunBin: string;
  ompCliPath: string;
  extensionPath: string;
  pluginDir: string;
  supervisorPath: string;
  cwd: string;
  agentDir: string;
  logPath: string;
  pidPath: string;
  stopPath: string;
  envPath: string;
  daemonArgs: string[];
  supervisorArgs: string[];
  supervisorCommand: string[];
  env: Record<string, string>;
};

export function buildDaemonSpec(input: DaemonSpecInput): DaemonSpec {
  const runtimeRoot = input.runtimeRoot || join(input.agentDir, "feishu");
  const pluginDir = dirname(dirname(input.extensionPath));
  const supervisorPath = join(pluginDir, "support", "feishu-supervisor.mjs");
  const daemonArgs = [
    input.ompCliPath,
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--allow-home",
    "--cwd", input.workspace,
    "-e", input.extensionPath,
  ];
  const env: Record<string, string> = {
    OMP_CLI_PATH: input.ompCliPath,
    PI_CODING_AGENT_DIR: input.agentDir,
    PI_FEISHU_DAEMON: "1",
  };
  if (input.pluginVersion) env.FEISHU_PLUGIN_VERSION = input.pluginVersion;

  return {
    bunBin: input.bunBin,
    ompCliPath: input.ompCliPath,
    extensionPath: input.extensionPath,
    pluginDir,
    supervisorPath,
    cwd: input.workspace,
    agentDir: input.agentDir,
    logPath: join(runtimeRoot, "daemon.log"),
    pidPath: join(runtimeRoot, "supervisor.pid"),
    stopPath: join(runtimeRoot, "supervisor.stop"),
    envPath: join(runtimeRoot, "supervisor.env.json"),
    daemonArgs,
    supervisorArgs: [
      "--cwd", input.workspace,
      "--log", join(runtimeRoot, "daemon.log"),
      "--pid", join(runtimeRoot, "supervisor.pid"),
      "--stop", join(runtimeRoot, "supervisor.stop"),
      "--",
      input.bunBin,
      ...daemonArgs,
    ],
    supervisorCommand: [
      input.bunBin,
      supervisorPath,
      "--cwd", input.workspace,
      "--log", join(runtimeRoot, "daemon.log"),
      "--pid", join(runtimeRoot, "supervisor.pid"),
      "--stop", join(runtimeRoot, "supervisor.stop"),
      "--",
      input.bunBin,
      ...daemonArgs,
    ],
    env,
  };
}
