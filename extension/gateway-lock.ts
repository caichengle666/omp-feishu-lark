import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processStartFingerprint } from "../support/feishu-supervisor.mjs";
import { AGENT_DIR } from "./config.js";
import { debugLog } from "./debug.js";

const LOCK_KEY = "pi-feishu-lark.feishu-gateway";
const LOCKS_PATH = join(AGENT_DIR, "locks.json");
const FILE_LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 400;
const HEARTBEAT_MS = 5_000;

export type GatewayOwner = {
  key: typeof LOCK_KEY;
  pid: number;
  processStart?: string;
  launchToken?: string;
  token: string;
  cwd: string;
  startedAt: string;
  heartbeatAt: string;
  status: "starting" | "connected" | "disconnected";
};

type LocksFile = Record<string, unknown>;
type LeaseOwner = { token: string; pid: number; processStart?: string };
type Lease = LeaseOwner & { path: string; heartbeat?: NodeJS.Timeout };

export type GatewayLockResult =
  | { status: "acquired"; handle: GatewayLockHandle }
  | { status: "busy"; owner: GatewayOwner };

export class GatewayLockHandle {
  private heartbeat: NodeJS.Timeout | undefined;
  private onLost: (() => void | Promise<void>) | undefined;

  constructor(readonly owner: GatewayOwner) {}

  setOnLost(handler: () => void | Promise<void>) { this.onLost = handler; }

  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.update("connected").catch((error) => {
        debugLog("feishu.gateway.heartbeat_error", { error: error instanceof Error ? error.message : String(error) });
      });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async update(status: GatewayOwner["status"]) {
    let lostOwnership = false;
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[LOCK_KEY]);
      if (!current || current.token !== this.owner.token || current.pid !== this.owner.pid || current.processStart !== this.owner.processStart) {
        this.stopHeartbeat();
        lostOwnership = true;
        return;
      }
      locks[LOCK_KEY] = { ...current, heartbeatAt: new Date().toISOString(), status };
      writeLocksFile(locks);
    });
    if (lostOwnership) {
      debugLog("feishu.gateway.lock_lost", { pid: this.owner.pid });
      await this.onLost?.();
    }
  }

  async release() {
    this.stopHeartbeat();
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[LOCK_KEY]);
      if (current?.token === this.owner.token && current.pid === this.owner.pid && current.processStart === this.owner.processStart) {
        delete locks[LOCK_KEY];
        writeLocksFile(locks);
        debugLog("feishu.gateway.lock_released", { pid: this.owner.pid });
      }
    });
  }

  private stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

export async function acquireGatewayLock(cwd: string, force = false): Promise<GatewayLockResult> {
  return withLocksFileLock(() => {
    const locks = readLocksFile();
    const existing = asGatewayOwner(locks[LOCK_KEY]);
    if (existing && !force && !isGatewayOwnerStale(existing)) {
      debugLog("feishu.gateway.lock_busy", { ownerPid: existing.pid, heartbeatAt: existing.heartbeatAt, currentPid: process.pid });
      return { status: "busy", owner: existing };
    }
    const now = new Date().toISOString();
    const owner: GatewayOwner = {
      key: LOCK_KEY,
      pid: process.pid,
      processStart: processStartFingerprint(process.pid),
      launchToken: process.env.FEISHU_LAUNCH_TOKEN || undefined,
      token: randomToken(),
      cwd,
      startedAt: now,
      heartbeatAt: now,
      status: "starting",
    };
    locks[LOCK_KEY] = owner;
    writeLocksFile(locks);
    debugLog("feishu.gateway.lock_acquired", { pid: owner.pid, cwd, replacedPid: existing?.pid, force });
    return { status: "acquired", handle: new GatewayLockHandle(owner) };
  });
}

export function readGatewayOwner(): GatewayOwner | undefined {
  const owner = asGatewayOwner(readLocksFile()[LOCK_KEY]);
  return owner && !isGatewayOwnerStale(owner) ? owner : undefined;
}

export function gatewayLockPath() { return LOCKS_PATH; }

function asGatewayOwner(value: unknown): GatewayOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GatewayOwner>;
  if (raw.key !== LOCK_KEY || typeof raw.pid !== "number" || typeof raw.token !== "string") return undefined;
  if (raw.processStart !== undefined && typeof raw.processStart !== "string") return undefined;
  if (raw.launchToken !== undefined && typeof raw.launchToken !== "string") return undefined;
  if (typeof raw.cwd !== "string" || typeof raw.startedAt !== "string" || typeof raw.heartbeatAt !== "string") return undefined;
  if (raw.status !== "starting" && raw.status !== "connected" && raw.status !== "disconnected") return undefined;
  return raw as GatewayOwner;
}

export function isGatewayOwnerStale(owner: GatewayOwner) {
  if (!isProcessAlive(owner.pid)) return true;
  if (fingerprintMismatch(owner.processStart, processStartFingerprint(owner.pid))) return true;
  return false;
}

function isProcessAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function randomToken() { return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function readLocksFile(): LocksFile {
  try { return existsSync(LOCKS_PATH) ? JSON.parse(readFileSync(LOCKS_PATH, "utf8")) as LocksFile : {}; } catch { return {}; }
}

function writeLocksFile(locks: LocksFile) {
  mkdirSync(dirname(LOCKS_PATH), { recursive: true });
  writeFileSync(LOCKS_PATH, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
}

async function withLocksFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lease = await acquireFileLease(`${LOCKS_PATH}.lock`);
  try { return await fn(); } finally { releaseFileLease(lease); }
}

export async function acquireFileLease(path: string): Promise<Lease> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const owner: LeaseOwner = {
      token: randomToken(),
      pid: process.pid,
      processStart: processStartFingerprint(process.pid),
    };
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), JSON.stringify(owner), "utf8");
      const lease: Lease = { path, ...owner };
      lease.heartbeat = setInterval(() => { try { utimesSync(path, new Date(), new Date()); } catch {} }, HEARTBEAT_MS);
      lease.heartbeat.unref?.();
      return lease;
    } catch {
      try {
        if (isFileLeaseAbandoned(path)) rmSync(path, { recursive: true, force: true });
      } catch {}
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out waiting for Feishu lock: ${path}`);
}

export function releaseFileLease(lease: Lease) {
  if (lease.heartbeat) clearInterval(lease.heartbeat);
  try {
    const owner = JSON.parse(readFileSync(join(lease.path, "owner"), "utf8")) as LeaseOwner;
    if (owner.token === lease.token) rmSync(lease.path, { recursive: true, force: true });
  } catch {}
}

function isFileLeaseAbandoned(path: string) {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner"), "utf8")) as Partial<LeaseOwner>;
    if (typeof owner.pid !== "number") return Date.now() - statSync(path).mtimeMs > FILE_LOCK_STALE_MS;
    if (!isProcessAlive(owner.pid)) return true;
    return fingerprintMismatch(owner.processStart, processStartFingerprint(owner.pid));
  } catch {
    return Date.now() - statSync(path).mtimeMs > FILE_LOCK_STALE_MS;
  }
}

export function fingerprintMismatch(expected: string | undefined, actual: string | undefined) {
  return Boolean(expected && actual && actual !== expected);
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
