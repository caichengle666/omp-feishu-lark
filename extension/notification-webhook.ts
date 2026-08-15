import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { debugLog } from "./debug.js";
import type { FeishuBridgeStore } from "./bridge-store.js";
import type { FeishuDelivery } from "./delivery.js";
import type { FeishuConfig } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

type NotificationBody = {
  sessionKey: string;
  text: string;
  eventId?: string;
};

export class FeishuNotificationWebhook {
  private server: Server | undefined;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: FeishuConfig,
    private readonly store: FeishuBridgeStore,
    private readonly delivery: FeishuDelivery,
  ) {}

  async start() {
    if (this.server) return;
    if (!this.config.notificationWebhookToken) throw new Error("Notification webhook token is required");
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(
        this.config.notificationWebhookPort || 3002,
        this.config.notificationWebhookHost || "127.0.0.1",
        () => {
          server.off("error", onError);
          resolve();
        },
      );
    });
    server.on("error", (error) => {
      debugLog("feishu.notification_webhook.server_error", { error: error.message });
    });
    this.server = server;
    debugLog("feishu.notification_webhook.started", { endpoint: this.getEndpointLabel() });
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    debugLog("feishu.notification_webhook.stopped");
  }

  getEndpointLabel() {
    return `http://${this.config.notificationWebhookHost || "127.0.0.1"}:${this.config.notificationWebhookPort || 3002}${this.config.notificationWebhookPath || "/webhook/notify"}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      if (request.method !== "POST" || request.url !== (this.config.notificationWebhookPath || "/webhook/notify")) {
        return sendJson(response, 404, { ok: false, error: "not_found" });
      }
      if (!tokenMatches(request.headers.authorization, this.config.notificationWebhookToken || "")) {
        return sendJson(response, 401, { ok: false, error: "unauthorized" });
      }
      const body = parseNotificationBody(await readBody(request));
      const route = this.store.getRoute(body.sessionKey);
      if (!route) return sendJson(response, 404, { ok: false, error: "route_not_found" });

      const deliveryKey = body.eventId ? `webhook:${body.sessionKey}:${body.eventId}` : undefined;
      if (deliveryKey && (this.store.hasSent(deliveryKey) || this.inFlight.has(deliveryKey))) {
        return sendJson(response, 200, { ok: true, duplicate: true });
      }
      if (deliveryKey) this.inFlight.add(deliveryKey);
      try {
        await this.delivery.send(route, body.text);
        if (deliveryKey) this.store.markSent(deliveryKey);
      } finally {
        if (deliveryKey) this.inFlight.delete(deliveryKey);
      }
      debugLog("feishu.notification_webhook.delivered", { sessionKey: body.sessionKey, eventId: body.eventId });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      const status = error instanceof WebhookRequestError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.notification_webhook.error", { status, error: message });
      return sendJson(response, status, { ok: false, error: status === 500 ? "delivery_failed" : message });
    }
  }
}

class WebhookRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new WebhookRequestError(413, "body_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WebhookRequestError(400, "invalid_json");
  }
}

function parseNotificationBody(value: unknown): NotificationBody {
  if (!value || typeof value !== "object") throw new WebhookRequestError(400, "invalid_body");
  const raw = value as Record<string, unknown>;
  const sessionKey = typeof raw.sessionKey === "string" ? raw.sessionKey.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const eventId = typeof raw.eventId === "string" ? raw.eventId.trim() : undefined;
  if (!sessionKey || !text) throw new WebhookRequestError(400, "sessionKey_and_text_required");
  if (eventId !== undefined && !eventId) throw new WebhookRequestError(400, "invalid_eventId");
  return { sessionKey, text, eventId };
}

function tokenMatches(authorization: string | undefined, expected: string) {
  const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function sendJson(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
