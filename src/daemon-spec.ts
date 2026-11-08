import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

export type OmpApprovalMode = "always-ask" | "write" | "yolo";

// launchd/systemd hand daemons a PATH copied from the unit they were started
// from, which the plugin itself wrote from this spec: without dedupe every
// restart prepends bunDir again, so the unit never matches the expected env
// and the daemon boots itself out on each start.
export function dedupePath(value: string): string {
  const seen = new Set<string>();
  const parts = value.split(delimiter).filter((part) => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  });
  return parts.join(delimiter);
}

export type OmpLaunchOptions = {
  enableSkills?: boolean;
  skills?: string[];
  tools?: string[];
  approvalMode?: OmpApprovalMode;
  maxTime?: string;
  appendSystemPrompt?: string;
  addDirs?: string[];
};

export function normalizeOmpLaunch(value: unknown): OmpLaunchOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const skills = normalizeStringList(raw.skills);
  const enableSkills = typeof raw.enableSkills === "boolean" ? raw.enableSkills : skills !== undefined ? true : undefined;
  const tools = normalizeStringList(raw.tools);
  const addDirs = normalizeStringList(raw.addDirs);
  const approvalMode = raw.approvalMode === "always-ask" || raw.approvalMode === "write" || raw.approvalMode === "yolo"
    ? raw.approvalMode
    : undefined;
  const maxTime = normalizeDuration(raw.maxTime);
  const appendSystemPrompt = typeof raw.appendSystemPrompt === "string" && raw.appendSystemPrompt.trim()
    ? raw.appendSystemPrompt.trim()
    : undefined;
  if (enableSkills === undefined && skills === undefined && tools === undefined && addDirs === undefined && approvalMode === undefined && maxTime === undefined && appendSystemPrompt === undefined) return undefined;
  return { enableSkills, skills, tools, approvalMode, maxTime, appendSystemPrompt, addDirs };
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return items.length ? [...new Set(items)] : undefined;
}

function normalizeDuration(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\d+(?:\.\d+)?(?:[smh])?$/.test(trimmed) ? trimmed : undefined;
}

export type DaemonSpecInput = {
  bunBin: string;
  ompCliPath: string;
  extensionPath: string;
  workspace: string;
  agentDir: string;
  runtimeRoot?: string;
  pluginVersion?: string;
  path?: string;
  homeDir?: string;
  ompLaunch?: OmpLaunchOptions;
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
  ];
  const launch = input.ompLaunch;
  if (!launch?.enableSkills) daemonArgs.push("--no-skills");
  daemonArgs.push("--allow-home", "--cwd", input.workspace, "-e", input.extensionPath);
  daemonArgs.push(...buildOmpLaunchArgs(launch, false, true));

  const bunDir = dirname(input.bunBin);
  const homeDir = input.homeDir || homedir();
  const env: Record<string, string> = {
    OMP_CLI_PATH: input.ompCliPath,
    PI_CODING_AGENT_DIR: input.agentDir,
    PI_FEISHU_DAEMON: "1",
    PATH: dedupePath([bunDir, input.path ?? process.env.PATH ?? ""].join(delimiter)),
  };
  if (input.pluginVersion) env.FEISHU_PLUGIN_VERSION = input.pluginVersion;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;

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

export function buildOmpLaunchArgs(launch?: OmpLaunchOptions, includeNoSkills = true, rpcMode = false): string[] {
  const args: string[] = [];
  if (includeNoSkills && !launch?.enableSkills) args.push("--no-skills");
  if (launch?.enableSkills && launch.skills?.length) args.push("--skills", launch.skills.join(","));
  if (launch?.tools?.length) args.push("--tools", launch.tools.join(","));
  if (!rpcMode && launch?.approvalMode) args.push("--approval-mode", launch.approvalMode);
  if (launch?.maxTime) args.push("--max-time", launch.maxTime);
  if (launch?.appendSystemPrompt) args.push("--append-system-prompt", launch.appendSystemPrompt);
  for (const dir of launch?.addDirs || []) args.push("--add-dir", dir);
  return args;
}
