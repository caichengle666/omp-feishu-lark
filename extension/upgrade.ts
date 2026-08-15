// 升级辅助：版本解析与比较。纯函数，便于单测。

export function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let seg = 0; seg < 3; seg += 1) {
    if (pa[seg] !== pb[seg]) return pa[seg] > pb[seg] ? 1 : -1;
  }
  return 0;
}

export function resolveTargetVersion(raw: string | undefined, latestFromRegistry: string | undefined):
  | { ok: true; version: string }
  | { ok: false; reason: string } {
  const pinned = raw?.trim();
  if (pinned) {
    if (!parseVersion(pinned)) {
      return { ok: false as const, reason: `版本号格式错误，应为 x.y.z，例如 /feishu upgrade 0.4.14（收到：${pinned}）` };
    }
    return { ok: true as const, version: pinned };
  }
  if (!latestFromRegistry) {
    return { ok: false as const, reason: "npm registry 未返回版本号" };
  }
  return { ok: true as const, version: latestFromRegistry };
}