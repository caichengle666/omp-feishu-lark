import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".tmp-gateway-config-test");
process.env.OMP_FEISHU_ROOT = join(root, "feishu");
process.env.OMP_AGENT_DIR = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const { MODELS_PATH, addGateway, listGateways, removeGateway, testGateway } = await import("../extension/gateway-config.ts");

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("add gateway preserves config, enables discovery, and writes a backup", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(MODELS_PATH, "defaults:\n  contextWindow: 32000\nproviders:\n  old:\n    baseUrl: https://old.example/v1\n    apiKey: old-secret\n    models: []\n", "utf8");

  await addGateway("edge", "https://api.example.test/v1/", "new-secret");

  const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
  assert.equal(config.defaults.contextWindow, 32000);
  assert.equal(config.providers.old.baseUrl, "https://old.example/v1");
  assert.equal(config.providers.edge.baseUrl, "https://api.example.test/v1");
  assert.equal(config.providers.edge.api, "openai-completions");
  assert.deepEqual(config.providers.edge.discovery, { type: "openai-models-list", timeoutMs: 15000 });
  assert.equal(config.providers.edge.apiKey, "new-secret");
  assert.equal(existsSync(`${MODELS_PATH}.bak-feishu`), true);
  assert.doesNotMatch(JSON.stringify(listGateways()), /new-secret/);
});

test("remove gateway requires confirmation and preserves other providers", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(MODELS_PATH, "providers:\n  edge:\n    baseUrl: https://api.example.test/v1\n    apiKey: secret\n  keep:\n    baseUrl: https://keep.example/v1\n", "utf8");

  await assert.rejects(removeGateway("edge"), /需要确认/);
  await removeGateway("edge", "confirm");
  const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
  assert.equal(config.providers.edge, undefined);
  assert.equal(config.providers.keep.baseUrl, "https://keep.example/v1");
});

test("test gateway sends bearer auth to the real models endpoint", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/models");
      assert.equal(request.headers.get("authorization"), "Bearer test-secret");
      return Response.json({ data: [{ id: "one" }, { id: "two" }] });
    },
  });
  try {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(MODELS_PATH, Bun.YAML.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-secret" } } }), "utf8");
    const result = await testGateway("local");
    assert.equal(result.status, 200);
    assert.equal(result.modelCount, 2);
  } finally {
    server.stop(true);
  }
});

test("gateway validation rejects unsafe names, URLs, and APIs", async () => {
  await assert.rejects(addGateway("bad name", "https://api.example.test", "secret"), /网关名称/);
  await assert.rejects(addGateway("edge", "file:///tmp/models", "secret"), /只支持 http/);
  await assert.rejects(addGateway("edge", "https://api.example.test", "secret", "unknown-api"), /不支持的 API/);
});
