import type { FeishuAttachment, FeishuMessage } from "./types.js";

export type BotCommand =
  | { name: "new" }
  | { name: "resume" }
  | { name: "model" }
  | { name: "effort"; level?: string }
  | { name: "compact"; instructions?: string }
  | { name: "autocompact"; enabled?: string }
  | { name: "stop" }
  | { name: "help" }
  | { name: "commands" }
  | { name: "doctor" }
  | { name: "version" }
  | { name: "upgrade"; version?: string }
  | { name: "setup" }
  | { name: "status" }
  | { name: "debug" }
  | { name: "refresh" }
  | { name: "config" }
  | { name: "send"; path?: string }
  | { name: "workspace"; path?: string }
  | { name: "pluginStart" }
  | { name: "pluginStop" }
  | { name: "pluginRestart" }
  | { name: "autostart" }
  | { name: "skills"; enabled?: string }
  | { name: "reset" }
  | { name: "providerList" }
  | { name: "providerAdd"; provider?: string }
  | { name: "providerTest"; provider?: string }
  | { name: "providerRemove"; provider?: string; confirmation?: string };

type PostBody = {
  title?: string;
  content?: unknown[];
};

export function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

export function conversationKey(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
  const threadId = msg.threadId || msg.rootId || msg.parentId;
  if (threadId) return `group:${msg.chatId}:thread:${threadId}`;
  if (msg.chatMode === "topic") return `group:${msg.chatId}:thread:${msg.messageId}`;
  return `group:${msg.chatId}`;
}

export function conversationLabel(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return "[飞书私聊]";
  if (msg.rootId || msg.parentId || msg.threadId || msg.chatMode === "topic") return "[飞书话题]";
  return "[飞书群聊]";
}

export function parseMessageInput(msg: FeishuMessage, botOpenId?: string): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return { text: text.trim(), attachments };
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale = resolvePostBody(post);
      const parts: string[] = [];
      if (typeof locale?.title === "string" && locale.title.trim()) {
        parts.push(locale.title.trim());
      }
      for (const para of locale?.content || []) {
        const paragraphText = extractPostText(para, attachments).trim();
        if (paragraphText) parts.push(paragraphText);
      }
      collectAttachments(json, attachments);
      return { text: parts.join("\n").trim(), attachments };
    }
    if (msg.msgType === "image" && typeof json.image_key === "string" && json.image_key) {
      attachments.push({ kind: "image", fileKey: json.image_key });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    if (msg.msgType === "file" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    if (msg.msgType === "audio" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({ kind: "audio", fileKey: json.file_key, fileName: "audio.ogg" });
      return { text: "", attachments };
    }
    collectAttachments(json, attachments);
    if (attachments.length) return { text: "", attachments };
  } catch {}
  return { text: msg.msgType === "text" ? msg.content : `[${msg.msgType}]`, attachments };
}

