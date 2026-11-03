import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createPluginElectronAdapter, pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { createPluginElectronWebFrame } from "../../src/lib/pluginElectronWebFrame";
import packageInfo from "../../package.json";

function documentHarness(rootPresent = true) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const root = rootPresent ? { style: { zoom: "" } } : null;
  const document = {
    documentElement: root,
    addEventListener: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(callback);
      listeners.set(name, set);
    }),
    removeEventListener: vi.fn((name: string, callback: (...args: unknown[]) => void) => listeners.get(name)?.delete(callback)),
    dispatch(name: string) { for (const callback of [...(listeners.get(name) ?? [])]) callback(); },
    listenerCount(name: string) { return listeners.get(name)?.size ?? 0; },
    root,
  };
  return document;
}

function runFullShim(document: any) {
  const delegate = vi.fn((specifier: string) => ({ delegated: specifier }));
  const nativeElectron = { ipcRenderer: { on: vi.fn() } };
  const localRequire = vi.fn((specifier: string) => specifier === "electron" ? nativeElectron : delegate(specifier));
  const hostWindow: any = {
    document,
    require: localRequire,
    console: { error: vi.fn() },
    utools: { getAppName: () => packageInfo.productName, getAppVersion: () => packageInfo.version },
  };
  const source = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  new Function("window", source)(hostWindow);
  return { hostWindow, localRequire, delegate };
}

function earlyDocument() {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  Object.defineProperty(dom.window.document, "documentElement", { configurable: true, value: null });
  return dom;
}

