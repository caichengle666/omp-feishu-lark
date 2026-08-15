import type { FeishuCardAction, FeishuConfig, FeishuMessage } from "./types.js";
import type { Client, WSClient } from "@larksuiteoapi/node-sdk";
import { debugLog } from "./debug.js";
import { buildMarkdownCardParts, buildPostMessages, chooseMessageMode } from "./rich-text.js";
import { FeishuCardActionWebhook } from "./card-action-webhook.js";

const TEXT_CHUNK_MAX_BYTES = 120 * 1024;
const REST_TIMEOUT_MS = 15_000;
const WS_READY_TIMEOUT_MS = 30_000;
type RuntimeWSClient = WSClient & {
  close?: (options?: { force?: boolean }) => void;
  stop?: () => Promise<void> | void;
};
type RuntimeSdkClient = Client & { httpInstance?: { defaults?: { timeout?: number } } };

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

export class FeishuTransport {
  private sdkClient: Client | undefined;
  private wsClient: RuntimeWSClient | undefined;
  private cardActionWebhook: FeishuCardActionWebhook | undefined;
  private running = false;
  private wsDisconnects = 0;
  private botOpenId: string | undefined;
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
  private readonly markdownCopySources = new Map<string, string>();
  private readonly markdownCopySourceOrder: string[] = [];
  private markdownCopySeq = 0;

  constructor(
    private readonly config: FeishuConfig,
    private readonly onMessage: (msg: FeishuMessage) => Promise<void>,
    private readonly onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>,
  ) {}

