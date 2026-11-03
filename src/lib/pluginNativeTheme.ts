export type PluginNativeThemeSource = "system" | "light" | "dark";

export interface PluginNativeTheme {
  readonly shouldUseDarkColors: boolean;
  readonly themeSource: PluginNativeThemeSource;
  on(event: "updated", listener: () => void): PluginNativeTheme;
  addListener(event: "updated", listener: () => void): PluginNativeTheme;
  once(event: "updated", listener: () => void): PluginNativeTheme;
  off(event: "updated", listener: () => void): PluginNativeTheme;
  removeListener(event: "updated", listener: () => void): PluginNativeTheme;
  removeAllListeners(event?: "updated"): PluginNativeTheme;
}

/** Read-only Electron nativeTheme subset scoped to one plugin document. */
export function createPluginNativeTheme(windowLike: any, sourceValue: unknown): PluginNativeTheme {
  const source: PluginNativeThemeSource = sourceValue === "light" || sourceValue === "dark" ? sourceValue : "system";
  const listeners: Array<{ callback: () => void; once: boolean }> = [];
  let media: any = null;
  let attached = false;
  let disposed = false;
  let pageHideAttached = false;
  let lastDark = source === "dark";

  function readDark(): boolean {
    if (source === "dark") return true;
    if (source === "light") return false;
    if (!media) {
      try { media = typeof windowLike.matchMedia === "function" ? windowLike.matchMedia("(prefers-color-scheme: dark)") : null; }
      catch { media = null; }
    }
    return media?.matches === true;
  }
  function detach() {
    if (!attached) return;
    attached = false;
    try {
      if (media?.removeEventListener) media.removeEventListener("change", onMediaChange);
      else media?.removeListener?.(onMediaChange);
    } catch { /* A document teardown must not leave a rejected event path. */ }
  }
  function clearDocument() {
    listeners.length = 0;
    detach();
    disposed = true;
    if (pageHideAttached) {
      pageHideAttached = false;
      try { windowLike.removeEventListener?.("pagehide", onPageHide); } catch { /* Best effort at document teardown. */ }
    }
  }
  function onPageHide() { clearDocument(); }
  function onMediaChange() {
    if (disposed) return;
    const next = readDark();
    if (next === lastDark) return;
    lastDark = next;
    for (const entry of [...listeners]) {
      if (!listeners.includes(entry)) continue;
      if (entry.once) removeEntry(entry);
      try { entry.callback.call(api); } catch { /* One plugin callback cannot block other listeners. */ }
    }
  }
  function attach() {
    if (attached || disposed) return;
    attached = true;
    lastDark = readDark();
    if (source === "system" && media) {
      if (media.addEventListener) media.addEventListener("change", onMediaChange);
      else media.addListener?.(onMediaChange);
    }
  }
  function removeEntry(entry: { callback: () => void; once: boolean }) {
    const index = listeners.indexOf(entry);
    if (index >= 0) listeners.splice(index, 1);
    if (!listeners.length) detach();
  }
  function ensureEvent(event: string) {
    if (event !== "updated") throw new TypeError("ERR_ATOOLS_ELECTRON_UNSUPPORTED: nativeTheme event");
    if (disposed) throw new Error("ERR_ATOOLS_DOCUMENT_CLOSED: nativeTheme");
  }
  function ensureSupportedEvent(event: string | undefined) {
    if (event !== undefined && event !== "updated") throw new TypeError("ERR_ATOOLS_ELECTRON_UNSUPPORTED: nativeTheme event");
  }
  function add(event: string, callback: () => void, once: boolean) {
    ensureEvent(event);
    if (typeof callback !== "function") throw new TypeError("nativeTheme listener must be a function");
    if (listeners.length >= 64) throw new Error("ERR_ATOOLS_NATIVE_THEME_LISTENER_LIMIT");
    listeners.push({ callback, once });
    attach();
    return api;
  }
  function remove(event: string, callback: () => void) {
    ensureSupportedEvent(event);
    if (disposed) return api;
    for (let index = listeners.length - 1; index >= 0; index--) {
      if (listeners[index].callback === callback) { removeEntry(listeners[index]); break; }
    }
    return api;
  }
  const api = {
    get shouldUseDarkColors() { return readDark(); },
    get themeSource() { return source; },
    set themeSource(_value: PluginNativeThemeSource) { throw new Error("ERR_ATOOLS_ELECTRON_UNSUPPORTED: nativeTheme.themeSource is read-only"); },
    on(event: "updated", callback: () => void) { return add(event, callback, false); },
    addListener(event: "updated", callback: () => void) { return add(event, callback, false); },
    once(event: "updated", callback: () => void) { return add(event, callback, true); },
    off(event: "updated", callback: () => void) { return remove(event, callback); },
    removeListener(event: "updated", callback: () => void) { return remove(event, callback); },
    removeAllListeners(event?: "updated") {
      ensureSupportedEvent(event);
      if (disposed) return api;
      listeners.length = 0;
      detach();
      return api;
    },
  };
  try {
    windowLike.addEventListener?.("pagehide", onPageHide, { once: true });
    pageHideAttached = typeof windowLike.addEventListener === "function";
  } catch { /* The host still rejects subscriptions after an observed pagehide. */ }
  return api;
}
