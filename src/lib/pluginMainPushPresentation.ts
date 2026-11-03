/** Query-only host policy; original scripts remain unchanged. Native Node permissions remain separate. */
export function createPluginMainPushPresentation(target: Window) {
  let mode: "query" | "select" | "visible" = "query";
  const restorations: Array<() => void> = [];
  function patch(owner: object, property: string, passive = false) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || !descriptor.configurable) return;
    const original = descriptor.value;
    Object.defineProperty(owner, property, { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
      if (mode === "query") {
        // focus() has no success return value. Ignoring it lets page initialization continue.
        if (passive) return;
        throw new DOMException("Main search cannot open windows", "NotAllowedError");
      }
      return Reflect.apply(original, this, args);
    } });
    restorations.push(() => Object.defineProperty(owner, property, descriptor));
  }
  patch(target, "focus", true); patch(target, "open");
  patch((target as Window & { HTMLElement: typeof HTMLElement }).HTMLElement.prototype, "focus", true);
  function setMode(next: "query" | "select" | "visible") {
    mode = next;
    if (next === "visible") dispose();
  }
  function dispose() { for (const restore of restorations.splice(0)) restore(); }
  return { setMode, dispose };
}

const PRESENTATION_MESSAGES = ["__ipc_main_window__", "__ipc_close__", "__ipc_out__", "__ipc_detach_plugin__",
  "__ipc_plugin_height__", "__ipc_plugin_escape__", "__ipc_plugin_contextmenu__", "__atools_feature_exports__",
  "__ipc_subinput__", "__ipc_subinput_focus__", "__ipc_subinput_remove__"];
const PRESENTATION_METHODS = new Set(["redirect", "redirectHotKeySetting", "redirectAiModelsSetting", "createBrowserWindow",
  "browserWindowAction", "startDrag", "hideMainWindowPasteText", "hideMainWindowPasteImage", "hideMainWindowPasteFile",
  "hideMainWindowTypeString", "simulateKeyboardTap", "shellOpenExternal", "shellOpenPath", "shellShowItemInFolder"]);
export function pluginMainPushPresentationDenied(mode: "query" | "select" | "visible", message: Record<string, unknown>) {
  return mode === "query" && (PRESENTATION_MESSAGES.some(key => message[key] === true)
    || message.__atools_native_call__ === true && PRESENTATION_METHODS.has(String(message.method ?? ""))
    || message.__ipc_call__ === true && ["shell_open", "copy_text"].includes(String(message.command ?? "")));
}
