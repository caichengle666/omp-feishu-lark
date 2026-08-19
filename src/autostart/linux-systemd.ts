import type { DaemonSpec } from "../daemon-spec.js";
import type { AutostartOptions, AutostartResult, AutostartStatus, NormalizedAutostartDeps } from "../autostart.js";

const SERVICE_NAME = "omp-feishu.service";
const UNIT_PATH = "/etc/systemd/system/omp-feishu.service";
const LABEL = "systemd";

function quoteSystemd(value: string) {
  return `"${value.replace(/%/g, "%%").replace(/([\\"$`])/g, "\\$1")}"`;
}

function escapeSystemdPath(value: string) {
  return value.replace(/%/g, "%%").replace(/([\\"$` ])/g, "\\$1");
}

export function buildSystemdUnit(spec: DaemonSpec) {
  const execStart = spec.supervisorCommand.map(quoteSystemd).join(" ");
  const envLines = Object.entries(spec.env)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `Environment=${key}=${quoteSystemd(value)}`)
    .join("\n");
  return [
    "[Unit]",
    "Description=OMP Feishu Supervisor",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${escapeSystemdPath(spec.cwd)}`,
    "Restart=on-failure",
    "RestartSec=5",
    envLines,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function parseUnitExecStart(unit: string) {
  const line = unit.split(/\r?\n/).find((entry) => entry.startsWith("ExecStart="));
  return line ? line.slice("ExecStart=".length) : undefined;
}

export function parseExecStartArgs(execStart: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let escaping = false;
  for (const char of execStart) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(char)) {
      if (current) {
        tokens.push(normalizeSystemdValue(current));
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(normalizeSystemdValue(current));
  return tokens;
}

export function parseEnvironmentMap(unit: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of unit.split(/\r?\n/)) {
    const match = line.match(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = normalizeSystemdValue(match[2]);
  }
  return values;
}

export function systemdUnitMatches(unit: string, expected: string, bunBin: string) {
  const execStart = parseUnitExecStart(unit);
  const expectedExecStart = parseUnitExecStart(expected);
  if (!execStart || !expectedExecStart) return false;
  const actualArgs = parseExecStartArgs(execStart);
  const expectedArgs = parseExecStartArgs(expectedExecStart);
  const actualEnv = parseEnvironmentMap(unit);
  const expectedEnv = parseEnvironmentMap(expected);
  const pathEntries = (actualEnv.PATH || "").split(/[:;]/);
  const bunDirIndex = Math.max(bunBin.lastIndexOf("/"), bunBin.lastIndexOf("\\"));
  const bunDir = bunDirIndex > 0 ? bunBin.slice(0, bunDirIndex) : "";
  const execMatch = actualArgs.length === expectedArgs.length
    && actualArgs.every((arg, index) => arg === expectedArgs[index]);
  const envMatch = Object.entries(expectedEnv).every(([key, value]) =>
    key === "FEISHU_PLUGIN_VERSION" || actualEnv[key] === value);
  const pathMatch = !bunDir || pathEntries.includes(bunDir);
  const workingDirectoryMatch = normalizeSystemdValue(unit.match(/^WorkingDirectory=(.*)$/m)?.[1] || "")
    === normalizeSystemdValue(expected.match(/^WorkingDirectory=(.*)$/m)?.[1] || "");
  return execMatch && envMatch && pathMatch && workingDirectoryMatch;
}

function normalizeSystemdValue(value: string) {
  const trimmed = value.trim();
  const unquoted = trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")
    ? trimmed.slice(1, -1)
    : trimmed;
  return unquoted
    .replace(/%%/g, "%")
    .replace(/\\(["\\$` ])/g, "$1");
}

function isOwnedUnit(unit: string, spec: DaemonSpec) {
  if (unit.includes(spec.supervisorPath) || unit.includes(spec.pluginDir)) return true;
  return unit.includes("omp-feishu") && (
    unit.includes("feishu-plugin/extension/index.ts")
    || unit.includes(".pi/extensions/feishu/extension/index.ts")
    || unit.includes(".omp/plugins/node_modules/@caichengle/omp-feishu-lark/extension/index.ts")
  );
}

