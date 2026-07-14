export type LocalLaunchSearchSetting = {
  localLaunchSearch?: boolean;
};

export type LocalAppSearchSetting = {
  localAppSearch?: boolean;
};

const DURATION_PATTERN = /^(\d+)(s|m)$/;

export function behaviorDelayMs(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "immediately") return 0;
  if (normalized === "never" || normalized === "off") return null;

  const match = normalized.match(DURATION_PATTERN);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2] === "m" ? amount * 60_000 : amount * 1_000;
}

export function autoClearDelayMs(value: string): number | null {
  return behaviorDelayMs(value);
}

export function autoBackToSearchDelayMs(value: string): number | null {
  return behaviorDelayMs(value);
}

export function autoPasteDelayMs(value: string): number | null {
  return behaviorDelayMs(value);
}

export type AutoPasteQueryCandidateInput = {
  setting: string;
  now: number;
  clipboardChangedAt: number | null;
  clipboardText: string;
  currentQuery: string;
  lastAutoPastedText?: string;
};

export function autoPasteQueryCandidate(input: AutoPasteQueryCandidateInput): string | null {
  const delay = autoPasteDelayMs(input.setting);
  if (delay === null || input.clipboardChangedAt === null) return null;
  if (input.now - input.clipboardChangedAt > delay) return null;
  if (input.currentQuery.trim()) return null;

  const text = input.clipboardText.trim();
  if (!text) return null;
  if (text === input.lastAutoPastedText) return null;
  return text;
}

export function includeLocalLaunchSearch(settings: LocalLaunchSearchSetting): boolean {
  return settings.localLaunchSearch !== false;
}

export function includeLocalAppSearch(settings: LocalAppSearchSetting): boolean {
  return settings.localAppSearch !== false;
}
