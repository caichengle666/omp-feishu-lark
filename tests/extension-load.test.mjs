import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeGatewayLockKey } from "../src/installer-state.ts";

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
  assert.match(source, /readSupervisorRecord\(SUPERVISOR_PID_PATH\)/);
  assert.match(source, /writeStopRequest\(SUPERVISOR_STOP_PATH, supervisor\)/);
  assert.match(source, /waitForSupervisorExit\(supervisor, 15_000\)/);
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

test("upgrade prepares the new version before stopping the running daemon/supervisor", () => {
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  const compileOk = installerSource.indexOf("ok(\"Plugin compile check passed\");");
  const stopSupervisor = installerSource.indexOf("await stopExistingProcess(supervisorPidPath, supervisorStopPath);");
  const replace = installerSource.indexOf("replacePluginDirectory(stagingDir, pluginDir);");
  assert.ok(compileOk > 0 && stopSupervisor > compileOk, "new code must compile before the old service is stopped");
  assert.ok(replace > stopSupervisor, "old service must stop before the directory swap");
  assert.match(installerSource, /installer lock acquired/);
  assert.match(installerSource, /acquireInstallerLease\(installLockPath\)/);
  assert.match(installerSource, /removeGatewayLockKey\(locks\)/);
  assert.doesNotMatch(installerSource, /rmSync\(path, \{ force: true, maxRetries: 3, retryDelay: 200 \}\)/);
});

test("installer removes only the Feishu gateway key from locks.json", () => {
  const locks = { "unrelated.lock": { status: "held" }, "pi-feishu-lark.feishu-gateway": { status: "connected" } };
  const after = removeGatewayLockKey(locks);
  assert.deepEqual(Object.keys(after), ["unrelated.lock"]);
  assert.equal(after["unrelated.lock"].status, "held");
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
  assert.match(installerSource, /const daemonExecutable = bunBin;/);
  assert.match(installerSource, /\[ompBin, \.\.\.daemonArgs\]/);
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
  assert.match(source, /help.*setup.*start.*stop.*restart.*refresh.*status.*doctor.*version.*debug.*autostart.*reset/s);
  assert.match(source, /const cmd = cmdRaw \|\| "status"/);
  assert.match(source, /ctx\.ui\.notify\(feishuHelpText\(\), "info"\)/);
});

test("provides doctor/version diagnostics and injects the release version into daemons", () => {
  const source = readFileSync(extensionPath, "utf8");
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.match(source, /async function doctorReport/);
  assert.match(source, /function versionReport/);
  assert.match(source, /formatStartError/);
  assert.match(installerSource, /FEISHU_PLUGIN_VERSION/);
});

test("keeps the release version readable after the installer rewrites runtime package.json", () => {
  const source = readFileSync(extensionPath, "utf8");
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.match(source, /omp-plugins\.lock\.json/);
  assert.match(source, /FEISHU_PLUGIN_VERSION/);
  assert.match(installerSource, /version: packageManifest\.version/);
  assert.match(installerSource, /FEISHU_PLUGIN_VERSION: packageManifest\.version/);
});

test("exposes doctor/version commands to Feishu messages as well as OMP", () => {
  const messagesSource = readFileSync(join(repoRoot, "extension", "messages.ts"), "utf8");
  const handlerSource = readFileSync(join(repoRoot, "extension", "message-handler.ts"), "utf8");
  assert.match(messagesSource, /\/feishu doctor/);
  assert.match(messagesSource, /\/feishu version/);
  assert.match(handlerSource, /command\.name === "doctor" \|\| command\.name === "version"/);
});

test("exposes the shared Chinese help command in OMP and Feishu", () => {
  const messagesSource = readFileSync(join(repoRoot, "extension", "messages.ts"), "utf8");
  const handlerSource = readFileSync(join(repoRoot, "extension", "message-handler.ts"), "utf8");
  const helpSource = readFileSync(join(repoRoot, "extension", "help.ts"), "utf8");
  assert.match(messagesSource, /\/feishu help/);
  assert.match(handlerSource, /command\.name === "help"/);
  assert.match(helpSource, /\/feishu setup - 配置飞书应用/);
  assert.match(helpSource, /\/workspace PATH - 切换当前聊天的工作目录/);
});

test("installs and manages the proactive notification webhook", () => {
  const source = readFileSync(extensionPath, "utf8");
  const installerSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  assert.match(source, /new FeishuNotificationWebhook\(cfg, bridgeStore, delivery\)/);
  assert.match(source, /await notificationWebhook\.start\(\)/);
  assert.match(source, /await notificationWebhook\?\.stop\(\)/);
  assert.match(installerSource, /"notification-webhook\.ts"/);
  assert.match(installerSource, /"help\.ts"/);
});

test("notifies an interactive OMP session when gateway ownership is lost", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.match(source, /uiRef\?\.notify\?\.\("飞书连接已由另一个进程接管/);
});
