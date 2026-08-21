export type OmpCommandInfo = {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  source?: string;
};

export function feishuHelpText(ompCommands?: ReadonlyArray<OmpCommandInfo>) {
  const lines = [
    "插件管理命令（OMP 中运行；管理员也可在飞书执行 start、stop、restart、autostart、reset）：",
    "管理员可在飞书发送：/feishu start、/feishu stop、/feishu restart、/feishu autostart、/feishu reset",
    "/feishu setup - 配置飞书应用（需要 OMP 终端交互，飞书端不能执行）",
    "/feishu start - 启动飞书连接",
    "/feishu stop - 停止飞书连接",
    "/feishu restart - 重启连接并加载最新代码和配置",
    "/feishu autostart - 开关并配置系统自启动（Linux systemd / macOS launchd / Windows 计划任务）",
    "/feishu reset - 重置插件配置和会话映射",
    "",
    "飞书聊天命令（直接发给机器人）：",
    "/feishu help 或 /help - 查看全部命令及用途",
    "/feishu doctor 或 /doctor - 检查配置、OMP、模型和 daemon",
    "/feishu version 或 /version - 查看插件、OMP 和 Bun 版本",
    "/feishu upgrade - 管理员安装最新版；指定版本可升级或降级（例如：/feishu upgrade 0.4.14）",
    "/feishu status - 查看连接状态和运行位置",
    "/feishu config - 查看脱敏配置（管理员）",
    "/feishu debug - 查看最近的调试日志（管理员）",
    "/feishu refresh - 刷新 OMP 模型列表（管理员）",
    "/feishu commands 或 /commands - 说明 OMP 原生命令仅能在本机终端执行",
    "/new - 新建当前飞书会话（群聊需管理员）",
    "/resume - 恢复当前飞书会话保存过的历史会话（群聊需管理员）",
    "/model - 选择当前聊天使用的模型（群聊需管理员）",
    "/effort - 查看或切换当前聊天的思考强度：inherit/off/minimal/low/medium/high/xhigh/max（群聊需管理员）",
    "/compact - 手动压缩当前飞书会话的上下文，可附带压缩重点",
    "/autocompact - 查看或开启/关闭自动上下文压缩，如 /autocompact on（群聊需管理员）",
    "/stop - 停止当前聊天正在执行的任务（群聊需管理员）",
    "/workspace PATH - 切换当前聊天的工作目录（管理员）",
    "/send PATH - 发送当前工作区内的文件或图片（管理员）",
    "自动发送 - OMP 任务完成后，自动把生成的图片、文档、音频发回当前飞书会话",
  ];
  if (ompCommands?.length) {
    lines.push("", formatOmpCommands(ompCommands));
  }
  return lines.join("\n");
}

export function formatOmpCommands(commands: ReadonlyArray<OmpCommandInfo>) {
  const lines = ["当前 OMP 会话可用命令："];
  for (const command of commands) {
    if (!command?.name) continue;
    const names = [command.name, ...(command.aliases || [])].map((name) => `/${name}`);
    const hint = command.input?.hint?.trim() ? ` ${command.input.hint.trim()}` : "";
    lines.push(`${names.join("、")}${hint} - ${command.description?.trim() || "OMP 可用命令"}`);
  }
  return lines.join("\n");
}
