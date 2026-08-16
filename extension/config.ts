import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CardActionMode, Domain, FeishuConfig, GroupPolicy } from "./types.js";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

// This is an OMP extension. OMP owns profile resolution; use its canonical
// directory when the extension is loaded by OMP. Environment fallbacks keep
// installer/self-test imports safe.
export const AGENT_DIR = typeof getAgentDir === "function"
  ? getAgentDir()
  : process.env.PI_CODING_AGENT_DIR || process.env.OMP_AGENT_DIR || join(homedir(), ".omp", "agent");
export const ROOT_DIR = process.env.OMP_FEISHU_ROOT || join(AGENT_DIR, "feishu");
export const CONFIG_PATH = join(ROOT_DIR, "config.json");
export const STATE_PATH = join(ROOT_DIR, "state.json");
export const DEBUG_LOG_PATH = join(ROOT_DIR, "debug.log");
export const DAEMON_LOG_PATH = join(ROOT_DIR, "daemon.log");
export const SUPERVISOR_PID_PATH = join(ROOT_DIR, "supervisor.pid");
export const SUPERVISOR_STOP_PATH = join(ROOT_DIR, "supervisor.stop");
export const DEDUPE_PATH = join(ROOT_DIR, "dedupe.json");
export const BRIDGE_PATH = join(ROOT_DIR, "bridge.json");
export const UPGRADE_NOTICE_PATH = join(ROOT_DIR, "upgrade-notice.json");
export const CHILD_SESSION_ENV = "PI_FEISHU_CHILD_SESSION";

export const DEFAULT_CONFIG: Pick<
  FeishuConfig,
  "domain" | "groupPolicy" | "cardActionMode" | "cardActionWebhookHost" | "cardActionWebhookPort" | "cardActionWebhookPath" | "notificationWebhookEnabled" | "notificationWebhookHost" | "notificationWebhookPort" | "notificationWebhookPath" | "language" | "reactEmoji" | "autoStart" | "promptNotifySec" | "promptTimeoutSec" | "promptTimeoutEnabled"
> = {
  domain: "feishu",
  groupPolicy: "mention",
  cardActionMode: "ws",
  cardActionWebhookHost: "0.0.0.0",
  cardActionWebhookPort: 3001,
  cardActionWebhookPath: "/webhook/card",
  notificationWebhookEnabled: false,
  notificationWebhookHost: "127.0.0.1",
  notificationWebhookPort: 3002,
  notificationWebhookPath: "/webhook/notify",
  language: "zh",
  reactEmoji: "THUMBSUP",
  autoStart: true,
  promptNotifySec: 180,
  promptTimeoutSec: 0,
  promptTimeoutEnabled: false,
};

export function ensureRoot() {
  mkdirSync(ROOT_DIR, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    backupCorruptJson(path);
    return fallback;
  }
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    try { chmodSync(path, 0o600); } catch {}
  } finally {
    try { rmSync(temporaryPath, { force: true }); } catch {}
  }
}

export function removePath(path: string) {
  rmSync(path, { recursive: true, force: true });
}

function backupCorruptJson(path: string) {
  const backup = `${path}.corrupt-${Date.now()}`;
  try { renameSync(path, backup); } catch {}
}

