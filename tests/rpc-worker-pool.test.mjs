import assert from "node:assert/strict";
import test from "node:test";
import { FeishuRpcWorkerPool } from "../extension/rpc-worker-pool.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeClient(name, gate) {
  const calls = [];
  let aborted = 0;
  return {
    calls,
    get aborted() { return aborted; },
    start: async () => { calls.push(["start"]); },
    stop: async () => { calls.push(["stop"]); },
    switchSession: async (path) => { calls.push(["session", path]); return { cancelled: false }; },
    setModel: async (provider, id) => { calls.push(["model", provider, id]); return { provider, id }; },
    promptAndWait: async (text) => { calls.push(["prompt", text]); await gate?.promise; },
    abort: async () => { aborted += 1; gate?.resolve(); },
    getLastAssistantText: async () => `reply:${name}`,
    getMessages: async () => [{ role: "assistant", content: [{ type: "text", text: `reply:${name}` }] }],
    getState: async () => ({ sessionId: `session:${name}`, sessionFile: `/sessions/${name}.json` }),
    onSessionEvent: () => () => {},
  };
}

test("isolates conversations in different workers and runs them concurrently", async () => {
  const gates = { a: deferred(), b: deferred() };
  const clients = new Map();
  const pool = new FeishuRpcWorkerPool(({ cwd }) => {
    const client = fakeClient(cwd, gates[cwd]);
    clients.set(cwd, client);
    return client;
  });
  const a = pool.prompt("chat-a", { cwd: "a", text: "A", images: [], timeoutMs: 1000, model: { provider: "p1", id: "m1" } });
  const b = pool.prompt("chat-b", { cwd: "b", text: "B", images: [], timeoutMs: 1000, model: { provider: "p2", id: "m2" } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(clients.get("a").calls.slice(0, 3), [["start"], ["model", "p1", "m1"], ["prompt", "A"]]);
  assert.deepEqual(clients.get("b").calls.slice(0, 3), [["start"], ["model", "p2", "m2"], ["prompt", "B"]]);
  gates.a.resolve();
  gates.b.resolve();
  assert.deepEqual(await Promise.all([a, b]), [
    { text: "reply:a", sessionFile: "/sessions/a.json" },
    { text: "reply:b", sessionFile: "/sessions/b.json" },
  ]);
});

test("abort only targets the requested conversation", async () => {
  const gates = { a: deferred(), b: deferred() };
  const clients = new Map();
  const pool = new FeishuRpcWorkerPool(({ cwd }) => {
    const client = fakeClient(cwd, gates[cwd]);
    clients.set(cwd, client);
    return client;
  });
  const a = pool.prompt("chat-a", { cwd: "a", text: "A", images: [], timeoutMs: 1000 });
  const b = pool.prompt("chat-b", { cwd: "b", text: "B", images: [], timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await pool.abort("chat-a"), true);
  assert.equal(clients.get("a").aborted, 1);
  assert.equal(clients.get("b").aborted, 0);
  gates.b.resolve();
  await Promise.all([a, b]);
});

test("abort during worker startup prevents the prompt from being submitted", async () => {
  const startGate = deferred();
  const client = fakeClient("starting");
  client.start = async () => {
    client.calls.push(["start"]);
    await startGate.promise;
  };
  const pool = new FeishuRpcWorkerPool(() => client);
  const prompt = pool.prompt("chat", { cwd: "a", text: "must-not-run", images: [], timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(await pool.abort("chat"), true);
  startGate.resolve();
  await assert.rejects(prompt, /cancelled before submission/);
  assert.equal(client.calls.some(([name]) => name === "prompt"), false);
});

test("restores only the session assigned to a conversation", async () => {
  const client = fakeClient("a");
  const pool = new FeishuRpcWorkerPool(() => client);
  await pool.prompt("chat-a", { cwd: "a", sessionFile: "/old/a.json", text: "continue", images: [], timeoutMs: 1000 });
  assert.deepEqual(client.calls.slice(0, 3), [["start"], ["session", "/old/a.json"], ["prompt", "continue"]]);
});

test("rebuilds a worker after startup fails", async () => {
  let attempts = 0;
  const pool = new FeishuRpcWorkerPool(() => {
    attempts += 1;
    const client = fakeClient(`attempt-${attempts}`);
    if (attempts === 1) client.start = async () => { throw new Error("start failed"); };
    return client;
  });
  await assert.rejects(pool.prompt("chat", { cwd: "a", text: "first", images: [], timeoutMs: 1000 }), /start failed/);
  const result = await pool.prompt("chat", { cwd: "a", text: "second", images: [], timeoutMs: 1000 });
  assert.equal(attempts, 2);
  assert.equal(result.text, "reply:attempt-2");
});

test("does not replay a submitted prompt after the worker crashes", async () => {
  let prompts = 0;
  const client = fakeClient("crash");
  client.promptAndWait = async () => { prompts += 1; throw new Error("worker exited"); };
  const pool = new FeishuRpcWorkerPool(() => client);
  await assert.rejects(pool.prompt("chat", { cwd: "a", text: "once", images: [], timeoutMs: 1000 }), /worker exited/);
  assert.equal(prompts, 1);
  assert.equal(client.calls.filter(([name]) => name === "stop").length, 1);
});

test("surfaces a provider error recorded on the assistant message", async () => {
  const client = fakeClient("error");
  client.getLastAssistantText = async () => null;
  client.getMessages = async () => [{ role: "assistant", content: [], errorMessage: "503 upstream error" }];
  const pool = new FeishuRpcWorkerPool(() => client);
  const result = await pool.prompt("chat", { cwd: "a", text: "request", images: [], timeoutMs: 1000 });
  assert.equal(result.text, "");
  assert.equal(result.error, "503 upstream error");
});

test("waits at the worker limit and reclaims the oldest idle worker", async () => {
  const firstGate = deferred();
  const clients = [];
  const pool = new FeishuRpcWorkerPool(({ cwd }) => {
    const client = fakeClient(cwd, cwd === "a" ? firstGate : undefined);
    clients.push(client);
    return client;
  }, { maxWorkers: 1 });
  const first = pool.prompt("chat-a", { cwd: "a", text: "A", images: [], timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = pool.prompt("chat-b", { cwd: "b", text: "B", images: [], timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(clients.length, 1);
  firstGate.resolve();
  await first;
  await second;
  assert.equal(clients.length, 2);
  assert.equal(clients[0].calls.filter(([name]) => name === "stop").length, 1);
});
