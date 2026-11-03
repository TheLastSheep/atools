import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";

function compiledDocument(baseBridgeScript?: string) {
  return createPluginBridgeDocument({
    action: { plugin_id: "fixture", plugin_name: "Fixture", feature_code: "fixture", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 0, payload: null },
    windowType: "main", browserWindowId: "", geometrySnapshot: null, workerScope: "fixture-scope",
    mainPushConfig: null, webContentsId: 1, subInputEpoch: 0, appName: "ATools", appVersion: "fixture",
    ...(baseBridgeScript === undefined ? {} : { baseBridgeScript }),
  });
}

function fixtureContext(browser: ReturnType<typeof createCompiledPluginFrameBrowserGlobals>) {
  const listeners = new Map<string, Function[]>();
  const window: any = {
    parent: { postMessage() {} }, top: {}, location: browser.location, history: browser.history,
    Event: browser.Event, CustomEvent: browser.CustomEvent, matchMedia: () => ({ matches: false }),
    addEventListener(name: string, listener: Function) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    removeEventListener(name: string, listener: Function) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)); },
    dispatchEvent(event: Event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
    __ATOOLS_FRAME_TRANSPORT__: { post: () => true, accept: () => true },
  };
  const document = { readyState: "complete", addEventListener() {}, removeEventListener() {} };
  return { target: vm.createContext({ window, document, navigator: { platform: "MacIntel" }, TextEncoder,
    Event: browser.Event, CustomEvent: browser.CustomEvent, Date, Math, Number, Promise, setTimeout, clearTimeout, console }), window };
}

describe("compiled plugin bridge HTML script execution", () => {
  it.each([{ base: "", count: 3 }, { base: undefined, count: 4 }])(
    "executes every inline script in compiler order for each base-transport mode",
    ({ base, count }) => {
      const html = compiledDocument(base);
      const browser = createCompiledPluginFrameBrowserGlobals();
      try {
        const fixture = fixtureContext(browser);
        expect(executeCompiledPluginBridgeScripts(html, fixture.target, count)).toBe(count);
        expect(fixture.window.ztools.onPluginEnter).toEqual(expect.any(Function));
        expect(fixture.window.require("electron")).toBeDefined();
      } finally {
        browser.dispose();
      }
    },
  );

  it("runs fragment-history against the iframe URL and resolves hash navigation", () => {
    const browser = createCompiledPluginFrameBrowserGlobals();
    try {
      const replaced: unknown[] = [];
      Object.defineProperty(browser.history, "pushState", {
        configurable: true,
        writable: true,
        value: (_state: unknown, _title: string, url?: string | URL | null) => replaced.push(url),
      });
      const fixture = fixtureContext(browser);
      executeCompiledPluginBridgeScripts(compiledDocument(""), fixture.target, 3);
      fixture.window.history.pushState({}, "", "#fixture-fragment");
      expect(replaced).toEqual(["about:blank#fixture-fragment"]);
    } finally {
      browser.dispose();
    }
  });
});
