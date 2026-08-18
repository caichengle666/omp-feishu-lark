import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { buildModelCard, buildResumeCard, isAuthorizedCardAction, parseModelActionValue, parseResumePageActionValue, parseResumeSelectActionValue } from "./cards.js";
import { isSupervisorProcessAlive, readSupervisorRecord, recordedProcessStatus, writeStopRequest } from "../support/feishu-supervisor.mjs";
import { BRIDGE_PATH, CONFIG_PATH, DAEMON_LOG_PATH, DEBUG_LOG_PATH, DEDUPE_PATH, ensureRoot, isFeishuAdmin, loadConfig, mask, readJson, removePath, STATE_PATH, SUPERVISOR_PID_PATH, SUPERVISOR_STOP_PATH, UPGRADE_NOTICE_PATH, writeJson } from "./config.js";
import { debugLog, flushDebugLog } from "./debug.js";
import { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { FeishuBridgeStore } from "./bridge-store.js";
import { ConversationManager } from "./conversation-manager.js";
import { FeishuRpcWorkerPool } from "./rpc-worker-pool.js";
import { FeishuDelivery } from "./delivery.js";
import { feishuHelpText } from "./help.js";
import { FeishuNotificationWebhook } from "./notification-webhook.js";
import { acquireFileLease, acquireGatewayLock, gatewayLockPath, readGatewayOwner, releaseFileLease, type GatewayLockHandle, type GatewayOwner } from "./gateway-lock.js";
import { FeishuMessageHandler } from "./message-handler.js";
import { runSetup, uiConfirm } from "./setup.js";
import { buildTaskStatusCard, parseStopTaskActionValue } from "./task-status-card.js";
import { bunDnsArgs, compareVersions, registryNetworkAttempts, resolveTargetVersion, resolveUpgradeNetworkPolicy, upgradeNetworkAttempts, upgradeTimeoutMs } from "./upgrade.js";
import { BotUnavailableError, FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuStatus } from "./types.js";

type UpgradeNoticeTarget = {
  chatId: string;
  messageId?: string;
  sessionKey?: string;
  chatType?: string;
};

type UpgradeNotice = {
  from?: string;
  to?: string;
  targets?: UpgradeNoticeTarget[];
  at?: string;
  chatId?: string;
  sessionKey?: string;
};

export default function feishuExtension(pi: ExtensionAPI) {
  let transport: FeishuTransport | undefined;
  let notificationWebhook: FeishuNotificationWebhook | undefined;
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
    promptTimeoutEnabled: bootConfig?.promptTimeoutEnabled,
  }, rpcWorkers);
  const messageHandler = new FeishuMessageHandler(conversations, () => transport, bridgeStore, {
    doctor: (detailed = true) => doctorReport(detailed),
    version: (detailed = true) => versionReport(detailed),
    upgrade: (version, target, onProgress) => requestUpgrade(version || "", target, onProgress),
    upgradeTimeoutSeconds: Math.round(upgradeTimeoutMs(process.env.OMP_FEISHU_UPGRADE_TIMEOUT_SEC) / 1000),
    isAdmin: (openId: string) => isFeishuAdmin(loadConfig(), openId),
    status: (detailed = true) => statusReport(detailed),
    debug: () => debugReport(),
    refresh: () => refreshReport(),
    config: () => configReport(),
  });

  const STATUS_KEY = "feishu-connection";
  const STATUS_REFRESH_MS = 2_000;
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void; notify?: (message: string, level?: string) => void } | undefined;
  let lastStatusText: string | undefined;
  let statusRefreshTimer: NodeJS.Timeout | undefined;
  const buildTag = process.env.FEISHU_EXT_DEV === "1" ? " [DEV]" : "";
  let upgradeInFlight = false;

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

  function statusReport(detailed = true) {
    refreshStatusFromState();
    const cfg = loadConfig();
    const owner = gatewayLock?.owner || readGatewayOwner();
    if (!detailed) {
      return [
        `Status: ${lastStatusText || (cfg ? "Feishu: disconnected" : "Feishu: not configured")}`,
        `Feishu plugin: ${pluginVersion()}`,
      ].join("\n");
    }
    return [
      `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
      `Gateway owner: ${formatOwner(owner)}`,
      `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
      `Notification webhook: ${cfg?.notificationWebhookEnabled ? (notificationWebhook?.getEndpointLabel() || "enabled; check daemon owner") : "disabled"}`,
      `Path: ${CONFIG_PATH}`,
      `Gateway lock: ${gatewayLockPath()}`,
      `Debug: ${DEBUG_LOG_PATH}`,
      `Gateway log: ${DAEMON_LOG_PATH}`,
    ].join("\n");
  }

  async function refreshReport() {
    await conversations.refreshModels();
    const owner = gatewayLock?.owner || readGatewayOwner();
    return [`模型列表已刷新。`, `Owner: ${formatOwner(owner)}`, `Log: ${DAEMON_LOG_PATH}`].join("\n");
  }

  function debugReport() {
    if (!existsSync(DEBUG_LOG_PATH)) return "还没有飞书调试日志。请先在飞书里发一条消息给机器人。";
    const lines = readFileSync(DEBUG_LOG_PATH, "utf8").trim().split("\n").slice(-20);
    return lines.join("\n");
  }

  function configReport() {
    const cfg = loadConfig();
    if (!cfg) return "配置不存在。请运行 /feishu setup。";
    return [
      "Feishu config",
      `Domain: ${cfg.domain}`,
      `App ID: ${mask(cfg.appId)}`,
      `App secret: ${cfg.appSecret ? "configured" : "missing"}`,
      `Group policy: ${cfg.groupPolicy}`,
      `Admins: ${(cfg.adminOpenIds || []).join(", ") || "none"}`,
      `Auto start: ${cfg.autoStart !== false ? "on" : "off"}`,
      `Prompt notice: ${cfg.promptNotifySec || 0}s`,
      `Notification webhook: ${cfg.notificationWebhookEnabled ? "enabled" : "disabled"}`,
      `Config path: ${CONFIG_PATH}`,
    ].join("\n");
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
    let lockResult = await acquireGatewayLock(process.cwd(), Boolean(options.takeover));
    // Daemon startup races the previous daemon winding down after an upgrade
    // replaces the plugin files: the old process owns the lock until its exit.
    // Instead of exiting immediately (supervisor restart loop / false "found
    // existing owner"), poll for the stale owner to release ownership so the
    // switch converges in one generation.
    if (lockResult.status === "busy" && process.env.PI_FEISHU_DAEMON === "1" && !options.takeover) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await sleep(1_000);
        lockResult = await acquireGatewayLock(process.cwd(), false);
        if (lockResult.status === "acquired") break;
      }
    }
    if (lockResult.status === "busy") {
      updateStatus("owned");
      return { status: "owned" as const, owner: lockResult.owner };
    }
    gatewayLock = lockResult.handle;
    gatewayLock.setOnLost(async () => {
      await notificationWebhook?.stop();
      notificationWebhook = undefined;
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
        if (!isAuthorizedCardAction(stopTask, action)) {
          debugLog("feishu.card.stop_denied", { cardMessageId: action.messageId, operatorOpenId: action.operatorOpenId });
          return;
        }
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
          ownerOpenId: stopTask.ownerOpenId,
          chatId: stopTask.chatId,
        });
      }
      const resumePage = parseResumePageActionValue(action.value);
      if (resumePage) {
        if (!isAuthorizedCardAction(resumePage, action)) {
          debugLog("feishu.card.resume_denied", { cardMessageId: action.messageId, operatorOpenId: action.operatorOpenId });
          return;
        }
        const page = await conversations.listResumeSessions(resumePage.key, resumePage.scope, resumePage.page);
        return buildResumeCard(page, resumePage.ownerOpenId, resumePage.chatId);
      }
      const resumeSelect = parseResumeSelectActionValue(action.value);
      if (resumeSelect) {
        if (!isAuthorizedCardAction(resumeSelect, action)) {
          debugLog("feishu.card.resume_denied", { cardMessageId: action.messageId, operatorOpenId: action.operatorOpenId });
          return;
        }
        await conversations.resumeConversation(resumeSelect.key, resumeSelect.sessionPath, async (reply) => {
          await transport?.replyText(action.messageId, reply);
        });
        const page = await conversations.listResumeSessions(resumeSelect.key, resumeSelect.scope, resumeSelect.page);
        return buildResumeCard(page, resumeSelect.ownerOpenId, resumeSelect.chatId);
      }
      const selected = parseModelActionValue(action.value);
      if (!selected) return;
      if (!isAuthorizedCardAction(selected, action)) {
        debugLog("feishu.card.model_denied", { cardMessageId: action.messageId, operatorOpenId: action.operatorOpenId });
        return;
      }
      await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const models = await conversations.getAvailableModels();
      const currentModel = await conversations.getSelectedModel(selected.key);
      return buildModelCard(selected.key, models, currentModel, selected.ownerOpenId, selected.chatId);
    });
    try {
      await transport.start();
      if (cfg.notificationWebhookEnabled) {
        notificationWebhook = new FeishuNotificationWebhook(cfg, bridgeStore, delivery);
        await notificationWebhook.start();
      }
      gatewayLock.startHeartbeat();
      await gatewayLock.update("connected");
      updateStatus("connected");
      // 预热模型列表,避免第一次命令调用时等待 provider 超时
      conversations.warmupModels().catch(() => undefined);
      if (process.env.PI_FEISHU_DAEMON === "1") {
        await deliverUpgradeNotice().catch((error) => {
          console.error("[feishu] upgrade notice delivery failed:", error instanceof Error ? error.message : error);
        });
      }

      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      await notificationWebhook?.stop().catch(() => undefined);
      notificationWebhook = undefined;
      await transport?.stop().catch(() => undefined);
      await gatewayLock.release();
      gatewayLock = undefined;
      transport = undefined;
      throw error;
    }
  }

  async function stop() {
    await notificationWebhook?.stop();
    notificationWebhook = undefined;
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

  function runtimePackageVersion() {
    try {
      const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      if (typeof manifest.version === "string" && manifest.version) return manifest.version;
    } catch {}
    return undefined;
  }

  function pluginVersion() {
    if (process.env.FEISHU_PLUGIN_VERSION) return process.env.FEISHU_PLUGIN_VERSION;
    const runtimeVersion = runtimePackageVersion();
    if (runtimeVersion) return runtimeVersion;
    try {
      const lockPath = join(getAgentDir(), "..", "plugins", "omp-plugins.lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      const version = lock?.plugins?.["@caichengle/omp-feishu-lark"]?.version;
      if (typeof version === "string" && version) return version;
    } catch {}
    return "unknown";
  }

  async function deliverUpgradeNotice() {
    if (!existsSync(UPGRADE_NOTICE_PATH) || !transport) return;
    const notice = readJson<UpgradeNotice>(UPGRADE_NOTICE_PATH, {});
    if (!notice.from || !notice.to) return;
    const targets = notice.targets?.length
      ? notice.targets
      : notice.chatId
        ? [{ chatId: notice.chatId, sessionKey: notice.sessionKey }]
        : [];
    if (!targets.length) {
      removePath(UPGRADE_NOTICE_PATH);
      return;
    }

    const reportedVersion = pluginVersion();
    const packageVersion = runtimePackageVersion() || "unknown";
    const healthy = reportedVersion === notice.to && packageVersion === notice.to && transport.isRunning();
    const doctor = await doctorReport().catch((error) => `Feishu doctor failed: ${error instanceof Error ? error.message : String(error)}`);
    const text = [
      healthy ? `升级自检通过：${notice.from} → ${notice.to}` : `升级自检失败：目标 ${notice.to}，当前 ${reportedVersion}`,
      `Runtime package: ${packageVersion}`,
      doctor,
    ].join("\n");
    const failed: UpgradeNoticeTarget[] = [];
    for (const target of targets) {
      try {
        if (target.messageId) await transport.replyText(target.messageId, text);
        else await transport.sendText(target.chatId, text);
      } catch {
        failed.push(target);
      }
    }
    if (failed.length) writeJson(UPGRADE_NOTICE_PATH, { ...notice, targets: failed });
    else removePath(UPGRADE_NOTICE_PATH);
  }

  function versionReport(detailed = true) {
    const omp = spawnSync(ompCliPath, ["--version"], { encoding: "utf8", timeout: 5_000 });
    const ompVersion = omp.status === 0 ? `${omp.stdout || omp.stderr}`.trim() : "unavailable";
    const report = [
      `Feishu plugin: ${pluginVersion()}`,
      `OMP: ${ompVersion || "unknown"}`,
      `Bun: ${process.versions.bun || process.version}`,
    ];
    if (detailed) report.push(`Agent dir: ${getAgentDir()}`, `Workspace: ${process.cwd()}`, `Config: ${CONFIG_PATH}`);
    return report.join("\n");
  }

  async function doctorReport(detailed = true) {
    const cfg = loadConfig();
    const owner = gatewayLock?.owner || readGatewayOwner();
    const supervisor = readSupervisorRecord(SUPERVISOR_PID_PATH);
    const supervisorRunning = supervisor ? isSupervisorProcessAlive(supervisor) : false;
    const models = await conversations.getAvailableModels().catch(() => []);
    if (!detailed) {
      return [
        "Feishu doctor",
        `version: ${pluginVersion()}`,
        `${cfg ? "OK" : "FAIL"} config`,
        `${owner?.status === "connected" ? "OK" : "WARN"} gateway`,
        `${supervisorRunning ? "OK" : "WARN"} supervisor`,
        `${models.length ? "OK" : "FAIL"} models: ${models.length} available`,
      ].join("\n");
    }
    const checks = [
      `${cfg ? "OK" : "FAIL"} config: ${cfg ? CONFIG_PATH : "missing; run /feishu setup"}`,
      `${existsSync(ompCliPath) ? "OK" : "FAIL"} omp cli: ${ompCliPath}`,
      `${owner?.status === "connected" ? "OK" : "WARN"} gateway: ${owner ? formatOwner(owner) : "not running"}`,
      `${supervisorRunning ? "OK" : "WARN"} supervisor: ${supervisor ? `pid=${supervisor.pid}` : "not running"}`,
      `${models.length ? "OK" : "FAIL"} models: ${models.length ? `${models.length} available` : "none available; check models.yml/auth"}`,
      `${cfg?.notificationWebhookEnabled ? (notificationWebhook ? "OK" : "WARN") : "OK"} notification webhook: ${cfg?.notificationWebhookEnabled ? (notificationWebhook?.getEndpointLabel() || "enabled but not running") : "disabled"}`,
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
        let stoppedSupervisor = false;
        const supervisor = readSupervisorRecord(SUPERVISOR_PID_PATH);
        if (supervisor && isSupervisorProcessAlive(supervisor)) {
          writeStopRequest(SUPERVISOR_STOP_PATH, supervisor);
          if (!await waitForSupervisorExit(supervisor, 15_000)) throw new Error(`Supervisor ${supervisor.pid} did not stop`);
          await waitForPathRemoval(SUPERVISOR_PID_PATH, 2_000);
          stoppedSupervisor = true;
        } else if (owner?.pid) {
          stopVerifiedGatewayOwner(owner);
        }
        if (!stoppedSupervisor && owner?.pid && !await waitForProcessExit(owner.pid, 10_000)) throw new Error(`Gateway owner ${owner.pid} did not stop`);
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
      let stoppedSupervisor = false;
      const supervisor = readSupervisorRecord(SUPERVISOR_PID_PATH);
      if (supervisor && isSupervisorProcessAlive(supervisor)) {
        writeStopRequest(SUPERVISOR_STOP_PATH, supervisor);
        if (!await waitForSupervisorExit(supervisor, 15_000)) throw new Error(`Supervisor ${supervisor.pid} did not stop`);
        await waitForPathRemoval(SUPERVISOR_PID_PATH, 2_000);
        stoppedSupervisor = true;
      } else if (owner?.pid) stopVerifiedGatewayOwner(owner);
      else return { status: "none" as const };
      if (!stoppedSupervisor && owner?.pid && !await waitForProcessExit(owner.pid, 10_000)) throw new Error(`Gateway owner ${owner.pid} did not stop`);
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

  async function requestUpgrade(targetVersion: string, noticeTarget?: UpgradeNoticeTarget, onProgress?: (phase: string) => void): Promise<string> {
    if (upgradeInFlight) return "已有升级任务正在执行，请等待升级完成通知。";
    upgradeInFlight = true;
    try {
      return await upgradeDaemon(targetVersion, noticeTarget, onProgress);
    } finally {
      upgradeInFlight = false;
    }
  }

async function upgradeDaemon(targetVersion: string, noticeTarget?: UpgradeNoticeTarget, onProgress?: (phase: string) => void): Promise<string> {
    const current = pluginVersion();
    const spec = daemonSpec();
    const networkPolicy = resolveUpgradeNetworkPolicy(process.env.OMP_FEISHU_NETWORK);
    let dnsArgs = bunDnsArgs(networkPolicy);
    let target: string;
    {
      let latest: string | undefined;
      if (!targetVersion) {
        onProgress?.("正在查询 npm 最新版本");
        const failures: string[] = [];
        const queryScript = 'fetch("https://registry.npmjs.org/@caichengle/omp-feishu-lark/latest").then(async r=>{if(!r.ok) throw new Error(`HTTP ${r.status}`); const j=await r.json(); if(typeof j.version!=="string") throw new Error("missing version"); console.log(j.version)})';
        for (const attemptArgs of registryNetworkAttempts(networkPolicy)) {
          const result = await runProcess(spec.bunBin, [...attemptArgs, "-e", queryScript], {
            timeout: 30_000,
            cwd: process.cwd(),
            env: { ...process.env },
          });
          const candidate = result.stdout.trim().split(/\r?\n/).pop();
          if (result.code === 0 && candidate) {
            latest = candidate;
            dnsArgs = attemptArgs;
            break;
          }
          failures.push((result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`).trim().split(/\r?\n/).pop() || "unknown error");
        }
        if (!latest) {
          throw new Error(`无法查询 npm registry（network=${networkPolicy}）：${failures.join(" | ")}。可设置 OMP_FEISHU_NETWORK=ipv4 或 ipv6 后重试。`);
        }
      }
      const resolved = resolveTargetVersion(targetVersion, latest);
      if (resolved.ok === false) {
        throw new Error(resolved.reason);
      }
      target = resolved.version;
    }
    if (target === current) {
      return `当前已是最新版本 ${current}，无需升级。`;
    }
    if (compareVersions(target, current) < 0) {
      return `目标版本 ${target} 低于当前版本 ${current}，拒绝降级。`;
    }
    onProgress?.(`已确认 v${target}，正在下载并安装`);
    // 从自身入口自动定位真实安装目录，不依赖 cwd、环境变量或人工传参。
    const pluginDir = dirname(dirname(spec.extensionPath));
    // --no-restart：安装器只替换文件，不重启 daemon（避免 90s 超时与残留进程）。
    // 装完校验 exit 0 后再由本进程触发重启（TUI: restartDaemon；daemon 内: 退出交给 supervisor 拉起）。
    let installed = false;
    const installFailures: string[] = [];
    for (const attemptArgs of upgradeNetworkAttempts(networkPolicy, dnsArgs)) {
      const args = [...attemptArgs, "x", `@caichengle/omp-feishu-lark@${target}`, pluginDir, "--no-restart"];
      try {
        const result = await runProcess(spec.bunBin, args, {
          timeout: upgradeTimeoutMs(process.env.OMP_FEISHU_UPGRADE_TIMEOUT_SEC),
          cwd: process.cwd(),
          env: { ...process.env },
        });
        if (result.code === 0) {
          installed = true;
          break;
        }
        installFailures.push((result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`).trim().split("\n").pop() || "unknown error");
      } catch (error) {
        installFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!installed) {
      throw new Error(`升级安装失败（network=${networkPolicy}）：${installFailures.join(" | ") || "安装器未返回错误详情"}`);
    }
    onProgress?.("安装完成，正在重启飞书服务");
    if (process.env.PI_FEISHU_DAEMON === "1") {
      // 升级前记录通知目标：找最近活跃的 p2p 会话，新 daemon 启动连上 WS 后
      // 会读 upgrade-notice.json 给这个会话补发"升级完成"消息 —— 不补，用户只能死等。
      try {
        let targetForNotice = noticeTarget;
        if (!targetForNotice) {
          const routes = readJson<{ routes?: Record<string, UpgradeNoticeTarget & { updatedAt?: number }> }>(BRIDGE_PATH, { routes: {} }).routes || {};
          targetForNotice = Object.values(routes)
            .filter((route) => Boolean(route.chatId))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        }
        if (targetForNotice?.chatId) {
          writeJson(UPGRADE_NOTICE_PATH, {
            from: current,
            to: target,
            targets: [targetForNotice],
            at: new Date().toISOString(),
          } satisfies UpgradeNotice);
        }
      } catch {}
      // daemon 内：文件已换。先返回（飞书回执发出），稍后主动释放
      // gateway lock / 停 WS 再退出，由 supervisor 自动拉起新版 daemon。
      // 不靠 setTimeout 硬退 —— 硬退若被阻塞会导致新旧 daemon 并存。
      queueMicrotask(() => {
        void (async () => {
          await sleep(1500);
          try { await stop(); } catch {}
          await flushDebugLog();
          process.exit(0);
        })();
      });
      return `升级文件已就绪（${current} → ${target}），正在重启服务…`;
    }
    const restarted = await restartDaemon();
    if (restarted.status === "error") {
      const detail = restarted.stopped.error instanceof Error ? restarted.stopped.error.message : String(restarted.stopped.error);
      throw new Error(`升级文件已安装，但飞书服务重启失败：${detail}。请运行 /feishu start 或 /feishu doctor。`);
    }
    return `升级完成：${current} → ${pluginVersion()}，服务已重启。`;
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark: help, setup, start, stop, restart, refresh, status, config, doctor, version, debug, autostart, upgrade, reset",
    getArgumentCompletions: (prefix) => {
      const commands = ["help", "setup", "start", "stop", "restart", "refresh", "status", "config", "doctor", "version", "debug", "autostart", "upgrade", "reset"];
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
        if (cmd === "help") {
          ctx.ui.notify(feishuHelpText(), "info");
          return;
        }
        if (cmd === "setup") {
          const previousConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : undefined;
          const setup = await runSetup(ctx);
          const hadRunningGateway = Boolean(transport?.isRunning() || readGatewayOwner());
          writeJson(CONFIG_PATH, setup.config);
          if (setup.startNow) {
            try {
              if (hadRunningGateway) {
                const result = await restartDaemon();
                if (result.status === "error") throw result.stopped.error;
                ctx.ui.notify(`飞书配置已更新，连接已重启。\nOwner: ${formatOwner(result.started.owner)}`, "info");
              } else {
                notifyDaemonStartResult(ctx, await startDaemon(false));
              }
            } catch (error) {
              if (previousConfig === undefined) removePath(CONFIG_PATH);
              else writeFileSync(CONFIG_PATH, previousConfig, "utf8");
              if (hadRunningGateway) await startDaemon(true).catch(() => undefined);
              throw new Error(`新配置启动失败，已恢复原配置：${error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            ctx.ui.notify(`飞书配置已保存。\nPath: ${CONFIG_PATH}\nApp ID: ${mask(setup.config.appId)}`, "info");
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
        if (cmd === "upgrade") {
          const [, targetVersion] = args.trim().split(/\s+/, 2);
          try {
            const report = await requestUpgrade(targetVersion || "");
            ctx.ui.notify(report, "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
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
          const stopped = await stopDaemon();
          if (stopped.status === "error") {
            ctx.ui.notify(`重置已取消：无法停止飞书连接。${stopped.error instanceof Error ? stopped.error.message : String(stopped.error)}`, "error");
            refreshStatusFromState();
            return;
          }
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
          ctx.ui.notify(await refreshReport(), "info");
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
          ctx.ui.notify(statusReport(), "info");
          return;
        }
        if (cmd === "config") {
          ctx.ui.notify(configReport(), "info");
          return;
        }
        if (cmd === "debug") {
          ctx.ui.notify(debugReport(), "info");
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
        ctx.ui.notify(feishuHelpText(), "info");
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
      start().then(async (result) => {
        if (typeof result === "object" && result.status === "owned") {
          // A previous daemon still owns the lock (its supervisor may outlive
          // the upgrade). Do NOT exit — that makes our supervisor restart us
          // and spin until the old process dies. Instead keep polling inside
          // start() so takeover happens the moment the lock frees.
          console.error("[feishu] daemon found existing owner, waiting for takeover:", formatOwner(result.owner));
          const claimed = await waitForTakeover(start, 300_000);
          if (!claimed) {
            console.error("[feishu] daemon could not take over gateway within 300s; exiting");
            process.exit(0);
          }
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


function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer | string) => `${current}${chunk}`.slice(-64 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child.pid);
      reject(new Error(`升级安装超过 ${Math.ceil(options.timeout / 1000)} 秒，已终止安装进程树。可通过 OMP_FEISHU_UPGRADE_TIMEOUT_SEC 调整。`));
    }, options.timeout);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function terminateProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

function stopVerifiedGatewayOwner(owner: GatewayOwner) {
  const status = recordedProcessStatus(owner);
  if (status === "dead" || status === "mismatch") return;
  if (status === "unverified") {
    throw new Error(`拒绝停止 PID ${owner.pid}：无法核验网关进程启动指纹。请手动确认旧进程后再重试。`);
  }
  process.kill(owner.pid, "SIGTERM");
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(100);
  }
  return false;
}

async function waitForSupervisorExit(supervisor: { pid: number; processStart?: string; token?: string }, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isSupervisorProcessAlive(supervisor)) return true;
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

// Called from the daemon autoStart path after start() reports "owned" while a
// previous daemon is still winding down. start() already polled for 20s; keep
// polling until the stale owner releases the lock so this daemon takes over
// instead of exiting and making the supervisor restart-loop.
async function waitForTakeover(start: (config?: FeishuConfig, options?: { takeover?: boolean }) => Promise<{ status: string; owner?: GatewayOwner } | string>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    // 不强制接管：force=true 会覆盖仍存活的 daemon，导致双进程抢占。
    // 等旧 owner 退出后锁自然可用，非重试即可拿到。
    const result = await start(undefined, { takeover: false });
    // start() 成功返回字符串 "started" / "already"，也视为接管成功。
    if (result === "started" || result === "already") return true;
    if (typeof result === "object" && result.status !== "owned") return true;
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
