import { dirname, join } from "node:path";
import type { DaemonSpec } from "../daemon-spec.js";
import type { AutostartOptions, AutostartResult, AutostartStatus, NormalizedAutostartDeps } from "../autostart.js";

const LABEL = "com.caichengle.omp-feishu";
const PLIST_NAME = `${LABEL}.plist`;

function plistPath(deps: NormalizedAutostartDeps) {
  return join(deps.homeDir, "Library", "LaunchAgents", PLIST_NAME);
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistString(value: string) {
  return xmlEscape(value);
}

function hasProgramArgument(plist: string, value: string) {
  return plist.includes(`<string>${plistString(value)}</string>`);
}

function launchdDomain(uid: number | string) {
  return `gui/${uid}`;
}

function loadLaunchd(path: string, deps: NormalizedAutostartDeps) {
  const bootstrapped = deps.run("launchctl", ["bootstrap", launchdDomain(deps.uid), path]);
  if (bootstrapped.status === 0) return bootstrapped;
  return deps.run("launchctl", ["load", "-w", path]);
}

function startLaunchd(deps: NormalizedAutostartDeps) {
  const kickstarted = deps.run("launchctl", ["kickstart", "-k", `${launchdDomain(deps.uid)}/${LABEL}`]);
  if (kickstarted.status === 0) return kickstarted;
  return deps.run("launchctl", ["start", LABEL]);
}

export function buildLaunchdPlist(spec: DaemonSpec) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xmlEscape(LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.supervisorCommand.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xmlEscape(spec.cwd)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>EnvironmentVariables</key><dict>",
    ...Object.entries(spec.env)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`),
    "  </dict>",
    `  <key>StandardOutPath</key><string>${xmlEscape(`${spec.logPath}.launchd.out`)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(`${spec.logPath}.launchd.err`)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function inspect(spec: DaemonSpec, deps: NormalizedAutostartDeps): Promise<AutostartStatus> {
  const path = plistPath(deps);
  if (!deps.exists(path)) {
    return {
      platform: "darwin",
      label: LABEL,
      state: "missing",
      detail: `${path} 未安装`,
    };
  }

  let plist: string;
  try {
    plist = deps.readFile(path);
  } catch (error) {
    return {
      platform: "darwin",
      label: LABEL,
      state: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!plist.includes(LABEL)) {
    return {
      platform: "darwin",
      label: LABEL,
      state: "foreign",
      detail: `${path} 不指向当前插件：${path}`,
    };
  }
  const argumentsValid = spec.supervisorCommand.every((arg) => hasProgramArgument(plist, arg));
  const environmentValid = Object.entries(spec.env).every(([key, value]) =>
    plist.includes(`<key>${plistString(key)}</key><string>${plistString(value)}</string>`),
  );
  const pathsValid = plist.includes(`<key>WorkingDirectory</key><string>${plistString(spec.cwd)}</string>`)
    && plist.includes(`<key>StandardOutPath</key><string>${plistString(`${spec.logPath}.launchd.out`)}</string>`)
    && plist.includes(`<key>StandardErrorPath</key><string>${plistString(`${spec.logPath}.launchd.err`)}</string>`);
  if (!argumentsValid || !environmentValid || !pathsValid) {
    return {
      platform: "darwin",
      label: LABEL,
      state: "misconfigured",
      detail: `${path} 配置与当前安装不一致`,
    };
  }

  const enabled = /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(plist);
  const keepAlive = /<key>KeepAlive<\/key>/.test(plist);
  if (enabled && keepAlive) {
    return {
      platform: "darwin",
      label: LABEL,
      state: "healthy",
      detail: `${path} RunAtLoad=true`,
      enabled: true,
    };
  }
  return {
    platform: "darwin",
    label: LABEL,
    state: enabled ? "misconfigured" : "disabled",
    detail: enabled ? `${path} 缺少 KeepAlive` : `${path} RunAtLoad 未开启`,
    enabled,
  };
}

export async function ensure(
  spec: DaemonSpec,
  enabled: boolean,
  deps: NormalizedAutostartDeps,
  options: AutostartOptions,
): Promise<AutostartResult> {
  const current = await inspect(spec, deps);
  const path = plistPath(deps);
  if (current.state === "foreign") {
    return {
      message: `拒绝覆盖其他应用的 launchd 配置：${current.detail}`,
      status: current,
    };
  }
  if (current.state === "unreadable") {
    return {
      message: `无法确认或修改 launchd 配置：${current.detail}`,
      status: current,
    };
  }

  if (!enabled) {
    if (current.state === "missing") {
      return {
        message: "macOS launchd 自启动本就未启用。",
        status: current,
      };
    }
    const bootout = deps.run("launchctl", ["bootout", `${launchdDomain(deps.uid)}/${LABEL}`]);
    const unloaded = bootout.status === 0 ? bootout : deps.run("launchctl", ["unload", path]);
    if (unloaded.status !== 0 && current.state !== "disabled") {
      return {
        message: `关闭 launchd 配置失败：${unloaded.stderr || unloaded.stdout || "unknown"}`,
        status: { ...current, state: "unreadable" },
      };
    }
    try {
      deps.removeFile(path);
    } catch (error) {
      return {
        message: `关闭 launchd 后删除配置文件失败：${error instanceof Error ? error.message : String(error)}`,
        status: { ...current, state: "unreadable" },
      };
    }
    return {
      message: "已关闭 macOS launchd 自启动，当前连接不会自动停止。",
      status: { ...current, state: "disabled", enabled: false },
    };
  }

  if (current.state === "healthy") {
    if (options.start) startLaunchd(deps);
    return {
      message: `macOS launchd 自启动已就绪：${current.detail}`,
      status: current,
    };
  }

  try {
    deps.mkdir(dirname(path));
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    deps.writeFile(temporary, buildLaunchdPlist(spec), 0o644);
    deps.rename(temporary, path);
  } catch (error) {
    return {
      message: `写入 launchd 配置失败：${error instanceof Error ? error.message : String(error)}`,
      status: {
        platform: "darwin",
        label: LABEL,
        state: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (current.state !== "missing") {
    const bootout = deps.run("launchctl", ["bootout", `${launchdDomain(deps.uid)}/${LABEL}`]);
    if (bootout.status !== 0) deps.run("launchctl", ["unload", path]);
  }
  const loaded = loadLaunchd(path, deps);
  if (loaded.status !== 0) {
    return {
      message: `加载 launchd 配置失败：${loaded.stderr || loaded.stdout || "unknown"}`,
      status: {
        platform: "darwin",
        label: LABEL,
        state: "unreadable",
        detail: loaded.stderr || loaded.stdout || "launchctl load failed",
      },
    };
  }
  if (options.start) {
    const started = startLaunchd(deps);
    if (started.status !== 0) {
      return {
        message: `启动 launchd 服务失败：${started.stderr || started.stdout || "unknown"}`,
        status: {
          platform: "darwin",
          label: LABEL,
          state: "unreadable",
          detail: started.stderr || started.stdout || "launchctl start failed",
        },
      };
    }
  }
  return {
    message: options.start ? "macOS launchd 自启动已安装并通过 supervisor 启动 daemon。" : "macOS launchd 自启动已安装。",
    status: {
      platform: "darwin",
      label: LABEL,
      state: "healthy",
      detail: `${path} 已写入并加载`,
      enabled: true,
    },
  };
}
