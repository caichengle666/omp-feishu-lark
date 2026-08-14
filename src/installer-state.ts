export const GATEWAY_LOCK_KEY = "pi-feishu-lark.feishu-gateway";

export function parseLocksFile(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function removeGatewayLockKey(locks: Record<string, unknown>, key = GATEWAY_LOCK_KEY) {
  if (Object.prototype.hasOwnProperty.call(locks, key)) delete locks[key];
  return locks;
}
