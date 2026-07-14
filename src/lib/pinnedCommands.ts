export type PinnedCommand = {
  code: string;
  label: string;
  explain: string;
  plugin_id?: string;
  plugin_name?: string;
  panel?: string;
};

export const PINNED_COMMANDS_STORAGE_KEY = "atools:pinned-commands";
export const PINNED_COMMANDS_UPDATED_EVENT = "atools-pinned-commands-updated";

export function normalizePinnedCommandCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const code = item.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

export function loadPinnedCommandCodes(): string[] {
  try {
    const value = localStorage.getItem(PINNED_COMMANDS_STORAGE_KEY);
    return normalizePinnedCommandCodes(value ? JSON.parse(value) : []);
  } catch {
    return [];
  }
}

export function savePinnedCommandCodes(codes: string[]) {
  try {
    localStorage.setItem(PINNED_COMMANDS_STORAGE_KEY, JSON.stringify(normalizePinnedCommandCodes(codes)));
  } catch {
    // Pinned commands are a convenience feature; restricted storage should not break settings.
  }
}

export function dispatchPinnedCommandCodes(codes: string[]) {
  if (typeof window === "undefined") return;
  const detail = normalizePinnedCommandCodes(codes);
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent<string[]>(PINNED_COMMANDS_UPDATED_EVENT, { detail }));
    return;
  }
  window.dispatchEvent({ type: PINNED_COMMANDS_UPDATED_EVENT, detail } as unknown as Event);
}

export function isPinnedCommandCode(code: string, codes: string[]): boolean {
  const targetCode = code.trim();
  if (!targetCode) return false;
  return normalizePinnedCommandCodes(codes).includes(targetCode);
}

export function togglePinnedCommandCode(codes: string[], code: string): string[] {
  const targetCode = code.trim();
  const normalized = normalizePinnedCommandCodes(codes);
  if (!targetCode) return normalized;
  if (normalized.includes(targetCode)) {
    return normalized.filter((item) => item !== targetCode);
  }
  return [...normalized, targetCode];
}