export function parseBotCommand(text: string): BotCommand | undefined {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (lower === "/new") return { name: "new" };
  if (lower === "/resume") return { name: "resume" };
  if (lower === "/model") return { name: "model" };
  const effortMatch = trimmed.match(/^\/effort(?:\s+(.+))?$/i);
  if (effortMatch) return { name: "effort", level: effortMatch[1]?.trim() };
  const compactMatch = trimmed.match(/^\/compact(?:\s+(.+))?$/is);
  if (compactMatch) return { name: "compact", instructions: compactMatch[1]?.trim() };
  const autoCompactMatch = trimmed.match(/^\/autocompact(?:\s+(on|off))?$/i);
  if (autoCompactMatch) return { name: "autocompact", enabled: autoCompactMatch[1]?.toLowerCase() };
  if (lower === "/stop") return { name: "stop" };
  if (lower === "/feishu help" || lower === "/help") return { name: "help" };
  if (lower === "/feishu commands" || lower === "/commands") return { name: "commands" };
  if (lower === "/feishu doctor" || lower === "/doctor") return { name: "doctor" };
  if (lower === "/feishu version" || lower === "/version") return { name: "version" };
  if (lower === "/feishu setup") return { name: "setup" };
  if (lower === "/feishu start") return { name: "pluginStart" };
  if (lower === "/feishu stop") return { name: "pluginStop" };
  if (lower === "/feishu restart") return { name: "pluginRestart" };
  if (lower === "/feishu autostart") return { name: "autostart" };
  const skillsMatch = trimmed.match(/^\/feishu\s+skills(?:\s+(on|off))?$/i);
  if (skillsMatch) return { name: "skills", enabled: skillsMatch[1]?.toLowerCase() };
  if (lower === "/feishu reset") return { name: "reset" };
  const providerMatch = trimmed.match(/^\/feishu\s+provider(?:\s+(list|add|test|remove)(?:\s+(.+))?)?$/is);
  if (providerMatch) {
    const action = (providerMatch[1] || "list").toLowerCase();
    const args = providerMatch[2]?.trim().split(/\s+/) || [];
    if (action === "list") return { name: "providerList" };
    if (action === "test") return { name: "providerTest", provider: args[0] };
    if (action === "remove") return { name: "providerRemove", provider: args[0], confirmation: args[1] };
    if (action === "add") return { name: "providerAdd", provider: providerMatch[2]?.trim() };
  }
  const upgradeMatch = trimmed.match(/^\/feishu\s+upgrade(?:\s+(\d+\.\d+\.\d+))?$/i);
  if (upgradeMatch) {
    return { name: "upgrade", version: upgradeMatch[1] };
  }
  if (lower === "/feishu status" || lower === "/status") return { name: "status" };
  if (lower === "/feishu debug" || lower === "/debug") return { name: "debug" };
  if (lower === "/feishu refresh" || lower === "/refresh") return { name: "refresh" };
  if (lower === "/feishu config") return { name: "config" };
  const sendMatch = trimmed.match(/^\/(?:feishu\s+)?send(?:\s+(.+))?$/is);
  if (sendMatch) return { name: "send", path: sendMatch[1]?.trim() };
  const workspaceMatch = trimmed.match(/^\/workspace(?:\s+(.+))?$/si);
  if (workspaceMatch) {
    return { name: "workspace", path: workspaceMatch[1]?.trim() };
  }
  return undefined;
}

function resolvePostBody(post: unknown): PostBody | undefined {
  if (isPostBody(post)) return post;
  if (!post || typeof post !== "object" || Array.isArray(post)) return undefined;

  const record = post as Record<string, unknown>;
  const candidates = [record.zh_cn, record.en_us, ...Object.values(record)];
  return candidates.find(isPostBody);
}

function isPostBody(value: unknown): value is PostBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content);
}

function extractPostText(node: unknown, attachments: FeishuAttachment[]): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map((item) => extractPostText(item, attachments)).join("");

  const obj = node as Record<string, unknown>;
  const tag = typeof obj.tag === "string" ? obj.tag : undefined;

  if ((tag === "img" || tag === "image") && typeof obj.image_key === "string" && obj.image_key) {
    attachments.push({ kind: "image", fileKey: obj.image_key });
    return "";
  }

  if (tag === "at") {
    return `@${typeof obj.user_name === "string" && obj.user_name ? obj.user_name : "user"}`;
  }

  if ((tag === "text" || tag === "a") && typeof obj.text === "string") {
    return obj.text;
  }

  if (typeof obj.text === "string") return obj.text;

  return Object.values(obj).map((item) => extractPostText(item, attachments)).join("");
}

function collectAttachments(value: unknown, attachments: FeishuAttachment[]) {
  const seen = new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`));
  walk(value);

  function add(attachment: FeishuAttachment) {
    const key = `${attachment.kind}:${attachment.fileKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  }

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.image_key === "string" && obj.image_key) {
      add({ kind: "image", fileKey: obj.image_key });
    }
    if (typeof obj.file_key === "string" && obj.file_key) {
      add({
        kind: "file",
        fileKey: obj.file_key,
        fileName: typeof obj.file_name === "string" ? obj.file_name : undefined,
      });
    }

    for (const item of Object.values(obj)) walk(item);
  }
}
