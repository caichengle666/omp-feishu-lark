import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { DaemonSpec } from "./daemon-spec.js";
import { isSupervisorProcessAlive, readSupervisorRecord } from "../support/feishu-supervisor.mjs";

export type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type AutostartDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  uid?: number | string;
  isRoot?: () => boolean;
  run?: (command: string, args: string[], options?: { encoding?: string; timeout?: number }) => RunResult;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string | Uint8Array, mode?: number) => void;
  rename?: (from: string, to: string) => void;
  removeFile?: (path: string) => void;
  mkdir?: (path: string) => void;
};

export type NormalizedAutostartDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  uid: number | string;
  isRoot: () => boolean;
  run: (command: string, args: string[], options?: { encoding?: string; timeout?: number }) => RunResult;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string | Uint8Array, mode?: number) => void;
  rename: (from: string, to: string) => void;
  removeFile: (path: string) => void;
  mkdir: (path: string) => void;
};

export type AutostartStatus = {
  platform: string;
  label: string;
  state: "unsupported" | "healthy" | "missing" | "misconfigured" | "foreign" | "disabled" | "unreadable" | "permission";
  detail?: string;
  enabled?: boolean;
  active?: boolean;
  versionStale?: boolean;
};

export type AutostartResult = {
  message: string;
  status: AutostartStatus;
};

export type AutostartOptions = {
  start?: boolean;
};

export function normalizeAutostartDeps(deps: AutostartDeps = {}): NormalizedAutostartDeps {
  const platform = deps.platform || process.platform;
  return {
    platform,
    env: deps.env || process.env,
    homeDir: deps.homeDir || homedir(),
    uid: deps.uid ?? (typeof process.getuid === "function" ? process.getuid?.() ?? 0 : 0),
    isRoot: deps.isRoot || (() => platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0),
    run: deps.run || ((command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        status: result.status ?? -1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        error: result.error,
      };
    }),
    exists: deps.exists || existsSync,
    readFile: deps.readFile || ((path) => readFileSync(path, "utf8")),
    writeFile: deps.writeFile || ((path, content, mode) => {
      writeFileSync(path, content, mode === undefined ? {} : { mode });
    }),
    rename: deps.rename || renameSync,
    removeFile: deps.removeFile || ((path) => rmSync(path, { force: true })),
    mkdir: deps.mkdir || ((path) => mkdirSync(path, { recursive: true })),
  };
}

export async function inspectAutoStart(spec: DaemonSpec, deps: AutostartDeps = {}): Promise<AutostartStatus> {
  const normalized = normalizeAutostartDeps(deps);
  if (normalized.platform === "linux") {
    const module = await import("./autostart/linux-systemd.js");
    return module.inspect(spec, normalized);
  }
  if (normalized.platform === "darwin") {
    const module = await import("./autostart/darwin-launchd.js");
    return module.inspect(spec, normalized);
  }
  if (normalized.platform === "win32") {
    const module = await import("./autostart/win32-task.js");
    return module.inspect(spec, normalized);
  }
  return {
    platform: normalized.platform,
    label: "autostart",
    state: "unsupported",
    detail: "当前平台暂不支持 OS 自启动集成。",
  };
}

export async function ensureAutoStart(
  spec: DaemonSpec,
  enabled: boolean,
  deps: AutostartDeps = {},
  options: AutostartOptions = {},
): Promise<AutostartResult> {
  const normalized = normalizeAutostartDeps(deps);
  let start = options.start !== false;
  const supervisor = readSupervisorRecord(spec.pidPath);
  if (supervisor && isSupervisorProcessAlive(supervisor)) start = false;
  const nextOptions = { start };

  if (normalized.platform === "linux") {
    const module = await import("./autostart/linux-systemd.js");
    return module.ensure(spec, enabled, normalized, nextOptions);
  }
  if (normalized.platform === "darwin") {
    const module = await import("./autostart/darwin-launchd.js");
    return module.ensure(spec, enabled, normalized, nextOptions);
  }
  if (normalized.platform === "win32") {
    const module = await import("./autostart/win32-task.js");
    return module.ensure(spec, enabled, normalized, nextOptions);
  }
  return {
    message: "当前平台暂不支持 OS 自启动集成。",
    status: {
      platform: normalized.platform,
      label: "autostart",
      state: "unsupported",
      detail: "当前平台暂不支持 OS 自启动集成。",
    },
  };
}
