import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_DIR } from "./config.js";
import { acquireFileLease, releaseFileLease } from "./gateway-lock.js";

export const MODELS_PATH = join(AGENT_DIR, "models.yml");
const BACKUP_PATH = `${MODELS_PATH}.bak-feishu`;
const WRITE_LOCK = `${MODELS_PATH}.feishu.lock`;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const API_NAMES = new Set(["auto", "openai-completions", "openai-responses", "anthropic-messages"]);

type Provider = Record<string, unknown>;
type ModelsConfig = { providers?: Record<string, Provider>; [key: string]: unknown };

export type ProviderSummary = { name: string; baseUrl: string; api: string; discovery: string; hasApiKey: boolean };

export function listProviders(): ProviderSummary[] {
  const config = readModelsConfig();
  return Object.entries(config.providers || {}).map(([name, provider]) => ({
    name,
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "未设置",
    api: typeof provider.api === "string" ? provider.api : "默认",
    discovery: typeof (provider.discovery as Provider | undefined)?.type === "string" ? String((provider.discovery as Provider).type) : "静态模型",
    hasApiKey: typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0,
  }));
}

export async function addProvider(name: string, baseUrl: string, apiKey: string, api = "openai-completions", modelIds: string[] = []) {
  validateName(name);
  const url = validateBaseUrl(baseUrl);
  if (!apiKey.trim()) throw new Error("API Key 不能为空。");
  if (!API_NAMES.has(api)) throw new Error(`不支持的 API：${api}`);
  const normalizedModelIds = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
  const resolvedApi = api === "auto" ? await detectOpenAiProtocol(url, apiKey) : api;
  return updateModelsConfig((config) => {
    const providers = config.providers || {};
    const previous = providers[name];
    const previousModels = Array.isArray(previous?.models) ? previous.models : [];
    if (resolvedApi === "anthropic-messages" && !normalizedModelIds.length && !previousModels.length) {
      throw new Error("Anthropic Provider 需要至少一个模型 ID，例如 claude-sonnet-4-20250514。");
    }
    const next: Provider = { ...(previous || {}), baseUrl: url, apiKey: apiKey.trim(), api: resolvedApi, feishuManaged: true };
    if (resolvedApi === "openai-completions" || resolvedApi === "openai-responses") next.discovery = { type: "openai-models-list", timeoutMs: 15000 };
    else {
      delete next.discovery;
      if (normalizedModelIds.length) next.models = normalizedModelIds.map((id) => ({ id, name: id, api: resolvedApi }));
    }
    providers[name] = next;
    config.providers = providers;
    return { name, replaced: Boolean(previous), baseUrl: url };
  });
}

export async function removeProvider(name: string, confirmation?: string) {
  validateName(name);
  if (confirmation?.toLowerCase() !== "confirm") throw new Error("删除 Provider 需要确认：/feishu provider remove <名称> confirm");
  return updateModelsConfig((config) => {
    const providers = config.providers || {};
    if (!providers[name]) throw new Error(`Provider 不存在：${name}`);
    delete providers[name];
    config.providers = providers;
    return name;
  });
}

