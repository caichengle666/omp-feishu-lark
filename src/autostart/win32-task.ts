import { dirname } from "node:path";
import type { DaemonSpec } from "../daemon-spec.js";
import type { AutostartOptions, AutostartResult, AutostartStatus, NormalizedAutostartDeps } from "../autostart.js";

const TASK_NAME = "OMP Feishu";
const LABEL = "Windows 计划任务";

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteTaskArgument(value: string) {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildWinTaskXml(spec: DaemonSpec) {
  const argumentsLine = [spec.supervisorPath, "--env-json", spec.envPath, ...spec.supervisorArgs].map(quoteTaskArgument).join(" ");
  const trigger = `<LogonTrigger><Enabled>true</Enabled></LogonTrigger>`;
  const principal = `<Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>OMP Feishu supervisor autostart</Description>`,
    `    <URI>\\OMP Feishu</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    `    ${trigger}`,
    "  </Triggers>",
    "  <Principals>",
    `    ${principal}`,
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>false</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(spec.bunBin)}</Command>`,
    `      <Arguments>${xmlEscape(argumentsLine)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(spec.cwd)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

function writeEnvironmentFile(spec: DaemonSpec, deps: NormalizedAutostartDeps) {
  deps.mkdir(dirname(spec.envPath));
  const temporary = `${spec.envPath}.tmp-${process.pid}-${Date.now()}`;
  deps.writeFile(temporary, `${JSON.stringify(spec.env, null, 2)}\n`, 0o600);
  deps.rename(temporary, spec.envPath);
}

export async function inspect(spec: DaemonSpec, deps: NormalizedAutostartDeps): Promise<AutostartStatus> {
  const result = deps.run("schtasks", ["/Query", "/TN", TASK_NAME, "/XML"]);
  if (result.error || result.status !== 0) {
    return {
      platform: "win32",
      label: LABEL,
      state: "missing",
      detail: `${TASK_NAME} 未注册`,
    };
  }
  const xml = result.stdout;
  if (!xml.includes(spec.supervisorPath) || !xml.includes(spec.extensionPath)) {
    return {
      platform: "win32",
      label: LABEL,
      state: "foreign",
      detail: `${TASK_NAME} 不指向当前插件：${xml.slice(0, 200)}`,
    };
  }
  if (!xml.includes(spec.cwd)) {
    return {
      platform: "win32",
      label: LABEL,
      state: "misconfigured",
      detail: `${TASK_NAME} 工作目录与当前安装不一致`,
    };
  }
  if (!xml.includes(spec.envPath) || !deps.exists(spec.envPath)) {
    return {
      platform: "win32",
      label: LABEL,
      state: "misconfigured",
      detail: `${TASK_NAME} 没有使用当前 supervisor 环境文件`,
    };
  }
  let envRecord: Record<string, unknown> | undefined;
  try {
    envRecord = JSON.parse(deps.readFile(spec.envPath)) as Record<string, unknown>;
  } catch {}
  const envMatches = Object.entries(spec.env).every(([key, value]) => envRecord?.[key] === value);
  if (!envMatches) {
    return {
      platform: "win32",
      label: LABEL,
      state: "misconfigured",
      detail: `${TASK_NAME} 环境文件与当前安装不一致`,
    };
  }
  const disabled = /<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/.test(xml);
  const enabled = !disabled;
  return {
    platform: "win32",
    label: LABEL,
    state: enabled ? "healthy" : "disabled",
    detail: `${TASK_NAME} enabled=${enabled}`,
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
  if (current.state === "foreign") {
    return {
      message: `拒绝覆盖其他应用的 Windows 计划任务：${current.detail}`,
      status: current,
    };
  }
  if (current.state === "unreadable") {
    return {
      message: `无法确认或修改 Windows 计划任务：${current.detail}`,
      status: current,
    };
  }

  if (!enabled) {
    if (current.state === "missing") {
      return {
        message: "Windows 计划任务自启动本就未启用。",
        status: current,
      };
    }
    const change = deps.run("schtasks", ["/Change", "/TN", TASK_NAME, "/DISABLE"]);
    if (change.status !== 0) {
      return {
        message: `关闭 Windows 计划任务失败：${change.stderr || change.stdout || "unknown"}`,
        status: { ...current, state: "unreadable" },
      };
    }
    return {
      message: "已关闭 Windows 计划任务自启动，当前连接不会自动停止。",
      status: { ...current, state: "disabled", enabled: false },
    };
  }

  if (current.state === "healthy") {
    try {
      writeEnvironmentFile(spec, deps);
    } catch (error) {
      return {
        message: `写入 Windows 计划任务环境失败：${error instanceof Error ? error.message : String(error)}`,
        status: {
          platform: "win32",
          label: LABEL,
          state: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (options.start) deps.run("schtasks", ["/Run", "/TN", TASK_NAME]);
    return {
      message: `Windows 计划任务自启动已就绪：${current.detail}`,
      status: current,
    };
  }
  if (current.state === "disabled") {
    try {
      writeEnvironmentFile(spec, deps);
    } catch (error) {
      return {
        message: `写入 Windows 计划任务环境失败：${error instanceof Error ? error.message : String(error)}`,
        status: {
          platform: "win32",
          label: LABEL,
          state: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const change = deps.run("schtasks", ["/Change", "/TN", TASK_NAME, "/ENABLE"]);
    if (change.status !== 0) {
      return {
        message: `重新启用 Windows 计划任务失败：${change.stderr || change.stdout || "unknown"}`,
        status: { ...current, state: "unreadable" },
      };
    }
    if (options.start) deps.run("schtasks", ["/Run", "/TN", TASK_NAME]);
    return {
      message: "Windows 计划任务自启动已启用。",
      status: { ...current, state: "healthy", enabled: true },
    };
  }

  const xmlPath = `${spec.pidPath}.task.xml`;
  try {
    deps.mkdir(dirname(spec.pidPath));
    writeEnvironmentFile(spec, deps);
    const xml = buildWinTaskXml(spec);
    deps.writeFile(xmlPath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(xml, "utf16le"),
    ]), 0o600);
  } catch (error) {
    return {
      message: `写入 Windows 计划任务 XML 失败：${error instanceof Error ? error.message : String(error)}`,
      status: {
        platform: "win32",
        label: LABEL,
        state: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const created = deps.run("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  try { deps.removeFile(xmlPath); } catch {}
  if (created.status !== 0) {
    return {
      message: `注册 Windows 计划任务失败：${created.stderr || created.stdout || "unknown"}`,
      status: {
        platform: "win32",
        label: LABEL,
        state: "unreadable",
        detail: created.stderr || created.stdout || "schtasks failed",
      },
    };
  }
  const enabledTask = deps.run("schtasks", ["/Change", "/TN", TASK_NAME, "/ENABLE"]);
  if (enabledTask.status !== 0) {
    return {
      message: `启用 Windows 计划任务失败：${enabledTask.stderr || enabledTask.stdout || "unknown"}`,
      status: {
        platform: "win32",
        label: LABEL,
        state: "unreadable",
        detail: enabledTask.stderr || enabledTask.stdout || "schtasks enable failed",
      },
    };
  }
  if (options.start) deps.run("schtasks", ["/Run", "/TN", TASK_NAME]);
  return {
    message: "Windows 计划任务自启动已安装，登录时通过 supervisor 启动 daemon。",
    status: {
      platform: "win32",
      label: LABEL,
      state: "healthy",
      detail: `${TASK_NAME} 已注册`,
      enabled: true,
    },
  };
}