export function loadConfig(): FeishuConfig | undefined {
  const envAppId = process.env.FEISHU_APP_ID?.trim();
  const envSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (envAppId && envSecret) {
    return validateConfig({
      appId: envAppId,
      appSecret: envSecret,
      domain: (process.env.FEISHU_DOMAIN as Domain) || DEFAULT_CONFIG.domain,
      groupPolicy: (process.env.FEISHU_GROUP_POLICY as GroupPolicy) || DEFAULT_CONFIG.groupPolicy,
      cardActionMode: parseCardActionMode(process.env.FEISHU_CARD_ACTION_MODE) || DEFAULT_CONFIG.cardActionMode,
      cardActionToken: process.env.FEISHU_CARD_ACTION_TOKEN?.trim() || undefined,
      cardActionWebhookHost: process.env.FEISHU_CARD_ACTION_WEBHOOK_HOST?.trim() || DEFAULT_CONFIG.cardActionWebhookHost,
      cardActionWebhookPort: parsePort(process.env.FEISHU_CARD_ACTION_WEBHOOK_PORT) ?? DEFAULT_CONFIG.cardActionWebhookPort,
      cardActionWebhookPath: normalizeWebhookPath(process.env.FEISHU_CARD_ACTION_WEBHOOK_PATH) || DEFAULT_CONFIG.cardActionWebhookPath,
      notificationWebhookEnabled: parseEnvBoolean(process.env.FEISHU_NOTIFY_WEBHOOK_ENABLED) ?? DEFAULT_CONFIG.notificationWebhookEnabled,
      notificationWebhookHost: process.env.FEISHU_NOTIFY_WEBHOOK_HOST?.trim() || DEFAULT_CONFIG.notificationWebhookHost,
      notificationWebhookPort: parsePort(process.env.FEISHU_NOTIFY_WEBHOOK_PORT) ?? DEFAULT_CONFIG.notificationWebhookPort,
      notificationWebhookPath: normalizeWebhookPath(process.env.FEISHU_NOTIFY_WEBHOOK_PATH) || DEFAULT_CONFIG.notificationWebhookPath,
      notificationWebhookToken: process.env.FEISHU_NOTIFY_WEBHOOK_TOKEN?.trim() || undefined,
      language: (process.env.FEISHU_LANGUAGE as "zh" | "en") || DEFAULT_CONFIG.language,
      reactEmoji: process.env.FEISHU_REACT_EMOJI || DEFAULT_CONFIG.reactEmoji,
      autoStart: process.env.FEISHU_AUTO_START ? process.env.FEISHU_AUTO_START !== "0" : DEFAULT_CONFIG.autoStart,
      adminOpenIds: parseAdminOpenIds(process.env.FEISHU_ADMIN_OPEN_IDS),
      promptNotifySec: parseEnvSeconds(process.env.FEISHU_PROMPT_NOTIFY_SEC) ?? DEFAULT_CONFIG.promptNotifySec,
      promptTimeoutSec: parseEnvSeconds(process.env.FEISHU_PROMPT_TIMEOUT_SEC) ?? DEFAULT_CONFIG.promptTimeoutSec,
      promptTimeoutEnabled: parseEnvBoolean(process.env.FEISHU_PROMPT_TIMEOUT_ENABLED) ?? DEFAULT_CONFIG.promptTimeoutEnabled,
    });
  }
  if (!existsSync(CONFIG_PATH)) return undefined;
  const cfg = readJson<Partial<FeishuConfig>>(CONFIG_PATH, {});
  return validateConfig({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain || DEFAULT_CONFIG.domain,
    groupPolicy: cfg.groupPolicy || DEFAULT_CONFIG.groupPolicy,
    cardActionMode: parseCardActionMode(cfg.cardActionMode) || DEFAULT_CONFIG.cardActionMode,
    cardActionToken: typeof cfg.cardActionToken === "string" && cfg.cardActionToken.trim() ? cfg.cardActionToken.trim() : undefined,
    cardActionWebhookHost: cfg.cardActionWebhookHost || DEFAULT_CONFIG.cardActionWebhookHost,
    cardActionWebhookPort: typeof cfg.cardActionWebhookPort === "number" ? cfg.cardActionWebhookPort : DEFAULT_CONFIG.cardActionWebhookPort,
    cardActionWebhookPath: normalizeWebhookPath(cfg.cardActionWebhookPath) || DEFAULT_CONFIG.cardActionWebhookPath,
    notificationWebhookEnabled: cfg.notificationWebhookEnabled ?? DEFAULT_CONFIG.notificationWebhookEnabled,
    notificationWebhookHost: cfg.notificationWebhookHost || DEFAULT_CONFIG.notificationWebhookHost,
    notificationWebhookPort: typeof cfg.notificationWebhookPort === "number" ? cfg.notificationWebhookPort : DEFAULT_CONFIG.notificationWebhookPort,
    notificationWebhookPath: normalizeWebhookPath(cfg.notificationWebhookPath) || DEFAULT_CONFIG.notificationWebhookPath,
    notificationWebhookToken: typeof cfg.notificationWebhookToken === "string" && cfg.notificationWebhookToken.trim() ? cfg.notificationWebhookToken.trim() : undefined,
    language: cfg.language || DEFAULT_CONFIG.language,
    reactEmoji: cfg.reactEmoji || DEFAULT_CONFIG.reactEmoji,
    autoStart: cfg.autoStart ?? DEFAULT_CONFIG.autoStart,
    adminOpenIds: normalizeAdminOpenIds(cfg.adminOpenIds),
    promptNotifySec: numberOr(cfg.promptNotifySec, DEFAULT_CONFIG.promptNotifySec),
    promptTimeoutSec: numberOr(cfg.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec),
    promptTimeoutEnabled: cfg.promptTimeoutEnabled ?? DEFAULT_CONFIG.promptTimeoutEnabled,
  });
}

