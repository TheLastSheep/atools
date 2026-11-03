import { describe, expect, it, vi } from "vitest";
import { createPluginNativeWindowDomControls } from "../../src/lib/pluginNativeWindowDomControls";
import { createPluginNativeWindowDragRegions } from "../../src/lib/pluginNativeWindowDragRegions";
import { createPluginNativeAppRegionCssRuntime } from "../../src/lib/pluginNativeAppRegionCssRuntime";
import { createPluginNativeAppRegionCss } from "../../src/lib/pluginNativeAppRegionCss";
import {
  NATIVE_FRAME_HTML,
  NATIVE_FRAME_ID,
  compileNativeWindowSelf,
  compileNativeFrameDocument,
  makeNativeFrameAction,
  makeNativeFrameDocumentSourceHost,
} from "./compiledPluginNativeWindowFrameFixture";

type Listener = (event: { type: string }) => void;
type TestTarget = {
  close: () => unknown;
  resizeTo: (width: unknown, height: unknown) => unknown;
  addEventListener: (name: string, listener: Listener) => void;
  removeEventListener: (name: string, listener: Listener) => void;
  dispatch: (name: string) => void;
};
type TestSelf = {
  close: () => unknown;
  setSize: (width: number, height: number) => unknown;
  isDestroyed: () => boolean;
  on: (name: string, listener: Listener) => unknown;
  off: (name: string, listener: Listener) => unknown;
};

function makeDomTarget() {
  const listeners = new Map<string, Set<Listener>>();
  const originalClose = vi.fn();
  const originalResizeTo = vi.fn();
  const target: TestTarget = {
    close: originalClose,
    resizeTo: originalResizeTo,
    addEventListener(name, listener) {
      const group = listeners.get(name) ?? new Set<Listener>();
      group.add(listener);
      listeners.set(name, group);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) { for (const listener of [...(listeners.get(name) ?? [])]) listener({ type: name }); },
  };
  return { target, originalClose, originalResizeTo };
}

function makeNativeSelf(overrides: Partial<TestSelf> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  let destroyed = false;
  const self: TestSelf = {
    close: vi.fn().mockResolvedValue(undefined),
    setSize: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn((name, listener) => {
      const group = listeners.get(name) ?? new Set<Listener>();
      group.add(listener);
      listeners.set(name, group);
    }),
    off: vi.fn((name, listener) => { listeners.get(name)?.delete(listener); }),
    ...overrides,
  };
  return {
    self,
    setDestroyed(value: boolean) { destroyed = value; },
    emit(name: string) {
      if (name === "closed") destroyed = true;
      for (const listener of [...(listeners.get(name) ?? [])]) listener({ type: name });
    },
  };
}

function installDomControls(target: TestTarget, self: TestSelf, reportError = vi.fn()) {
  return createPluginNativeWindowDomControls(target as unknown as Window, {
    windowType: "browserWindow", hostKind: "native", self, reportError,
  });
}

