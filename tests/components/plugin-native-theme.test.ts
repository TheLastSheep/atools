import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { createPluginNativeTheme } from "../../src/lib/pluginNativeTheme";
import { createPluginPanelDocumentSourceHost } from "../../src/lib/pluginPanelDocumentSourceHost";
import { createLauncherNavigationController } from "../../src/lib/launcherNavigationController";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";

function mediaHarness(initial = false) {
  let matches = initial;
  const listeners = new Set<Function>();
  return {
    media: { get matches() { return matches; }, addEventListener: (_: string, fn: Function) => listeners.add(fn),
      removeEventListener: (_: string, fn: Function) => listeners.delete(fn) },
    set(value: boolean) { if (matches === value) return; matches = value; for (const listener of [...listeners]) listener({ matches }); },
    count: () => listeners.size,
  };
}

function hostWindow(media = mediaHarness()) {
  const listeners = new Map<string, Set<Function>>();
  return {
    media,
    window: {
      matchMedia: () => media.media,
      addEventListener(name: string, fn: Function) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); },
      removeEventListener(name: string, fn: Function) { listeners.get(name)?.delete(fn); },
      fire(name: string) { for (const listener of [...(listeners.get(name) ?? [])]) listener(); },
      listenerCount(name: string) { return listeners.get(name)?.size ?? 0; },
    },
  };
}

function executeThemeDocument(html: string) {
  const browser = createCompiledPluginFrameBrowserGlobals();
  const media = mediaHarness(false), windowListeners = new Map<string, Set<Function>>(), broker = { on() {} };
  const window: any = {
    parent: { postMessage() {} }, top: {}, location: browser.location, history: browser.history,
    Event: browser.Event, CustomEvent: browser.CustomEvent, DOMParser, matchMedia: () => media.media,
    require: (name: string) => name === "electron" ? { ipcRenderer: broker } : {},
    addEventListener(name: string, listener: Function) { const set = windowListeners.get(name) ?? new Set(); set.add(listener); windowListeners.set(name, set); },
    removeEventListener(name: string, listener: Function) { windowListeners.get(name)?.delete(listener); },
    fire(name: string) { for (const listener of [...(windowListeners.get(name) ?? [])]) listener(); },
    __ATOOLS_FRAME_TRANSPORT__: { post: () => true, accept: () => true },
  };
  const context = vm.createContext({ window, document: { readyState: "complete", addEventListener() {}, removeEventListener() {} },
    navigator: { platform: "MacIntel" }, TextEncoder, Event: browser.Event, CustomEvent: browser.CustomEvent,
    Date, Math, Number, Promise, setTimeout, clearTimeout, console });
  executeCompiledPluginBridgeScripts(html, context, 3);
  return { electron: window.require("electron"), media, close: () => { window.fire("pagehide"); browser.dispose(); } };
}

