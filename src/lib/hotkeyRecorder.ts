export type HotkeyPlatform = "mac" | "windows" | "linux";

export type HotkeyKeyboardEventLike = {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
};

export type ShortcutValidation = {
  valid: boolean;
  message: string;
};

const MODIFIER_KEYS = new Set([
  "Alt",
  "Control",
  "Ctrl",
  "Meta",
  "Shift",
  "Command",
  "Option",
  "OS",
]);

const SPECIAL_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

const MAC_RESERVED_SHORTCUTS = new Set([
  "Command+Space",
  "Command+Option+Space",
  "Command+Tab",
  "Command+Shift+3",
  "Command+Shift+4",
  "Command+Shift+5",
  "Control+Space",
]);

export function shortcutFromKeyboardEvent(event: HotkeyKeyboardEventLike, platform: HotkeyPlatform): string | null {
  if (isCancelKey(event) || MODIFIER_KEYS.has(event.key)) return null;

  const primaryKey = normalizePrimaryKey(event.key, event.code);
  if (!primaryKey) return null;

  const modifiers = modifierLabels(event, platform);
  if (modifiers.length === 0) return null;
  return [...modifiers, primaryKey].join("+");
}

export function isCancelKey(event: Pick<HotkeyKeyboardEventLike, "key">): boolean {
  return event.key === "Escape" || event.key === "Esc";
}

export function recordingHint(platform: HotkeyPlatform): string {
  if (platform === "mac") return "请按下新的快捷键，Esc 取消";
  return "请按下新的快捷键，Esc 取消";
}

export function validateShortcut(shortcut: string, platform: HotkeyPlatform): ShortcutValidation {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { valid: false, message: "快捷键不能为空" };
  }

  const primary = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);
  if (!primary || MODIFIER_KEYS.has(primary)) {
    return { valid: false, message: "快捷键需要包含主键" };
  }
  if (modifiers.length === 0) {
    return { valid: false, message: "快捷键需要包含至少一个修饰键" };
  }

  const normalized = [...modifiers.map((modifier) => normalizeModifierLabel(modifier, platform)), normalizePrimaryKey(primary)]
    .filter(Boolean)
    .join("+");
  if (platform === "mac" && MAC_RESERVED_SHORTCUTS.has(normalized)) {
    return { valid: false, message: "该组合通常被系统占用，请换一个快捷键" };
  }

  return { valid: true, message: "可用" };
}

export function shortcutStatusMessage(
  shortcut: string,
  platform: HotkeyPlatform,
  saveState: "idle" | "saving" | "saved" | "error",
  saveError = "",
): string {
  const validation = validateShortcut(shortcut, platform);
  if (!validation.valid) return validation.message;
  if (saveState === "saving") return "正在保存并注册快捷键";
  if (saveState === "error") {
    const detail = saveError.trim();
    return detail ? `保存失败：${detail}` : "保存失败，可能是格式无效或快捷键已被系统占用";
  }
  return "已保存；若系统占用，注册失败会显示为保存失败";
}

function modifierLabels(event: HotkeyKeyboardEventLike, platform: HotkeyPlatform) {
  const labels: string[] = [];
  if (platform === "mac") {
    if (event.metaKey) labels.push("Command");
    if (event.ctrlKey) labels.push("Control");
    if (event.altKey) labels.push("Option");
    if (event.shiftKey) labels.push("Shift");
    return labels;
  }

  if (event.ctrlKey) labels.push("Ctrl");
  if (event.altKey) labels.push("Alt");
  if (event.shiftKey) labels.push("Shift");
  if (event.metaKey) labels.push("Meta");
  return labels;
}

function normalizePrimaryKey(key: string, code?: string) {
  if (SPECIAL_KEYS[key]) return SPECIAL_KEYS[key];
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.length === 1) return key.toUpperCase();
  if (/^Digit\d$/.test(code ?? "")) return String(code).replace("Digit", "");
  if (/^Key[A-Z]$/.test(code ?? "")) return String(code).replace("Key", "");
  return key.length > 0 ? key[0].toUpperCase() + key.slice(1) : "";
}

function normalizeModifierLabel(modifier: string, platform: HotkeyPlatform) {
  const normalized = modifier.trim().toLowerCase();
  if (platform === "mac") {
    if (["cmd", "command", "meta"].includes(normalized)) return "Command";
    if (["ctrl", "control"].includes(normalized)) return "Control";
    if (["alt", "option"].includes(normalized)) return "Option";
    if (normalized === "shift") return "Shift";
  }
  if (["cmd", "command"].includes(normalized)) return "Meta";
  if (["ctrl", "control"].includes(normalized)) return "Ctrl";
  if (["alt", "option"].includes(normalized)) return "Alt";
  if (normalized === "shift") return "Shift";
  if (normalized === "meta") return "Meta";
  return modifier.trim();
}
