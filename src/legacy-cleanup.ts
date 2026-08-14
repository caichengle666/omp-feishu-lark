import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export const PLUGIN_NAME = "@caichengle/omp-feishu-lark";

type CleanupOptions = {
  homeDir: string;
  pluginDir: string;
  bunBin: string;
  version: string;
  platform?: NodeJS.Platform;
  run?: typeof spawnSync;
};

export function isFeishuPluginDirectory(path: string) {
  try {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    return manifest?.name === PLUGIN_NAME || manifest?.name === "omp-feishu-runtime";
  } catch {
    try {
      const source = readFileSync(join(path, "extension", "index.ts"), "utf8");
      return source.includes("pi-feishu-lark.feishu-gateway") && source.includes("registerCommand(\"feishu\"");
    } catch {
      return false;
    }
  }
}

export function findLegacyPluginDirectories(homeDir: string, pluginDir: string) {
  const active = resolve(pluginDir);
  return [
    join(homeDir, "omp", "feishu-plugin"),
    join(homeDir, ".pi", "extensions", "feishu"),
  ].filter((path) => resolve(path) !== active && existsSync(path) && isFeishuPluginDirectory(path));
}

export function systemdServiceReferencesFeishuPlugin(service: string) {
  return service.includes("omp-feishu")
    && (
      service.includes("feishu-plugin/extension/index.ts")
      || service.includes(".pi/extensions/feishu/extension/index.ts")
      || service.includes(".omp/plugins/node_modules/@caichengle/omp-feishu-lark/extension/index.ts")
    );
}

export function ompRegistryNeedsUpgrade(homeDir: string, version: string) {
  const manifestPath = join(homeDir, ".omp", "plugins", "package.json");
  const installedPath = join(homeDir, ".omp", "plugins", "node_modules", "@caichengle", "omp-feishu-lark", "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const registered = typeof manifest?.dependencies?.[PLUGIN_NAME] === "string";
    if (!registered && !existsSync(installedPath)) return false;
    const installed = JSON.parse(readFileSync(installedPath, "utf8"));
    return installed?.version !== version;
  } catch {
    return existsSync(installedPath);
  }
}

export function cleanupLegacyInstallations(options: CleanupOptions) {
  const run = options.run || spawnSync;
  const platform = options.platform || process.platform;
  const messages: string[] = [];

  const runtimeDir = join(options.homeDir, ".omp", "agent", "feishu");
  const watcherPidPath = join(runtimeDir, "watcher.pid");
  if (existsSync(watcherPidPath)) {
    const pid = readPid(watcherPidPath);
    if (pid) {
      if (platform === "win32") run("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else run("kill", ["-TERM", String(pid)], { stdio: "ignore" });
    }
    rmSync(watcherPidPath, { force: true });
    messages.push("stopped legacy Feishu watcher");
  }

  for (const path of [
    join(runtimeDir, "start-daemon.cmd"),
    join(options.homeDir, ".omp", "feishu-watcher.mjs"),
  ]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    messages.push(`removed legacy launcher ${path}`);
  }

  if (platform === "linux") {
    const inspected = run("systemctl", ["cat", "omp-feishu.service"], { encoding: "utf8" });
    if (inspected.status === 0 && systemdServiceReferencesFeishuPlugin(inspected.stdout || "")) {
      run("systemctl", ["stop", "omp-feishu.service"], { stdio: "ignore" });
      run("systemctl", ["disable", "omp-feishu.service"], { stdio: "ignore" });
      messages.push("disabled legacy omp-feishu.service");
    }
  }

  for (const path of findLegacyPluginDirectories(options.homeDir, options.pluginDir)) {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    messages.push(`removed legacy plugin directory ${path}`);
  }

  if (ompRegistryNeedsUpgrade(options.homeDir, options.version)) {
    const registryDir = join(options.homeDir, ".omp", "plugins");
    const upgraded = run(options.bunBin, ["add", `${PLUGIN_NAME}@${options.version}`], {
      cwd: registryDir,
      stdio: "inherit",
    });
    if (upgraded.status !== 0) throw new Error("Could not upgrade the OMP npm plugin registration.");
    syncOmpPluginLock(options.homeDir, options.version);
    messages.push(`upgraded OMP npm plugin registration to ${options.version}`);
  }

  return messages;
}

export function syncOmpPluginLock(homeDir: string, version: string) {
  const path = join(homeDir, ".omp", "plugins", "omp-plugins.lock.json");
  if (!existsSync(path)) return;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    const plugin = lock?.plugins?.[PLUGIN_NAME];
    if (!plugin || typeof plugin !== "object") return;
    plugin.version = version;
    writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } catch {
    // An invalid OMP lock belongs to OMP; leave it untouched.
  }
}

function readPid(path: string) {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
