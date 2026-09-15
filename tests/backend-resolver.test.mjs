import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandAvailable, resolveAgentBackend } from "../extension/backend-resolver.ts";

test("explicit backend selection takes precedence", () => {
  assert.equal(resolveAgentBackend("omp", { command: "missing-dsh" }), "omp");
  assert.equal(resolveAgentBackend("dsh", { command: "missing-dsh" }), "dsh");
});

test("unset backend automatically detects DSH when available", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-feishu-backend-"));
  const command = join(dir, process.platform === "win32" ? "dsh.cmd" : "dsh");
  writeFileSync(command, "");
  assert.equal(resolveAgentBackend(undefined, { command }), "dsh");
});

test("unset backend falls back to OMP when DSH is unavailable", () => {
  assert.equal(resolveAgentBackend(undefined, { command: "missing-dsh" }), "omp");
});

test("auto selects DSH when the configured command exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-feishu-backend-"));
  const command = join(dir, process.platform === "win32" ? "dsh.cmd" : "dsh");
  writeFileSync(command, "");
  assert.equal(commandAvailable(command), true);
  assert.equal(resolveAgentBackend("auto", { command }), "dsh");
});

test("auto falls back to OMP when DSH is unavailable", () => {
  assert.equal(resolveAgentBackend("auto", { command: "missing-dsh" }), "omp");
});