describe("plugin document nativeTheme subset", () => {
  it("follows system changes only when the resolved dark value changes and supports EventEmitter removal", () => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, "system");
    expect(fixture.window.listenerCount("pagehide")).toBe(1);
    const changed = vi.fn(), once = vi.fn(), removed = vi.fn();
    expect(theme.shouldUseDarkColors).toBe(false);
    expect(theme.on("updated", changed)).toBe(theme);
    theme.once("updated", once).addListener("updated", removed);
    theme.removeListener("updated", removed);
    expect(fixture.media.count()).toBe(1);
    fixture.media.set(true);
    expect(theme.shouldUseDarkColors).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(once).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    fixture.media.set(true);
    expect(changed).toHaveBeenCalledOnce();
    fixture.media.set(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(once).toHaveBeenCalledOnce();
    theme.removeAllListeners();
    expect(fixture.media.count()).toBe(0);
    expect(fixture.window.listenerCount("pagehide")).toBe(1);
    fixture.window.fire("pagehide");
    expect(fixture.window.listenerCount("pagehide")).toBe(0);
  });

  it.each([["light", false], ["dark", true]] as const)("keeps explicit %s mode fixed", (source, dark) => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, source);
    const updated = vi.fn();
    theme.on("updated", updated);
    fixture.media.set(!dark);
    expect(theme.themeSource).toBe(source);
    expect(theme.shouldUseDarkColors).toBe(dark);
    expect(updated).not.toHaveBeenCalled();
    expect(fixture.media.count()).toBe(0);
    expect(() => { (theme as any).themeSource = "system"; }).toThrow("read-only");
    theme.removeAllListeners();
  });

  it("isolates listener errors, enforces a fixed cap, and clears subscriptions on pagehide", () => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, "system");
    const afterFailure = vi.fn();
    theme.on("updated", () => { throw new Error("plugin callback"); }).on("updated", afterFailure);
    for (let index = 0; index < 62; index++) theme.on("updated", () => {});
    expect(() => theme.on("updated", () => {})).toThrow("LISTENER_LIMIT");
    fixture.media.set(true);
    expect(afterFailure).toHaveBeenCalledOnce();
    fixture.window.fire("pagehide");
    expect(fixture.media.count()).toBe(0);
    expect(fixture.window.listenerCount("pagehide")).toBe(0);
    expect(() => theme.on("updated", () => {})).toThrow("DOCUMENT_CLOSED");
    fixture.media.set(false);
    expect(afterFailure).toHaveBeenCalledOnce();
  });

  it("allows late plugin cleanup after pagehide while rejecting new listeners", () => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, "system");
    const callback = vi.fn();
    const listener = vi.fn();
    theme.on("updated", callback).addListener("updated", listener);
    fixture.window.fire("pagehide");

    expect(fixture.media.count()).toBe(0);
    expect(fixture.window.listenerCount("pagehide")).toBe(0);
    expect(() => theme.off("updated", callback)).not.toThrow();
    expect(() => theme.removeListener("updated", listener)).not.toThrow();
    expect(() => theme.removeAllListeners("updated")).not.toThrow();
    expect(() => theme.removeAllListeners()).not.toThrow();
    expect(() => theme.on("updated", vi.fn())).toThrow("DOCUMENT_CLOSED");
  });

  it("keeps document-close protection after removeAllListeners", () => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, "system");
    theme.on("updated", vi.fn());
    expect(fixture.media.count()).toBe(1);
    theme.removeAllListeners();
    expect(fixture.media.count()).toBe(0);
    expect(fixture.window.listenerCount("pagehide")).toBe(1);

    fixture.window.fire("pagehide");
    expect(fixture.window.listenerCount("pagehide")).toBe(0);
    expect(() => theme.on("updated", vi.fn())).toThrow("DOCUMENT_CLOSED");
    expect(() => theme.once("updated", vi.fn())).toThrow("DOCUMENT_CLOSED");
    expect(() => theme.addListener("updated", vi.fn())).toThrow("DOCUMENT_CLOSED");
    expect(fixture.media.count()).toBe(0);
  });

  it("invalidates even a document that never subscribed and keeps system reads unobserved", () => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, "system");
    expect(theme.shouldUseDarkColors).toBe(false);
    expect(fixture.media.count()).toBe(0);
    expect(fixture.window.listenerCount("pagehide")).toBe(1);

    fixture.window.fire("pagehide");
    expect(() => theme.on("updated", vi.fn())).toThrow("DOCUMENT_CLOSED");
    expect(fixture.media.count()).toBe(0);
    expect(fixture.window.listenerCount("pagehide")).toBe(0);
  });

  it("calls ordinary function listeners with nativeTheme as this", () => {
    const fixture = hostWindow();
    const theme = createPluginNativeTheme(fixture.window, "system");
    let receiver: unknown;
    theme.on("updated", function (this: unknown) { receiver = this; });
    fixture.media.set(true);
    expect(receiver).toBe(theme);
    theme.removeAllListeners();
    fixture.window.fire("pagehide");
  });

  it("installs the effective ATools document theme in the production Electron adapter", async () => {
    const rootTheme = document.documentElement.dataset.atoolsTheme;
    document.documentElement.dataset.atoolsTheme = "system";
    const sourceHost = createPluginPanelDocumentSourceHost({
      action: () => ({ plugin_id: "fixture", plugin_name: "Fixture", feature_code: "fixture", main_url: "index.html", plugin_path: "/fixture", expand_height: 0 }),
      workerDocument: { freshScope: () => "scope" }, hostedIpc: { reserve: () => 1 }, mainPushHost: undefined,
      generation: () => 1, pluginPathForPreview: "/fixture", productName: "ATools", productVersion: "test",
      clipboard: () => undefined, data: () => undefined, paths: () => undefined, dialogs: () => undefined, display: () => undefined,
      secretStorage: () => undefined, bridgeScript: () => "", smokeEnabled: () => false, smokeSampleIndex: () => 0,
      subInputState: () => ({ sequence: 0, epoch: 0, value: "", visible: false, options: {} }), setSubInputState() {},
      iframeSrc() {}, iframeSrcDoc() {}, setPluginItems() {}, setSelectedIndex() {}, setLoadError() {},
    } as any);
    const firstDocument = executeThemeDocument(sourceHost.bridgeHtml());
    try {
      const firstUpdated = vi.fn();
      expect(firstDocument.electron.nativeTheme.themeSource).toBe("system");
      expect(firstDocument.electron.nativeTheme.shouldUseDarkColors).toBe(false);
      firstDocument.electron.nativeTheme.on("updated", firstUpdated);
      firstDocument.media.set(true);
      expect(firstDocument.electron.nativeTheme.shouldUseDarkColors).toBe(true);
      expect(firstUpdated).toHaveBeenCalledOnce();

      const state: any = { activePlugin: { plugin_id: "fixture" }, activePanel: "home", appSettings: {}, query: "", results: [],
        selectedIndex: 0, selectedRecentIndex: 0, settingsMenuTarget: "general", pluginMarketRequest: null,
        commandHistory: [], visibleRecentCommands: [] };
      const navigation = createLauncherNavigationController({
        state, pendingPluginActivation: { cancel() {} }, clearReturnContext() {}, closePromoted: async () => {},
        returnPluginToSearch: async () => {}, refreshFeatureCatalog() {}, hasTauriRuntime: () => false, resetPalette: async () => {},
        focusSearch() {}, cancelTabTarget() {}, onQueryChange: async () => {}, activateFeature: async () => {}, expectedPluginId: () => undefined,
        rememberCommandResult() {}, activateHistoryPayload: async () => {}, launcherPinsContext: () => ({}), copyText: async () => {},
        openHideMainWindow: async () => {}, hasContentContext: () => false, clearContentContext() {}, cancelMediaIntake() {},
        advanceSearchRun() {}, clearSearchContexts() {}, defaultWindowHeight: () => 500, expandPalette: async () => {},
        normalizePluginMarketRequest: () => null,
      } as any);
      await navigation.handlePluginSettingsRedirect("ai");
      expect(state.activePlugin).toBeNull();
      expect(state.activePanel).toBe("settings");
      document.documentElement.dataset.atoolsTheme = "light";
      const nextDocument = executeThemeDocument(sourceHost.bridgeHtml());
      expect(nextDocument.electron.nativeTheme.themeSource).toBe("light");
      expect(nextDocument.electron.nativeTheme.shouldUseDarkColors).toBe(false);
      expect(() => { nextDocument.electron.nativeTheme.themeSource = "dark"; }).toThrow("read-only");
      firstDocument.close();
      firstDocument.media.set(false);
      expect(firstUpdated).toHaveBeenCalledOnce();
      nextDocument.close();
    } finally {
      firstDocument.close();
      if (rootTheme === undefined) delete document.documentElement.dataset.atoolsTheme;
      else document.documentElement.dataset.atoolsTheme = rootTheme;
    }
  });
});
