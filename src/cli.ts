#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = process.env.HOME || process.env.USERPROFILE;
const timeoutSeconds = parsePositiveInt(process.env.OMP_FEISHU_TIMEOUT, 90);

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
  join(homeDir, ".bun", "bin", isWindows ? "bun.exe" : "bun"),
  isWindows ? "C:\\Program Files\\Bun\\bun.exe" : "/usr/local/bin/bun",
]);
const ompBin = findCommand("omp", [
  join(homeDir, ".bun", "bin", isWindows ? "omp.exe" : "omp"),
  isWindows ? "C:\\Program Files\\Bun\\omp.exe" : "/usr/local/bin/omp",
]);

if (!bunBin) fail("Bun was not found. Install Bun first, then rerun this command.");
if (!ompBin) fail("OMP was not found. Install OMP first, then rerun this command.");

let compatibleOmpCli = "";
try {
  const ompPackageJson = Bun.resolveSync("@oh-my-pi/pi-coding-agent/package.json", packageRoot);
  compatibleOmpCli = join(dirname(ompPackageJson), "dist", "cli.js");
} catch {
  // A globally installed OMP remains a supported fallback.
}

const pythonBin = isWindows
  ? findCommand("python", ["python.exe"] ) || findCommand("py", ["py.exe"])
  : findCommand("python3", ["/usr/bin/python3", "/usr/local/bin/python3"]);

pluginDir = pluginDir || join(homeDir, ".omp", "extensions", "feishu");
const extensionDir = join(pluginDir, "extension");
const runtimeDir = join(homeDir, ".omp", "agent", "feishu");
const configPath = join(runtimeDir, "config.json");
const lockPath = join(homeDir, ".omp", "agent", "locks.json");
const depsDir = join(homeDir, ".omp", "plugins");
const watcherDestination = join(homeDir, ".omp", "feishu-watcher.mjs");
const legacyConfigPath = join(homeDir, ".pi", "agent", "feishu", "config.json");
workspace = workspace || homeDir;

console.log("==> Feishu/Lark plugin install");
info(`target: ${pluginDir}`);
ok(`bun: ${bunBin}`);
ok(`omp: ${ompBin}`);
if (pythonBin) ok(`python: ${pythonBin}`); else ok("python: not found (ASR 转写不可用)");

mkdirSync(depsDir, { recursive: true });
const depsPackage = join(depsDir, "package.json");
if (!existsSync(depsPackage)) {
  writeFileSync(depsPackage, JSON.stringify({ name: "omp-feishu-deps", private: true }, null, 2));
}
if (!existsSync(join(depsDir, "node_modules", "@larksuiteoapi", "node-sdk"))) {
  info("installing Feishu SDK...");
  const installed = spawnSync(bunBin, ["add", "@larksuiteoapi/node-sdk"], { cwd: depsDir, stdio: "inherit" });
  if (installed.status !== 0) fail("Could not install @larksuiteoapi/node-sdk.");
}
ok("Feishu SDK ready");

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
  config = { appId, appSecret, domain, autoStart: true, promptNotifySec: 30, promptTimeoutSec: 120 };
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  ok("Feishu credentials saved");
} else {
  validateInstallerConfig(config);
  ok("Feishu credentials found");
}

await checkFeishuApp(config);

if (existsSync(extensionDir)) removeDirectory(extensionDir);
mkdirSync(extensionDir, { recursive: true });
const extensionFiles = ["attachments.ts", "bridge-runtime.ts", "bridge-store.ts", "card-action-webhook.ts", "cards.ts", "config.ts", "conversation-manager.ts", "debug.ts", "dedupe-store.ts", "delivery.ts", "gateway-lock.ts", "index.ts", "message-handler.ts", "messages.ts", "prompt-timeout.ts", "rich-text.ts", "setup.ts", "task-status-card.ts", "tencent-asr.ts", "transport.ts", "types.ts"];
for (const file of extensionFiles) {
  writeFileSync(join(extensionDir, file), readFileSync(join(packageRoot, "extension", file)));
}
writeFileSync(watcherDestination, readFileSync(join(packageRoot, "support", "feishu-watcher.mjs")));
ok("Plugin files installed");

const buildTarget = isWindows ? "NUL" : "/dev/null";
const compiled = spawnSync(bunBin, ["build", "--target=bun", "--external", "@oh-my-pi/pi-coding-agent", "--external", "typebox", "--external", "@larksuiteoapi/node-sdk", "--external", "qrcode-terminal", `--outfile=${buildTarget}`, join(extensionDir, "index.ts")], { cwd: packageRoot, encoding: "utf8" });
if (compiled.status !== 0) fail(`Plugin compile check failed:\n${[compiled.stdout, compiled.stderr].join("\n")}`);
ok("Plugin compile check passed");

