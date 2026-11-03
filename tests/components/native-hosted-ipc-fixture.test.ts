import { expect, it } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import frameSource from "./nativePluginBrowserWindowFrameProbe.js?raw";
import operationsSource from "./nativePluginHostedIpcOperations.js?raw";

const sourceRoot = "ZTools-plugins/plugins/pomodoro-timer/";
const menuClass = readFileSync(sourceRoot + "page/index/js/contextMenuWindow.js", "utf8");
const menuHtml = readFileSync(sourceRoot + "page/contextMenu/contextMenu.html", "utf8");
const childPreload = readFileSync(sourceRoot + "base/js/preload.js", "utf8");
type Callback = (...args: any[]) => void;

function harness() {
  // Synthetic host routing only. The actual fixture observer, operations and complete original menu sources execute;
  // this unit test proves their wiring and verifier boundaries, never production identity security or native UI.
  let nextId = 1, receive: (event: any) => Promise<void> = async () => {};
  const replies: any[] = [], events: string[] = [], frames = new Map<number, { api: any; close: () => void }>();
  const parent: any = { postMessage: (value: any) => replies.push(value) };
  function ipc(id: number) {
    const listeners = new Map<string, { callback: Callback; once: boolean }[]>();
    const api = {
      on(channel: string, callback: Callback) { listeners.set(channel, [...(listeners.get(channel) || []), { callback, once: false }]); return api; },
      once(channel: string, callback: Callback) { listeners.set(channel, [...(listeners.get(channel) || []), { callback, once: true }]); return api; },
      off(channel: string, callback: Callback) { listeners.set(channel, (listeners.get(channel) || []).filter(entry => entry.callback !== callback)); return api; },
      removeAllListeners(channel: string) { listeners.delete(channel); return api; },
      sendTo(targetId: number, channel: string, ...args: any[]) {
        if (channel.endsWith("original-menu-click")) events.push("fixed-trigger");
        frames.get(targetId)?.api.deliver(channel, { senderId: id }, args);
      },
      deliver(channel: string, event: any, args: any[]) {
        for (const entry of [...(listeners.get(channel) || [])]) {
          if (entry.once) api.off(channel, entry.callback);
          entry.callback(event, ...args);
        }
      },
    };
    return api;
  }
  function createWindow(path: string, _options: unknown, callback?: () => void): any {
    const id = ++nextId; let destroyed = false, dom: JSDOM;
    function initialize() {
      dom?.window.close();
      const api = ipc(id);
      frames.set(id, { api, close: () => dom.window.close() });
      dom = new JSDOM(path.startsWith("page/contextMenu/") ? menuHtml : "<!doctype html><p>Generated child</p>", {
        runScripts: "dangerously",
        beforeParse(child) {
          Object.assign(child, { ztools: { getWebContentsId: () => id, isDarkColors: () => false },
            utools: { createBrowserWindow: createWindow }, require: () => ({ ipcRenderer: api }) });
          child.console.log = () => {}; child.console.error = () => {};
          if (path.startsWith("page/contextMenu/")) child.eval(childPreload);
        },
      });
    }
    initialize();
    const handle = { id: "synthetic-child-" + id, webContents: { id,
      executeJavaScript: async (code: string) => {
        const armsClick = code.includes("ipcRenderer.once(");
        if (armsClick) events.push("arm-rpc");
        const value = await dom.window.eval(code);
        if (armsClick && value === "atools-original-menu-click-v1") events.push("arm-ack");
        if (code === "document.getElementById('hidePile').click();true") events.push("self-closing-click-rpc");
        return value;
      } },
      isDestroyed: () => destroyed, setSkipTaskbar() {}, setAlwaysOnTop() {},
      reload: async () => { initialize(); return true; },
      close: async () => { events.push("child-close"); destroyed = true; frames.delete(id); dom.window.close(); return { closed: true }; },
      destroy: () => handle.close(), ready: Promise.resolve() };
    handle.ready = Promise.resolve().then(() => { callback?.(); });
    return handle;
  }
  const mainApi = ipc(1), main: any = { parent, top: parent,
    addEventListener(kind: string, listener: typeof receive) { if (kind === "message") receive = listener; },
    require: () => ({ ipcRenderer: mainApi }), ztools: { getWebContentsId: () => 1 },
    utools: { createBrowserWindow: createWindow },
  };
  main.ipcRenderer = mainApi;
  frames.set(1, { api: mainApi, close() {} });
  const context = vm.createContext({ window: main, location: { origin: "null" }, document: { hidden: true, visibilityState: "hidden" },
    console: { log() {}, error() {} }, setTimeout, clearTimeout, performance, URLSearchParams, utools: main.utools, ztools: main.ztools });
  vm.runInContext(`window.__AToolsMenuFixtureState={toggles:[]}; const settings={config:{autoHideAni:false,darkMode:'light'}};
    const tomatoPile={getState:()=>true};
    const settingsPageComponent=[{name:'showTomatoAnimation',component:{toggle:value=>window.__AToolsMenuFixtureState.toggles.push(value)}}];
    ${menuClass}\nwindow.__AToolsReviewedContextMenuWindow=ContextMenuWindow;`, context);
  vm.runInContext(operationsSource, context);
  vm.runInContext(frameSource.replaceAll("__ATOOLS_PANEL_TOKEN__", "fixed-token"), context);
  return { main, replies, frames, events, async send(operation: string, overrides: Record<string, unknown> = {}, source: any = parent) {
    await receive({ source, data: { kind: "atools-browser-contract-probe", token: "fixed-token", id: "request-" + replies.length,
      operation, ...overrides } }); return replies.at(-1);
  }, close() { for (const frame of frames.values()) frame.close(); frames.clear(); } };
}

