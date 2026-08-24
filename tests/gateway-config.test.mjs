import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".tmp-gateway-config-test");
process.env.OMP_FEISHU_ROOT = join(root, "feishu");
process.env.OMP_AGENT_DIR = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const { MODELS_PATH, addProvider, listProviders, removeProvider, syncAllProviders, syncProvider, testProvider } = await import("../extension/provider-config.ts");

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("add gateway preserves config, enables discovery, and writes a backup", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(MODELS_PATH, "defaults:\n  contextWindow: 32000\nproviders:\n  old:\n    baseUrl: https://old.example/v1\n    apiKey: old-secret\n    models: []\n", "utf8");

  await addProvider("edge", "https://api.example.test/v1/", "new-secret");

  const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
  assert.equal(config.defaults.contextWindow, 32000);
  assert.equal(config.providers.old.baseUrl, "https://old.example/v1");
  assert.equal(config.providers.edge.baseUrl, "https://api.example.test/v1");
  assert.equal(config.providers.edge.api, "openai-completions");
  assert.deepEqual(config.providers.edge.discovery, { type: "openai-models-list", timeoutMs: 15000 });
  assert.equal(config.providers.edge.apiKey, "new-secret");
  assert.equal(existsSync(`${MODELS_PATH}.bak-feishu`), true);
  assert.doesNotMatch(JSON.stringify(listProviders()), /new-secret/);
});

test("remove gateway requires confirmation and preserves other providers", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(MODELS_PATH, "providers:\n  edge:\n    baseUrl: https://api.example.test/v1\n    apiKey: secret\n  keep:\n    baseUrl: https://keep.example/v1\n", "utf8");

  await assert.rejects(removeProvider("edge"), /需要确认/);
  await removeProvider("edge", "confirm");
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
    const result = await testProvider("local");
    assert.equal(result.status, 200);
    assert.equal(result.modelCount, 2);
  } finally {
    server.stop(true);
  }
});

test("gateway validation rejects unsafe names, URLs, and APIs", async () => {
  await assert.rejects(addProvider("bad name", "https://api.example.test", "secret"), /Provider 名称/);
  await assert.rejects(addProvider("edge", "file:///tmp/models", "secret"), /只支持 http/);
  await assert.rejects(addProvider("edge", "https://api.example.test", "secret", "unknown-api"), /不支持的 API/);
  await assert.rejects(addProvider("edge", "https://user:pass@example.test", "secret"), /用户名/);
  await assert.rejects(addProvider("edge", "https://api.example.test?token=x", "secret"), /查询参数/);
  await assert.rejects(addProvider("edge", "https://api.example.test/#secret", "secret"), /片段/);
});

test("test auto provider persists the detected protocol", async () => {
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ data: [{ id: "detected" }] }); } });
  try {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(MODELS_PATH, Bun.YAML.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "secret", feishuManaged: true } } }), "utf8");
    const result = await testProvider("local");
    assert.equal(result.modelCount, 1);
    const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
    assert.equal(config.providers.local.api, "openai-completions");
  } finally {
    server.stop(true);
  }
});

test("auto protocol detects OpenAI-compatible providers and persists the result", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/models");
    return Response.json({ data: [{ id: "auto-model" }] });
  } });
  try {
    mkdirSync(join(root, "agent"), { recursive: true });
    await addProvider("auto", `http://127.0.0.1:${server.port}/v1`, "secret", "auto");
    const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
    assert.equal(config.providers.auto.api, "openai-completions");
    assert.deepEqual(config.providers.auto.discovery, { type: "openai-models-list", timeoutMs: 15000 });
  } finally {
    server.stop(true);
  }
});

test("sync provider persists upstream models only for managed providers", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/models");
      return Response.json({ data: [{ id: "new-model" }, { id: "second-model", name: "Second" }] });
    },
  });
  try {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(MODELS_PATH, Bun.YAML.stringify({ providers: {
      managed: { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "secret", feishuManaged: true },
      manual: { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "secret" },
    } }), "utf8");
    const result = await syncProvider("managed");
    assert.equal(result.modelCount, 2);
    const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
    assert.deepEqual(config.providers.managed.models, [
      { id: "new-model", name: "new-model", api: "openai-completions" },
      { id: "second-model", name: "Second", api: "openai-completions" },
    ]);
    await assert.rejects(syncProvider("manual"), /未启用自动同步/);
    assert.equal((await syncAllProviders()).length, 1);
  } finally {
    server.stop(true);
  }
});

test("anthropic gateway stores static models and skips discovery", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  await addProvider("claude", "https://api.example.test", "secret", "anthropic-messages", ["claude-sonnet-4-20250514", "claude-sonnet-4-20250514"]);
  const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
  assert.equal(config.providers.claude.api, "anthropic-messages");
  assert.equal(config.providers.claude.discovery, undefined);
  assert.deepEqual(config.providers.claude.models, [{ id: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514", api: "anthropic-messages" }]);
});

test("anthropic gateway requires a model and test only checks configuration", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  const name = `claude-${process.pid}-${Date.now()}`;
  await assert.rejects(addProvider(name, "https://127.0.0.1:1", "secret", "anthropic-messages"), /至少一个模型 ID/);
  await addProvider(name, "https://127.0.0.1:1", "secret", "anthropic-messages", ["claude-opus-4-1"]);
  const result = await testProvider(name);
  assert.equal(result.status, "configured");
  assert.equal(result.modelCount, 1);
});

test("concurrent gateway updates preserve both providers", async () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  await Promise.all([
    addProvider("one", "https://one.example.test", "secret"),
    addProvider("two", "https://two.example.test", "secret"),
  ]);
  const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
  assert.equal(config.providers.one.baseUrl, "https://one.example.test");
  assert.equal(config.providers.two.baseUrl, "https://two.example.test");
});