if (!restart) {
  info("Files installed; daemon was not restarted (--no-restart).");
  process.exit(0);
}

if (!existsSync(workspace)) fail(`Workspace does not exist: ${workspace}`);
mkdirSync(runtimeDir, { recursive: true });
await stopExistingDaemon(lockPath);

const logPath = join(runtimeDir, "daemon.log");
const logFd = openSync(logPath, "a");
closeSync(logFd);
const daemonArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--allow-home", "--cwd", workspace, "-e", join(extensionDir, "index.ts")];
const daemonExecutable = compatibleOmpCli ? bunBin : ompBin;
const daemonLaunchArgs = compatibleOmpCli ? [compatibleOmpCli, ...daemonArgs] : daemonArgs;
const daemonEnv = {
  ...process.env,
  PI_FEISHU_DAEMON: "1",
  BUN_CONFIG_DNS_RESULT_ORDER: "ipv4first",
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--dns-result-order=ipv4first"].filter(Boolean).join(" "),
};

if (isWindows) {
  const launcherPath = join(runtimeDir, "start-daemon.cmd");
  const quote = quoteCmd;
  const command = [quote(daemonExecutable), ...daemonLaunchArgs.map(quote)].join(" ");
  writeFileSync(launcherPath, `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset PI_FEISHU_DAEMON=1\r\nset BUN_CONFIG_DNS_RESULT_ORDER=ipv4first\r\nset NODE_OPTIONS=--dns-result-order=ipv4first\r\ncd /d ${quote(workspace)}\r\npowershell.exe -NoProfile -Command "$event = [Threading.ManualResetEvent]::new($false); $event.WaitOne()" | ${command} >> ${quote(logPath)} 2>&1\r\n`);
  const launched = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", launcherPath], {
    cwd: workspace,
    detached: true,
    env: daemonEnv,
    stdio: "ignore",
  });
  launched.unref();
} else {
  const daemonLogFd = openSync(logPath, "a");
  const launched = spawn(daemonExecutable, daemonLaunchArgs, { cwd: workspace, detached: true, env: daemonEnv, stdio: ["ignore", daemonLogFd, daemonLogFd] });
  launched.unref();
}

info(`Waiting for the Feishu gateway (up to ${timeoutSeconds} seconds)...`);
if (await waitForConnected(lockPath, timeoutSeconds * 1000)) {
  ok("Feishu gateway connected");
  console.log("\nReady. Open your Feishu bot and send a message.");
  process.exit(0);
}

fail(`The daemon did not connect within ${timeoutSeconds} seconds. Read the log: ${logPath}`);

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function quoteCmd(value: string) {
  const escaped = value.replace(/%/g, "%%").replace(/[\"^&|<>]/g, "^$&");
  return `"${escaped}"`;
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
}

function removeDirectory(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    fail(`Could not remove existing plugin directory: ${path}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

async function stopExistingDaemon(path: string) {
  if (!existsSync(path)) return;
  let owner: { pid?: number; heartbeatAt?: string; status?: string } | undefined;
  try {
    const locks = JSON.parse(readFileSync(path, "utf8")) as Record<string, typeof owner>;
    owner = locks["pi-feishu-lark.feishu-gateway"];
  } catch {}
  if (owner?.pid && owner.pid !== process.pid) {
    const heartbeatAge = owner.heartbeatAt ? Date.now() - Date.parse(owner.heartbeatAt) : Number.POSITIVE_INFINITY;
    if (heartbeatAge < 60_000 || processExists(owner.pid)) {
      if (isWindows) spawnSync("taskkill", ["/PID", String(owner.pid), "/T", "/F"], { stdio: "ignore" });
      else {
        try { process.kill(owner.pid, "SIGTERM"); } catch {}
      }
      await waitForProcessExit(owner.pid, 10_000);
    }
  }
  try { rmSync(path, { force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
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
    for (const required of ["im:message", "im:message:send_as_bot"]) {
      if (!names.has(required)) info(`warning: missing Feishu permission ${required}`);
    }
    ok("Feishu bot and permission check passed");
  } catch (error) {
    info(`warning: Feishu backend check skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) await Bun.sleep(200);
}

function processExists(pid: number) {
  if (isWindows) return spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" }).stdout.includes(String(pid));
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForConnected(path: string, timeoutMs: number) {
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
        const lock = JSON.parse(readFileSync(path, "utf8")) as Record<string, { status?: string }>;
        if (Object.values(lock).some((entry) => entry?.status === "connected")) finish(true);
      } catch {}
    };
    try { watcher = watch(dirname(path), () => check()); } catch {}
    check();
  });
}
