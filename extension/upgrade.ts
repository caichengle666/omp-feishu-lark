// 升级辅助：版本解析、网络策略与超时。纯函数，便于单测。

export type UpgradeNetworkPolicy = "auto" | "ipv4" | "ipv6";

export function resolveUpgradeNetworkPolicy(value: string | undefined): UpgradeNetworkPolicy {
  const policy = value?.trim().toLowerCase() || "auto";
  if (policy === "auto" || policy === "ipv4" || policy === "ipv6") return policy;
  throw new Error(`OMP_FEISHU_NETWORK 只能是 auto、ipv4 或 ipv6（收到：${value}）`);
}

export function bunDnsArgs(policy: UpgradeNetworkPolicy): string[] {
  if (policy === "ipv4") return ["--dns-result-order=ipv4first"];
  if (policy === "ipv6") return ["--dns-result-order=ipv6first"];
  return [];
}

export function registryNetworkAttempts(policy: UpgradeNetworkPolicy): string[][] {
  if (policy !== "auto") return [bunDnsArgs(policy)];
  return [[], bunDnsArgs("ipv4"), bunDnsArgs("ipv6")];
}

export function upgradeTimeoutMs(value: string | undefined): number {
  const seconds = Number.parseInt(value || "", 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000;
}

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
  if (!parseVersion(latestFromRegistry)) {
    return { ok: false as const, reason: `npm registry 返回了无效版本号：${latestFromRegistry}` };
  }
  return { ok: true as const, version: latestFromRegistry };
}
