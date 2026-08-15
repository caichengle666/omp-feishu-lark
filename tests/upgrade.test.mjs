import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseVersion, resolveTargetVersion } from "../extension/upgrade.ts";

test("parseVersion accepts x.y.z and rejects others", () => {
  assert.deepEqual(parseVersion("0.4.13"), [0, 4, 13]);
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("0.4"), undefined);
  assert.equal(parseVersion("0.4.x"), undefined);
  assert.equal(parseVersion(""), undefined);
  assert.equal(parseVersion("0.4.13-beta"), undefined);
});

test("compareVersions orders semver correctly", () => {
  assert.equal(compareVersions("0.4.13", "0.4.13"), 0);
  assert.equal(compareVersions("0.4.14", "0.4.13"), 1);
  assert.equal(compareVersions("0.4.13", "0.4.14"), -1);
  assert.equal(compareVersions("0.5.0", "0.4.99"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.4.9", "0.4.13"), -1);
});

test("resolveTargetVersion pins valid versions and rejects malformed ones", () => {
  assert.deepEqual(resolveTargetVersion("0.4.14", "0.4.13"), { ok: true, version: "0.4.14" });
  assert.deepEqual(resolveTargetVersion("", "0.4.14"), { ok: true, version: "0.4.14" });
  assert.equal(resolveTargetVersion("abc", "0.4.14").ok, false);
  assert.equal(resolveTargetVersion("", undefined).ok, false);
});