function waitForPromiseTurn() {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("native BrowserWindow DOM controls", () => {
  it("routes the public native child window.resizeTo and close methods through BrowserWindow actions", async () => {
    const frame = compileNativeWindowSelf(makeNativeFrameAction(null, ["browserWindow"]), "native");
    try {
      frame.window.resizeTo(640, 480);
      const resizeRequest = frame.messages.find(message => message.__atools_native_call__ === true);
      if (resizeRequest) {
        frame.dispatchMessage({ __atools_native_response__: true, reqId: resizeRequest.reqId, result: {} });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      frame.window.close();

      const calls = frame.messages.filter(message => message.__atools_native_call__ === true);
      expect(calls.map(message => ({
        method: message.method,
        id: (message.args as Record<string, unknown>).id,
        action: (message.args as Record<string, unknown>).action,
        args: (message.args as Record<string, unknown>).args,
      }))).toEqual([
        { method: "browserWindowAction", id: NATIVE_FRAME_ID, action: "setSize", args: [640, 480] },
        { method: "browserWindowAction", id: NATIVE_FRAME_ID, action: "close", args: [] },
      ]);
      expect(frame.nativeWindowCalls).toEqual({ close: 0, resizeTo: [] });
    } finally {
      frame.dispose();
    }
  });

  it("serializes native controls only into native children and leaves ordinary DOM methods untouched", () => {
    const native = compileNativeWindowSelf(makeNativeFrameAction(), "native");
    const hosted = compileNativeWindowSelf(makeNativeFrameAction(), "hosted");
    const mainHost = makeNativeFrameDocumentSourceHost(makeNativeFrameAction({ srcdoc: NATIVE_FRAME_HTML }));
    mainHost.host.loadPreview();
    const main = compileNativeFrameDocument(mainHost.getIframeSrcDoc());
    const factorySource = createPluginNativeWindowDomControls.toString();
    try {
      expect(native.sourceHtml).toContain(factorySource);
      expect(hosted.sourceHtml).not.toContain(factorySource);
      expect(main.sourceHtml).not.toContain(factorySource);
      const nativeOnlyFactories = [
        createPluginNativeWindowDomControls.toString(),
        createPluginNativeWindowDragRegions.toString(),
        createPluginNativeAppRegionCssRuntime.toString(),
        createPluginNativeAppRegionCss.toString(),
      ];
      for (const source of nativeOnlyFactories) {
        expect(native.sourceHtml).toContain(source);
        expect(hosted.sourceHtml).not.toContain(source);
        expect(main.sourceHtml).not.toContain(source);
      }
      expect(native.sourceHtml.length - hosted.sourceHtml.length).toBe(
        nativeOnlyFactories.reduce((total, source) => total + source.length - "undefined".length, 0),
      );
      expect(native.window.close).not.toBe(native.originalWindowMethods.close);
      expect(native.window.resizeTo).not.toBe(native.originalWindowMethods.resizeTo);
      for (const frame of [hosted, main]) {
        expect(frame.window.close).toBe(frame.originalWindowMethods.close);
        expect(frame.window.resizeTo).toBe(frame.originalWindowMethods.resizeTo);
      }
    } finally {
      native.dispose();
      hosted.dispose();
      main.dispose();
    }
  });

  it("deduplicates a pending close and allows retry after rejection", async () => {
    const pendingClose = deferred<void>();
    const firstError = new Error("close did not finish");
    const close = vi.fn()
      .mockReturnValueOnce(pendingClose.promise)
      .mockResolvedValueOnce(undefined);
    const reportError = vi.fn();
    const { target } = makeDomTarget();
    const { self, emit, setDestroyed } = makeNativeSelf({ close });
    const controls = installDomControls(target, self, reportError);

    try {
      expect(target.close()).toBeUndefined();
      expect(target.close()).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);

      pendingClose.reject(firstError);
      await waitForPromiseTurn();
      expect(reportError).toHaveBeenCalledWith(firstError);
      expect(target.close()).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(2);

      setDestroyed(true);
      emit("closed");
    } finally {
      controls.dispose();
    }
  });

  it("coalesces resize bursts to one in-flight call and the latest pending size", async () => {
    const first = deferred<void>();
    const last = deferred<void>();
    const setSize = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(last.promise);
    const { target } = makeDomTarget();
    const { self } = makeNativeSelf({ setSize });
    const controls = installDomControls(target, self);
    const width = { [Symbol.toPrimitive]: vi.fn(() => 100.9) };

    try {
      expect(target.resizeTo(width, 200.9)).toBeUndefined();
      for (let index = 0; index < 100; index++) target.resizeTo(1000 + index, 2000 + index);
      expect(setSize).toHaveBeenCalledTimes(1);
      expect(setSize).toHaveBeenNthCalledWith(1, 100, 200);
      expect(width[Symbol.toPrimitive]).toHaveBeenCalledTimes(1);

      first.resolve();
      await waitForPromiseTurn();
      expect(setSize).toHaveBeenCalledTimes(2);
      expect(setSize).toHaveBeenNthCalledWith(2, 1099, 2099);
      last.resolve();
      await waitForPromiseTurn();
      expect(setSize).toHaveBeenCalledTimes(2);
    } finally {
      controls.dispose();
    }
  });

  it("validates resize dimensions before sending a native size action", () => {
    const { target } = makeDomTarget();
    const { self } = makeNativeSelf();
    const controls = installDomControls(target, self);
    try {
      expect(() => target.resizeTo(0, 480)).toThrow(RangeError);
      expect(() => target.resizeTo(16_385, 480)).toThrow(RangeError);
      expect(() => target.resizeTo(Number.NaN, 480)).toThrow(RangeError);
      expect(() => target.resizeTo(Symbol("width"), 480)).toThrow(TypeError);
      expect(self.setSize).not.toHaveBeenCalled();
    } finally {
      controls.dispose();
    }
  });

  it("drops a queued resize once close starts", async () => {
    const size = deferred<void>();
    const closing = deferred<void>();
    const setSize = vi.fn(() => size.promise);
    const close = vi.fn(() => closing.promise);
    const { target } = makeDomTarget();
    const { self, emit, setDestroyed } = makeNativeSelf({ setSize, close });
    const controls = installDomControls(target, self);
    try {
      target.resizeTo(300, 400);
      target.resizeTo(800, 900);
      target.close();
      expect(setSize).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(target.resizeTo(1000, 1200)).toBeUndefined();

      size.resolve();
      await waitForPromiseTurn();
      expect(setSize).toHaveBeenCalledTimes(1);
      setDestroyed(true);
      closing.resolve();
      await waitForPromiseTurn();
      emit("closed");
    } finally {
      controls.dispose();
    }
  });

  it.each(["pagehide", "atools-plugin-out", "closed"] as const)(
    "makes captured DOM methods inert after %s", async eventName => {
      const { target } = makeDomTarget();
      const { self, emit } = makeNativeSelf();
      const controls = installDomControls(target, self);
      const capturedClose = target.close;
      const capturedResizeTo = target.resizeTo;

      if (eventName === "closed") emit(eventName);
      else target.dispatch(eventName);
      capturedResizeTo(320, 240);
      capturedClose();
      await waitForPromiseTurn();

      expect(self.setSize).not.toHaveBeenCalled();
      expect(self.close).not.toHaveBeenCalled();
      expect(target.close).not.toBe(capturedClose);
      expect(target.resizeTo).not.toBe(capturedResizeTo);
      controls.dispose();
    },
  );

  it("does not overwrite a later plugin replacement while restoring descriptors", () => {
    const { target, originalClose, originalResizeTo } = makeDomTarget();
    const { self } = makeNativeSelf();
    const controls = installDomControls(target, self);
    const capturedClose = target.close;
    const capturedResizeTo = target.resizeTo;
    const pluginClose = vi.fn();
    const pluginResizeTo = vi.fn();

    target.close = pluginClose;
    target.resizeTo = pluginResizeTo;
    controls.dispose();

    expect(target.close).toBe(pluginClose);
    expect(target.resizeTo).toBe(pluginResizeTo);
    capturedResizeTo(320, 240);
    capturedClose();
    expect(self.setSize).not.toHaveBeenCalled();
    expect(self.close).not.toHaveBeenCalled();
    expect(originalClose).not.toHaveBeenCalled();
    expect(originalResizeTo).not.toHaveBeenCalled();
  });

  it("preserves plugin accessors without invoking getters that return captured wrappers", () => {
    const { target } = makeDomTarget();
    const { self } = makeNativeSelf();
    const controls = installDomControls(target, self);
    const capturedClose = target.close;
    const capturedResizeTo = target.resizeTo;
    const closeGetter = vi.fn(() => capturedClose);
    const resizeGetter = vi.fn(() => capturedResizeTo);
    const closeSetter = vi.fn();
    const resizeSetter = vi.fn();

    Object.defineProperty(target, "close", { configurable: true, enumerable: true, get: closeGetter, set: closeSetter });
    Object.defineProperty(target, "resizeTo", { configurable: true, enumerable: true, get: resizeGetter, set: resizeSetter });
    controls.dispose();

    const closeDescriptor = Object.getOwnPropertyDescriptor(target, "close");
    const resizeDescriptor = Object.getOwnPropertyDescriptor(target, "resizeTo");
    expect(closeGetter).not.toHaveBeenCalled();
    expect(resizeGetter).not.toHaveBeenCalled();
    expect(closeDescriptor?.get).toBe(closeGetter);
    expect(closeDescriptor?.set).toBe(closeSetter);
    expect(resizeDescriptor?.get).toBe(resizeGetter);
    expect(resizeDescriptor?.set).toBe(resizeSetter);

    capturedResizeTo(320, 240);
    capturedClose();
    expect(self.setSize).not.toHaveBeenCalled();
    expect(self.close).not.toHaveBeenCalled();
  });

  it("does not enqueue a reentrant resize when coercion starts a close", async () => {
    const firstSize = deferred<void>();
    const closeResult = deferred<void>();
    const setSize = vi.fn(() => firstSize.promise);
    const close = vi.fn(() => closeResult.promise);
    const { target } = makeDomTarget();
    const { self } = makeNativeSelf({ setSize, close });
    const controls = installDomControls(target, self);

    try {
      target.resizeTo(320, 240);
      const valueOf = vi.fn(() => {
        target.close();
        return 640;
      });
      const width = { valueOf };
      expect(target.resizeTo(width, 480)).toBeUndefined();
      expect(valueOf).toHaveBeenCalledTimes(1);
      expect(setSize).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);

      closeResult.reject(new Error("close was denied"));
      await waitForPromiseTurn();
      firstSize.resolve();
      await waitForPromiseTurn();
      expect(setSize).toHaveBeenCalledTimes(1);
      expect(setSize).toHaveBeenCalledWith(320, 240);
    } finally {
      controls.dispose();
    }
  });

  it("does not send a resize captured across pagehide-triggered coercion", async () => {
    const firstSize = deferred<void>();
    const setSize = vi.fn(() => firstSize.promise);
    const { target, originalResizeTo } = makeDomTarget();
    const { self } = makeNativeSelf({ setSize });
    const controls = installDomControls(target, self);

    try {
      target.resizeTo(320, 240);
      const valueOf = vi.fn(() => {
        target.dispatch("pagehide");
        return 640;
      });
      const width = { valueOf };
      const inProgressResizeTo = target.resizeTo;
      expect(inProgressResizeTo(width, 480)).toBeUndefined();
      expect(valueOf).toHaveBeenCalledTimes(1);
      expect(target.resizeTo).toBe(originalResizeTo);

      firstSize.resolve();
      await waitForPromiseTurn();
      expect(setSize).toHaveBeenCalledTimes(1);
      expect(setSize).toHaveBeenCalledWith(320, 240);
    } finally {
      controls.dispose();
    }
  });

  it("contains synchronous and rejected failures even when the reporter throws", async () => {
    const syncCloseError = new Error("sync close failed");
    const asyncCloseError = new Error("async close failed");
    const syncSizeError = new Error("sync size failed");
    const asyncSizeError = new Error("async size failed");
    let closeCount = 0;
    let sizeCount = 0;
    const close = vi.fn(() => {
      if (++closeCount === 1) throw syncCloseError;
      return Promise.reject(asyncCloseError);
    });
    const setSize = vi.fn(() => {
      if (++sizeCount === 1) throw syncSizeError;
      return Promise.reject(asyncSizeError);
    });
    const reportError = vi.fn(() => { throw new Error("reporter failed"); });
    const { target } = makeDomTarget();
    const { self } = makeNativeSelf({ close, setSize });
    const controls = installDomControls(target, self, reportError);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(target.close()).toBeUndefined();
      expect(target.close()).toBeUndefined();
      await waitForPromiseTurn();
      expect(target.resizeTo(320, 240)).toBeUndefined();
      expect(target.resizeTo(360, 260)).toBeUndefined();
      await waitForPromiseTurn();
      expect(close).toHaveBeenCalledTimes(2);
      expect(setSize).toHaveBeenCalledTimes(2);
      expect(reportError.mock.calls.map(call => call[0])).toEqual([
        syncCloseError, asyncCloseError, syncSizeError, asyncSizeError,
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      controls.dispose();
    }
  });
});
