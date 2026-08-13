import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "extension", "index.ts");
const conversationManagerPath = join(repoRoot, "extension", "conversation-manager.ts");

test("compiles against the OMP 17 extension boundary", () => {
  const result = spawnSync(process.execPath, [
    "build",
    "--target=bun",
    "--external",
    "@oh-my-pi/pi-coding-agent",
    "--external",
    "@larksuiteoapi/node-sdk",
    "--external",
    "qrcode-terminal",
    "--outfile=/dev/null",
    extensionPath,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  assert.equal(result.status, 0, output || `bun exited via ${result.signal || "unknown signal"}`);
});

test("uses the OMP 17 ModelRegistry adapter", () => {
  const source = readFileSync(conversationManagerPath, "utf8");
  assert.match(source, /from "@oh-my-pi\/pi-coding-agent"/);
  assert.match(source, /ModelRegistry/);
  assert.match(source, /discoverAuthStorage/);
  assert.doesNotMatch(source, /@earendil-works\/pi-coding-agent/);
});

test("keeps refresh non-destructive and handles atomic model-file replacement", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.doesNotMatch(source, /cmd === "refresh"[\s\S]{0,200}resetMemory/);
  assert.match(source, /watch\(dirname\(modelsPath\)/);
  assert.match(source, /filename\.toString\(\) !== modelsName/);
});

test("starts the detached Feishu gateway through the shared cross-platform supervisor", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.match(source, /feishu-supervisor\.mjs/);
  assert.match(source, /"--stop", SUPERVISOR_STOP_PATH/);
  assert.match(source, /waitForGatewayConnection\(15_000\)/);
  assert.doesNotMatch(source, /powershell|tail -f|spawn\("bash"/i);
});

test("resolves RPC workers from a stable OMP CLI path", () => {
  const extensionSource = readFileSync(extensionPath, "utf8");
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.doesNotMatch(extensionSource, /Bun\.resolveSync/);
  assert.match(extensionSource, /process\.env\.OMP_CLI_PATH/);
  assert.match(extensionSource, /install", "global", "node_modules"/);
  assert.match(installerSource, /OMP_CLI_PATH: rpcOmpCli/);
});

test("passes the resolved model into the Feishu OMP session without awaiting its own cache", () => {
  const source = readFileSync(conversationManagerPath, "utf8");
  assert.match(source, /const model = await this\.resolveSelectedModel\(key, false\);/);
  assert.doesNotMatch(source, /const model = selected \?/);
});

