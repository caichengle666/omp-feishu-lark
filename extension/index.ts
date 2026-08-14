import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { buildModelCard, buildResumeCard, parseModelActionValue, parseResumePageActionValue, parseResumeSelectActionValue } from "./cards.js";
import { BRIDGE_PATH, CONFIG_PATH, DAEMON_LOG_PATH, DEBUG_LOG_PATH, DEDUPE_PATH, ensureRoot, loadConfig, mask, removePath, STATE_PATH, SUPERVISOR_PID_PATH, SUPERVISOR_STOP_PATH, writeJson } from "./config.js";
import { debugLog, flushDebugLog } from "./debug.js";
import { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { FeishuBridgeStore } from "./bridge-store.js";
import { ConversationManager } from "./conversation-manager.js";
import { FeishuRpcWorkerPool } from "./rpc-worker-pool.js";
import { FeishuDelivery } from "./delivery.js";
import { acquireFileLease, acquireGatewayLock, gatewayLockPath, readGatewayOwner, releaseFileLease, type GatewayLockHandle, type GatewayOwner } from "./gateway-lock.js";
import { FeishuMessageHandler } from "./message-handler.js";
import { runSetup, uiConfirm } from "./setup.js";
import { buildTaskStatusCard, parseStopTaskActionValue } from "./task-status-card.js";
import { BotUnavailableError, FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuStatus } from "./types.js";

export default function feishuExtension(pi: ExtensionAPI) {
  let transport: FeishuTransport | undefined;
  let gatewayLock: GatewayLockHandle | undefined;
  const bridgeStore = new FeishuBridgeStore();
  const delivery = new FeishuDelivery(() => transport);
  const bridge = new FeishuBridgeRuntime(bridgeStore, delivery);
  const bootConfig = loadConfig();
  const ompCliPath = resolveOmpCliPath();
  const rpcWorkers = process.env.PI_FEISHU_DAEMON === "1"
    ? new FeishuRpcWorkerPool(({ cwd }) => new RpcClient({
        cwd,
        cliPath: ompCliPath,
        args: ["--no-extensions"],
      }))
    : undefined;
  const conversations = new ConversationManager(process.cwd(), bridge, {
    promptNotifySec: bootConfig?.promptNotifySec,
    promptTimeoutSec: bootConfig?.promptTimeoutSec,
  }, rpcWorkers);
  const messageHandler = new FeishuMessageHandler(conversations, () => transport, bridgeStore, {
    doctor: () => doctorReport(),
    version: () => versionReport(),
  });

  const STATUS_KEY = "feishu-connection";
  const STATUS_REFRESH_MS = 2_000;
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void; notify?: (message: string, level?: string) => void } | undefined;
  let lastStatusText: string | undefined;
  let statusRefreshTimer: NodeJS.Timeout | undefined;
  const buildTag = process.env.FEISHU_EXT_DEV === "1" ? " [DEV]" : "";

  function setStatusText(text: string | undefined) {
    if (lastStatusText === text) return;
    lastStatusText = text;
    uiRef?.setStatus?.(STATUS_KEY, text);
  }

  function updateStatus(status: FeishuStatus) {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    setStatusText(statusText(brand, status));
  }

  function withBuildTag(text: string) {
    return `${text}${buildTag}`;
  }

  function statusText(brand: "Feishu" | "Lark", status: FeishuStatus) {
    const labels: Record<FeishuStatus, string> = {
      "not configured": "未配置 / Not configured",
      connecting: "连接中 / Connecting",
      connected: "已连接 / Connected",
      disconnected: "已断开 / Disconnected",
      owned: "连接被占用 / In use by another process",
      "bot unavailable": "机器人不可用 / Bot unavailable",
    };
    return withBuildTag(`${brand}: ${labels[status]}`);
  }

  function refreshStatusFromState() {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    if (!cfg) {
      setStatusText(statusText(brand, "not configured"));
      return;
    }
    if (transport?.isRunning()) {
      setStatusText(statusText(brand, "connected"));
      return;
    }
    const owner = readGatewayOwner();
    if (owner?.status === "connected") {
      setStatusText(statusText(brand, "connected"));
    } else if (owner?.status === "starting") {
      setStatusText(statusText(brand, "connecting"));
    } else if (owner) {
      setStatusText(statusText(brand, "disconnected"));
    } else {
      setStatusText(statusText(brand, "disconnected"));
    }
  }

  function startStatusRefresh() {
    if (statusRefreshTimer) return;
    refreshStatusFromState();
    statusRefreshTimer = setInterval(refreshStatusFromState, STATUS_REFRESH_MS);
    statusRefreshTimer.unref?.();
  }

  function stopStatusRefresh() {
    if (!statusRefreshTimer) return;
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = undefined;
  }

  function clearStatus() {
    stopStatusRefresh();
    lastStatusText = undefined;
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  }

  pi.on("message_end", async (event, ctx) => {
    bridge.handleMessageEnd(ctx.sessionManager.getSessionId(), undefined, event.message);
  });

  async function start(config?: FeishuConfig, options: { takeover?: boolean } = {}) {
    if (transport?.isRunning()) {
      updateStatus("connected");
      return "already";
    }
    const cfg = config || loadConfig();
    if (!cfg) {
      updateStatus("not configured");
      throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
    }
    updateStatus("connecting");
    const lockResult = await acquireGatewayLock(process.cwd(), Boolean(options.takeover));
    if (lockResult.status === "busy") {
      updateStatus("owned");
      return { status: "owned" as const, owner: lockResult.owner };
    }
    gatewayLock = lockResult.handle;
    gatewayLock.setOnLost(async () => {
      await transport?.stop();
      transport = undefined;
      gatewayLock = undefined;
      updateStatus(loadConfig() ? "owned" : "not configured");
      if (process.env.PI_FEISHU_DAEMON === "1") {
        await flushDebugLog();
        process.exit(0);
      } else {
        uiRef?.notify?.("飞书连接已由另一个进程接管。本会话仍可继续使用；运行 /feishu status 查看当前 owner。", "warning");
      }
    });
    transport = new FeishuTransport(cfg, (msg) => messageHandler.handle(msg), async (action) => {
      const copy = parseCopyMarkdownActionValue(action.value);
      if (copy) {
        const source = transport?.getMarkdownCopySource(copy.copySourceId);
        await transport?.replyPlainText(action.messageId, source || "MD 原文已过期，请重新生成卡片。");
        return;
      }
      const stopTask = parseStopTaskActionValue(action.value);
      if (stopTask) {
        debugLog("feishu.card.stop_requested", {
          key: stopTask.key,
          runId: stopTask.runId,
          cardMessageId: action.messageId,
          chatId: action.chatId,
        });
        const result = await conversations.stopConversation(stopTask.key, async (reply) => {
          await transport?.replyText(action.messageId, reply);
        }, stopTask.runId);
        const status = result.status === "stopped"
          ? "stopped"
          : result.status === "failed"
            ? "failed"
            : "inactive";
        debugLog("feishu.card.stop_final_update_done", {
          key: stopTask.key,
          runId: stopTask.runId,
          cardMessageId: action.messageId,
          result: result.status,
        });
        return buildTaskStatusCard({
          key: stopTask.key,
          runId: stopTask.runId,
          status,
          phase: result.message,
        });
      }
      const resumePage = parseResumePageActionValue(action.value);
      if (resumePage) {
        const page = await conversations.listResumeSessions(resumePage.key, resumePage.scope, resumePage.page);
        return buildResumeCard(page);
      }
      const resumeSelect = parseResumeSelectActionValue(action.value);
      if (resumeSelect) {
        await conversations.resumeConversation(resumeSelect.key, resumeSelect.sessionPath, async (reply) => {
          await transport?.replyText(action.messageId, reply);
        });
        const page = await conversations.listResumeSessions(resumeSelect.key, resumeSelect.scope, resumeSelect.page);
        return buildResumeCard(page);
      }
      const selected = parseModelActionValue(action.value);
      if (!selected) return;
      await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const models = await conversations.getAvailableModels();
      const currentModel = await conversations.getSelectedModel(selected.key);
      return buildModelCard(selected.key, models, currentModel);
    });
    try {
      await transport.start();
      gatewayLock.startHeartbeat();
      await gatewayLock.update("connected");
      updateStatus("connected");
      // 预热模型列表,避免第一次命令调用时等待 provider 超时
      conversations.warmupModels().catch(() => undefined);

      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      await gatewayLock.release();
      gatewayLock = undefined;
      transport = undefined;
      throw error;
    }
  }

  async function stop() {
    await transport?.stop();
    transport = undefined;
    await rpcWorkers?.disposeAll();
    await gatewayLock?.release();
    gatewayLock = undefined;
    updateStatus(loadConfig() ? "disconnected" : "not configured");
  }

  function formatOwner(owner: GatewayOwner | undefined) {
    if (!owner) return "none";
    return `pid=${owner.pid}, status=${owner.status}, startedAt=${owner.startedAt}, heartbeatAt=${owner.heartbeatAt}, cwd=${owner.cwd}`;
  }

  function notifyDaemonStartResult(ctx: any, result: Awaited<ReturnType<typeof startDaemon>>) {
    if (result.status === "busy") {
      ctx.ui.notify(withBuildTag(`飞书连接已在后台运行。\n${formatOwner(result.owner)}`), "info");
      return;
    }
    ctx.ui.notify(withBuildTag(`飞书连接已启动。\nGateway pid=${result.pid}\nLog: ${DAEMON_LOG_PATH}`), "info");
  }

  function formatStartError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    let cause = "未知启动错误";
    if (lower.includes("missing config")) cause = "配置文件不存在或无效";
    else if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("im:message")) cause = "飞书权限不足";
    else if (lower.includes("model") || lower.includes("provider") || lower.includes("auth")) cause = "模型或模型凭据不可用";
    else if (lower.includes("omp cli") || lower.includes("could not locate")) cause = "找不到 OMP CLI";
    else if (lower.includes("supervisor")) cause = "supervisor 启动失败";
    else if (lower.includes("connect") || lower.includes("gateway")) cause = "飞书网关连接失败";
    return `启动失败：${cause}\n${message}\n请运行 /feishu doctor，并查看日志：${DAEMON_LOG_PATH}`;
  }

  function pluginVersion() {
    if (process.env.FEISHU_PLUGIN_VERSION) return process.env.FEISHU_PLUGIN_VERSION;
    try {
      const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      return typeof manifest.version === "string" ? manifest.version : "unknown";
    } catch {
      return "unknown";
    }
  }

  function versionReport() {
    const omp = spawnSync(ompCliPath, ["--version"], { encoding: "utf8", timeout: 5_000 });
    const ompVersion = omp.status === 0 ? `${omp.stdout || omp.stderr}`.trim() : "unavailable";
    return [
      `Feishu plugin: ${pluginVersion()}`,
      `OMP: ${ompVersion || "unknown"}`,
      `Bun: ${process.versions.bun || process.version}`,
      `Agent dir: ${getAgentDir()}`,
      `Workspace: ${process.cwd()}`,
      `Config: ${CONFIG_PATH}`,
    ].join("\n");
  }

  async function doctorReport() {
    const cfg = loadConfig();
    const owner = gatewayLock?.owner || readGatewayOwner();
    const supervisorPid = readPidFile(SUPERVISOR_PID_PATH);
    const models = await conversations.getAvailableModels().catch(() => []);
    const checks = [
      `${cfg ? "OK" : "FAIL"} config: ${cfg ? CONFIG_PATH : "missing; run /feishu setup"}`,
      `${existsSync(ompCliPath) ? "OK" : "FAIL"} omp cli: ${ompCliPath}`,
      `${owner?.status === "connected" ? "OK" : "WARN"} gateway: ${owner ? formatOwner(owner) : "not running"}`,
      `${supervisorPid && processExists(supervisorPid) ? "OK" : "WARN"} supervisor: ${supervisorPid || "not running"}`,
      `${models.length ? "OK" : "FAIL"} models: ${models.length ? `${models.length} available` : "none available; check models.yml/auth"}`,
      `${existsSync(process.cwd()) ? "OK" : "FAIL"} workspace: ${process.cwd()}`,
      `logs: ${DAEMON_LOG_PATH}`,
    ];
    return [`Feishu doctor`, `version: ${pluginVersion()}`, ...checks].join("\n");
  }

  function daemonSpec() {
    const extensionPath = fileURLToPath(import.meta.url);
    const args = [
      ompCliPath,
      "--mode", "rpc",
      "--no-extensions",
      "--no-skills",
      "-e", extensionPath,
    ];
    const supervisorPath = join(dirname(extensionPath), "..", "support", "feishu-supervisor.mjs");
    const bunBin = process.execPath;
    return { extensionPath, args, supervisorPath, bunBin };
  }

  async function startDaemon(takeover = false) {
    return withDaemonSpawnLock(async () => {
      const cfg = loadConfig();
      if (!cfg) throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
      let owner = readGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      if (owner?.pid === process.pid || transport?.isRunning()) {
        await stop();
      } else if (owner && takeover) {
        const supervisorPid = readPidFile(SUPERVISOR_PID_PATH);
        if (supervisorPid) {
          writeFileSync(SUPERVISOR_STOP_PATH, `${Date.now()}\n`, "utf8");
          if (!await waitForProcessExit(supervisorPid, 15_000)) throw new Error(`Supervisor ${supervisorPid} did not stop`);
          await waitForPathRemoval(SUPERVISOR_PID_PATH, 2_000);
        }
        else try { process.kill(owner.pid, "SIGTERM"); } catch {}
        if (!await waitForProcessExit(owner.pid, 10_000)) throw new Error(`Gateway owner ${owner.pid} did not stop`);
      }

      // Re-check while holding the spawn lock. Another TUI may have started it
      // while this process was waiting for the lock.
      owner = readGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      ensureRoot();
      const spec = daemonSpec();
      const launchToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (!existsSync(spec.supervisorPath)) throw new Error(`Feishu supervisor is missing: ${spec.supervisorPath}`);
      const child = spawn(spec.bunBin, [
        spec.supervisorPath,
        "--cwd", process.cwd(),
        "--log", DAEMON_LOG_PATH,
        "--pid", SUPERVISOR_PID_PATH,
        "--stop", SUPERVISOR_STOP_PATH,
        "--",
        spec.bunBin,
        ...spec.args,
      ], {
        detached: true,
        cwd: process.cwd(),
        env: { ...process.env, FEISHU_LAUNCH_TOKEN: launchToken },
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      const connectedOwner = await waitForGatewayConnection(launchToken, daemonStartTimeoutMs());
      if (!connectedOwner) {
        throw new Error(`Feishu gateway did not connect. Read the log: ${DAEMON_LOG_PATH}`);
      }
      return { status: "started" as const, pid: connectedOwner.pid, owner: connectedOwner };
    });
  }

  async function stopDaemon() {
    const owner = readGatewayOwner();
    if (owner?.pid === process.pid) {
      await stop();
      return { status: "stopped-current" as const };
    }
    try {
      const supervisorPid = readPidFile(SUPERVISOR_PID_PATH);
      if (supervisorPid) {
        writeFileSync(SUPERVISOR_STOP_PATH, `${Date.now()}\n`, "utf8");
        if (!await waitForProcessExit(supervisorPid, 15_000)) throw new Error(`Supervisor ${supervisorPid} did not stop`);
        await waitForPathRemoval(SUPERVISOR_PID_PATH, 2_000);
      }
      else if (owner?.pid) process.kill(owner.pid, "SIGTERM");
      else return { status: "none" as const };
      if (owner?.pid && !await waitForProcessExit(owner.pid, 10_000)) throw new Error(`Gateway owner ${owner.pid} did not stop`);
      return { status: "stopped" as const, owner };
    } catch (error) {
      return { status: "error" as const, owner, error };
    }
  }

  async function restartDaemon() {
    const stopped = await stopDaemon();
    if (stopped.status === "error") return { status: "error" as const, stopped };
    const started = await startDaemon(true);
    return { status: "restarted" as const, stopped, started };
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark: setup, start, stop, restart, refresh, status, doctor, version, debug, autostart, reset",
    getArgumentCompletions: (prefix) => {
      const commands = ["setup", "start", "stop", "restart", "refresh", "status", "doctor", "version", "debug", "autostart", "reset"];
      const query = prefix.trim().toLowerCase();
      return commands
        .filter((command) => command.startsWith(query))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const [cmdRaw] = args.trim().toLowerCase().split(/\s+/, 1);
      const cmd = cmdRaw || "status";
      try {
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            writeJson(CONFIG_PATH, configToStart);
            notifyDaemonStartResult(ctx, await startDaemon(false));
          }
          refreshStatusFromState();
          return;
        }
        if (cmd === "start") {
          try {
            notifyDaemonStartResult(ctx, await startDaemon(false));
          } catch (error) {
            ctx.ui.notify(formatStartError(error), "error");
          }
          refreshStatusFromState();
          return;
        }
        if (cmd === "stop") {
          const result = await stopDaemon();
          if (result.status === "error") {
            ctx.ui.notify(`停止飞书连接失败：${result.error instanceof Error ? result.error.message : String(result.error)}\nOwner: ${formatOwner(result.owner)}`, "error");
            refreshStatusFromState();
            return;
          }
          ctx.ui.notify(result.status === "none" ? "飞书连接未在运行。" : "飞书连接已停止。", "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "restart") {
          let result;
          try {
            result = await restartDaemon();
          } catch (error) {
            ctx.ui.notify(formatStartError(error), "error");
            refreshStatusFromState();
            return;
          }
          if (result.status === "error") {
            const stopped = result.stopped;
            ctx.ui.notify(`飞书连接重启失败：${stopped.error instanceof Error ? stopped.error.message : String(stopped.error)}\nOwner: ${formatOwner(stopped.owner)}`, "error");
            refreshStatusFromState();
            return;
          }
          ctx.ui.notify(`飞书连接已重启，最新代码和配置已生效。\nOwner: ${formatOwner(result.started.owner)}\nLog: ${DAEMON_LOG_PATH}`, "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "reset") {
          const ok = await uiConfirm(
            ctx,
            "确认重置飞书扩展？会删除配置和会话映射，但保留所有会话历史。 / Reset Feishu extension? This deletes config and conversation mappings, but keeps all session history.",
            false,
          );
          if (!ok) {
            ctx.ui.notify("Reset cancelled / 已取消重置", "info");
            return;
          }
          await stopDaemon();
          removePath(CONFIG_PATH);
          removePath(STATE_PATH);
          removePath(DEDUPE_PATH);
          removePath(`${DEDUPE_PATH}.lock`);
          removePath(BRIDGE_PATH);
          conversations.resetMemory();
          messageHandler.reset();
          ensureRoot();
          updateStatus("not configured");
          ctx.ui.notify(
            "Feishu extension reset. Session history was kept. Run /feishu setup. / 飞书扩展已重置，会话历史已保留，请运行 /feishu setup。",
            "info",
          );
          refreshStatusFromState();
          return;
        }
        if (cmd === "refresh") {
          await conversations.refreshModels();
          const cfg = loadConfig();
          const owner = gatewayLock?.owner || readGatewayOwner();
          ctx.ui.notify(
            [
              `模型列表已刷新。`,
              `Owner: ${formatOwner(owner)}`,
              `Log: ${DAEMON_LOG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "doctor") {
          ctx.ui.notify(await doctorReport(), "info");
          return;
        }
        if (cmd === "version") {
          ctx.ui.notify(versionReport(), "info");
          return;
        }
        if (cmd === "status") {
          refreshStatusFromState();
          const cfg = loadConfig();
          const owner = gatewayLock?.owner || readGatewayOwner();
          ctx.ui.notify(
            [
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Gateway owner: ${formatOwner(owner)}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PATH}`,
              `Gateway lock: ${gatewayLockPath()}`,
              `Debug: ${DEBUG_LOG_PATH}`,
              `Gateway log: ${DAEMON_LOG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "debug") {
          if (!existsSync(DEBUG_LOG_PATH)) {
            ctx.ui.notify("还没有飞书调试日志。请先在飞书里发一条消息给机器人。", "info");
            return;
          }
          const lines = readFileSync(DEBUG_LOG_PATH, "utf8").trim().split("\n").slice(-20);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (cmd === "autostart") {
          const cfg = loadConfig();
          if (!cfg) {
            ctx.ui.notify("Missing config. Run /feishu setup first.", "warning");
            return;
          }
          cfg.autoStart = cfg.autoStart === false;
          writeJson(CONFIG_PATH, cfg);
          ctx.ui.notify(cfg.autoStart ? "飞书自动启动已开启。" : "飞书自动启动已关闭。", "info");
          refreshStatusFromState();
          return;
        }
        ctx.ui.notify("可用命令：/feishu setup | start | stop | restart | refresh | status | doctor | version | debug | autostart | reset", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    uiRef = ctx.ui as any;
    startStatusRefresh();
  });

  if (bootConfig && bootConfig.autoStart !== false) {
    if (process.env.PI_FEISHU_DAEMON === "1") {
      start().then((result) => {
        if (typeof result === "object" && result.status === "owned") {
          console.error("[feishu] daemon found existing owner, exiting:", formatOwner(result.owner));
          process.exit(0);
        }
      }).catch((error) => {
        updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
        console.error("[feishu] daemon autoStart failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
    } else {
      startDaemon(false).catch((error) => {
        updateStatus("disconnected");
        console.error("[feishu] daemon spawn failed:", error instanceof Error ? error.message : error);
      });
    }
  }

  // daemon 里监听 models.yml 变化,自动刷新模型列表
  if (process.env.PI_FEISHU_DAEMON === "1") {
    const modelsPath = join(getAgentDir(), "models.yml");
    if (existsSync(modelsPath)) {
      let debounce: NodeJS.Timeout | null = null;
      const modelsName = basename(modelsPath);
      watch(dirname(modelsPath), (_eventType, filename) => {
        if (filename && filename.toString() !== modelsName) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.error("[feishu] models.yml changed, refreshing...");
          conversations.refreshModels().catch((err) =>
            console.error("[feishu] refresh failed:", err),
          );
        }, 1000);
      });
    }
  }

  pi.on("session_shutdown", async () => {
    await stop();
    await flushDebugLog();
    clearStatus();
  });
}

function resolveOmpCliPath() {
  if (process.env.OMP_CLI_PATH) return process.env.OMP_CLI_PATH;
  const candidates = [
    join(dirname(process.execPath), "..", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
    process.env.OMP_BIN_PATH ? join(dirname(process.env.OMP_BIN_PATH), "..", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js") : "",
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error("Could not locate the OMP CLI. Reinstall OMP or set OMP_CLI_PATH.");
}

function parseCopyMarkdownActionValue(value: unknown): { copySourceId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_copy_markdown") return undefined;
  if (typeof raw.copySourceId !== "string" || !raw.copySourceId) return undefined;
  return { copySourceId: raw.copySourceId };
}

function readPidFile(path: string) {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(100);
  }
  return false;
}

async function waitForGatewayConnection(launchToken: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owner = readGatewayOwner();
    if (owner?.status === "connected" && owner.launchToken === launchToken) return owner;
    await sleep(250);
  }
  return undefined;
}

async function withDaemonSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${gatewayLockPath()}.spawn.lock`;
  const lease = await acquireFileLease(lockPath);
  try { return await fn(); } finally { releaseFileLease(lease); }
}

async function waitForPathRemoval(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for cleanup: ${path}`);
}

function daemonStartTimeoutMs() {
  const seconds = Number.parseInt(process.env.OMP_FEISHU_TIMEOUT || "", 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
