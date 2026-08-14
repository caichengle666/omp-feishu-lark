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
  assert.match(source, /waitForGatewayConnection\(launchToken, daemonStartTimeoutMs\(\)\)/);
  assert.match(source, /FEISHU_LAUNCH_TOKEN: launchToken/);
  assert.match(source, /owner\.launchToken === launchToken/);
  assert.match(source, /await waitForProcessExit\(supervisorPid, 15_000\)/);
  assert.match(source, /acquireFileLease\(lockPath\)/);
  assert.doesNotMatch(source, /return fn\(\);/);
  assert.doesNotMatch(source, /powershell|tail -f|spawn\("bash"/i);
});

test("stages and atomically replaces the plugin directory during upgrades", () => {
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.match(installerSource, /\.feishu-install-/);
  assert.match(installerSource, /replacePluginDirectory\(stagingDir, pluginDir\)/);
  assert.match(installerSource, /removeDirectory\(backup\)/);
  assert.match(installerSource, /--no-save/);
});

test("resolves RPC workers from a stable OMP CLI path", () => {
  const extensionSource = readFileSync(extensionPath, "utf8");
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.doesNotMatch(extensionSource, /Bun\.resolveSync/);
  assert.match(extensionSource, /process\.env\.OMP_CLI_PATH/);
  assert.match(extensionSource, /install", "global", "node_modules"/);
  assert.match(installerSource, /OMP_CLI_PATH: rpcOmpCli/);
  assert.match(installerSource, /process\.env\.OMP_BIN_PATH/);
  assert.match(installerSource, /readGlobalPackageRoots\("npm"\)/);
  assert.match(installerSource, /PI_CODING_AGENT_DIR/);
  assert.match(installerSource, /agentDir/);
  assert.match(installerSource, /OMP_PROFILE/);
  assert.match(installerSource, /FEISHU_LAUNCH_TOKEN: launchToken/);
  assert.match(installerSource, /entry\.launchToken === launchToken/);
  assert.match(installerSource, /Existing Feishu supervisor.*did not stop/);
});

test("passes the resolved model into the Feishu OMP session without awaiting its own cache", () => {
  const source = readFileSync(conversationManagerPath, "utf8");
  assert.match(source, /const model = await this\.resolveSelectedModel\(key, false\);/);
  assert.doesNotMatch(source, /const model = selected \?/);
});

test("documents the actual config and model-file ownership", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const configSource = readFileSync(join(repoRoot, "extension", "config.ts"), "utf8");
  assert.match(configSource, /getAgentDir/);
  assert.match(readme, /`\/feishu setup`/);
  assert.match(readme, /does not overwrite `models\.yml`/);
});

test("registers OMP argument completions for /feishu subcommands", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.match(source, /getArgumentCompletions: \(prefix\)/);
  assert.match(source, /setup.*start.*stop.*restart.*refresh.*status.*doctor.*version.*debug.*autostart.*reset/s);
  assert.match(source, /const cmd = cmdRaw \|\| "status"/);
  assert.match(source, /可用命令：\/feishu setup \| start \| stop \| restart \| refresh \| status \| doctor \| version \| debug \| autostart \| reset/);
});

test("provides doctor/version diagnostics and injects the release version into daemons", () => {
  const source = readFileSync(extensionPath, "utf8");
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.match(source, /async function doctorReport/);
  assert.match(source, /function versionReport/);
  assert.match(source, /formatStartError/);
  assert.match(installerSource, /FEISHU_PLUGIN_VERSION/);
});

test("exposes doctor/version commands to Feishu messages as well as OMP", () => {
  const messagesSource = readFileSync(join(repoRoot, "extension", "messages.ts"), "utf8");
  const handlerSource = readFileSync(join(repoRoot, "extension", "message-handler.ts"), "utf8");
  assert.match(messagesSource, /\/feishu doctor/);
  assert.match(messagesSource, /\/feishu version/);
  assert.match(handlerSource, /command\.name === "doctor" \|\| command\.name === "version"/);
});

test("notifies an interactive OMP session when gateway ownership is lost", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.match(source, /uiRef\?\.notify\?\.\("飞书连接已由另一个进程接管/);
});
