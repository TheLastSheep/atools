export type PluginNavigationIntent = "return" | "clear" | "escape" | "previous" | "next" | "activate";

type NavigationKeyboardEvent = Pick<KeyboardEvent,
  "key" | "defaultPrevented" | "isComposing" | "keyCode" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/** Input-local policy; native buttons and the plugin frame keep their own keys. */
export function pluginNavigationIntent(
  event: NavigationKeyboardEvent,
  value: string,
  composing = false,
): PluginNavigationIntent | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;

  switch (event.key) {
    case "Backspace": return value.length === 0 ? "return" : null;
    case "Escape": return value.length > 0 ? "clear" : "escape";
    case "ArrowUp": return "previous";
    case "ArrowDown": return "next";
    case "Enter": return "activate";
    default: return null;
  }
}