export async function testProvider(name: string) {
  validateName(name);
  const provider = readModelsConfig().providers?.[name];
  if (!provider) throw new Error(`Provider 不存在：${name}`);
  const api = typeof provider.api === "string" ? provider.api : "auto";
  const baseUrl = validateBaseUrl(typeof provider.baseUrl === "string" ? provider.baseUrl : "");
  const resolvedApi = api === "auto" ? await detectOpenAiProtocol(baseUrl, typeof provider.apiKey === "string" ? provider.apiKey : "") : api;
  if (api === "anthropic-messages") {
    const models = Array.isArray(provider.models) ? provider.models.length : 0;
    return { name, endpoint: baseUrl, status: "configured" as const, modelCount: models };
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (typeof provider.apiKey === "string" && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}`);
  let count = 0;
  try {
    const parsed = JSON.parse(body) as { data?: unknown[]; models?: unknown[] };
    count = Array.isArray(parsed.data) ? parsed.data.length : Array.isArray(parsed.models) ? parsed.models.length : 0;
  } catch {}
  return { name, endpoint, status: response.status, modelCount: count };
}

export async function syncProvider(name: string) {
  validateName(name);
  const config = readModelsConfig();
  const provider = config.providers?.[name];
  if (!provider) throw new Error(`Provider 不存在：${name}`);
  if (provider.feishuManaged !== true) throw new Error(`Provider ${name} 未启用自动同步，请在 models.yml 设置 feishuManaged: true。`);
  const api = typeof provider.api === "string" ? provider.api : "auto";
  if (api === "anthropic-messages") throw new Error("Anthropic Provider 没有标准模型发现接口，请手动维护 models.yml。");
  const baseUrl = validateBaseUrl(typeof provider.baseUrl === "string" ? provider.baseUrl : "");
  const resolvedApi = api === "auto" ? await detectOpenAiProtocol(baseUrl, typeof provider.apiKey === "string" ? provider.apiKey : "") : api;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (typeof provider.apiKey === "string" && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
  const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models = entries.map((item) => typeof item.id === "string" ? { id: item.id, name: typeof item.name === "string" ? item.name : item.id, api: resolvedApi } : undefined).filter((item): item is { id: string; name: string; api: string } => Boolean(item));
  return updateModelsConfig((latest) => {
    const current = latest.providers?.[name];
    if (!current || current.feishuManaged !== true) throw new Error(`Provider ${name} 已被修改，未执行同步。`);
    latest.providers![name] = { ...current, api: resolvedApi, discovery: { type: "openai-models-list", timeoutMs: 15000 }, models };
    return { name, modelCount: models.length };
  });
}

export async function syncAllProviders() {
  const names = Object.entries(readModelsConfig().providers || {}).filter(([, provider]) => provider.feishuManaged === true && provider.api !== "anthropic-messages").map(([name]) => name);
  const results = [];
  for (const name of names) results.push(await syncProvider(name));
  return results;
}

function readModelsConfig(): ModelsConfig {
  if (!existsSync(MODELS_PATH)) return { providers: {} };
  const raw = readFileSync(MODELS_PATH, "utf8");
  const parsed = Bun.YAML.parse(raw) as ModelsConfig | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("models.yml 不是有效的对象配置。");
  return parsed;
}

async function writeModelsConfigUnlocked(config: ModelsConfig) {
  const temporaryPath = `${MODELS_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (existsSync(MODELS_PATH)) copyFileSync(MODELS_PATH, BACKUP_PATH);
    writeFileSync(temporaryPath, Bun.YAML.stringify(config), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, MODELS_PATH);
    try { chmodSync(MODELS_PATH, 0o600); } catch {}
  } catch (error) {
    try { if (existsSync(BACKUP_PATH)) copyFileSync(BACKUP_PATH, MODELS_PATH); } catch {}
    throw error;
  } finally { try { rmSync(temporaryPath, { force: true }); } catch {} }
}

async function updateModelsConfig<T>(update: (config: ModelsConfig) => T): Promise<T> {
  mkdirSync(dirname(MODELS_PATH), { recursive: true });
  const lease = await acquireFileLease(WRITE_LOCK);
  try { const config = readModelsConfig(); const result = update(config); await writeModelsConfigUnlocked(config); return result; }
  finally { releaseFileLease(lease); }
}

function validateName(name: string) {
  if (!PROVIDER_NAME.test(name)) throw new Error("Provider 名称只能包含字母、数字、点、下划线和短横线，长度不超过 64。");
}

async function detectOpenAiProtocol(baseUrl: string, apiKey: string) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  let response: Response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error(`自动判断 Provider 协议失败：${error instanceof Error ? error.message : String(error)}。请手动指定 api。`);
  }
  if (!response.ok) throw new Error(`自动判断 Provider 协议失败：/models 返回 HTTP ${response.status}。请手动指定 api。`);
  return "openai-completions";
}

function validateBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("baseUrl 必须是有效的 http:// 或 https:// 地址。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl 只支持 http:// 或 https://。");
  if (url.username || url.password || url.search || url.hash) throw new Error("baseUrl 不能包含用户名、密码、查询参数或片段。");
  return url.toString().replace(/\/$/, "");
}
