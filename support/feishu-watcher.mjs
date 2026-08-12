import { watch, appendFileSync, existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME || homedir();
const PLUGIN_DIR = process.env.FEISHU_PLUGIN_DIR || join(HOME, ".omp", "extensions", "feishu");
// The daemon's cwd is the default workspace for new sessions. Derive it from
// the plugin dir so a watcher restart cannot silently relocate the workspace.
const PLUGIN_SUFFIX = `${sep}.omp${sep}extensions${sep}feishu`;
const DAEMON_CWD = process.env.FEISHU_DAEMON_CWD
  || (PLUGIN_DIR.endsWith(PLUGIN_SUFFIX)
    ? PLUGIN_DIR.slice(0, -PLUGIN_SUFFIX.length)
    : HOME);
// Resolved by install.sh; `omp` on PATH is the fallback.
const OMP_BIN = process.env.FEISHU_OMP_BIN || "omp";
const WATCHER_DIR = join(HOME, ".omp", "agent", "feishu");
const LOCK_FILE = join(HOME, ".omp", "agent", "locks.json");
const PID_FILE = join(WATCHER_DIR, "watcher.pid");
const LOG_FILE = join(WATCHER_DIR, "watcher.log");
const DEBOUNCE_MS = 1500;
const DEBOUNCE_MAX_WAIT = 5000;

mkdirSync(WATCHER_DIR, { recursive: true });

// ---- PID guard: allow only one watcher ----
if (existsSync(PID_FILE)) {
  try {
    const oldPid = Number(readFileSync(PID_FILE, "utf8").trim());
    process.kill(oldPid, 0);
    process.stdout.write(`[${new Date().toISOString()}] watcher already running (pid ${oldPid}), exiting\n`);
    process.exit(0);
  } catch {
    try { unlinkSync(PID_FILE); } catch {}
  }
}
writeFileSync(PID_FILE, String(process.pid));
const cleanup = () => { try { unlinkSync(PID_FILE); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); watcher.close(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); watcher.close(); process.exit(0); });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ---- Restart daemon ----
let running = false;
let pendingTimer = null;
let pendingDeadline = 0;

function readLockPid() {
  try {
    const locks = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    return locks["pi-feishu-lark.feishu-gateway"]?.pid;
  } catch { return undefined; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function currentDaemonPids() {
  // The launcher shell keeps stdin open; the bun child is the real daemon.
  const out = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout || "";
  return out
    .split("\n")
    .filter((l) => l.includes(`${PLUGIN_DIR}/index.ts`) && !l.includes("ps -eo"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n !== process.pid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doRestart() {
  if (running) {
    log("restart already in progress, queuing another restart");
    pendingTimer = setTimeout(doRestart, 500);
    return;
  }
  running = true;
  try {
    log(">>> restarting feishu daemon");

    for (const pid of currentDaemonPids()) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await sleep(1500);
    try { unlinkSync(LOCK_FILE); } catch {}

    // stdin must stay open: RPC mode exits on EOF.
    const child = spawn(
      "bash",
      ["-lc", `cd ${JSON.stringify(DAEMON_CWD)} && tail -f /dev/null | exec ${OMP_BIN} --mode rpc --no-extensions --no-skills --allow-home --cwd ${JSON.stringify(DAEMON_CWD)} -e ${PLUGIN_DIR}/index.ts`],
      {
        cwd: existsSync(DAEMON_CWD) ? DAEMON_CWD : HOME,
        env: { ...process.env, PI_FEISHU_DAEMON: "1" },
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      },
    );
    child.on("error", (err) => log(`restart spawn error: ${err.message}`));
    child.unref();

    // Readiness is the gateway lock reporting a live connected pid.
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const pid = readLockPid();
      if (pid && alive(pid)) {
        log(`>>> daemon ready (pid ${pid})`);
        return;
      }
    }
    log("!!! daemon did not become ready within 60s");
  } finally {
    running = false;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      log("applying queued file changes...");
      setTimeout(doRestart, 500);
    }
  }
}

function scheduleRestart(reason) {
  log(`change detected: ${reason}`);
  const now = Date.now();
  if (!pendingTimer) {
    pendingDeadline = now + DEBOUNCE_MAX_WAIT;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      doRestart();
    }, DEBOUNCE_MS);
  } else if (now >= pendingDeadline) {
    // Force restart if too many changes accumulate
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      doRestart();
    }, 200);
  }
}

// ---- File watcher ----
const IGNORED = /\.(bak|orig|swp|tmp|log)$/;
const WATCHED_EXT = /\.(ts|js|mjs)$/;

const watcher = watch(PLUGIN_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (!WATCHED_EXT.test(filename)) return;
  if (IGNORED.test(filename)) return;
  if (filename.includes("watcher")) return;
  scheduleRestart(`${eventType} ${filename}`);
});

watcher.on("error", (err) => {
  log(`watcher error: ${err.message}`);
  process.exit(1);
});

log(`watching ${PLUGIN_DIR} (debounce ${DEBOUNCE_MS}ms)`);
log(`log: ${LOG_FILE}`);
