import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processStartFingerprint } from "../support/feishu-supervisor.mjs";

const FILE_LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 400;
const HEARTBEAT_MS = 5_000;

export type InstallerLease = {
  token: string;
  pid: number;
  path: string;
  processStart?: string;
  heartbeat?: ReturnType<typeof setInterval>;
};

type Owner = Pick<InstallerLease, "token" | "pid" | "processStart">;

export async function acquireInstallerLease(path: string): Promise<InstallerLease> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const owner: Owner = {
      token: randomToken(),
      pid: process.pid,
      processStart: processStartFingerprint(process.pid),
    };
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), JSON.stringify(owner), "utf8");
      const lease: InstallerLease = { path, ...owner };
      lease.heartbeat = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()); } catch {}
      }, HEARTBEAT_MS);
      lease.heartbeat.unref?.();
      return lease;
    } catch {
      try {
        if (isLeaseAbandoned(path)) rmSync(path, { recursive: true, force: true });
      } catch {}
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out waiting for Feishu installer lock: ${path}`);
}

export function releaseInstallerLease(lease: InstallerLease) {
  if (lease.heartbeat) clearInterval(lease.heartbeat);
  try {
    const owner = JSON.parse(readFileSync(join(lease.path, "owner"), "utf8")) as Owner;
    if (owner.token === lease.token) rmSync(lease.path, { recursive: true, force: true });
  } catch {}
}

function isLeaseAbandoned(path: string) {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner"), "utf8")) as Partial<Owner>;
    if (typeof owner.pid !== "number") return Date.now() - statSync(path).mtimeMs > FILE_LOCK_STALE_MS;
    if (!processAlive(owner.pid)) return true;
    const fingerprint = processStartFingerprint(owner.pid);
    return Boolean(owner.processStart && fingerprint && fingerprint !== owner.processStart);
  } catch {
    return Date.now() - statSync(path).mtimeMs > FILE_LOCK_STALE_MS;
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
