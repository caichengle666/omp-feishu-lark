import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstallerLease, releaseInstallerLease } from "../src/installer-lock.ts";

test("installer lock prevents concurrent upgrades and releases by token", async () => {
  const root = join(tmpdir(), `omp-feishu-installer-lease-${process.pid}-${Date.now()}`);
  const path = join(root, "install.lock");
  mkdirSync(root, { recursive: true });
  const first = await acquireInstallerLease(path);
  let acquiredSecond = false;
  const secondPromise = acquireInstallerLease(path).then((lease) => {
    acquiredSecond = true;
    return lease;
  });
  await Bun.sleep(100);
  assert.equal(acquiredSecond, false);
  releaseInstallerLease(first);
  const second = await secondPromise;
  assert.equal(existsSync(path), true);
  releaseInstallerLease(second);
  assert.equal(existsSync(path), false);
  rmSync(root, { recursive: true, force: true });
});

test("installer lock immediately recovers a lock left by a dead process", async () => {
  const root = join(tmpdir(), `omp-feishu-installer-dead-${process.pid}-${Date.now()}`);
  const path = join(root, "install.lock");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner"), JSON.stringify({ token: "dead", pid: 2_147_483_647 }), "utf8");
  const lease = await acquireInstallerLease(path);
  assert.notEqual(lease.token, "dead");
  releaseInstallerLease(lease);
  assert.equal(existsSync(path), false);
  rmSync(root, { recursive: true, force: true });
});
