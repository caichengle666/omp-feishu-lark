#!/usr/bin/env node
"use strict";

const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");
const { delimiter, join } = require("node:path");

function resolveBunExecutable(env = process.env, home = homedir()) {
  const platform = env.__OMP_FEISHU_TEST_PLATFORM__ || process.platform;
  const executable = platform === "win32" ? "bun.exe" : "bun";

  const explicitBun = env.BUN_BIN_PATH || "";
  if (explicitBun) {
    if (existsSync(explicitBun) && /bun(\.exe)?$/i.test(explicitBun)) return explicitBun;
    const explicitBin = join(explicitBun, executable);
    if (existsSync(explicitBin)) return explicitBin;
  }

  const direct = [
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin", executable) : "",
    join(home, ".bun", "bin", executable),
    join(home, ".local", "bin", executable),
    platform === "win32" ? join(env.ProgramFiles || "C:\\Program Files", "Bun", executable) : "/usr/local/bin/bun",
  ].filter(Boolean);

  for (const candidate of direct) {
    if (candidate.endsWith(executable) && existsSync(candidate)) return candidate;
  }

  const pathEntries = (env.PATH || "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, executable);
    if (existsSync(candidate)) return candidate;
  }

  try {
    const lookup = spawnSync(platform === "win32" ? "where" : "which", ["bun"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    const found = (lookup.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found && !/\.(cmd|bat)$/i.test(found)) return found;
  } catch {}

  return "";
}

function run() {
  const bun = resolveBunExecutable();
  if (!bun) {
    console.error("Bun was not found. Install Bun first (https://bun.sh), or set BUN_BIN_PATH to the Bun bin directory.");
    process.exit(1);
  }

  const { spawn } = require("node:child_process");
  const script = join(__dirname, "..", "src", "cli.ts");
  const child = spawn(bun, [script, ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(`Could not start Bun: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch {}
      return;
    }
    process.exit(code ?? 0);
  });
}

if (require.main === module) run();

module.exports = { resolveBunExecutable };
