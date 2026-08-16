import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { checkFeishuApp } from "../extension/setup.ts";

let server;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("setup validates credentials, bot capability, and required scopes over HTTP", async () => {
  const requests = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname.endsWith("tenant_access_token/internal")) {
        assert.equal(request.headers.get("content-type"), "application/json; charset=utf-8");
        assert.deepEqual(await request.json(), { app_id: "cli_test", app_secret: "secret" });
        return Response.json({ code: 0, tenant_access_token: "token" });
      }
      assert.equal(request.headers.get("authorization"), "Bearer token");
      if (url.pathname.endsWith("bot/v3/info")) return Response.json({ code: 0 });
      return Response.json({ code: 0, data: { scopes: [{ scope_name: "im:message" }, { scope_name: "im:message:send_as_bot" }] } });
    },
  });

  await checkFeishuApp({ appId: "cli_test", appSecret: "secret", domain: "feishu" }, server.url.origin);
  assert.deepEqual(requests, [
    "/open-apis/auth/v3/tenant_access_token/internal",
    "/open-apis/bot/v3/info",
    "/open-apis/application/v6/scopes",
  ]);
});

test("setup rejects missing Feishu permissions", async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "token" });
      if (path.endsWith("bot/v3/info")) return Response.json({ code: 0 });
      return Response.json({ code: 0, data: { scopes: [{ scope_name: "im:message" }] } });
    },
  });

  await assert.rejects(
    checkFeishuApp({ appId: "cli_test", appSecret: "secret", domain: "feishu" }, server.url.origin),
    /im:message:send_as_bot/,
  );
});