export async function inspect(spec: DaemonSpec, deps: NormalizedAutostartDeps): Promise<AutostartStatus> {
  const cat = deps.run("systemctl", ["cat", "--no-pager", SERVICE_NAME]);
  if (cat.error || cat.status !== 0) {
    if (deps.exists(UNIT_PATH)) {
      return {
        platform: "linux",
        label: LABEL,
        state: "unreadable",
        detail: `${UNIT_PATH} 存在但 systemctl 无法读取：${(cat.stderr || cat.error?.message || "unknown").trim()}`,
      };
    }
    return {
      platform: "linux",
      label: LABEL,
      state: "missing",
      detail: `${SERVICE_NAME} 未安装`,
    };
  }
  const unit = cat.stdout;
  const execStart = parseUnitExecStart(unit);
  if (!execStart) {
    return {
      platform: "linux",
      label: LABEL,
      state: "misconfigured",
      detail: `${SERVICE_NAME} 没有 ExecStart`,
      enabled: false,
      active: false,
    };
  }
  const owned = isOwnedUnit(unit, spec);
  if (!owned) {
    return {
      platform: "linux",
      label: LABEL,
      state: "foreign",
      detail: `${SERVICE_NAME} 不指向当前插件安装：${execStart}`,
    };
  }
  const enabledResult = deps.run("systemctl", ["is-enabled", SERVICE_NAME]);
  const enabled = enabledResult.stdout.trim() === "enabled";
  const activeResult = deps.run("systemctl", ["is-active", SERVICE_NAME]);
  const active = activeResult.stdout.trim() === "active";
  const expected = buildSystemdUnit(spec);
  const expectedExecStart = parseUnitExecStart(expected);
  const correct = systemdUnitMatches(unit, expected, spec.bunBin);
  const versionStale = parseEnvironmentMap(unit).FEISHU_PLUGIN_VERSION
    !== parseEnvironmentMap(expected).FEISHU_PLUGIN_VERSION;
  if (!correct) {
    return {
      platform: "linux",
      label: LABEL,
      state: "misconfigured",
      detail: `${SERVICE_NAME} 配置与当前安装不一致：${execStart}`,
      enabled,
      active,
      versionStale,
    };
  }
  if (!enabled) {
    return {
      platform: "linux",
      label: LABEL,
      state: "disabled",
      detail: `${SERVICE_NAME} 配置正确但未启用`,
      enabled: false,
      active,
      versionStale,
    };
  }
  return {
    platform: "linux",
    label: LABEL,
    state: "healthy",
    detail: `${SERVICE_NAME} enabled=${enabled} active=${active}`,
    enabled: true,
    active,
    versionStale,
  };
}

export async function ensure(
  spec: DaemonSpec,
  enabled: boolean,
  deps: NormalizedAutostartDeps,
  options: AutostartOptions,
): Promise<AutostartResult> {
  let current = await inspect(spec, deps);
  if (current.state === "foreign") {
    return {
      message: `拒绝覆盖其他应用的 systemd service：${current.detail}`,
      status: current,
    };
  }
  if (current.state === "unreadable" || current.state === "permission") {
    return {
      message: `无法确认或修改 systemd service：${current.detail}`,
      status: current,
    };
  }

  if (!enabled) {
    if (current.state === "missing") {
      return {
        message: "Linux systemd 自启动本就未启用。",
        status: current,
      };
    }
    if (!deps.isRoot()) {
      return {
        message: "关闭 Linux systemd 自启动需要 root 权限。",
        status: {
          platform: "linux",
          label: LABEL,
          state: "permission",
          detail: "systemctl disable 需要 root 权限。",
        },
      };
    }
    deps.run("systemctl", ["disable", SERVICE_NAME]);
    return {
      message: "已关闭 Linux systemd 自启动，当前连接不会自动停止。",
      status: { ...current, state: "disabled", enabled: false },
    };
  }

  if (current.state === "healthy") {
    if (!current.versionStale) {
      if (!current.enabled) deps.run("systemctl", ["enable", SERVICE_NAME]);
      if (options.start && !current.active) deps.run("systemctl", ["start", SERVICE_NAME]);
      return {
        message: `Linux systemd 自启动已就绪：${current.detail}`,
        status: current,
      };
    }
    current = { ...current, state: "misconfigured" };
  }
  if (current.state === "disabled") {
    if (!deps.isRoot()) {
      return {
        message: "启用 Linux systemd 自启动需要 root 权限。",
        status: {
          platform: "linux",
          label: LABEL,
          state: "permission",
          detail: "systemctl enable 需要 root 权限。",
        },
      };
    }
    deps.run("systemctl", ["enable", SERVICE_NAME]);
    if (options.start && !current.active) deps.run("systemctl", ["start", SERVICE_NAME]);
    return {
      message: "Linux systemd 自启动已启用。",
      status: { ...current, state: "healthy", enabled: true, active: current.active },
    };
  }

  if (!deps.isRoot()) {
    return {
      message: "安装 Linux systemd 自启动需要 root 权限。",
      status: {
        platform: "linux",
        label: LABEL,
        state: "permission",
        detail: `写入 ${UNIT_PATH} 和 systemctl enable 需要 root 权限。`,
      },
    };
  }

  const unit = buildSystemdUnit(spec);
  const temporary = `${UNIT_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    deps.writeFile(temporary, unit, 0o644);
    deps.rename(temporary, UNIT_PATH);
  } catch (error) {
    return {
      message: `写入 systemd unit 失败：${error instanceof Error ? error.message : String(error)}`,
      status: {
        platform: "linux",
        label: LABEL,
        state: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  deps.run("systemctl", ["daemon-reload"]);
  deps.run("systemctl", ["enable", SERVICE_NAME]);
  if (options.start) {
    const activeResult = deps.run("systemctl", ["is-active", SERVICE_NAME]);
    const active = activeResult.stdout.trim() === "active";
    deps.run("systemctl", [active ? "restart" : "start", SERVICE_NAME]);
  }
  return {
    message: options.start ? "Linux systemd 自启动已安装并通过 supervisor 启动 daemon。" : "Linux systemd 自启动已安装并启用。",
    status: {
      platform: "linux",
      label: LABEL,
      state: "healthy",
      detail: `${UNIT_PATH} 已写入并启用`,
      enabled: true,
      active: options.start !== false,
    },
  };
}