  async start() {
    if (this.running) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });
    configureSdkRestTimeout(this.sdkClient);

    await this.probeBotOpenId();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
      "im.message.reaction.created_v1": async () => undefined,
      "im.chat.member.bot.added_v1": async () => undefined,
    });

    // Always register the WS card action handler. When the app is connected
    // via WebSocket (which is always the case with WSClient), the Feishu
    // platform delivers card action callbacks through the WS channel.
    // Without this handler the EventDispatcher returns an invalid response
    // to the platform, causing error 200672 on the client.
    dispatcher.register({
      "card.action.trigger": async (data: unknown) => this.handleCardAction(data),
    });

    // Optional webhook server as a backup delivery channel (only used when
    // the developer console is explicitly configured for webhook delivery).
    if (this.cardActionMode() === "webhook") {
      this.cardActionWebhook = new FeishuCardActionWebhook(this.config, async (action) => this.handleCardActionAction(action, "webhook"));
      await this.cardActionWebhook.start();
      debugLog("feishu.card.webhook.endpoint", {
        endpoint: this.cardActionWebhook.getEndpointLabel(),
      });
    }

    const ready = createWsReadyGate(WS_READY_TIMEOUT_MS);
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
      onReady: () => {
        this.running = true;
        ready.resolve();
      },
      onError: (error) => {
        this.running = false;
        this.wsDisconnects += 1;
        debugLog("feishu.ws.disconnected", { count: this.wsDisconnects, error: error.message });
        ready.reject(error);
      },
      onReconnecting: () => {
        this.running = false;
        debugLog("feishu.ws.reconnecting", { count: this.wsDisconnects });
      },
      onReconnected: () => {
        this.running = true;
        debugLog("feishu.ws.reconnected", { at: new Date().toISOString() });
      },
    });

    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      await ready.promise;
      debugLog("feishu.ws.connected", { at: new Date().toISOString() });
    } catch (error) {
      this.running = false;
      ready.cancel();
      try { this.wsClient.close?.({ force: true }); } catch {}
      try { await this.cardActionWebhook?.stop(); } catch {}
      this.cardActionWebhook = undefined;
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.wsDisconnects += 1;
    debugLog("feishu.ws.disconnected", { count: this.wsDisconnects, reason: "stop" });
    try {
      if (this.wsClient?.close) this.wsClient.close({ force: true });
      else await this.wsClient?.stop?.();
    } catch {}
    this.wsClient = undefined;
    try { await this.cardActionWebhook?.stop(); } catch {}
    this.cardActionWebhook = undefined;
  }

  isRunning() {
    return this.running;
  }

  getBotOpenId() {
    return this.botOpenId;
  }

  private async probeBotOpenId() {
    try {
      const res = await this.sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      this.botOpenId = res?.bot?.open_id || res?.data?.bot?.open_id || res?.data?.open_id;
      if (!this.botOpenId) {
        throw new Error(`bot/v3/info response missing open_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
    } catch (error) {
      throw new BotUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRawMessage(data: any) {
    const event = data?.event || data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message) return;
    if (sender?.sender_type === "bot") return;

    debugLog("feishu.message.received", {
      messageId: message.message_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      hasRootId: Boolean(message.root_id),
      hasParentId: Boolean(message.parent_id),
      hasThreadId: Boolean(message.thread_id),
      content: message.content || "",
    });

    if (message.chat_type === "group" && this.config.groupPolicy === "mention") {
      if (!this.isMentioned(message)) {
        debugLog("feishu.message.ignored_not_mentioned", { messageId: message.message_id });
        return;
      }
    }

    const chatMode = await this.getChatMode(message.chat_id, message.chat_type);
    const msg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      chatMode,
      senderOpenId: sender?.sender_id?.open_id || "unknown",
      msgType: message.message_type,
      content: message.content || "",
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
      mentions: message.mentions,
    };

    if (this.config.reactEmoji) {
      void this.addReaction(msg.messageId, this.config.reactEmoji);
    }
    debugLog("feishu.message.dispatch", { messageId: msg.messageId });
    void this.onMessage(msg).catch((error) => {
      debugLog("feishu.message.dispatch_error", {
        messageId: msg.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleCardAction(data: any) {
    // After EventDispatcher/RequestHandle.parse() the event fields are
    // flattened to the top level. data.event is gone; use data directly.
    const messageId = data?.context?.open_message_id || data?.open_message_id;
    const chatId = data?.context?.open_chat_id || data?.open_chat_id;
    const operatorOpenId = data?.operator?.open_id;
    if (!messageId || !operatorOpenId) return;
    debugLog("feishu.card.action", {
      messageId,
      chatId,
      hasToken: Boolean(data?.token),
      value: data?.action?.value,
    });
    const result = await this.handleCardActionAction({
      messageId,
      chatId,
      operatorOpenId,
      token: typeof data?.token === "string" ? data.token : undefined,
      value: data?.action?.value,
    }, "ws");
    // The WSClient sends the return value back to the Feishu platform as
    // the card callback response. It must use the wrapped format:
    //   { "card": { "type": "raw", "data": { ... card JSON ... } } }
    if (result) {
      return { card: { type: "raw", data: result } };
    }
    return result;
  }

  private async handleCardActionAction(action: FeishuCardAction, mode: "ws" | "webhook") {
    const result = await this.onCardAction(action);
    if (mode === "ws" && result) {
      await this.updateCard(action.messageId, result);
    }
    return result;
  }

  private cardActionMode() {
    return this.config.cardActionMode || "webhook";
  }

  private isMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    const botOpenId = this.botOpenId;
    if (!botOpenId) return true;
    return mentions.some((m: any) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId);
  }

  private async getChatMode(chatId: string, chatType: "p2p" | "group"): Promise<"p2p" | "group" | "topic"> {
    if (chatType === "p2p") return "p2p";
    const cached = this.chatModeCache.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.sdkClient.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = res?.data?.chat_mode === "topic" ? "topic" : "group";
      this.chatModeCache.set(chatId, mode);
      debugLog("feishu.chat.mode", { chatId, mode });
      return mode;
    } catch (error) {
      debugLog("feishu.chat.mode_error", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "group";
    }
  }

  private async addReaction(messageId: string, emojiType: string) {
    try {
      await this.sdkClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch {}
  }

  async replyText(messageId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.replyMarkdownCard(messageId, text);
      return;
    }
    if (mode === "post") {
      await this.replyPost(messageId, text);
      return;
    }
    debugLog("feishu.reply.text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      });
    }
  }

  async replyPlainText(messageId: string, text: string) {
    debugLog("feishu.reply.plain_text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      });
    }
  }

  async sendText(chatId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.sendMarkdownCard(chatId, text);
      return;
    }
    if (mode === "post") {
      await this.sendPost(chatId, text);
      return;
    }
    debugLog("feishu.send.text", { chatId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
  }

  async replyMarkdownCard(messageId: string, text: string) {
    debugLog("feishu.reply.markdown_card", { messageId, length: text.length });
    for (const { card } of this.buildMarkdownCardPartsWithCopySources(text)) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "interactive", content: JSON.stringify(card) },
      });
    }
  }

  async sendMarkdownCard(chatId: string, text: string) {
    debugLog("feishu.send.markdown_card", { chatId, length: text.length });
    for (const { card } of this.buildMarkdownCardPartsWithCopySources(text)) {
      await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    }
  }

  getMarkdownCopySource(copySourceId: string) {
    return this.markdownCopySources.get(copySourceId);
  }

  private buildMarkdownCardPartsWithCopySources(text: string) {
    return buildMarkdownCardParts(text, this.config.language, () => this.createMarkdownCopySourceId())
      .map((part) => {
        const copySourceId = extractCopySourceId(part.card);
        if (copySourceId) this.rememberMarkdownCopySource(copySourceId, part.markdown);
        return part;
      });
  }

  private rememberMarkdownCopySource(copySourceId: string, markdown: string) {
    this.markdownCopySources.set(copySourceId, markdown);
    this.markdownCopySourceOrder.push(copySourceId);
    while (this.markdownCopySourceOrder.length > 200) {
      const oldest = this.markdownCopySourceOrder.shift();
      if (oldest) this.markdownCopySources.delete(oldest);
    }
  }

  private createMarkdownCopySourceId() {
    this.markdownCopySeq += 1;
    return `${Date.now().toString(36)}-${this.markdownCopySeq.toString(36)}`;
  }

  async replyPost(messageId: string, text: string) {
    debugLog("feishu.reply.post", { messageId, length: text.length });
    for (const post of buildPostMessages(text, this.config.language)) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "post", content: JSON.stringify(post) },
      });
    }
  }

  async sendPost(chatId: string, text: string) {
    debugLog("feishu.send.post", { chatId, length: text.length });
    for (const post of buildPostMessages(text, this.config.language)) {
      await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(post),
        },
      });
    }
  }

  async replyCard(messageId: string, card: object) {
    debugLog("feishu.reply.card", { messageId });
    const res = await this.sdkClient.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
    return res?.data?.message_id as string | undefined;
  }

  async updateCard(messageId: string, card: object) {
    debugLog("feishu.update.card", { messageId });
    await this.sdkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ bytes: Buffer; mimeType?: string }> {
    debugLog("feishu.download.resource.start", { messageId, fileKey, type });
    const result = await this.sdkClient.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result));
    const rawContentType = result.headers?.["content-type"] || result.headers?.["Content-Type"];
    const mimeType = typeof rawContentType === "string" ? rawContentType.split(";")[0]?.trim() : undefined;
    debugLog("feishu.download.resource.done", { messageId, fileKey, type, bytes: bytes.length, mimeType });
    return { bytes, mimeType: mimeType || undefined };
  }

  async downloadImage(messageId: string, imageKey: string): Promise<{ bytes: Buffer; mimeType?: string }> {
    try {
      return await this.downloadMessageResource(messageId, imageKey, "image");
    } catch (resourceError) {
      debugLog("feishu.download.image.resource_failed", {
        messageId,
        imageKey,
        error: resourceError instanceof Error ? resourceError.message : String(resourceError),
      });
    }

    debugLog("feishu.download.image.fallback_start", { messageId, imageKey });
    const result = await this.sdkClient.im.v1.image.get({
      path: { image_key: imageKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result));
    debugLog("feishu.download.image.fallback_done", { messageId, imageKey, bytes: bytes.length });
    // 旧版硬编码 image/jpeg 会把 png/webp 字节标成 jpeg，导致多模态模型解码失败；
    // 返回 undefined 让 detectImageMime 走魔数嗅探。
    return { bytes, mimeType: undefined };
  }
}

export function configureSdkRestTimeout(client: Client, timeoutMs = REST_TIMEOUT_MS) {
  const http = (client as RuntimeSdkClient).httpInstance;
  if (http?.defaults) http.defaults.timeout = timeoutMs;
}

export function createWsReadyGate(timeoutMs: number) {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectPromise(new Error(`Feishu WebSocket did not connect within ${Math.ceil(timeoutMs / 1000)} seconds`));
  }, timeoutMs);
  timer.unref?.();
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action();
  };
  return {
    promise,
    resolve: () => finish(resolvePromise),
    reject: (error: Error) => finish(() => rejectPromise(error)),
    cancel: () => finish(() => undefined),
  };
}

function splitText(text: string, maxBytes: number) {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (textPayloadSize(rest) > maxBytes) {
    const cut = findCutIndexByBytes(rest, maxBytes);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function findCutIndexByBytes(text: string, maxBytes: number) {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const safeMid = avoidHalfSurrogate(text, mid);
    if (safeMid > 0 && textPayloadSize(text.slice(0, safeMid)) <= maxBytes) {
      best = safeMid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const newline = text.lastIndexOf("\n", best);
  if (newline > 0 && newline >= Math.floor(best * 0.6)) return newline + 1;
  return Math.max(1, best);
}

function avoidHalfSurrogate(text: string, index: number) {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

function byteSize(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function textPayloadSize(text: string) {
  return byteSize(JSON.stringify({ text }));
}

function extractCopySourceId(card: object) {
  const elements = (card as any)?.body?.elements;
  if (!Array.isArray(elements)) return undefined;
  for (const element of elements) {
    const behaviors = element?.behaviors;
    if (!Array.isArray(behaviors)) continue;
    for (const behavior of behaviors) {
      const value = behavior?.value;
      if (value?.action === "pi_feishu_copy_markdown" && typeof value.copySourceId === "string") {
        return value.copySourceId;
      }
    }
  }
  return undefined;
}

async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readableFromDownload(result: any): NodeJS.ReadableStream {
  return typeof result?.getReadableStream === "function" ? result.getReadableStream() : result;
}
