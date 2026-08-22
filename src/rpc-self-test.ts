import { spawn } from "node:child_process";
import { buildOmpLaunchArgs } from "./daemon-spec.js";

type OmpApprovalMode = "always-ask" | "write" | "yolo";

type RpcSelfTestOmpLaunch = {
  enableSkills?: boolean;
  skills?: string[];
  tools?: string[];
  approvalMode?: OmpApprovalMode;
  maxTime?: string;
  appendSystemPrompt?: string;
  addDirs?: string[];
};

type RpcSelfTestOptions = {
  bunBin: string;
  ompCliPath: string;
  workspace: string;
  timeoutMs: number;
  ompLaunch?: RpcSelfTestOmpLaunch;
};

export async function verifyRpcWorkerReady(options: RpcSelfTestOptions): Promise<void> {
  const args = [
    options.ompCliPath,
    "--mode", "rpc",
    "--no-extensions",
    "--allow-home",
    "--cwd", options.workspace,
    ...buildOmpLaunchArgs(options.ompLaunch),
  ];
  const child = spawn(options.bunBin, args, {
    cwd: options.workspace,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RPC worker did not become ready within ${Math.ceil(options.timeoutMs / 1000)} seconds`));
      }, options.timeoutMs);
      timer.unref?.();

      const complete = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-16_384);
        for (const line of stdout.split(/\r?\n/)) {
          try {
            if (JSON.parse(line)?.type === "ready") return complete();
          } catch {}
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
      child.once("error", (error) => complete(error));
      child.once("exit", (code, signal) => complete(new Error(
        `RPC worker exited before ready (code=${code ?? "none"}, signal=${signal ?? "none"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      )));
    });
  } finally {
    await finish();
  }
}
