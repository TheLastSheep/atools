import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedBrowserWindowRpcHost, HostedBrowserWindowNavigationTokens } from "../../src/lib/hostedBrowserWindowRpc";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter, type PluginHostedDocumentLease } from "../../src/lib/pluginHostedIpcRouter";
import type { PluginBrowserWindowCreator } from "../../src/lib/pluginBrowserWindowReady";
import type { PluginBrowserWindowState } from "../../src/lib/pluginBrowserWindowTypes";
import { createPluginNativeBrowserWindowController } from "../../src/lib/pluginNativeBrowserWindowController";

const { readTextFile } = vi.hoisted(() => ({ readTextFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile }));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_BINDING_ID = "c".repeat(64);
const NONCE = "a".repeat(32);
const NATIVE_EVENT = "plugin-native-browser-window-event";
const TASK_EVENT = "task-run-updated";

type NativeCall = { command: string; args?: Record<string, unknown> };
type Listener = (event: { payload: unknown }) => void;

const snapshot = (nativeSequence: number, overrides: Record<string, unknown> = {}) => {
  const bounds = { x: 24, y: 48, width: 540, height: 420 };
  return {
    bounds,
    contentBounds: bounds,
    minimumSize: [0, 0],
    maximumSize: [0, 0],
    visible: true,
    focused: true,
    alwaysOnTop: false,
    minimized: false,
    maximized: false,
    fullScreen: false,
    resizable: true,
    title: "Native paste window",
    nativeSequence,
    constraintsSource: "adapter",
    ...overrides,
  };
};

function hostedMainDocument() {
  const sources = new PluginFrameSourceRegistry();
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const source = {};
  const webContentsId = hostedIpc.reserve({ kind: "main" });
  const reservation = sources.reserveDocument({ kind: "main", source, pageDocumentId: "plugin-page",
    expectedOrigin: "https://plugin.example", parentOrigin: window.location.origin });
  const identity = sources.activateDocument(reservation, NONCE);
  if (!identity) throw Error("document activation failed");
  const registered = hostedIpc.registerFrame({ kind: "main" }, source, true, true);
  if (!registered) throw Error("main source registration failed");
  hostedIpc.handleLifecycle({ source, identity: registered }, { __atools_hosted_ipc_document__: true,
    phase: "open", webContentsId, documentNonce: NONCE });
  const lease = hostedIpc.captureDocumentLease({ source, identity: registered }, NONCE) as PluginHostedDocumentLease;
  return { sources, hostedIpc, source, identity: registered, lease };
}