export function validateConfig(value: unknown): FeishuConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<FeishuConfig>;
  if (typeof raw.appId !== "string" || !raw.appId.trim()) return undefined;
  if (typeof raw.appSecret !== "string" || !raw.appSecret.trim()) return undefined;
  const domain = raw.domain || DEFAULT_CONFIG.domain;
  const groupPolicy = raw.groupPolicy || DEFAULT_CONFIG.groupPolicy;
  const cardActionMode = parseCardActionMode(raw.cardActionMode) || DEFAULT_CONFIG.cardActionMode;
  if (domain !== "feishu" && domain !== "lark") return undefined;
  if (groupPolicy !== "open" && groupPolicy !== "mention") return undefined;
  const language = raw.language || DEFAULT_CONFIG.language;
  if (language !== "zh" && language !== "en") return undefined;
  const port = raw.cardActionWebhookPort ?? DEFAULT_CONFIG.cardActionWebhookPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const notificationPort = raw.notificationWebhookPort ?? DEFAULT_CONFIG.notificationWebhookPort;
  if (typeof notificationPort !== "number" || !Number.isInteger(notificationPort) || notificationPort < 1 || notificationPort > 65535) return undefined;
  if (raw.notificationWebhookEnabled && (typeof raw.notificationWebhookToken !== "string" || !raw.notificationWebhookToken.trim())) return undefined;
  if (cardActionMode === "webhook" && (typeof raw.cardActionToken !== "string" || !raw.cardActionToken.trim())) return undefined;
  const promptNotifySec = numberOr(raw.promptNotifySec, DEFAULT_CONFIG.promptNotifySec);
  const promptTimeoutSec = numberOr(raw.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec);
  if (promptNotifySec < 0 || promptTimeoutSec < 0) return undefined;
  return {
    appId: raw.appId.trim(),
    appSecret: raw.appSecret.trim(),
    domain,
    groupPolicy,
    cardActionMode,
    cardActionToken: typeof raw.cardActionToken === "string" && raw.cardActionToken.trim() ? raw.cardActionToken.trim() : undefined,
    cardActionWebhookHost: typeof raw.cardActionWebhookHost === "string" && raw.cardActionWebhookHost.trim() ? raw.cardActionWebhookHost.trim() : DEFAULT_CONFIG.cardActionWebhookHost,
    cardActionWebhookPort: port,
    cardActionWebhookPath: normalizeWebhookPath(raw.cardActionWebhookPath) || DEFAULT_CONFIG.cardActionWebhookPath,
    notificationWebhookEnabled: typeof raw.notificationWebhookEnabled === "boolean" ? raw.notificationWebhookEnabled : DEFAULT_CONFIG.notificationWebhookEnabled,
    notificationWebhookHost: typeof raw.notificationWebhookHost === "string" && raw.notificationWebhookHost.trim() ? raw.notificationWebhookHost.trim() : DEFAULT_CONFIG.notificationWebhookHost,
    notificationWebhookPort: notificationPort,
    notificationWebhookPath: normalizeWebhookPath(raw.notificationWebhookPath) || DEFAULT_CONFIG.notificationWebhookPath,
    notificationWebhookToken: typeof raw.notificationWebhookToken === "string" && raw.notificationWebhookToken.trim() ? raw.notificationWebhookToken.trim() : undefined,
    language,
    reactEmoji: typeof raw.reactEmoji === "string" ? raw.reactEmoji : DEFAULT_CONFIG.reactEmoji,
    autoStart: typeof raw.autoStart === "boolean" ? raw.autoStart : DEFAULT_CONFIG.autoStart,
    adminOpenIds: normalizeAdminOpenIds(raw.adminOpenIds),
    promptNotifySec,
    promptTimeoutSec,
    promptTimeoutEnabled: typeof raw.promptTimeoutEnabled === "boolean" ? raw.promptTimeoutEnabled : DEFAULT_CONFIG.promptTimeoutEnabled,
  };
}

export function isFeishuAdmin(config: FeishuConfig | undefined, openId: string) {
  return Boolean(openId && config?.adminOpenIds?.includes(openId));
}

function parseAdminOpenIds(value: string | undefined) {
  return value ? normalizeAdminOpenIds(value.split(",")) : undefined;
}

function normalizeAdminOpenIds(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return ids.length ? ids : undefined;
}

function parseEnvSeconds(value: string | undefined) {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function parseEnvBoolean(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseCardActionMode(value: unknown): CardActionMode | undefined {
  if (value !== "webhook" && value !== "ws") return undefined;
  return value;
}

function parsePort(value: string | undefined) {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  return port;
}

function normalizeWebhookPath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function mask(s: string) {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}
