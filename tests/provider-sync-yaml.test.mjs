import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".tmp-provider-sync-yaml-test");
process.env.OMP_FEISHU_ROOT = join(root, "feishu");
process.env.OMP_AGENT_DIR = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const { MODELS_PATH, syncProvider } = await import("../extension/provider-config.ts");

afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedModels(extra) {
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(MODELS_PATH, Bun.YAML.stringify({
    providers: {
      managed: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "secret",
        api: "openai-completions",
        feishuManaged: true,
        models: [{ id: "kept", name: "Kept", api: "openai-completions", contextWindow: 128000, maxTokens: 8192, input: ["text", "image"], reasoning: true }],
        ...extra,
      },
    },
  }, null, 2), "utf8");
}

test("sync writes indented multi-line YAML instead of one unreadable line", async () => {
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ data: [{ id: "kept" }, { id: "fresh" }] }); } });
  try {
    seedModels({ baseUrl: `http://127.0.0.1:${server.port}/v1` });
    await syncProvider("managed");
    const raw = readFileSync(MODELS_PATH, "utf8");
    assert.match(raw, /\n/);
    assert.match(raw, /\n  managed:/);
    assert.match(raw, /\n    baseUrl:/);
    assert.doesNotMatch(raw, /\{providers:/);
  } finally {
    server.stop(true);
  }
});

test("sync keeps hand-written model metadata that upstream /models never returns", async () => {
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ data: [{ id: "kept" }, { id: "fresh" }] }); } });
  try {
    seedModels({ baseUrl: `http://127.0.0.1:${server.port}/v1` });
    await syncProvider("managed");
    const config = Bun.YAML.parse(readFileSync(MODELS_PATH, "utf8"));
    const models = config.providers.managed.models;
    assert.equal(models.length, 2);
    const kept = models.find((item) => item.id === "kept");
    assert.equal(kept.contextWindow, 128000);
    assert.equal(kept.maxTokens, 8192);
    assert.deepEqual(kept.input, ["text", "image"]);
    assert.equal(kept.reasoning, true);
    const fresh = models.find((item) => item.id === "fresh");
    assert.equal(fresh.name, "fresh");
    assert.equal(fresh.api, "openai-completions");
  } finally {
    server.stop(true);
  }
});