it("actual generic frame probe passes fixed IPC operations to the real fixture implementation", async () => {
  const test = harness();
  try {
    const result = await test.send("hosted-ipc-basic");
    expect(result.error).toBe(""); expect(result.state).toMatchObject({ sourceOpaque: true, noTauri: true, documentHidden: true, visibilityState: "hidden" });
    expect(result.result).toMatchObject({ positiveDistinctIds: true, childIdentityMatches: true, returnWasVoid: true,
      parentToChildSenderAuthentic: true, childToParentSenderAuthentic: true, allArgumentsPreserved: true,
      onceCount: 1, offCount: 0, removedCount: 0, childOpaque: true, childNoTauri: true });
    const measurement=result.result.roundTripMeasurement;
    expect(measurement).toMatchObject({ iterations:20,serial:true,descriptiveOnly:true,clock:"main-frame performance.now",
      visibility:{documentHidden:true,visibilityState:"hidden"},payloadTemplate:{fixture:"atools-hosted-ipc-rtt-v1",value:42} });
    expect(measurement.samples).toHaveLength(20);
    expect(measurement.samples.map((sample:any)=>sample.sequence)).toEqual(Array.from({length:20},(_,index)=>index));
    expect(measurement.samples.every((sample:any)=>sample.senderId===result.result.childId
      &&typeof sample.elapsedMs==="number"&&Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0)).toBe(true);
    // Fake synchronous routing verifies structure only; no native timing threshold or metric claim is derived here.
    expect(test.frames.size).toBe(1);
  } finally { test.close(); }
});

it("actual generic frame probe and operations exercise original menu class, original child preload and original HTML click", async () => {
  const test = harness();
  try {
    const result = await test.send("original-context-menu");
    expect(result.error).toBe("");
    expect(result.result).toMatchObject({ handshakeParentMatches: true, originalChildPreloadExecuted: true,
      originalToggleCalls: [false], classClearedHandle: true, actualChildDestroyed: true, queryConfigurationVerified: false });
    expect(result.result.originalDomMenuText).toContain("隐藏番茄堆"); expect(test.frames.size).toBe(1);
    expect(test.events).toEqual(["arm-rpc", "arm-ack", "fixed-trigger", "child-close"]);
  } finally { test.close(); }
});

it("original menu failure diagnostics preserve only a fixed stage, class and code", async () => {
  const test = harness();
  try {
    test.main.utools.createBrowserWindow = () => { throw new Error("secret-token-and-arbitrary-payload"); };
    const result = await test.send("original-context-menu");
    expect(result.error).toBe("FixtureOperationFailure");
    expect(result.diagnostic).toEqual({ step: "handle-create", errorClass: "Error", knownErrorCode: "ORIGINAL_MENU_CREATE_FAILED" });
    expect(JSON.stringify(result)).not.toContain("secret-token-and-arbitrary-payload");
    expect(test.frames.size).toBe(1);
  } finally { test.close(); }
});

it("shared probe rejects foreign source/token/kind and reports unapproved operation without executing it", async () => {
  const test = harness();
  try {
    await test.send("original-context-menu", {}, {}); await test.send("original-context-menu", { token: "foreign" });
    await test.send("original-context-menu", { kind: "other" }); expect(test.replies).toEqual([]);
    expect(test.main.__AToolsMenuFixtureState.toggles).toEqual([]);
    const rejected = await test.send("arbitrary-filesystem-operation");
    expect(rejected.error).toBe("Error"); expect(test.main.__AToolsMenuFixtureState.toggles).toEqual([]);
  } finally { test.close(); }
});

it("shared probe deduplicates the same transport request before repeating original DOM operations", async () => {
  const test = harness();
  try {
    const first = await test.send("original-context-menu", { id: "fixed-request" });
    const second = await test.send("original-context-menu", { id: "fixed-request" });
    expect(second).toBe(first); expect(test.main.__AToolsMenuFixtureState.toggles).toEqual([false]);
  } finally { test.close(); }
});

it("actual fixture sibling/nested and confirmed lifecycle observations remain separately scoped", async () => {
  const test = harness();
  try {
    const siblings = await test.send("hosted-ipc-sibling-nested"); expect(siblings.error).toBe("");
    expect(siblings.result).toMatchObject({ positiveDistinctIds: true, siblingSenderAuthentic: true,
      nestedCreatorMatches: true, nestedIdentityMatches: true, nestedToMainSenderAuthentic: true });
    const lifecycle = await test.send("hosted-ipc-lifecycle"); expect(lifecycle.error).toBe("");
    expect(lifecycle.result).toMatchObject({ reloadIdStable: true, reloadReplacedDocument: true, oldListenersNotCopied: true,
      freshSenderAuthentic: true, closedHandleDestroyed: true, newIdentityDistinct: true, closedTargetDeliveries: 0 });
    expect(lifecycle.result.observationBoundary).toContain("no deterministic in-flight navigation race asserted");
  } finally { test.close(); }
});
