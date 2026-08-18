import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

export function readEnvironmentFile(path) {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid supervisor env JSON: ${path}`);
  }
  const env = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function readSupervisorRecord(path) {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return undefined;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { pid: Number.parseInt(raw, 10) };
    }
    const pid = typeof parsed?.pid === "number" ? parsed.pid : Number.parseInt(parsed?.pid, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return {
      pid,
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : undefined,
      processStart: typeof parsed.processStart === "string" && parsed.processStart ? parsed.processStart : undefined,
      startedAt: typeof parsed.startedAt === "string" && parsed.startedAt ? parsed.startedAt : undefined,
      command: Array.isArray(parsed.command) ? parsed.command.map(String) : undefined,
    };
  } catch {
    return undefined;
  }
}

export function writeSupervisorRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function processStartFingerprint(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      return closing >= 0 ? stat.slice(closing + 2).trim().split(/\s+/)[19] : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    try {
      const result = spawnSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      });
      const match = /CreationDate=(\d{14})/.exec(result.stdout || "");
      if (match) return match[1];
    } catch {
      // WMIC is absent on newer Windows installations; use CIM below.
    }
    try {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue).CreationDate.ToUniversalTime().Ticks`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      });
      const value = (result.stdout || "").trim();
      return /^\d+$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 3_000,
      });
      const value = (result.stdout || "").trim().replace(/\s+/g, " ");
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function recordedProcessStatus(record) {
  if (!record?.pid || !processAlive(record.pid)) return "dead";
  if (!record.processStart) return "unverified";
  const fingerprint = processStartFingerprint(record.pid);
  if (!fingerprint) return "unverified";
  return fingerprint === record.processStart ? "match" : "mismatch";
}

export function isSupervisorProcessAlive(record) {
  if (!record || !record.pid || !processAlive(record.pid)) return false;
  if (record.processStart) {
    const fingerprint = processStartFingerprint(record.pid);
    if (fingerprint && fingerprint !== record.processStart) return false;
  }
  if (!record.processStart && !record.token) {
    const readsAsSupervisor = processCommandMatchesSupervisor(record.pid);
    if (readsAsSupervisor === false) return false;
  }
  return true;
}

export function writeStopRequest(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const request = {
    pid: record?.pid ?? null,
    token: record?.token ?? null,
    requestedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

export function shouldStopRequested(path, record) {
  try {
    const request = JSON.parse(readFileSync(path, "utf8"));
    if (request?.token && record?.token && request.token !== record.token) return false;
    return true;
  } catch {
    return existsSync(path);
  }
}

export async function stopChild(daemon, log = () => {}, signal = "SIGTERM") {
  if (!daemon || daemon.exitCode !== null) return;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitExit = (ms) => {
    // Race: the child may exit before we register the listener (common when
    // it's already winding down). Check the captured exit code first so an
    // already-exited child resolves immediately instead of waiting out the
    // full window.
    if (daemon.exitCode !== null) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers();
    daemon.once("exit", () => resolve());
    const timer = setTimeout(() => resolve(), ms);
    promise.finally(() => clearTimeout(timer));
    return promise;
  };
  try { daemon.stdin?.end(); } catch {}
  try { daemon.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM"); } catch {}
  await waitExit(5000);
  if (daemon.exitCode === null) {
    try { daemon.kill("SIGKILL"); } catch {}
    await waitExit(5000);
  }
  if (daemon.exitCode === null) {
    // Never block the supervisor on a stubborn daemon: a zombie child would
    // otherwise wedge stop() forever (kill -9 cannot reap an uninterruptible
    // process), leaving upgrade/restart loops spinning. Log and move on; the
    // gateway lock's stale-owner detection recovers ownership once the old
    // process actually dies.
    log(`daemon ${daemon.pid} did not exit after SIGKILL; releasing supervisor without waiting`);
    await waitExit(1000);
  }
}

export async function runSupervisor(argv = process.argv.slice(2)) {
  const { options, command, args } = parseSupervisorArgs(argv);
  const cwd = options.cwd || process.cwd();
  const logPath = required(options.log, "--log");
  const pidPath = required(options.pid, "--pid");
  const stopPath = required(options.stop, "--stop");
  const fileEnv = options["env-json"] ? readEnvironmentFile(options["env-json"]) : {};
  mkdirSync(dirname(logPath), { recursive: true });

  const existing = readSupervisorRecord(pidPath);
  if (existing && isSupervisorProcessAlive(existing)) {
    throw new Error(`Supervisor already running (pid ${existing.pid})`);
  }
  const supervisorToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const supervisorRecord = {
    pid: process.pid,
    token: supervisorToken,
    processStart: processStartFingerprint(process.pid),
    startedAt: new Date().toISOString(),
    command: [command, ...args],
  };
  try { rmSync(stopPath, { force: true }); } catch {}
  writeSupervisorRecord(pidPath, supervisorRecord);

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
    await stopChild(child, log, signal);
  };

  const traceStopSource = (signal) => {
    try {
      const ppid = process.ppid;
      let parent = "(unknown)";
      try { parent = execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8" }).trim(); } catch {}
      let stopFile = "";
      try { stopFile = readFileSync(stopPath, "utf8").trim(); } catch {}
      log(`stop requested via ${signal}; ppid=${ppid} (${parent})${stopFile ? ` stopFile=${stopFile}` : ""}`);
      // Snapshot every process that could be involved so the next stop is
      // attributable even without auditd: list our own pid file record, all
      // feishu-supervisor/omp --mode rpc processes and their start times.
      try {
        const psOut = execFileSync("ps", ["-eo", "pid,ppid,etime,args"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
        const relevant = psOut.split("\n").filter((line) => /feishu-supervisor|omp --mode rpc/.test(line));
        log(`process snapshot at stop:\n${relevant.join("\n")}`);
      } catch {}
    } catch (error) {
      log(`stop requested via ${signal}; trace failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  process.on("SIGINT", () => { traceStopSource("SIGINT"); void stop("SIGINT"); });
  process.on("SIGTERM", () => { traceStopSource("SIGTERM"); void stop("SIGTERM"); });
  const stopPoll = setInterval(() => {
    if (shouldStopRequested(stopPath, supervisorRecord)) {
      traceStopSource("stopfile");
      void stop("SIGTERM");
    }
  }, 200);

  try {
    while (!stopping) {
      const startedAt = Date.now();
      log(`starting daemon: ${command} ${args.join(" ")}`);
      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          ...fileEnv,
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
    const current = readSupervisorRecord(pidPath);
    if (current?.pid === process.pid && (!current.token || current.token === supervisorToken)) {
      try { rmSync(pidPath, { force: true }); } catch {}
    }
    try { rmSync(stopPath, { force: true }); } catch {}
    log("supervisor stopped");
  }
}

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processCommandMatchesSupervisor(pid) {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      });
      const normal = (result.stdout || "").replace(/\0/g, "");
      return /CommandLine=.*feishu-supervisor\.mjs/i.test(normal) ? true : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.includes("feishu-supervisor.mjs") ? true : false;
  } catch {
    return undefined;
  }
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
