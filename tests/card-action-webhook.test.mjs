import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { FeishuCardActionWebhook } from "../extension/card-action-webhook.ts";

test("card action webhook rejects a real HTTP request without its bearer token", async () => {
  const port = await freePort();
  const webhook = new FeishuCardActionWebhook({
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    groupPolicy: "open",
    cardActionMode: "webhook",
    cardActionToken: "card-token",
    cardActionWebhookHost: "127.0.0.1",
    cardActionWebhookPort: port,
    cardActionWebhookPath: "/webhook/card",
  }, async () => undefined);

  await webhook.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: 401, msg: "unauthorized" });
  } finally {
    await webhook.stop();
  }
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  return address.port;
}
