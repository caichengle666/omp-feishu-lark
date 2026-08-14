import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveBunExecutable } from "../bin/omp-feishu.cjs";

test("bin launcher finds Bun in the standard home location without PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-feishu-bin-home-"));
  const platform = process.platform;
  const executable = platform === "win32" ? "bun.exe" : "bun";
  const binDir = join(root, ".bun", "bin");
  mkdirSync(binDir, { recursive: true });
  const bunPath = join(binDir, executable);
  writeFileSync(bunPath, "");
  const resolved = resolveBunExecutable({ PATH: "", __OMP_FEISHU_TEST_PLATFORM__: platform }, root);
  assert.equal(resolved, bunPath);
  rmSync(root, { recursive: true, force: true });
});

test("bin launcher respects BUN_BIN_PATH even when PATH is empty", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-feishu-bin-path-"));
  const platform = process.platform;
  const executable = platform === "win32" ? "bun.exe" : "bun";
  const binDir = join(root, "custom-bin");
  mkdirSync(binDir, { recursive: true });
  const bunPath = join(binDir, executable);
  writeFileSync(bunPath, "");
  const resolved = resolveBunExecutable({
    PATH: "",
    BUN_BIN_PATH: binDir,
    __OMP_FEISHU_TEST_PLATFORM__: platform,
  }, root);
  assert.equal(resolved, bunPath);
  assert.equal(existsSync(resolved), true);
  rmSync(root, { recursive: true, force: true });
});

test("bin launcher searches PATH when Bun is installed in a custom location", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-feishu-bin-path-lookup-"));
  const platform = process.platform;
  const executable = platform === "win32" ? "bun.exe" : "bun";
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const bunPath = join(binDir, executable);
  writeFileSync(bunPath, "");
  const resolved = resolveBunExecutable({
    PATH: binDir,
    __OMP_FEISHU_TEST_PLATFORM__: platform,
  }, join(root, "home"));
  assert.equal(resolved, bunPath);
  rmSync(root, { recursive: true, force: true });
});
