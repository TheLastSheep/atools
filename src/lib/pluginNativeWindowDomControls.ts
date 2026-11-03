type NativeWindowDomSelf = {
  close: () => unknown;
  setSize: (width: number, height: number) => unknown;
  isDestroyed: () => boolean;
  on: (name: string, listener: (...args: unknown[]) => void) => unknown;
  off: (name: string, listener: (...args: unknown[]) => void) => unknown;
};

type NativeWindowDomTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type NativeWindowDomControlsOptions = {
  windowType: string;
  hostKind: string;
  self?: NativeWindowDomSelf | null;
  reportError?: (error: unknown) => unknown;
};
type ResizeRequest = { width: number; height: number };

/** Serializable DOM controls for the native BrowserWindow's own plugin document. */
export function createPluginNativeWindowDomControls(
  target: NativeWindowDomTarget,
  options: NativeWindowDomControlsOptions,
) {
  const candidate = options.self;
  const noopDispose = () => undefined;
  if (options.windowType !== "browserWindow" || options.hostKind !== "native" || !candidate
    || typeof candidate.close !== "function" || typeof candidate.setSize !== "function"
    || typeof candidate.isDestroyed !== "function" || typeof candidate.on !== "function" || typeof candidate.off !== "function") {
    return { dispose: noopDispose };
  }
  const self: NativeWindowDomSelf = candidate;

  const targetRecord = target as unknown as Record<string, unknown>;
  const originalClose = Object.getOwnPropertyDescriptor(target, "close");
  const originalResizeTo = Object.getOwnPropertyDescriptor(target, "resizeTo");
  let disposed = false;
  let closing = false;
  let resizeInFlight = false;
  let pendingResize: ResizeRequest | undefined;
  let closeWrapper!: () => undefined;
  let resizeWrapper!: (width: unknown, height: unknown) => undefined;

  function report(error: unknown) {
    try {
      const result = options.reportError?.(error) as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => undefined);
    } catch { /* Diagnostics must never create an unhandled rejection. */ }
  }

  function restore(name: "close" | "resizeTo", wrapper: Function, descriptor?: PropertyDescriptor) {
    try {
      const current = Object.getOwnPropertyDescriptor(target, name);
      if (!current || !("value" in current) || current.value !== wrapper) return;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete targetRecord[name];
    } catch (error) { report(error); }
  }

  function install(name: "close" | "resizeTo", wrapper: Function, descriptor?: PropertyDescriptor) {
    if (descriptor && !descriptor.configurable
      && (!("value" in descriptor) || !descriptor.writable)) {
      throw new TypeError(`window.${name} cannot be replaced by the native BrowserWindow host`);
    }
    Object.defineProperty(target, name, {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: wrapper,
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pendingResize = undefined;
    try { target.removeEventListener("pagehide", dispose); } catch (error) { report(error); }
    try { target.removeEventListener("atools-plugin-out", dispose); } catch (error) { report(error); }
    try { self.off("closed", onSelfClosed); } catch (error) { report(error); }
    restore("close", closeWrapper, originalClose);
    restore("resizeTo", resizeWrapper, originalResizeTo);
  }

  function onSelfClosed() { dispose(); }
  function isDestroyed() {
    try { return self.isDestroyed() === true; }
    catch (error) { report(error); return true; }
  }
  function toNativeSize(value: unknown) {
    const numeric = +(value as number);
    const size = Math.trunc(numeric);
    if (!Number.isFinite(numeric) || !Number.isInteger(size) || size < 1 || size > 16384)
      throw new RangeError("window.resizeTo size must be a finite integer from 1 through 16384");
    return size;
  }

  function finishResize(failed: boolean, error?: unknown) {
    resizeInFlight = false;
    if (disposed) return;
    if (failed) report(error);
    flushResize();
  }
  function flushResize() {
    if (disposed || closing || resizeInFlight || !pendingResize) return;
    if (isDestroyed()) { dispose(); return; }
    const request = pendingResize;
    pendingResize = undefined;
    resizeInFlight = true;
    let result: unknown;
    try { result = self.setSize(request.width, request.height); }
    catch (error) { finishResize(true, error); return; }
    Promise.resolve(result).then(
      () => finishResize(false),
      error => finishResize(true, error),
    ).catch(report);
  }

  closeWrapper = function() {
    if (disposed || closing) return undefined;
    if (isDestroyed()) { dispose(); return undefined; }
    closing = true;
    pendingResize = undefined;
    let result: unknown;
    try { result = self.close(); }
    catch (error) {
      closing = false;
      report(error);
      return undefined;
    }
    Promise.resolve(result).then(
      () => { if (!disposed && isDestroyed()) dispose(); },
      error => { if (!disposed) { closing = false; report(error); } },
    ).catch(report);
    return undefined;
  };

  resizeWrapper = function(width: unknown, height: unknown) {
    if (disposed || closing) return undefined;
    if (isDestroyed()) { dispose(); return undefined; }
    const request = { width: toNativeSize(width), height: toNativeSize(height) };
    if (disposed || closing) return undefined;
    if (isDestroyed()) { dispose(); return undefined; }
    pendingResize = request;
    flushResize();
    return undefined;
  };

  try {
    self.on("closed", onSelfClosed);
    target.addEventListener("pagehide", dispose);
    target.addEventListener("atools-plugin-out", dispose);
    if (disposed) return { dispose };
    install("close", closeWrapper, originalClose);
    install("resizeTo", resizeWrapper, originalResizeTo);
  } catch (error) {
    report(error);
    dispose();
    return { dispose };
  }

  if (isDestroyed()) dispose();
  return { dispose };
}
