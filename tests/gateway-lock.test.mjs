import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFileLease, fingerprintMismatch, isGatewayOwnerStale, releaseFileLease } from "../extension/gateway-lock.ts";

test("file lease prevents concurrent ownership and releases by token", async () => {
  const root = join(tmpdir(), `omp-feishu-lease-${process.pid}-${Date.now()}`);
  const path = join(root, "lock");
  mkdirSync(root, { recursive: true });
  const first = await acquireFileLease(path);
  let acquiredSecond = false;
  const secondPromise = acquireFileLease(path).then((lease) => {
    acquiredSecond = true;
    return lease;
  });
  await Bun.sleep(100);
  assert.equal(acquiredSecond, false);
  releaseFileLease(first);
  const second = await secondPromise;
  assert.equal(existsSync(path), true);
  releaseFileLease(second);
  assert.equal(existsSync(path), false);
  rmSync(root, { recursive: true, force: true });
});

test("file lease immediately recovers a lock left by a dead process", async () => {
  const root = join(tmpdir(), `omp-feishu-dead-lease-${process.pid}-${Date.now()}`);
  const path = join(root, "lock");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner"), JSON.stringify({ token: "dead", pid: 2_147_483_647 }), "utf8");
  const lease = await acquireFileLease(path);
  assert.notEqual(lease.token, "dead");
  releaseFileLease(lease);
  assert.equal(existsSync(path), false);
  rmSync(root, { recursive: true, force: true });
});

test("gateway owner records a Linux process start fingerprint", async () => {
  if (process.platform !== "linux") return;
  const source = await Bun.file(new URL("../extension/gateway-lock.ts", import.meta.url)).text();
  assert.match(source, /processStartFingerprint\(process\.pid\)/);
  assert.match(source, /fingerprintMismatch\(owner\.processStart, processStartFingerprint\(owner\.pid\)\)/);
});

test("a live gateway owner is not stale only because its heartbeat is old", () => {
  assert.equal(isGatewayOwnerStale({
    key: "pi-feishu-lark.feishu-gateway",
    pid: process.pid,
    token: "live",
    cwd: process.cwd(),
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    status: "starting",
  }), false);
});

test("a dead gateway owner is stale", () => {
  assert.equal(isGatewayOwnerStale({
    key: "pi-feishu-lark.feishu-gateway",
    pid: 2_147_483_647,
    token: "dead",
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    status: "connected",
  }), true);
});

test("a transient fingerprint lookup failure does not invalidate a live owner", () => {
  assert.equal(fingerprintMismatch("known-start", undefined), false);
  assert.equal(fingerprintMismatch("known-start", "different-start"), true);
});
