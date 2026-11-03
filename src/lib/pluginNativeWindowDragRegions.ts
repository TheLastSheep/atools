export type PluginNativeWindowDragSelf = {
  isDestroyed: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type PluginNativeWindowDragOptions = {
  windowType: string;
  hostKind: string;
  self?: PluginNativeWindowDragSelf | null;
  beginDrag?: (startedAtMs: number) => unknown;
  reportError?: (error: unknown) => unknown;
  /** Test seam for exercising the production listener with synthetic DOM events. */
  isTrustedPointerDown?: (event: PointerEvent) => boolean;
};

type WindowLike = Pick<Window, "addEventListener" | "removeEventListener" | "getComputedStyle">;

/** Serializable, native-only app-region gestures for a BrowserWindow document. */
export function createPluginNativeWindowDragRegions(target: WindowLike, options: PluginNativeWindowDragOptions) {
  const candidate = options.self;
  const noop = () => undefined;
  if (options.windowType !== "browserWindow" || options.hostKind !== "native" || !candidate
    || typeof candidate.isDestroyed !== "function" || typeof candidate.on !== "function" || typeof candidate.off !== "function"
    || typeof options.beginDrag !== "function") return { dispose: noop };
  const self: PluginNativeWindowDragSelf = candidate;

  let disposed = false;
  let dragInFlight = false;
  const now = Date.now;
  function report(error: unknown) {
    try {
      const result = options.reportError?.(error) as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => undefined);
    } catch { /* Diagnostics must not interfere with native window gestures. */ }
  }
  function isDestroyed() {
    try { return self.isDestroyed() === true; }
    catch (error) { report(error); return true; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { target.removeEventListener("pointerdown", onPointerDown, true); } catch (error) { report(error); }
    try { target.removeEventListener("pagehide", dispose); } catch (error) { report(error); }
    try { target.removeEventListener("atools-plugin-out", dispose); } catch (error) { report(error); }
    try { self.off("closed", onSelfClosed); } catch (error) { report(error); }
  }
  function onSelfClosed() { dispose(); }
  function hasDragRegion(event: PointerEvent) {
    let path: EventTarget[] = [];
    try { path = typeof event.composedPath === "function" ? event.composedPath() : []; }
    catch (error) { report(error); return false; }
    for (const item of path) {
      const node = item as Element | null;
      if (!node || node.nodeType !== 1 || node.ownerDocument?.defaultView !== target) continue;
      try {
        const value = target.getComputedStyle(node).getPropertyValue("--atools-native-app-region").trim().toLowerCase();
        if (value === "drag") return true;
        if (value === "no-drag") return false;
      } catch (error) { report(error); return false; }
    }
    return false;
  }
  function onPointerDown(event: PointerEvent) {
    if (disposed || event.type !== "pointerdown" || event.pointerType !== "mouse" || event.isPrimary !== true
      || event.button !== 0 || event.buttons !== 1 || event.ctrlKey === true) return;
    const nativeTrusted = event.isTrusted === true;
    if (!nativeTrusted && !options.isTrustedPointerDown) return;
    // Capture the event epoch before computed-style work or any injected callback can re-enter.
    const startedAtMs = now();
    let trusted = nativeTrusted;
    if (!trusted && options.isTrustedPointerDown) {
      try { trusted = options.isTrustedPointerDown(event); }
      catch (error) { report(error); return; }
    }
    if (!trusted || disposed || dragInFlight) return;
    if (isDestroyed()) { dispose(); return; }
    if (disposed || dragInFlight || !hasDragRegion(event) || disposed || dragInFlight) return;
    if (isDestroyed()) { dispose(); return; }
    if (disposed || dragInFlight) return;

    dragInFlight = true;
    try {
      const result = options.beginDrag?.(startedAtMs) as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") {
        Promise.resolve(result).then(
          () => { if (!disposed) dragInFlight = false; },
          error => { if (!disposed) { dragInFlight = false; report(error); } },
        ).catch(report);
      } else dragInFlight = false;
    } catch (error) { dragInFlight = false; report(error); }
  }

  try {
    self.on("closed", onSelfClosed);
    target.addEventListener("pagehide", dispose);
    target.addEventListener("atools-plugin-out", dispose);
    target.addEventListener("pointerdown", onPointerDown, true);
  } catch (error) {
    report(error);
    dispose();
  }
  if (isDestroyed()) dispose();
  return { dispose };
}
