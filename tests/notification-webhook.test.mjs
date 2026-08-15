import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { FeishuNotificationWebhook } from "../extension/notification-webhook.ts";

test("notification webhook authenticates, routes, delivers, and deduplicates", async () => {
  const port = await freePort();
  const sent = new Set();
  const deliveries = [];
  const route = { sessionKey: "group:test", chatId: "oc_test", chatType: "group", lastMessageId: "om_test", updatedAt: Date.now() };
  const store = {
    getRoute: (key) => key === route.sessionKey ? route : undefined,
    hasSent: (key) => sent.has(key),
    markSent: (key) => sent.add(key),
  };
  const delivery = { send: async (target, text) => deliveries.push({ target, text }) };
  const webhook = new FeishuNotificationWebhook({
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    groupPolicy: "open",
    notificationWebhookEnabled: true,
    notificationWebhookHost: "127.0.0.1",
    notificationWebhookPort: port,
    notificationWebhookPath: "/webhook/notify",
    notificationWebhookToken: "test-token",
  }, store, delivery);

  await webhook.start();
  try {
    const endpoint = `http://127.0.0.1:${port}/webhook/notify`;
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.equal((await request(endpoint, "test-token", { sessionKey: "missing", text: "hello" })).status, 404);

    const first = await request(endpoint, "test-token", { sessionKey: "group:test", text: "CI failed", eventId: "run-1" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].text, "CI failed");

    const duplicate = await request(endpoint, "test-token", { sessionKey: "group:test", text: "CI failed", eventId: "run-1" });
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
    assert.equal(deliveries.length, 1);
  } finally {
    await webhook.stop();
  }
});

function request(url, token, body) {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  return address.port;
}
