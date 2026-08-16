import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const GENERATED_IMAGE_TOOLS = new Set(["generate_image", "image_generation", "image_gen", "imagegen"]);
const GENERATED_FILE_TOOLS = new Set(["write", "apply_patch", "edit", "patch", "tts", "speech"]);
const PATH_PATH_ARG_KEYS = ["path", "filePath", "file_path"];

export type ArtifactCandidate = { path: string; allowOutsideWorkspace: boolean };

const SENDABLE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ppt",
  ".pptx",
  ".csv",
  ".tsv",
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".gz",
  ".tgz",
  ".mp3",
  ".wav",
  ".mp4",
  ".mov",
  ".m4a",
  ".json",
  ".html",
]);

/**
 * Trusted OMP artifact candidates. Image generation is allowed to point at the
 * OS temp dir because the tool writes generated images there; workspace writes
 * and TTS remain restricted to the current chat workspace.
 */
export function collectArtifactCandidates(event: unknown, workspaceRoot?: string): ArtifactCandidate[] {
  const candidates = collectCandidatePaths(event, workspaceRoot);
  const seen = new Set<string>();
  const result: ArtifactCandidate[] = [];
  for (const candidate of candidates) {
    if (!isSendableExtension(candidate.path) || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    result.push(candidate);
  }
  return result;
}

export function collectSendableArtifacts(event: unknown, workspaceRoot?: string): string[] {
  return collectArtifactCandidates(event, workspaceRoot)
    .filter((candidate) => isExistingSendableArtifact(candidate.path, workspaceRoot, candidate.allowOutsideWorkspace))
    .map((candidate) => candidate.path);
}

export function isExistingSendableArtifact(filePath: string, workspaceRoot?: string, allowOutsideWorkspace = false): boolean {
  try {
    const realFile = realpathSync(filePath);
    const stat = statSync(realFile);
    if (!stat.isFile() || stat.size <= 0) return false;
    if (!workspaceRoot) return true;
    const realWorkspace = realpathSync(workspaceRoot);
    if (isPathInside(realWorkspace, realFile)) return true;
    if (!allowOutsideWorkspace) return false;
    return isPathInside(realpathSync(tmpdir()), realFile);
  } catch {
    return false;
  }
}

function collectCandidatePaths(event: unknown, workspaceRoot?: string): ArtifactCandidate[] {
  if (!event || typeof event !== "object") return [];
  const raw = event as any;
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  const candidates: ArtifactCandidate[] = [];

  if (raw.type === "tool_execution_start" && (toolName === "tts" || toolName === "speech")) {
    const args = raw.args && typeof raw.args === "object" ? raw.args : {};
    for (const key of PATH_PATH_ARG_KEYS) {
      pushPath(candidates, args[key], workspaceRoot, false);
    }
    if (toolName === "tts" || toolName === "speech") {
      pushPath(candidates, args.output_path, workspaceRoot, false);
      pushPath(candidates, args.outputPath, workspaceRoot, false);
    }
    return candidates;
  }

  if (raw.type !== "tool_execution_end" || raw.isError === true) return [];
  const details = raw.result?.details && typeof raw.result.details === "object" ? raw.result.details : {};

  if (GENERATED_IMAGE_TOOLS.has(toolName) && Array.isArray(details.imagePaths)) {
    for (const imagePath of details.imagePaths) {
      pushPath(candidates, imagePath, workspaceRoot, true);
    }
  }

  if (GENERATED_FILE_TOOLS.has(toolName)) {
    if (typeof details.resolvedPath === "string") pushPath(candidates, details.resolvedPath, workspaceRoot, false);
    if (typeof details.output_path === "string") pushPath(candidates, details.output_path, workspaceRoot, false);
    if (typeof details.outputPath === "string") pushPath(candidates, details.outputPath, workspaceRoot, false);
    const source = details.meta?.source;
    if (source?.type === "path" && typeof source.value === "string") {
      pushPath(candidates, source.value, workspaceRoot, false);
    }
  }

  return candidates;
}

function pushPath(candidates: ArtifactCandidate[], value: unknown, workspaceRoot: string | undefined, allowOutside: boolean) {
  if (typeof value !== "string" || !value.trim()) return;
  const root = workspaceRoot ? resolve(workspaceRoot) : undefined;
  const candidate = isAbsolute(value) ? resolve(value) : root ? resolve(root, value) : undefined;
  if (!candidate) return;
  if (!allowOutside && !isPathInside(root, candidate)) return;
  if (allowOutside && !isPathInside(resolve(tmpdir()), candidate)) return;
  candidates.push({ path: candidate, allowOutsideWorkspace: allowOutside });
}


function isSendableExtension(filePath: string) {
  return SENDABLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isPathInside(workspaceRoot: string | undefined, target: string): boolean {
  if (!workspaceRoot) return false;
  const rel = relative(resolve(workspaceRoot), target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