describe("serialized Electron webFrame zoom compatibility", () => {
  it("scopes zoom to each frame document and preserves the Node require bridge", () => {
    const parent = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
    const child = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
    const parentAddDocument = vi.spyOn(parent.window.document, "addEventListener");
    const parentAddWindow = vi.spyOn(parent.window, "addEventListener");
    const childAddDocument = vi.spyOn(child.window.document, "addEventListener");
    const childAddWindow = vi.spyOn(child.window, "addEventListener");
    const childInitialZoom = child.window.document.documentElement!.style.zoom;
    const parentHost = runFullShim(parent.window.document), childHost = runFullShim(child.window.document);
    const parentFrame = parentHost.hostWindow.require("electron").webFrame;
    const childFrame = childHost.hostWindow.require("electron").webFrame;

    expect(parentFrame.getZoomFactor()).toBe(1);
    expect(childFrame.getZoomFactor()).toBe(1);
    parentFrame.setZoomFactor(1.25);
    expect(parent.window.document.documentElement!.style.zoom).toBe("1.25");
    expect(parentFrame.getZoomFactor()).toBe(1.25);
    expect(child.window.document.documentElement!.style.zoom).toBe(childInitialZoom);
    expect(childFrame.getZoomFactor()).toBe(1);
    expect(parentHost.hostWindow.require("fs")).toEqual({ delegated: "fs" });
    expect(parentHost.localRequire).toHaveBeenCalledWith("fs");
    expect(parentHost.hostWindow.require("electron")).toBe(parentHost.hostWindow.require("electron"));
    expect(parentAddDocument).not.toHaveBeenCalled();
    expect(parentAddWindow).not.toHaveBeenCalled();
    expect(childAddDocument).not.toHaveBeenCalled();
    expect(childAddWindow).not.toHaveBeenCalled();
    parent.window.close();
    child.window.close();
  });

  it("rejects non-finite and non-positive factors without changing the current zoom", () => {
    const document = documentHarness();
    const { hostWindow } = runFullShim(document);
    const frame = hostWindow.require("electron").webFrame;
    frame.setZoomFactor(1.5);
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2", null, undefined]) {
      expect(() => frame.setZoomFactor(invalid)).toThrow();
      expect(frame.getZoomFactor()).toBe(1.5);
      expect(document.root?.style.zoom).toBe("1.5");
    }
  });

  it("defers one early document zoom until DOMContentLoaded and removes lifecycle listeners", () => {
    const dom = earlyDocument();
    const document = dom.window.document;
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const removeWindowListener = vi.spyOn(dom.window, "removeEventListener");
    const { hostWindow } = runFullShim(document);
    const frame = hostWindow.require("electron").webFrame;
    frame.setZoomFactor(1.25);
    frame.setZoomFactor(1.5);
    expect(addDocumentListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
    expect(addDocumentListener).not.toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(frame.getZoomFactor()).toBe(1);
    Object.defineProperty(document, "documentElement", { configurable: true, value: { style: { zoom: "" } } });
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    expect(document.documentElement?.style.zoom).toBe("1.5");
    expect(removeWindowListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
    expect(frame.getZoomFactor()).toBe(1.5);
    dom.window.close();
  });

  it("cleans a pending early application when the frame receives pagehide", () => {
    const dom = earlyDocument();
    const document = dom.window.document;
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const addWindowListener = vi.spyOn(dom.window, "addEventListener");
    const removeWindowListener = vi.spyOn(dom.window, "removeEventListener");
    const { hostWindow } = runFullShim(document);
    const frame = hostWindow.require("electron").webFrame;
    frame.setZoomFactor(1.25);
    expect(addWindowListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    document.dispatchEvent(new dom.window.PageTransitionEvent("pagehide"));
    expect(removeWindowListener).not.toHaveBeenCalledWith("pagehide", expect.any(Function));
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide"));
    expect(removeWindowListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
    expect(() => frame.setZoomFactor(1.5)).toThrow("document is no longer active");
    dom.window.close();
  });

  it("reports only the last applied factor when the deferred CSS write fails", () => {
    const dom = earlyDocument();
    const document = dom.window.document;
    const report = vi.spyOn(dom.window.console, "error").mockImplementation(() => {});
    const { hostWindow } = runFullShim(document);
    const frame = hostWindow.require("electron").webFrame;
    frame.setZoomFactor(1.25);
    expect(frame.getZoomFactor()).toBe(1);

    let current = "";
    const rejectingRoot = {
      style: {
        get zoom() { return current; },
        set zoom(_value: string) { throw new Error("deferred CSS write failed"); },
      },
    };
    Object.defineProperty(document, "documentElement", { configurable: true, value: rejectingRoot });
    expect(() => document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }))).not.toThrow();
    expect(frame.getZoomFactor()).toBe(1);
    expect(current).toBe("");
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0]).toBe("[ATools electron webFrame.setZoomFactor]");
    dom.window.close();
  });

  it("does not report success or change its factor when the document rejects CSS zoom", () => {
    const document = documentHarness();
    let current = "";
    Object.defineProperty(document.root!.style, "zoom", {
      get: () => current,
      set: () => { throw new Error("CSS style rejected zoom"); },
    });
    const { hostWindow } = runFullShim(document);
    const frame = hostWindow.require("electron").webFrame;
    expect(() => frame.setZoomFactor(1.25)).toThrow("CSS style rejected zoom");
    expect(frame.getZoomFactor()).toBe(1);
    expect(current).toBe("");
  });

  it("reports webFrame unsupported when an adapter has no current document host", () => {
    const electron = createPluginElectronAdapter({ application: { name: "ATools", version: "test" } });
    expect(() => electron.webFrame.getZoomFactor()).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    expect(() => electron.webFrame.setZoomFactor(1.25)).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
  });

  it("does not install an uncollectable DOMContentLoaded listener without the frame Window", () => {
    const addEventListener = vi.fn();
    const detachedDocument = {
      defaultView: null,
      documentElement: null,
      createElement: () => ({ style: { zoom: "" } }),
      addEventListener,
    } as unknown as Document;
    const frame = createPluginElectronWebFrame(detachedDocument);
    expect(() => frame.setZoomFactor(1.25)).toThrow("current document window is unavailable");
    expect(frame.getZoomFactor()).toBe(1);
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
