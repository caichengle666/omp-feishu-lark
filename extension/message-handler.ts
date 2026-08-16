import { detectCodeLanguage, decodeTextFile, detectImageMime, type FeishuImageInput, isSupportedImageMime, isSupportedTextFile } from "./attachments.js";
import { buildModelCard, buildResumeCard } from "./cards.js";
import type { ConversationManager } from "./conversation-manager.js";
import { claimFeishuMessage, markFeishuMessage } from "./dedupe-store.js";
import { debugLog } from "./debug.js";
import { conversationKey, conversationLabel, normalizeForDedupe, parseBotCommand, parseMessageInput, pruneRecentMap } from "./messages.js";
import { TaskStatusCard } from "./task-status-card.js";
import { feishuHelpText } from "./help.js";
import { transcribeTencentAudio } from "./tencent-asr.js";
import type { FeishuBridgeStore } from "./bridge-store.js";
import type { FeishuTransport } from "./transport.js";
import type { FeishuMessage } from "./types.js";

const CONTENT_DEDUPE_TTL_MS = 5_000;

export class FeishuMessageHandler {
  private readonly seen = new Set<string>();
  private readonly recentContent = new Map<string, number>();

  constructor(
    private readonly conversations: ConversationManager,
    private readonly getTransport: () => FeishuTransport | undefined,
    private readonly bridgeStore?: FeishuBridgeStore,
    private readonly diagnostics?: {
      doctor: (detailed?: boolean) => string | Promise<string>;
      version: (detailed?: boolean) => string;
      upgrade?: (version?: string, target?: { chatId: string; messageId: string; sessionKey: string; chatType: string }) => Promise<string>;
      isAdmin?: (openId: string) => boolean;
      status?: (detailed?: boolean) => string | Promise<string>;
      debug?: () => string | Promise<string>;
      refresh?: () => string | Promise<string>;
      config?: () => string | Promise<string>;
    },
  ) {}

  reset() {
    this.seen.clear();
    this.recentContent.clear();
  }

