export function normalizeWakeupBlacklist(items: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value) continue;
    const key = normalizeWakeupAppName(value);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export function addWakeupBlacklistItem(items: string[], value: string): string[] {
  return normalizeWakeupBlacklist([...items, value]);
}

export function wakeupBlacklistMatches(foregroundApp: string, items: string[]): boolean {
  const key = normalizeWakeupAppName(foregroundApp);
  if (!key) return false;
  return normalizeWakeupBlacklist(items).some((item) => normalizeWakeupAppName(item) === key);
}

function normalizeWakeupAppName(value: string): string {
  return value.trim().toLowerCase();
}
