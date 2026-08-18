import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { DaemonSpec } from "./daemon-spec.js";
import { isSupervisorProcessAlive, readSupervisorRecord } from "../support/feishu-supervisor.mjs";

export type OrphanRecoveryDeps = {
  readRecord?: typeof readSupervisorRecord;
  isAlive?: typeof isSupervisorProcessAlive;
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
};

export async function recoverOrphanDaemon(
  spec: DaemonSpec,
  withLock: <T>(fn: () => Promise<T>) => Promise<T>,
  deps: OrphanRecoveryDeps = {},
) {
  const readRecord = deps.readRecord || readSupervisorRecord;
  const isAlive = deps.isAlive || isSupervisorProcessAlive;
  const spawnProcess = deps.spawn || spawn;
  const sleep = deps.sleep || ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return withLock(async () => {
    // The supervisor writes its pid record before spawning the daemon. A short
    // grace window avoids treating that normal startup gap as orphaning.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const record = readRecord(spec.pidPath);
      if (record && isAlive(record)) return false;
      if (attempt < 5) await sleep(250);
    }

    const record = readRecord(spec.pidPath);
    if (record && isAlive(record)) return false;

    let child: ChildProcess;
    try {
      child = spawnProcess(spec.supervisorCommand[0], spec.supervisorCommand.slice(1), {
        cwd: spec.cwd,
        detached: true,
        env: { ...process.env, ...spec.env },
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      return false;
    }
    child.unref();
    return true;
  });
}