function harness(options: { emitEarlyMove?: boolean; pendingTaskRun?: boolean } = {}) {
  const fixture = hostedMainDocument();
  const listeners = new Map<string, Set<Listener>>();
  const locations: string[] = [];
  const calls: NativeCall[] = [];
  const taskRuns = new Map<string, Record<string, unknown>>();
  const results = new Map<string, unknown>();
  const labels = new Map<string, string>();
  const mountedDestroy = vi.fn();
  const dispatchWindowEvent = vi.fn();
  const preparePreload = vi.fn(async () => "/* prepared preload */");
  const injectBridge = vi.fn((html: string) => `${html}\n<!-- injected bridge -->`);
  const mountFrame = vi.fn(() => ({ destroy: mountedDestroy }));
  const geometry = {
    snapshot: vi.fn((state: { id: string; documentGeneration: number }) => ({
      windowId: state.id, documentGeneration: state.documentGeneration, revision: 1,
    })),
    publish: vi.fn(), remove: vi.fn(), clear: vi.fn(),
  };
  let windows: PluginBrowserWindowState[] = [];
  let windowSequence = 0;
  let creatingCount = 0;
  let nextIndex = 0;
  let actionLabelOverride: string | undefined;
  let announceTaskRunStarted!: (runId: string) => void;
  const taskRunStarted = new Promise<string>(resolve => { announceTaskRunStarted = resolve; });

  const dispatch = (eventName: string, payload: unknown) => {
    for (const receive of [...(listeners.get(eventName) ?? [])]) receive({ payload });
  };
  const listen = async <T,>(eventName: string, receive: (event: { payload: T }) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set<Listener>();
    listeners.set(eventName, eventListeners);
    eventListeners.add(receive as Listener);
    return () => eventListeners.delete(receive as Listener);
  };
  const invoke = async <T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args });
    if (command === "bind_plugin_window_source") return { sourceBindingId: SOURCE_BINDING_ID } as T;
    if (command === "prepare_plugin_browser_window") {
      const index = ++nextIndex;
      const intentId = index.toString(16).padStart(64, "0");
      const runId = `run-00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const tool = "atools.host.browser-window.000000000000000000000000";
      const nativeLabel = `atools-native-browser-${index.toString(16).padStart(32, "0")}`;
      labels.set(String(args.windowId), nativeLabel);
      taskRuns.set(runId, {
        id: runId,
        capabilityId: tool,
        initiator: { type: "human", clientId: "atools-ui" },
        input: { operation: "open", intentId },
        status: options.pendingTaskRun ? "running" : "succeeded",
      });
      results.set(intentId, {
        windowId: args.windowId,
        nativeLabel,
        snapshot: snapshot(1),
      });
      const ticket = (index + 100).toString(16).padStart(64, "0");
      const open = (window as Window & { __ATOOLS_NATIVE_WINDOWS__?: { openAuthorized: (...values: string[]) => boolean } })
        .__ATOOLS_NATIVE_WINDOWS__?.openAuthorized;
      if (!open || !open(String(args.sourceBindingId), String(args.windowId),
        `${window.location.origin}/atools-native-window.html#${ticket}`)) throw Error("trusted shell open was rejected");
      return {
        intentId,
        runId,
        permission_required: false,
        client_id: "atools-ui",
        tool,
        arguments: { operation: "open", intentId },
      } as T;
    }
    if (command === "prepare_plugin_browser_window_action") {
      const index = ++nextIndex;
      const intentId = index.toString(16).padStart(64, "0");
      const runId = `run-00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const tool = "atools.host.browser-window.000000000000000000000000";
      taskRuns.set(runId, {
        id: runId,
        capabilityId: tool,
        initiator: { type: "human", clientId: "atools-ui" },
        input: { operation: "action", intentId },
        status: options.pendingTaskRun ? "running" : "succeeded",
      });
      results.set(intentId, {
        windowId: args.windowId,
        nativeLabel: actionLabelOverride ?? labels.get(String(args.windowId)),
        value: { action: args.action },
        snapshot: snapshot(2),
      });
      return {
        intentId, runId, permission_required: false, client_id: "atools-ui", tool,
        arguments: { operation: "action", intentId },
      } as T;
    }
    if (command === "get_task_run") {
      const run = taskRuns.get(String(args.id));
      if (run && options.pendingTaskRun) announceTaskRunStarted(String(args.id));
      return (run ?? null) as T;
    }
    if (command === "take_plugin_browser_window_result") {
      const result = results.get(String(args.intentId)) as Record<string, unknown> | undefined;
      if (options.emitEarlyMove && result?.windowId && typeof result.nativeLabel === "string"
        && !calls.some(call => call.command === "early-native-event")) {
        calls.push({ command: "early-native-event" });
        dispatch(NATIVE_EVENT, { windowId: result.windowId, nativeLabel: result.nativeLabel,
          kind: "NativeStateChanged", snapshot: snapshot(2), kinds: ["Moved"] });
      }
      return result as T;
    }
    if (command === "prepare_plugin_window_document") return { documentId: "f".repeat(64) } as T;
    return undefined as T;
  };

  vi.spyOn(window, "open").mockImplementation((value) => {
    const href = String(value);
    const ticket = new URL(href).hash.slice(1);
    const shellApi = {
      bind: vi.fn(() => true),
      setLocation: vi.fn((_ticket: string, _nonce: string, location: string) => { locations.push(location); return true; }),
      postMessage: vi.fn(),
      dispose: vi.fn(() => { for (const frame of document.querySelectorAll("iframe[title='Plugin window content']")) frame.remove(); }),
    };
    const shellProxy = {
      location: { href, origin: window.location.origin },
      document: {
        location: { pathname: "/atools-native-window.html" },
        createElement: (name: string) => document.createElement(name),
        body: { replaceChildren: (...nodes: Node[]) => document.body.replaceChildren(...nodes) },
      },
      __ATOOLS_NATIVE_SHELL__: shellApi,
    };
    setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: shellProxy as unknown as Window,
      data: { __atools_native_window_shell__: "hello", version: 1, ticket },
    })), 0);
    return shellProxy as unknown as WindowProxy;
  });

  const ports = {
    pluginId: () => "snipaste",
    pluginPath: () => "/plugins/snipaste",
    previewPluginPath: "/preview",
    mainUrl: () => "index.html",
    resources: () => ({
      prepare: async () => ({ sessionId: SESSION_ID, pluginRoot: "/plugins/snipaste", instanceId: INSTANCE_ID }),
      resolveModuleSrc: async (path: string) => `atools-plugin://localhost/${SESSION_ID}/${path}`,
    }),
    runtime: () => undefined,
    preparePreload,
    injectBridge,
    mountFrame,
    invoke,
    get windows() { return windows; },
    setWindows(value: PluginBrowserWindowState[]) { windows = value; },
    get windowSequence() { return windowSequence; },
    setWindowSequence(value: number) { windowSequence = value; },
    get creatingCount() { return creatingCount; },
    setCreatingCount(value: number) { creatingCount = value; },
    get hostGeneration() { return 1; },
    sources: fixture.sources,
    hostedIpc: fixture.hostedIpc,
    navigation: new HostedBrowserWindowNavigationTokens(),
    rpc: new HostedBrowserWindowRpcHost(),
    frames: new Map<string, HTMLIFrameElement>(),
    geometry,
    creators: new Map<string, PluginBrowserWindowCreator>(),
    insertedCss: new Map<string, unknown>(),
    clearInsertedCss: vi.fn(),
    dispatchWindowEvent,
    pageTitle: async (_id: string, fallback: string) => fallback,
    tick: async () => undefined,
    listen,
    isTauri: () => true,
    resourceOrigin: () => "atools-plugin://localhost",
  };
  const controller = createPluginNativeBrowserWindowController(ports);
  const creator: PluginBrowserWindowCreator = { source: fixture.source, identity: fixture.identity };
  const create = (url = "paster.html?id=42&windowRole=paster#paste") =>
    controller.create({ url, options: { width: 540, height: 420 } }, creator, fixture.lease);
  return { controller, fixture, creator, calls, listeners, locations, dispatch, dispatchWindowEvent,
    preparePreload, injectBridge, mountFrame, geometry, create, getWindows: () => windows,
    taskRunStarted,
    setActionLabelOverride: (label: string | undefined) => { actionLabelOverride = label; } };
}

