import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginNativeBrowserWindowSnapshotResult } from "./pluginNativeBrowserWindowTypes";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const pointAndSize = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SNAPSHOT:${label}`);
  const bounds = value as Record<string, unknown>;
  if (!finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) throw Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SNAPSHOT:${label}`);
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
};
const size = (value: unknown, label: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])
    || value[0] < 0 || value[1] < 0) throw Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SNAPSHOT:${label}`);
  return [value[0], value[1]];
};

/** Validates Rust's authoritative window state without applying the overlay's bounds clamps. */
export function readPluginNativeBrowserWindowSnapshot(value: unknown): PluginNativeBrowserWindowSnapshotResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SNAPSHOT");
  const snapshot = value as Record<string, unknown>;
  if (snapshot.closed === true) {
    if (!Number.isSafeInteger(snapshot.nativeSequence) || Number(snapshot.nativeSequence) < 0) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SEQUENCE");
    return { closed: true, nativeSequence: Number(snapshot.nativeSequence) };
  }
  if (!Number.isSafeInteger(snapshot.nativeSequence) || Number(snapshot.nativeSequence) < 0
    || snapshot.constraintsSource !== "adapter" || typeof snapshot.visible !== "boolean"
    || typeof snapshot.focused !== "boolean" || typeof snapshot.alwaysOnTop !== "boolean"
    || typeof snapshot.minimized !== "boolean" || typeof snapshot.maximized !== "boolean"
    || typeof snapshot.fullScreen !== "boolean" || typeof snapshot.resizable !== "boolean"
    || typeof snapshot.title !== "string") throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SNAPSHOT");
  const minimumSize = size(snapshot.minimumSize, "minimumSize"), maximumSize = size(snapshot.maximumSize, "maximumSize");
  if ((maximumSize[0] !== 0 && maximumSize[0] < minimumSize[0])
    || (maximumSize[1] !== 0 && maximumSize[1] < minimumSize[1])) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_CONSTRAINTS");
  return {
    bounds: pointAndSize(snapshot.bounds, "bounds"), contentBounds: pointAndSize(snapshot.contentBounds, "contentBounds"),
    minimumSize, maximumSize, visible: snapshot.visible, focused: snapshot.focused,
    alwaysOnTop: snapshot.alwaysOnTop, minimized: snapshot.minimized, maximized: snapshot.maximized,
    fullScreen: snapshot.fullScreen, resizable: snapshot.resizable, title: snapshot.title,
    nativeSequence: Number(snapshot.nativeSequence), constraintsSource: "adapter",
  };
}

export function applyPluginNativeBrowserWindowSnapshot<T extends PluginBrowserWindowState>(
  window: T,
  value: PluginNativeBrowserWindowSnapshotResult,
): T | null {
  const snapshot = readPluginNativeBrowserWindowSnapshot(value);
  const prior = window.nativeSnapshot?.nativeSequence ?? -1;
  if (snapshot.nativeSequence <= prior) return null;
  if ("closed" in snapshot) return null;
  return {
    ...window, nativeSnapshot: snapshot,
    x: snapshot.bounds.x, y: snapshot.bounds.y, width: snapshot.bounds.width, height: snapshot.bounds.height,
    minimumWidth: snapshot.minimumSize[0], minimumHeight: snapshot.minimumSize[1],
    maximumWidth: snapshot.maximumSize[0], maximumHeight: snapshot.maximumSize[1],
    visible: snapshot.visible, focused: snapshot.focused, alwaysOnTop: snapshot.alwaysOnTop,
    minimized: snapshot.minimized, maximized: snapshot.maximized, fullScreen: snapshot.fullScreen,
    resizable: snapshot.resizable, title: snapshot.title, positioned: true,
  };
}

