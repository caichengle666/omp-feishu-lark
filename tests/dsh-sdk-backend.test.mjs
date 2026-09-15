import assert from "node:assert/strict";
import test from "node:test";
import { DshSdkBackend } from "../extension/dsh-sdk-backend.ts";

function fakeRuntimeScript() {
  return `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    rl.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id: request.id, result: { serverInfo: { name: "fake", version: "1" } } });
      } else if (request.method === "session/prompt") {
        const sessionId = request.params.sessionId;
        send({ jsonrpc: "2.0", id: request.id, result: { messageId: "message-1" } });
        send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "child-session", event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "wrong" }] } } } } });
        send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: "running" } });
        send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "right" }] } } } } });
        send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: "idle" } });
      } else if (request.method === "session/cancel") {
        send({ jsonrpc: "2.0", id: request.id, result: { accepted: true } });
      } else if (request.method === "shutdown") {
        send({ jsonrpc: "2.0", id: request.id, result: {} });
      }
    });
  `;
}

function options() {
  return {
    cwd: process.cwd(),
    text: "hello",
    images: [],
    timeoutMs: 5_000,
    onSessionEvent: () => {},
  };
}

test("DSH backend isolates the root session from child-agent notifications", async () => {
  const backend = new DshSdkBackend(process.execPath, ["-e", fakeRuntimeScript()], "p", "m");
  const result = await backend.prompt("chat-1", options());
  assert.equal(result.text, "right");
  await backend.disposeAll();
});
