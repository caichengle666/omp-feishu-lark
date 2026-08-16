import assert from "node:assert/strict";
import test from "node:test";
import { isFeishuAdmin, validateConfig } from "../extension/config.ts";

const base = {
  appId: "cli_test",
  appSecret: "secret",
  domain: "feishu",
  groupPolicy: "open",
};

test("notification webhook remains disabled by default", () => {
  const config = validateConfig(base);
  assert.equal(config?.notificationWebhookEnabled, false);
  assert.equal(config?.notificationWebhookHost, "127.0.0.1");
  assert.equal(config?.notificationWebhookPort, 3002);
  assert.equal(config?.notificationWebhookPath, "/webhook/notify");
  assert.equal(config?.promptTimeoutEnabled, false);
});

test("enabled notification webhook requires a token and validates its port", () => {
  assert.equal(validateConfig({ ...base, notificationWebhookEnabled: true }), undefined);
  assert.equal(validateConfig({ ...base, notificationWebhookEnabled: true, notificationWebhookToken: "token", notificationWebhookPort: 70000 }), undefined);
  const config = validateConfig({ ...base, notificationWebhookEnabled: true, notificationWebhookToken: "token", notificationWebhookPath: "ci" });
  assert.equal(config?.notificationWebhookPath, "/ci");
  assert.equal(config?.notificationWebhookToken, "token");
});

test("card action webhook mode requires a verification token", () => {
  assert.equal(validateConfig({ ...base, cardActionMode: "webhook" }), undefined);
  const config = validateConfig({ ...base, cardActionMode: "webhook", cardActionToken: "card-token" });
  assert.equal(config?.cardActionMode, "webhook");
  assert.equal(config?.cardActionToken, "card-token");
});

test("remote administration is denied by default and allows configured open IDs", () => {
  assert.equal(isFeishuAdmin(validateConfig(base), "ou_admin"), false);
  const config = validateConfig({ ...base, adminOpenIds: [" ou_admin ", "ou_admin"] });
  assert.deepEqual(config?.adminOpenIds, ["ou_admin"]);
  assert.equal(isFeishuAdmin(config, "ou_admin"), true);
  assert.equal(isFeishuAdmin(config, "ou_other"), false);
});
