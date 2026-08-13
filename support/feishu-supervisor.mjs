import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

export function restartDelay(failures) {
  return Math.min(30_000, 1000 * (2 ** Math.max(0, failures - 1)));
}

export function appendRotatingLog(logPath, content, maxBytes = 5 * 1024 * 1024) {
  try {
    if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(content) > maxBytes) {
      const previousPath = `${logPath}.1`;
      try { rmSync(previousPath, { force: true }); } catch {}
      renameSync(logPath, previousPath);
    }
    appendFileSync(logPath, content, "utf8");
  } catch {}
}

export function parseSupervisorArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new Error("Missing -- before daemon command");
  const options = {};
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid supervisor option: ${name || "<empty>"}`);
    options[name.slice(2)] = value;
  }
  const command = argv[separator + 1];
  if (!command) throw new Error("Missing daemon executable");
  return { options, command, args: argv.slice(separator + 2) };
}

export async function runSupervisor(argv = process.argv.slice(2)) {
  const { options, command, args } = parseSupervisorArgs(argv);
  const cwd = options.cwd || process.cwd();
  const logPath = required(options.log, "--log");
  const pidPath = required(options.pid, "--pid");
  const stopPath = required(options.stop, "--stop");
  mkdirSync(dirname(logPath), { recursive: true });

  const existingPid = readPid(pidPath);
  if (existingPid && existingPid !== process.pid && processAlive(existingPid)) {
    throw new Error(`Supervisor already running (pid ${existingPid})`);
  }
  try { rmSync(stopPath, { force: true }); } catch {}
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");

  let child;
  let stopping = false;
  let failures = 0;
  let stableTimer;
  let restartTimer;
  let wakeRestart;
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    appendRotatingLog(logPath, line);
  };

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (stableTimer) clearTimeout(stableTimer);
    if (restartTimer) clearTimeout(restartTimer);
    wakeRestart?.();
    if (child && child.exitCode === null) {
      try { child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM"); } catch {}
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
      if (child.exitCode === null) try { child.kill("SIGKILL"); } catch {}
    }
  };

  process.on("SIGINT", () => { void stop("SIGINT"); });
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  const stopPoll = setInterval(() => {
    if (existsSync(stopPath)) void stop("SIGTERM");
  }, 200);

  try {
    while (!stopping) {
      const startedAt = Date.now();
      log(`starting daemon: ${command} ${args.join(" ")}`);
      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          PI_FEISHU_DAEMON: "1",
          BUN_CONFIG_DNS_RESULT_ORDER: "ipv4first",
          NODE_OPTIONS: [process.env.NODE_OPTIONS, "--dns-result-order=ipv4first"].filter(Boolean).join(" "),
        },
        // RPC stdout contains full protocol frames, including conversation
        // content. The supervisor only needs stderr diagnostics and the
        // gateway lock for readiness, so do not persist stdout.
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk) => appendRotatingLog(logPath, chunk));
      // RPC mode exits on stdin EOF. Keeping this writable pipe open is the
      // portable replacement for platform-specific shell pipelines.
      child.stdin.on("error", () => undefined);
      stableTimer = setTimeout(() => { failures = 0; }, 60_000);
      stableTimer.unref?.();

      const exit = await new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(stableTimer);
      stableTimer = undefined;
      child = undefined;
      if (stopping) break;

      failures = Date.now() - startedAt >= 60_000 ? 1 : failures + 1;
      const delay = restartDelay(failures);
      log(`daemon exited (${formatExit(exit)}); restarting in ${delay}ms`);
      await new Promise((resolve) => {
        wakeRestart = resolve;
        restartTimer = setTimeout(resolve, delay);
      });
      restartTimer = undefined;
      wakeRestart = undefined;
    }
  } finally {
    clearInterval(stopPoll);
    if (readPid(pidPath) === process.pid) try { rmSync(pidPath, { force: true }); } catch {}
    try { rmSync(stopPath, { force: true }); } catch {}
    log("supervisor stopped");
  }
}

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readPid(path) {
  try {
    if (!existsSync(path)) return undefined;
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function formatExit(exit) {
  if (exit.error) return exit.error instanceof Error ? exit.error.message : String(exit.error);
  return `code=${exit.code ?? "none"}, signal=${exit.signal ?? "none"}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) {
  runSupervisor().catch((error) => {
    process.stderr.write(`[feishu-supervisor] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

