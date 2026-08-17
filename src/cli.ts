#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { acquireInstallerLease, releaseInstallerLease } from "./installer-lock.js";
import { isSupervisorProcessAlive, readSupervisorRecord, recordedProcessStatus, writeStopRequest } from "../support/feishu-supervisor.mjs";
import { GATEWAY_LOCK_KEY, parseLocksFile, removeGatewayLockKey } from "./installer-state.js";
import { cleanupLegacyInstallations } from "./legacy-cleanup.js";
import { verifyRpcWorkerReady } from "./rpc-self-test.js";
import { bunDnsArgs, resolveUpgradeNetworkPolicy, upgradeNetworkAttempts, upgradeTimeoutMs } from "../extension/upgrade.js";

const isWindows = process.platform === "win32";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
};
const homeDir = process.env.HOME || process.env.USERPROFILE;
const timeoutSeconds = parsePositiveInt(process.env.OMP_FEISHU_TIMEOUT, 90);
const networkPolicy = resolveUpgradeNetworkPolicy(process.env.OMP_FEISHU_NETWORK);
const dnsArgs = bunDnsArgs(networkPolicy);

if (!homeDir) {
  console.error("Cannot determine the home directory. Set HOME or USERPROFILE and run again.");
  process.exit(1);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function info(message: string) {
  console.log(`  ${message}`);
}

function ok(message: string) {
  console.log(`  ✓ ${message}`);
}

function findCommand(name: string, candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const lookup = spawnSync(isWindows ? "where" : "which", [name], { encoding: "utf8" });
  const found = lookup.stdout.trim().split(/\r?\n/)[0];
  return found || "";
}

const args = process.argv.slice(2);
let pluginDir = "";
let workspace = "";
let reconfigure = false;
let restart = true;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--reconfigure") reconfigure = true;
  else if (arg === "--no-restart") restart = false;
  else if (arg === "--workspace") workspace = args[++index] || fail("--workspace needs a directory");
  else if (arg === "--help" || arg === "-h") {
    console.log("bunx @caichengle/omp-feishu-lark [PLUGIN_DIR] [--workspace DIR] [--reconfigure] [--no-restart]");
    process.exit(0);
  } else if (arg.startsWith("-")) fail(`Unknown option: ${arg}`);
  else pluginDir = arg;
}

const bunBin = findCommand("bun", [
  process.env.BUN_BIN_PATH || "",
  join(homeDir, ".bun", "bin", isWindows ? "bun.exe" : "bun"),
  isWindows ? "C:\\Program Files\\Bun\\bun.exe" : "/usr/local/bin/bun",
]);
const ompBin = findCommand("omp", [
  process.env.OMP_BIN_PATH || "",
  join(homeDir, ".bun", "bin", isWindows ? "omp.exe" : "omp"),
  isWindows ? "C:\\Program Files\\Bun\\omp.exe" : "/usr/local/bin/omp",
]);

if (!bunBin) fail("Bun was not found. Install Bun first, then rerun this command.");
if (!ompBin) fail("OMP was not found. Install OMP first, then rerun this command.");