beforeEach(() => {
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
    randomUUID: vi.fn(() => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
  });
  readTextFile.mockReset().mockResolvedValue("<!doctype html><html><head><title>Paste</title></head><body><main>Paste</main></body></html>");
});

afterEach(() => vi.unstubAllGlobals());

describe("native BrowserWindow controller", () => {
  it("forwards flattened Paste WebPreferences to the Rust open intent and keeps renderer options on the preload path", async () => {
    const subject = harness();
    const options = { width: 640, webPreferences: { preload: "preload.js", nodeIntegration: false,
      contextIsolation: false, backgroundThrottling: false } };
    try {
      await subject.controller.create({ url: "paste-shelf.html", options }, subject.creator, subject.fixture.lease);
      const openCall = subject.calls.find(call => call.command === "prepare_plugin_browser_window");

      expect(openCall?.args?.options).toMatchObject({ width: 640, backgroundThrottling: false });
      expect(openCall?.args?.options).not.toHaveProperty("webPreferences");
      expect(openCall?.args?.options).not.toHaveProperty("nodeIntegration");
      expect(openCall?.args?.options).not.toHaveProperty("contextIsolation");
      expect(subject.preparePreload).toHaveBeenCalledWith(options, expect.any(Function));
      expect(subject.getWindows()[0]).toMatchObject({ backgroundThrottling: false, preloadOptions: options });
      expect((subject.injectBridge.mock.calls as unknown as unknown[][])[0]?.[7]).toBe(false);
    } finally {
      await subject.controller.destroy();
    }
  });

  it("rejects unreviewed browser preferences before creating a native window", async () => {
    const subject = harness();
    try {
      await expect(subject.controller.create({ url: "paste-shelf.html", options: {
        webPreferences: { backgroundThrottling: false, sandbox: false },
      } }, subject.creator, subject.fixture.lease)).rejects.toThrow(/unsupported webPreferences field/u);
      expect(subject.calls.filter(call => call.command === "prepare_plugin_browser_window")).toEqual([]);
      expect(subject.preparePreload).not.toHaveBeenCalled();
    } finally {
      await subject.controller.destroy();
    }
  });

  it("creates one query-preserving real plugin document, routes native-only actions, filters events and destroys cleanly", async () => {
    const subject = harness({ emitEarlyMove: true });
    expect(subject.controller.nativeEnabled()).toBe(true);
    const created = await subject.create() as Record<string, unknown>;
    const id = String(created.id);
    const documentCalls = subject.calls.filter(call => call.command === "prepare_plugin_window_document");

    expect(documentCalls).toHaveLength(1);
    expect(documentCalls[0].args).toMatchObject({
      sourceBindingId: SOURCE_BINDING_ID,
      nativeLabel: `atools-native-browser-${"0".repeat(31)}1`,
      documentGeneration: 1,
      relativePath: "paster.html",
    });
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(subject.injectBridge).toHaveBeenCalledTimes(1);
    expect((subject.injectBridge.mock.calls as unknown as unknown[][])[0]?.[5]).toBe("native");
    expect((subject.injectBridge.mock.calls as unknown as unknown[][])[0]?.[7]).toBe(true);
    expect(subject.mountFrame).toHaveBeenCalledTimes(1);
    expect(subject.locations).toHaveLength(1);
    const actualUrl = new URL(subject.locations[0]);
    expect(actualUrl.pathname).toBe(`/${SESSION_ID}/paster.html`);
    expect(actualUrl.searchParams.get("id")).toBe("42");
    expect(actualUrl.searchParams.get("windowRole")).toBe("paster");
    expect(actualUrl.searchParams.get("__atools_window_document")).toBe("f".repeat(64));
    expect(actualUrl.hash).toBe("#paste");
    expect(created).toMatchObject({ hostKind: "native", type: "browserWindow", windowType: "browserWindow" });
    for (const key of ["processId", "osProcessId", "mediaSourceId", "webContentsMediaSourceId", "webContentsId"])
      expect(created).not.toHaveProperty(key);

    expect(subject.controller.handlesAction({ id, action: "show" })).toBe(true);
    expect(subject.controller.handlesAction({ id, action: "webContents.loadURL" })).toBe(true);
    expect(subject.controller.handlesAction({ id, action: "webContents.stop" })).toBe(true);
    expect(subject.controller.handlesAction({ id, action: "webContents.send" })).toBe(false);
    expect(subject.controller.handlesAction({ id, action: "webContents.executeJavaScript" })).toBe(false);
    expect(subject.controller.handlesAction({ id, action: "webContents.insertCSS" })).toBe(false);
    expect(subject.controller.handlesAction({ id: "legacy-window", action: "show" })).toBe(false);
    await expect(subject.controller.action({ id, action: "__renderReady" })).rejects.toThrow(/PRIVATE_ACTION/);
    await expect(subject.controller.action({ id, action: "webContents.stop" }, subject.creator, subject.fixture.lease))
      .rejects.toThrow(/UNSUPPORTED_ACTION/);
    expect(subject.calls.filter(call => call.command === "prepare_plugin_browser_window_action")).toHaveLength(0);

    const event = (label: string, sequence: number, kinds: string[]) => ({
      windowId: id, nativeLabel: label, kind: "NativeStateChanged" as const,
      snapshot: snapshot(sequence, { focused: false, title: `state ${sequence}` }), kinds,
    });
    subject.dispatch(NATIVE_EVENT, event(`atools-native-browser-${"e".repeat(32)}`, 3, ["Moved"]));
    expect((subject.getWindows()[0] as { nativeSnapshot: { nativeSequence: number } }).nativeSnapshot.nativeSequence).toBe(2);
    await expect(subject.controller.action({ id, action: "show", args: [] }, subject.creator, subject.fixture.lease))
      .resolves.toEqual({ action: "show" });
    subject.setActionLabelOverride(`atools-native-browser-${"e".repeat(32)}`);
    await expect(subject.controller.action({ id, action: "hide", args: [] }, subject.creator, subject.fixture.lease))
      .rejects.toThrow(/ACTION_RESULT/);
    subject.setActionLabelOverride(undefined);

    subject.dispatch(NATIVE_EVENT, event(`atools-native-browser-${"0".repeat(31)}1`, 4, ["Moved"]));
    expect((subject.getWindows()[0] as { nativeSnapshot: { nativeSequence: number } }).nativeSnapshot.nativeSequence).toBe(4);
    subject.dispatch(NATIVE_EVENT, { ...event(`atools-native-browser-${"0".repeat(31)}1`, 5, ["Moved"]), windowId: "other-window" });
    expect((subject.getWindows()[0] as { nativeSnapshot: { nativeSequence: number } }).nativeSnapshot.nativeSequence).toBe(4);
    subject.dispatch(NATIVE_EVENT, event(`atools-native-browser-${"0".repeat(31)}1`, 5, ["Moved", "Resized", "Focused"]));
    expect((subject.getWindows()[0] as { nativeSnapshot: { nativeSequence: number } }).nativeSnapshot.nativeSequence).toBe(5);
    expect(subject.dispatchWindowEvent.mock.calls.map(call => call[1])).toEqual(["move", "move", "move", "resize", "blur"]);
    subject.dispatch(NATIVE_EVENT, { windowId: id, nativeLabel: `atools-native-browser-${"0".repeat(31)}1`, kind: "Destroyed" });
    expect(subject.getWindows()).toEqual([]);
    expect(subject.dispatchWindowEvent.mock.calls.map(call => call[1])).toEqual(["move", "move", "move", "resize", "blur", "closed"]);

    await subject.controller.destroy();
    await subject.controller.destroy();
    expect(subject.listeners.get(NATIVE_EVENT)?.size ?? 0).toBe(0);
    expect((window as Window & { __ATOOLS_NATIVE_WINDOWS__?: unknown }).__ATOOLS_NATIVE_WINDOWS__).toBeUndefined();
  });

  it("keeps native provenance on loadURL, reload, and history document reinjection", async () => {
    const subject = harness();
    const created = await subject.controller.create({
      url: "paster.html?id=42&windowRole=paster#paste",
      options: { width: 540, height: 420, webPreferences: { preload: "preload.js", nodeIntegration: false,
        contextIsolation: false, backgroundThrottling: false } },
    }, subject.creator, subject.fixture.lease);
    const id = String((created as Record<string, unknown>).id);
    const injectedCalls = () => subject.injectBridge.mock.calls as unknown as unknown[][];

    expect(injectedCalls()[0]?.[5]).toBe("native");
    expect(injectedCalls()[0]?.[7]).toBe(false);

    // The harness does not mount the child RPC endpoint. Each navigation must still prepare and
    // inject one document before failing with the specific missing-readiness error.
    const actions: Array<{ action: string; args: unknown[] }> = [
      { action: "webContents.loadURL", args: ["next.html?mode=2"] },
      { action: "webContents.reload", args: [] },
      { action: "webContents.navigationHistory.goBack", args: [] },
    ];
    for (const navigation of actions) {
      const before = injectedCalls().length;
      await expect(subject.controller.action({ id, ...navigation }, subject.creator, subject.fixture.lease))
        .rejects.toMatchObject({ message: `Hosted BrowserWindow RPC ${id} is not attached` });
      const after = injectedCalls();
      expect(after).toHaveLength(before + 1);
      expect(after[before]?.[5]).toBe("native");
      expect(after[before]?.[7]).toBe(false);
    }

    const hostKinds = injectedCalls().map(call => call[5]);
    expect(hostKinds).toEqual(["native", "native", "native", "native"]);
    expect(injectedCalls().map(call => call[7])).toEqual([false, false, false, false]);
    await subject.controller.destroy();
  });

  it("routes the public raw loadURL/reload/getURL aliases through native navigation state", async () => {
    const subject = harness();
    try {
      const created = await subject.create();
      const id = String((created as Record<string, unknown>).id);
      const initialUrl = "paster.html?id=42&windowRole=paster#paste";
      const nextUrl = "next.html?source=paste#result";
      const calls = (command: string) => subject.calls.filter(call => call.command === command);
      const injectedCalls = () => subject.injectBridge.mock.calls as unknown as unknown[][];
      const readinessError = { message: `Hosted BrowserWindow RPC ${id} is not attached` };

      for (const action of ["loadURL", "reload", "getURL"])
        expect(subject.controller.handlesAction({ id, action })).toBe(true);

      const docCount = calls("prepare_plugin_window_document").length;
      const actionCount = calls("prepare_plugin_browser_window_action").length;
      await expect.soft(subject.controller.action({ id, action: "loadURL", args: [nextUrl] },
        subject.creator, subject.fixture.lease)).rejects.toMatchObject(readinessError);
      expect.soft(calls("prepare_plugin_window_document")).toHaveLength(docCount + 1);
      expect.soft(calls("prepare_plugin_browser_window_action")).toHaveLength(actionCount);
      expect.soft(injectedCalls()).toHaveLength(docCount + 1);
      expect.soft(injectedCalls().at(-1)?.[5]).toBe("native");
      expect.soft(subject.locations).toHaveLength(2);
      expect.soft(new URL(subject.locations.at(-1)!).searchParams.get("source")).toBe("paste");
      expect.soft(new URL(subject.locations.at(-1)!).hash).toBe("#result");

      const reloadDocCount = calls("prepare_plugin_window_document").length;
      const reloadActionCount = calls("prepare_plugin_browser_window_action").length;
      await expect.soft(subject.controller.action({ id, action: "reload", args: [] },
        subject.creator, subject.fixture.lease)).rejects.toMatchObject(readinessError);
      expect.soft(calls("prepare_plugin_window_document")).toHaveLength(reloadDocCount + 1);
      expect.soft(calls("prepare_plugin_browser_window_action")).toHaveLength(reloadActionCount);
      expect.soft(injectedCalls()).toHaveLength(reloadDocCount + 1);
      expect.soft(injectedCalls().at(-1)?.[5]).toBe("native");

      const getUrlActionCount = calls("prepare_plugin_browser_window_action").length;
      const getUrlDocCount = calls("prepare_plugin_window_document").length;
      await expect.soft(subject.controller.action({ id, action: "getURL", args: [] },
        subject.creator, subject.fixture.lease)).resolves.toBe(nextUrl);
      expect.soft(calls("prepare_plugin_browser_window_action")).toHaveLength(getUrlActionCount);
      expect.soft(calls("prepare_plugin_window_document")).toHaveLength(getUrlDocCount);
      expect.soft(subject.getWindows()[0]?.url).not.toBe(initialUrl);
    } finally {
      await subject.controller.destroy();
    }
  });

  it("enforces the four-window owner quota before opening a fifth shell", async () => {
    const subject = harness();
    for (let index = 0; index < 4; index++) await subject.create(`paster.html?id=${index}`);
    expect(subject.getWindows()).toHaveLength(4);
    await expect(subject.create("paster.html?id=overflow")).rejects.toThrow(/OWNER_WINDOW_LIMIT/);
    expect(subject.calls.filter(call => call.command === "prepare_plugin_browser_window")).toHaveLength(4);
    expect(subject.locations).toHaveLength(4);
    await subject.controller.destroy();
  });

  it("cancels an in-flight private intent and detaches its TaskRun listener on terminal destroy", async () => {
    const subject = harness({ pendingTaskRun: true });
    const opening = subject.create();
    const runId = await subject.taskRunStarted;
    await subject.controller.destroy();
    subject.dispatch(TASK_EVENT, runId);

    await expect(opening).rejects.toThrow(/SOURCE_STALE|WINDOW_STALE|CREATOR_STALE/);
    expect(subject.calls).toContainEqual({
      command: "cancel_plugin_browser_window_intent",
      args: { intentId: "1".padStart(64, "0") },
    });
    expect(subject.calls).toContainEqual({
      command: "close_plugin_window_source",
      args: { sourceBindingId: SOURCE_BINDING_ID },
    });
    expect(subject.listeners.get(TASK_EVENT)?.size ?? 0).toBe(0);
    expect(subject.listeners.get(NATIVE_EVENT)?.size ?? 0).toBe(0);
  });
});
