import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FeishuAgentBackend } from "./types.js";

export type ResolvedAgentBackend = "dsh" | "omp";

/**
 * Resolve which agent backend the Feishu layer should run on.
 *
 * Explicit config always wins. `"auto"` probes the local machine: if a `dsh`
 * executable is present on PATH it uses DSH, otherwise it falls back to OMP.
 * An unset backend also uses automatic detection. Keep this side-effect free
 * and fail closed so a missing `dsh` never blocks startup.
 */
export function resolveAgentBackend(
  configBackend: FeishuAgentBackend | undefined,
  options: { command?: string } = {},
): ResolvedAgentBackend {
  if (configBackend === "dsh") return "dsh";
  if (configBackend === "omp") return "omp";
  const command = options.command || process.env.FEISHU_DSH_COMMAND || "dsh";
  return commandAvailable(command) ? "dsh" : "omp";
}

/** Best-effort executable lookup on PATH (or absolute path). Never throws. */
export function commandAvailable(command: string): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isFile(command);
  }
  const pathExt = (process.env.PATHEXT || (process.platform === "win32" ? ".COM;.EXE;.BAT;.CMD" : ""))
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.startsWith("."));
  const extensions = pathExt.length ? pathExt : [""];
  const pathSep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH || "").split(pathSep);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      if (isFile(join(dir, `${command}${ext}`))) return true;
    }
  }
  return false;
}

function isFile(path: string): boolean {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return Boolean(stat?.isFile());
  } catch {
    return false;
  }
}