const bundledOmpPackage = join(packageRoot, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json");
const compatibleOmpCli = existsSync(bundledOmpPackage)
  ? join(dirname(bundledOmpPackage), "dist", "cli.js")
  : "";
const globalOmpCliCandidates = [
  join(dirname(ompBin), "..", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
  join(dirname(bunBin), "..", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
  ...readGlobalPackageRoots("npm"),
].map((root) => root.endsWith("cli.js") ? root : join(root, "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
const configuredOmpCli = process.env.OMP_CLI_PATH || "";
const rpcOmpCli = [configuredOmpCli, compatibleOmpCli, ...globalOmpCliCandidates].find((candidate) => candidate && existsSync(candidate)) || "";
if (!rpcOmpCli) fail("Could not locate the OMP CLI used by RPC workers. Reinstall OMP or set OMP_CLI_PATH.");

const pythonBin = isWindows
  ? findCommand("python", ["python.exe"] ) || findCommand("py", ["py.exe"])
  : findCommand("python3", ["/usr/bin/python3", "/usr/local/bin/python3"]);

// OMP 17 exposes the resolved agent directory through its compatibility
// environment name PI_CODING_AGENT_DIR. This installer forwards it only so the
// detached OMP daemon and RPC workers use the same OMP profile directory.
const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.OMP_AGENT_DIR || join(homeDir, ".omp", "agent");
if (process.env.OMP_PROFILE && !process.env.PI_CODING_AGENT_DIR && !process.env.OMP_AGENT_DIR) {
  fail("OMP_PROFILE is set but no PI_CODING_AGENT_DIR was provided. Set PI_CODING_AGENT_DIR to the profile's agent directory so Feishu config and OMP state stay aligned.");
}
pluginDir = pluginDir || join(dirname(agentDir), "extensions", "feishu");
const extensionDir = join(pluginDir, "extension");
const runtimeDir = join(agentDir, "feishu");
const configPath = join(runtimeDir, "config.json");
const lockPath = join(agentDir, "locks.json");
const supportDir = join(pluginDir, "support");
const supervisorPath = join(supportDir, "feishu-supervisor.mjs");
const supervisorPidPath = join(runtimeDir, "supervisor.pid");
const supervisorStopPath = join(runtimeDir, "supervisor.stop");
const installLockPath = join(runtimeDir, "install.lock");
const legacyConfigPath = join(homeDir, ".pi", "agent", "feishu", "config.json");
workspace = workspace || homeDir;

console.log("==> Feishu/Lark plugin install");
info(`target: ${pluginDir}`);
ok(`bun: ${bunBin}`);
ok(`omp: ${ompBin}`);
info(`network: ${networkPolicy}`);
if (pythonBin) ok(`python: ${pythonBin}`); else ok("python: not found (ASR 转写不可用)");

let installLease: Awaited<ReturnType<typeof acquireInstallerLease>> | undefined;
try {
  installLease = await acquireInstallerLease(installLockPath);
} catch (error) {
  fail(`Another Feishu install/upgrade is already in progress: ${error instanceof Error ? error.message : String(error)}`);
}
process.on("exit", () => { if (installLease) releaseInstallerLease(installLease); });
ok("installer lock acquired");

if (!existsSync(configPath) && existsSync(legacyConfigPath)) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(configPath, readFileSync(legacyConfigPath), { mode: 0o600 });
  ok("Migrated legacy Feishu config from .pi to .omp");
}

let config: Record<string, unknown> | undefined;
if (existsSync(configPath) && !reconfigure) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    fail(`Invalid configuration file: ${configPath}`);
  }
}
if (!config) {
  const appId = prompt("App ID: ")?.trim() || "";
  const appSecret = prompt("App Secret: ")?.trim() || "";
  const domain = prompt("Domain (feishu/lark, default feishu): ")?.trim() || "feishu";
  if (!appId || !appSecret) fail("App ID and App Secret are required.");
  if (domain !== "feishu" && domain !== "lark") fail("Domain must be feishu or lark.");
  config = { appId, appSecret, domain, groupPolicy: "mention", autoStart: true, promptNotifySec: 30, promptTimeoutSec: 0, promptTimeoutEnabled: false };
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  ok("Feishu credentials saved");
} else {
  validateInstallerConfig(config);
  ok("Feishu credentials found");
}

if (restart) {
  if (!existsSync(workspace)) fail(`Workspace does not exist: ${workspace}`);
  mkdirSync(runtimeDir, { recursive: true });
  for (const message of cleanupLegacyInstallations({
    homeDir,
    pluginDir,
    bunBin,
    version: packageManifest.version,
  })) ok(message);
}

await checkFeishuApp(config);

const stagingDir = join(dirname(pluginDir), `.feishu-install-${process.pid}-${Date.now()}`);
removeDirectory(stagingDir);
mkdirSync(stagingDir, { recursive: true });
const stagingExtensionDir = join(stagingDir, "extension");
const stagingSupportDir = join(stagingDir, "support");
mkdirSync(stagingExtensionDir, { recursive: true });
mkdirSync(stagingSupportDir, { recursive: true });
const extensionFiles = readdirSync(join(packageRoot, "extension")).filter((file) => file.endsWith(".ts")).sort();
for (const file of extensionFiles) {
  writeFileSync(join(stagingExtensionDir, file), readFileSync(join(packageRoot, "extension", file)));
}
writeFileSync(join(stagingSupportDir, "feishu-supervisor.mjs"), readFileSync(join(packageRoot, "support", "feishu-supervisor.mjs")));
ok("Plugin files installed");

const stagingPackagePath = join(stagingDir, "package.json");
const stagingSupervisorPath = join(stagingSupportDir, "feishu-supervisor.mjs");
const stagingExtensionPath = join(stagingExtensionDir, "index.ts");
writeFileSync(stagingPackagePath, `${JSON.stringify({
  name: "omp-feishu-runtime",
  private: true,
  type: "module",
  version: packageManifest.version,
  description: "@caichengle/omp-feishu-lark installed runtime",
  dependencies: packageManifest.dependencies || {},
}, null, 2)}\n`);
const pluginPackagePath = stagingPackagePath;
info("installing plugin runtime dependencies...");
const installFailures: string[] = [];
let dependenciesInstalled = false;
for (const attemptArgs of upgradeNetworkAttempts(networkPolicy, dnsArgs)) {
  const installed = spawnSync(bunBin, [...attemptArgs, "install", "--production", "--no-save"], {
    cwd: stagingDir,
    stdio: "inherit",
    timeout: upgradeTimeoutMs(process.env.OMP_FEISHU_UPGRADE_TIMEOUT_SEC),
    killSignal: "SIGKILL",
  });
  if (installed.status === 0) {
    dependenciesInstalled = true;
    break;
  }
  installFailures.push(installed.error?.message || installed.signal || `exit ${installed.status ?? "unknown"}`);
}
if (!dependenciesInstalled) {
  removeDirectory(stagingDir);
  fail(`Could not install plugin runtime dependencies (network=${networkPolicy}, ${installFailures.join(" | ")}). Set OMP_FEISHU_NETWORK=ipv4 or ipv6 if this device has broken dual-stack DNS.`);
}
ok("Plugin dependencies ready");

const buildTarget = join(tmpdir(), `omp-feishu-build-${process.pid}.js`);
const compiled = spawnSync(bunBin, ["build", "--target=bun", "--external", "@oh-my-pi/pi-coding-agent", "--external", "typebox", "--external", "@larksuiteoapi/node-sdk", "--external", "qrcode-terminal", `--outfile=${buildTarget}`, stagingExtensionPath], { cwd: packageRoot, encoding: "utf8" });
try { rmSync(buildTarget, { force: true }); } catch {}
if (compiled.status !== 0) {
  removeDirectory(stagingDir);
  fail(`Plugin compile check failed:\n${[compiled.stdout, compiled.stderr].join("\n")}`);
}
ok("Plugin compile check passed");

if (restart) {
  mkdirSync(runtimeDir, { recursive: true });
  for (const message of cleanupLegacyInstallations({
    homeDir,
    pluginDir,
    bunBin,
    version: packageManifest.version,
  })) ok(message);
  await stopExistingProcess(supervisorPidPath, supervisorStopPath);
  await stopExistingDaemon(lockPath);
}

const rollbackDir = replacePluginDirectory(stagingDir, pluginDir);
removeDirectory(stagingDir);
ok("Old plugin files replaced; rollback copy retained until startup passes");

if (!restart) {
  removeDirectory(rollbackDir);
  info("Files installed; daemon was not restarted (--no-restart).");
  process.exit(0);
}

mkdirSync(runtimeDir, { recursive: true });

const logPath = join(runtimeDir, "daemon.log");
const daemonArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--allow-home", "--cwd", workspace, "-e", join(pluginDir, "extension", "index.ts")];
const daemonExecutable = bunBin;
const daemonLaunchArgs = [rpcOmpCli, ...daemonArgs];
const launchToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const launched = spawn(bunBin, [
  join(pluginDir, "support", "feishu-supervisor.mjs"),
  "--cwd", workspace,
  "--log", logPath,
  "--pid", supervisorPidPath,
  "--stop", supervisorStopPath,
  "--",
  daemonExecutable,
  ...daemonLaunchArgs,
], {
  cwd: workspace,
  detached: true,
  env: {
    ...process.env,
    ...(rpcOmpCli ? { OMP_CLI_PATH: rpcOmpCli } : {}),
    ...(process.env.PI_CODING_AGENT_DIR || process.env.OMP_AGENT_DIR ? { PI_CODING_AGENT_DIR: agentDir } : {}),
    FEISHU_PLUGIN_VERSION: packageManifest.version,
    FEISHU_LAUNCH_TOKEN: launchToken,
  },
  stdio: "ignore",
  windowsHide: true,
});
launched.unref();

info(`Waiting for the Feishu gateway (up to ${timeoutSeconds} seconds)...`);
if (await waitForConnected(lockPath, launchToken, timeoutSeconds * 1000)) {
  ok("Feishu gateway connected");
  info("Checking that an OMP RPC worker can start...");
  try {
    await verifyRpcWorkerReady({ bunBin, ompCliPath: rpcOmpCli, workspace, timeoutMs: timeoutSeconds * 1000 });
    ok("OMP RPC worker ready");
  } catch (error) {
    await stopExistingProcess(supervisorPidPath, supervisorStopPath);
    const restored = restorePluginDirectory(rollbackDir, pluginDir);
    const recovered = restored ? await restartRestoredDaemon() : false;
    fail(`Gateway connected, but conversations cannot start: ${error instanceof Error ? error.message : String(error)}. ${restored ? `Previous plugin restored${recovered ? " and restarted" : "; restart it manually"}.` : "No previous plugin was available for rollback."}`);
  }
  removeDirectory(rollbackDir);
  ok("Rollback copy removed after startup checks passed");
  console.log("\nReady. Open your Feishu bot and send a message.");
  process.exit(0);
}

await stopExistingProcess(supervisorPidPath, supervisorStopPath);
const restored = restorePluginDirectory(rollbackDir, pluginDir);
const recovered = restored ? await restartRestoredDaemon() : false;
fail(`The daemon did not connect within ${timeoutSeconds} seconds. Read the log: ${logPath}. ${restored ? `Previous plugin restored${recovered ? " and restarted" : "; restart it manually"}.` : "No previous plugin was available for rollback."}`);

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readGlobalPackageRoots(command: string) {
  const result = spawnSync(command, ["root", "-g"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function validateInstallerConfig(value: Record<string, unknown> | undefined) {
  if (!value || typeof value.appId !== "string" || !value.appId.trim() || typeof value.appSecret !== "string" || !value.appSecret.trim()) {
    fail(`Invalid configuration file: ${configPath}`);
  }
  if (value.domain !== undefined && value.domain !== "feishu" && value.domain !== "lark") {
    fail(`Invalid domain in configuration: ${configPath}`);
  }
  if (value.promptNotifySec !== undefined && (!Number.isFinite(value.promptNotifySec) || Number(value.promptNotifySec) < 0)) {
    fail(`Invalid promptNotifySec in configuration: ${configPath}`);
  }
  if (value.promptTimeoutSec !== undefined && (!Number.isFinite(value.promptTimeoutSec) || Number(value.promptTimeoutSec) < 0)) {
    fail(`Invalid promptTimeoutSec in configuration: ${configPath}`);
  }
  if (value.notificationWebhookPort !== undefined && (!Number.isInteger(value.notificationWebhookPort) || Number(value.notificationWebhookPort) < 1 || Number(value.notificationWebhookPort) > 65535)) {
    fail(`Invalid notificationWebhookPort in configuration: ${configPath}`);
  }
  if (value.notificationWebhookEnabled === true && (typeof value.notificationWebhookToken !== "string" || !value.notificationWebhookToken.trim())) {
    fail(`notificationWebhookToken is required when notificationWebhookEnabled is true: ${configPath}`);
  }
  if (value.cardActionMode === "webhook" && (typeof value.cardActionToken !== "string" || !value.cardActionToken.trim())) {
    fail(`cardActionToken is required when cardActionMode is webhook: ${configPath}`);
  }
}

function removeDirectory(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    fail(`Could not remove existing plugin directory: ${path}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

function replacePluginDirectory(staging: string, target: string) {
  const backup = `${target}.old-${process.pid}-${Date.now()}`;
  try {
    if (existsSync(target)) renameSync(target, backup);
    renameSync(staging, target);
    return backup;
  } catch (error) {
    try {
      if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    } catch {}
    removeDirectory(staging);
    throw new Error(`Could not replace plugin directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function restorePluginDirectory(backup: string, target: string) {
  if (!existsSync(backup)) return false;
  const failed = `${target}.failed-${process.pid}-${Date.now()}`;
  try {
    if (existsSync(target)) renameSync(target, failed);
    renameSync(backup, target);
    removeDirectory(failed);
    ok("New plugin failed startup; previous plugin files restored");
    return true;
  } catch (error) {
    fail(`Plugin rollback failed. Previous files remain at ${backup}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function stopExistingDaemon(path: string) {
  if (!existsSync(path)) return;
  let owner: { pid?: number; processStart?: string; heartbeatAt?: string; status?: string } | undefined;
  try {
    const locks = parseLocksFile(readFileSync(path, "utf8"));
    owner = locks[GATEWAY_LOCK_KEY] as { pid?: number; processStart?: string; heartbeatAt?: string; status?: string } | undefined;
  } catch {
    fail(`Invalid Feishu daemon lock file. Refusing to replace the running plugin: ${path}`);
  }
  if (owner?.pid && owner.pid !== process.pid) {
    const status = recordedProcessStatus(owner);
    if (status === "unverified") {
      fail(`Refusing to stop PID ${owner.pid}: the gateway process identity cannot be verified. Stop the old gateway manually, then retry.`);
    }
    if (status === "match") {
      if (isWindows) spawnSync("taskkill", ["/PID", String(owner.pid), "/T", "/F"], { stdio: "ignore" });
      else {
        try { process.kill(owner.pid, "SIGTERM"); } catch {}
      }
      if (!await waitForProcessExit(owner.pid, 15_000)) fail(`Existing Feishu daemon ${owner.pid} did not stop; plugin files were not replaced.`);
    }
  }
  try {
    const locks = parseLocksFile(readFileSync(path, "utf8"));
    removeGatewayLockKey(locks);
    writeFileSync(path, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
  } catch {}
}

async function stopExistingProcess(pidPath: string, stopPath: string) {
  const supervisor = readSupervisorRecord(pidPath);
  if (!supervisor || !isSupervisorProcessAlive(supervisor)) return;
  writeStopRequest(stopPath, supervisor);
  if (!await waitForSupervisorExit(supervisor, 15_000)) fail(`Existing Feishu supervisor ${supervisor.pid} did not stop; plugin files were not replaced.`);
  const current = readSupervisorRecord(pidPath);
  if (current?.pid === supervisor.pid && (!current.token || current.token === supervisor.token)) {
    try { rmSync(pidPath, { force: true }); } catch {}
  }
  try { rmSync(stopPath, { force: true }); } catch {}
}

async function checkFeishuApp(value: Record<string, unknown> | undefined) {
  if (!value || typeof value.appId !== "string" || typeof value.appSecret !== "string") return;
  const base = value.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  try {
    const tokenResponse = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: value.appId, app_secret: value.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const token = await tokenResponse.json() as { code?: number; msg?: string; tenant_access_token?: string };
    if (!tokenResponse.ok || !token.tenant_access_token) throw new Error(token.msg || `HTTP ${tokenResponse.status}`);
    const headers = { Authorization: `Bearer ${token.tenant_access_token}` };
    const [bot, scopes] = await Promise.all([
      fetch(`${base}/open-apis/bot/v3/info`, { headers, signal: AbortSignal.timeout(15_000) }),
      fetch(`${base}/open-apis/application/v6/scopes`, { headers, signal: AbortSignal.timeout(15_000) }),
    ]);
    if (!bot.ok) throw new Error(`bot/v3/info HTTP ${bot.status}`);
    const scopeJson = await scopes.json() as { data?: { scopes?: Array<{ scope_name?: string }> } };
    const names = new Set((scopeJson.data?.scopes || []).map((item) => item.scope_name));
    const missing = ["im:message", "im:message:send_as_bot"].filter((required) => !names.has(required));
    if (missing.length) {
      const consoleUrl = value.domain === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app";
      info(`warning: missing Feishu permissions: ${missing.join(", ")}`);
      info(`grant them in the app console, then publish a new app version: ${consoleUrl}`);
    } else {
      ok("Feishu bot and permission check passed");
    }
  } catch (error) {
    info(`warning: Feishu backend check skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) await Bun.sleep(200);
  return !processExists(pid);
}

async function waitForSupervisorExit(supervisor: { pid: number; processStart?: string; token?: string }, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isSupervisorProcessAlive(supervisor)) return true;
    await Bun.sleep(200);
  }
  return !isSupervisorProcessAlive(supervisor);
}

function processExists(pid: number) {
  if (isWindows) return spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" }).stdout.includes(String(pid));
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForConnected(path: string, launchToken: string, timeoutMs: number) {
  return await new Promise<boolean>((resolve) => {
    let done = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (connected: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher?.close();
      resolve(connected);
    };
    const check = () => {
      try {
        const lock = JSON.parse(readFileSync(path, "utf8")) as Record<string, { status?: string; launchToken?: string }>;
        if (Object.values(lock).some((entry) => entry?.status === "connected" && entry.launchToken === launchToken)) finish(true);
      } catch {}
    };
    try { watcher = watch(dirname(path), () => check()); } catch {}
    check();
  });
}

async function restartRestoredDaemon() {
  try {
    const restoredManifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { version?: string };
    const launchToken = `${process.pid}-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const daemonArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--allow-home", "--cwd", workspace, "-e", join(pluginDir, "extension", "index.ts")];
    const daemonLaunchArgs = [rpcOmpCli, ...daemonArgs];
    const launched = spawn(bunBin, [
      join(pluginDir, "support", "feishu-supervisor.mjs"),
      "--cwd", workspace,
      "--log", join(runtimeDir, "daemon.log"),
      "--pid", supervisorPidPath,
      "--stop", supervisorStopPath,
      "--",
      bunBin,
      ...daemonLaunchArgs,
    ], {
      cwd: workspace,
      detached: true,
      env: {
        ...process.env,
        ...(rpcOmpCli ? { OMP_CLI_PATH: rpcOmpCli } : {}),
        ...(process.env.PI_CODING_AGENT_DIR || process.env.OMP_AGENT_DIR ? { PI_CODING_AGENT_DIR: agentDir } : {}),
        FEISHU_PLUGIN_VERSION: restoredManifest.version || "unknown",
        FEISHU_LAUNCH_TOKEN: launchToken,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    launched.unref();
    return await waitForConnected(lockPath, launchToken, timeoutSeconds * 1000);
  } catch {
    return false;
  }
}
