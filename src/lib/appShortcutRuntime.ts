import type { AppShortcutSetting } from "./settings";
import {
  shortcutFromKeyboardEvent,
  validateShortcut,
  type HotkeyKeyboardEventLike,
  type HotkeyPlatform,
} from "./hotkeyRecorder";

export type AppShortcutRuntimeOptions = {
  platform: HotkeyPlatform;
  availableTargetCodes?: string[];
  editableTarget?: boolean;
};

export type AppShortcutTargetMatch = {
  id: string;
  shortcut: string;
  targetCode: string;
};

export function appShortcutTargetFromKeyboardEvent(
  event: HotkeyKeyboardEventLike,
  entries: AppShortcutSetting[],
  options: AppShortcutRuntimeOptions,
): AppShortcutTargetMatch | null {
  if (options.editableTarget) return null;

  const shortcut = shortcutFromKeyboardEvent(event, options.platform);
  if (!shortcut) return null;

  const shortcutKey = shortcutIdentity(shortcut);
  const availableTargetCodes = options.availableTargetCodes
    ? new Set(options.availableTargetCodes)
    : null;
  const candidates = entries.filter((entry) => {
    if (!entry.enabled) return false;
    if (!entry.shortcut.trim() || !entry.targetCode.trim()) return false;
    if (availableTargetCodes && !availableTargetCodes.has(entry.targetCode)) return false;
    if (!validateShortcut(entry.shortcut, options.platform).valid) return false;
    return shortcutIdentity(entry.shortcut) === shortcutKey;
  });

  if (candidates.length !== 1) return null;
  const entry = candidates[0];
  return {
    id: entry.id,
    shortcut: entry.shortcut,
    targetCode: entry.targetCode,
  };
}

export function shortcutIdentity(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .join("+");
}
