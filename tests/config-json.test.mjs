import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("backs up malformed state JSON and atomically writes its replacement", () => {
  const root = join(tmpdir(), `omp-feishu-config-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const script = [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { readJson, writeJson } from "./extension/config.ts";',
    'const path = join(process.env.OMP_FEISHU_ROOT, "state.json");',
    'writeFileSync(path, "\\ufeff" + JSON.stringify({ sessions: { "p2p:bom": "session.jsonl" } }));',
    'if (readJson(path, { sessions: {} }).sessions["p2p:bom"] !== "session.jsonl") process.exit(2);',
    'writeFileSync(path, "{invalid");',
    'if (readJson(path, { sessions: {} }).sessions === undefined) process.exit(3);',
    'writeJson(path, { sessions: { "p2p:test": "session.jsonl" } });',
    'if (!existsSync(path)) process.exit(4);',
    'if (JSON.parse(readFileSync(path, "utf8")).sessions["p2p:test"] !== "session.jsonl") process.exit(5);',
  ].join(" ");

  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, OMP_FEISHU_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).sessions["p2p:test"], "session.jsonl");
    assert.ok(readdirSync(root).some((name) => name.startsWith("state.json.corrupt-")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