  async handle(msg: FeishuMessage) {
    const transport = this.getTransport();
    if (!transport) return;
    const startedAt = Date.now();

    try {
      if (this.seen.has(msg.messageId)) return;
      if (!(await claimFeishuMessage(msg.messageId))) return;
      this.seen.add(msg.messageId);
      if (this.seen.size > 2000) this.seen.clear();

      const parsed = parseMessageInput(msg, transport.getBotOpenId());
      const text = parsed.text || "";
      const key = conversationKey(msg);
      this.bridgeStore?.bindConversation(key, msg);
      debugLog("feishu.handler.parsed", {
        messageId: msg.messageId,
        key,
        chatMode: msg.chatMode,
        threadId: msg.threadId || msg.rootId || msg.parentId,
        textLength: text.length,
        attachments: parsed.attachments.map((item) => ({
          kind: item.kind,
          fileKey: item.fileKey,
          fileName: item.fileName,
        })),
      });

      if (!parsed.attachments.length) {
        if (!text) {
          await markFeishuMessage(msg.messageId, "ignored");
          return;
        }
        const handled = await this.handleCommand(msg, key, text);
        if (handled) {
          await markFeishuMessage(msg.messageId, "replied");
          return;
        }
      }

      if (this.isDuplicateContent(msg, key, text, parsed.attachments)) {
        await markFeishuMessage(msg.messageId, "ignored");
        return;
      }

      const model = await this.conversations.getSelectedModel(key);
      const modelSupportsImage = Boolean(model && Array.isArray((model as any).input) && (model as any).input.includes("image"));
      debugLog("feishu.handler.model", {
        messageId: msg.messageId,
        key,
        model: model ? `${(model as any).provider}/${(model as any).id}` : undefined,
        modelSupportsImage,
      });

      const processed = await this.processAttachments(msg, parsed.attachments, modelSupportsImage);
      const { imageInputs, fileSections, transcribedText, downloadErrors, skippedImageCount } = processed;
      const promptText = [text, transcribedText].filter(Boolean).join("\n\n");

      if (skippedImageCount > 0 && imageInputs.length === 0 && !fileSections.length && !text.trim()) {
        await transport.replyText(
          msg.messageId,
          "当前模型不支持图片解析。请先发送 /model 并切换到支持图片的模型后，再重发图片。",
        );
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      if (downloadErrors.length && !imageInputs.length && !fileSections.length && !promptText.trim()) {
        await transport.replyText(msg.messageId, `没有可处理的内容：${downloadErrors.join("；")}`);
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      const prompt = buildPrompt(msg, promptText, fileSections, imageInputs, skippedImageCount, modelSupportsImage, downloadErrors);
      const status = new TaskStatusCard(key, msg.messageId, transport, this.conversations.getWorkspace(key));
      await status.start();
      const modelStartedAt = Date.now();
      await this.conversations.promptWithImages(key, prompt, imageInputs, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      }, status);
      debugLog("feishu.model.completed", { messageId: msg.messageId, latencyMs: Date.now() - modelStartedAt });
      await markFeishuMessage(msg.messageId, "replied");
      debugLog("feishu.message.completed", { messageId: msg.messageId, latencyMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.handler.error", { messageId: msg.messageId, error: message });
      await markFeishuMessage(msg.messageId, "failed", message);
      await this.getTransport()?.replyText(msg.messageId, `OMP error: ${message}`);
      debugLog("feishu.message.failed", { messageId: msg.messageId, latencyMs: Date.now() - startedAt });
    }
  }

  private async handleCommand(msg: FeishuMessage, key: string, text: string) {
    const command = parseBotCommand(text);
    if (!command) return false;

    const transport = this.getTransport();
    if (!transport) return true;

    if (command.name === "new") {
      await this.conversations.newConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "model") {
      debugLog("feishu.command.model.start", { messageId: msg.messageId, key });
      const models = await this.conversations.getAvailableModels();
      debugLog("feishu.command.model.models_loaded", { messageId: msg.messageId, key, count: models.length });
      if (!models.length) {
        await transport.replyText(msg.messageId, "当前没有可用模型。请先在 OMP 里完成模型登录或 API Key 配置。");
        return true;
      }
      const currentModel = await this.conversations.getSelectedModel(key);
      await transport.replyCard(msg.messageId, buildModelCard(key, models, currentModel));
      debugLog("feishu.command.model.replied", { messageId: msg.messageId, key });
      return true;
    }

    if (command.name === "resume") {
      const page = await this.conversations.listResumeSessions(key, "current", 0);
      await transport.replyCard(msg.messageId, buildResumeCard(page));
      return true;
    }

    if (command.name === "stop") {
      await this.conversations.stopConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "help") {
      await transport.replyText(msg.messageId, feishuHelpText());
      return true;
    }

    if (command.name === "setup") {
      await transport.replyText(
        msg.messageId,
        "/feishu setup 需要交互式界面，请在 OMP 后台运行。飞书端暂不支持扫码或输入表单配置；配置好后运行 /feishu restart 生效。",
      );
      return true;
    }

    if (command.name === "status") {
      const text = await this.diagnostics?.status?.(this.diagnostics?.isAdmin?.(msg.senderOpenId) === true);
      await transport.replyText(msg.messageId, text || "状态功能尚未准备好，请在 OMP 中运行 /feishu status。");
      return true;
    }

    if (command.name === "debug" || command.name === "refresh") {
      if (!this.diagnostics?.isAdmin?.(msg.senderOpenId)) {
        await transport.replyText(msg.messageId, `无权执行远程 ${command.name}。请在 OMP 中运行 /feishu ${command.name}，或将你的 Open ID 加入 adminOpenIds：${msg.senderOpenId}`);
        return true;
      }
      const text = command.name === "debug"
        ? await this.diagnostics?.debug?.()
        : await this.diagnostics?.refresh?.();
      await transport.replyText(msg.messageId, text || "该功能尚未准备好，请在 OMP 中运行 /feishu " + command.name + ".");
      return true;
    }

    if (command.name === "config") {
      if (!this.diagnostics?.isAdmin?.(msg.senderOpenId)) {
        await transport.replyText(
          msg.messageId,
          `无权查看远程配置。请将你的 Open ID 加入 adminOpenIds：${msg.senderOpenId}`,
        );
        return true;
      }
      const text = await this.diagnostics?.config?.();
      await transport.replyText(msg.messageId, text || "配置报告尚未准备好，请在 OMP 中运行 /feishu config。");
      return true;
    }

    if (command.name === "doctor" || command.name === "version") {
      const detailed = this.diagnostics?.isAdmin?.(msg.senderOpenId) === true;
      const text = command.name === "doctor"
        ? await this.diagnostics?.doctor(detailed)
        : this.diagnostics?.version(detailed);
      await transport.replyText(msg.messageId, text || "诊断功能尚未准备好，请在 OMP 中运行 /feishu doctor 或 /feishu version。");
      return true;
    }

    if (command.name === "upgrade") {
      if (!this.diagnostics?.isAdmin?.(msg.senderOpenId)) {
        await transport.replyText(msg.messageId, `无权执行远程升级。请在 OMP 中运行 /feishu upgrade，或将你的 Open ID 加入 adminOpenIds：${msg.senderOpenId}`);
        return true;
      }
      // 先回执，再触发升级：daemon 内升级会重启进程，入口回复必须先发出。
      await transport.replyText(msg.messageId, "收到，正在检查并升级插件…升级成功后服务会自动重启恢复。");
      const report = await this.diagnostics?.upgrade?.(command.version, {
        chatId: msg.chatId,
        messageId: msg.messageId,
        sessionKey: key,
        chatType: msg.chatType,
      });
      if (report) await transport.replyText(msg.messageId, report);
      return true;
    }

    if (command.name === "send") {
      if (!this.diagnostics?.isAdmin?.(msg.senderOpenId)) {
        await transport.replyText(
          msg.messageId,
          `发送文件需要管理员权限。请将你的 Open ID 加入 adminOpenIds：${msg.senderOpenId}`,
        );
        return true;
      }
      try {
        const filePath = this.conversations.resolveWorkspaceFile(key, command.path);
        const sent = await transport.replyLocalFile(msg.messageId, filePath);
        await transport.replyText(msg.messageId, sent?.fileName ? `${sent.fileName} 已发送。` : "文件已发送。");
      } catch (error) {
        await transport.replyText(msg.messageId, `无法发送文件：${error instanceof Error ? error.message : String(error)}\n用法：/send 文件路径`);
      }
      return true;
    }

    if (command.name === "workspace") {
      if (!this.diagnostics?.isAdmin?.(msg.senderOpenId)) {
        await transport.replyText(
          msg.messageId,
          `切换工作区需要管理员权限。请将你的 Open ID 加入 adminOpenIds：${msg.senderOpenId}`,
        );
        return true;
      }
      await this.conversations.switchWorkspace(key, command.path, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    return false;
  }

  private isDuplicateContent(msg: FeishuMessage, key: string, text: string, attachments: Array<{ kind: string; fileKey: string; fileName?: string }>) {
    const now = Date.now();
    const attachmentKey = attachments.map((a) => `${a.kind}:${a.fileKey}:${a.fileName || ""}`).join("|");
    const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text), attachmentKey].join("\u0000");
    const previousContentAt = this.recentContent.get(contentKey);
    if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return true;
    this.recentContent.set(contentKey, now);
    if (this.recentContent.size > 2000) pruneRecentMap(this.recentContent, now, CONTENT_DEDUPE_TTL_MS);
    return false;
  }

  private async processAttachments(
    msg: FeishuMessage,
    attachments: Array<{ kind: "image" | "file" | "audio"; fileKey: string; fileName?: string }>,
    modelSupportsImage: boolean,
  ) {
    const transport = this.getTransport();
    const imageInputs: FeishuImageInput[] = [];
    const fileSections: string[] = [];
    const transcribedParts: string[] = [];
    const downloadErrors: string[] = [];
    let skippedImageCount = 0;

    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        if (!modelSupportsImage) {
          skippedImageCount += 1;
          continue;
        }
        if (!transport) {
          downloadErrors.push("飞书连接不可用，图片无法下载");
          continue;
        }
        try {
          const resource = await withTimeout(
            transport.downloadImage(msg.messageId, attachment.fileKey),
            15000,
            "图片下载超时",
          );
          const mimeType = detectImageMime(resource.bytes, resource.mimeType);
          if (!isSupportedImageMime(mimeType)) {
            downloadErrors.push("图片格式暂不支持（仅支持 png/jpg/webp）");
            continue;
          }
          imageInputs.push({
            type: "image",
            data: resource.bytes.toString("base64"),
            mimeType,
          });
        } catch (error) {
          debugLog("feishu.handler.image_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
          downloadErrors.push(error instanceof Error ? error.message : "图片下载失败");
        }
        continue;
      }

      if (attachment.kind === "audio") {
        if (!transport) {
          downloadErrors.push("飞书连接不可用，语音无法下载");
          continue;
        }
        try {
          await transport.replyPlainText(msg.messageId, "正在识别语音，请稍候…");
          const resource = await withTimeout(
            transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
            15000,
            "语音下载超时",
          );
          transcribedParts.push(await withTimeout(
            transcribeTencentAudio(resource.bytes, resource.mimeType, attachment.fileName),
            35000,
            "语音识别超时",
          ));
        } catch (error) {
          debugLog("feishu.handler.audio_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
          downloadErrors.push(error instanceof Error ? error.message : "语音识别失败");
        }
        continue;
      }

      const fileName = attachment.fileName || "unnamed";
      if (!isSupportedTextFile(fileName)) {
        downloadErrors.push(`文件类型不支持：${fileName}`);
        continue;
      }
      if (!transport) {
        downloadErrors.push(`飞书连接不可用，文件无法下载：${fileName}`);
        continue;
      }
      try {
        const resource = await withTimeout(
          transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
          15000,
          `文件下载超时：${fileName}`,
        );
        const decoded = decodeTextFile(fileName, resource.bytes);
        if (!decoded.ok) {
          downloadErrors.push(`文件无法按文本读取：${fileName}`);
          continue;
        }
        const language = detectCodeLanguage(fileName);
        const suffix = decoded.truncated ? "\n[内容过长，已截断]" : "";
        fileSections.push(`[Feishu file: ${fileName}]\n\`\`\`${language}\n${decoded.text}${suffix}\n\`\`\``);
      } catch (error) {
        downloadErrors.push(error instanceof Error ? error.message : `文件下载失败：${fileName}`);
      }
    }

    return { imageInputs, fileSections, transcribedText: transcribedParts.join("\n\n"), downloadErrors, skippedImageCount };
  }
}

function buildPrompt(
  msg: FeishuMessage,
  text: string,
  fileSections: string[],
  imageInputs: FeishuImageInput[],
  skippedImageCount: number,
  modelSupportsImage: boolean,
  downloadErrors: string[],
) {
  const contentParts: string[] = [];
  if (text.trim()) contentParts.push(text.trim());
  if (fileSections.length) contentParts.push(fileSections.join("\n\n"));
  if (!contentParts.length && imageInputs.length) {
    contentParts.push("请根据图片内容进行分析。");
  }

  if (skippedImageCount > 0 && !modelSupportsImage) {
    contentParts.push("[提示：当前模型不支持图片，本次仅处理文本/文件内容。]");
  }

  if (downloadErrors.length) {
    contentParts.push(`[部分附件未处理：${downloadErrors.join("；")}]`);
  }

  const promptBody = contentParts.join("\n\n").trim();
  return `${conversationLabel(msg)} ${promptBody}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
