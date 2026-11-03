import { describe, expect, it, vi } from "vitest";
import vm, { runInNewContext } from "node:vm";
import { bindOwnPluginBridgeTransport, injectPluginHostScripts } from "../../src/lib/pluginBridgeTransportBinding";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";
import { pluginFrameTransportScript } from "../../src/lib/pluginFrameTransport";

const SENTINELS = ["window.parent.postMessage(", "window.addEventListener('message', function(e) {"];

function runtime() {
  const listeners: Array<(event: unknown) => void> = [];
  const post = vi.fn(), postLegacy = vi.fn(), accept = vi.fn(() => false), originalPost = vi.fn();
  const window = { parent: { postMessage: originalPost }, __ATOOLS_FRAME_TRANSPORT__: { post, postLegacy, accept },
    addEventListener: (_kind: string, listener: (event: unknown) => void) => listeners.push(listener), received: undefined as unknown };
  return { window, listeners, post, postLegacy, accept, originalPost };
}

function compiledRuntime(action: Parameters<typeof createPluginBridgeDocument>[0]["action"]) {
  const browser = createCompiledPluginFrameBrowserGlobals();
  const posts: Array<{ data: unknown; origin: string; transfer: unknown }> = [];
  const ownedPosts: unknown[] = [];
  const parent = { postMessage: vi.fn((data: unknown, origin: string, transfer: unknown) => {
    posts.push({ data, origin, transfer });
  }) };
  const post = vi.fn((message: unknown, _transfer?: unknown[]) => { ownedPosts.push(message); return true; });
  const transport = {
    post,
    postLegacy: vi.fn((message: unknown, _targetOrigin?: string, transfer?: unknown[]) => post(message, transfer)),
    accept: vi.fn((event: MessageEvent) => event.source === parent),
  };
  const windowListeners = new Map<string, Array<{ callback: (event: any) => void; once: boolean }>>();
  const window: any = {
    parent,
    __ATOOLS_FRAME_TRANSPORT__: transport,
    top: {},
    location: browser.location,
    history: browser.history,
    DOMParser,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    MessageEvent,
    HTMLElement,
    console,
    matchMedia: () => ({ matches: false }),
    addEventListener(name: string, callback: (event: any) => void, options?: { once?: boolean }) {
      const listeners = windowListeners.get(name) ?? [];
      listeners.push({ callback, once: options?.once === true });
      windowListeners.set(name, listeners);
    },
    removeEventListener(name: string, callback: (event: any) => void) {
      windowListeners.set(name, (windowListeners.get(name) ?? []).filter(item => item.callback !== callback));
    },
    dispatchEvent(event: Event) {
      for (const item of [...(windowListeners.get(event.type) ?? [])]) {
        if (!(windowListeners.get(event.type) ?? []).includes(item)) continue;
        if (item.once) window.removeEventListener(event.type, item.callback);
        item.callback(event);
      }
      return true;
    },
  };
  const documentListeners = new Map<string, Array<() => void>>();
  const document = {
    readyState: "loading",
    addEventListener(name: string, callback: () => void) {
      const listeners = documentListeners.get(name) ?? [];
      listeners.push(callback);
      documentListeners.set(name, listeners);
    },
    removeEventListener(name: string, callback: () => void) {
      documentListeners.set(name, (documentListeners.get(name) ?? []).filter(item => item !== callback));
    },
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { platform: "MacIntel" },
    TextEncoder,
    TextDecoder,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    Date,
    Math,
    Number,
    Promise,
    setTimeout,
    clearTimeout,
    console,
  });
  const html = createPluginBridgeDocument({
    action,
    windowType: "main",
    browserWindowId: "",
    geometrySnapshot: null,
    workerScope: "transport-binding-fixture",
    mainPushConfig: null,
    webContentsId: 17,
    subInputEpoch: 0,
    appName: "ATools transport fixture",
    appVersion: "fixture",
    baseBridgeScript: "",
  });
  executeCompiledPluginBridgeScripts(html, context, 3);
  return {
    browser,
    window,
    parent,
    posts,
    ownedPosts,
    transport,
    dispatchMessage(source: unknown, data: unknown) {
      const event = new MessageEvent("message", { data, origin: "https://host.fixture" });
      Object.defineProperty(event, "source", { configurable: true, value: source });
      window.dispatchEvent(event);
    },
    dispose: () => browser.dispose(),
  };
}

describe("own bridge transport adaptation", () => {
  it("routes owned posts through the transport and guards the owned message listener", () => {
    const fixture = runtime();
    const source = "window.parent.postMessage({value:42}, '*');\nwindow.addEventListener('message', function(e) { window.received=e.data; });";
    runInNewContext(bindOwnPluginBridgeTransport(source), { window: fixture.window });
    expect(fixture.postLegacy).toHaveBeenCalledTimes(1);
    expect(fixture.postLegacy).toHaveBeenCalledWith({ value: 42 }, "*");
    expect(fixture.originalPost).not.toHaveBeenCalled();
    fixture.listeners[0]({ data: "rejected" });
    expect(fixture.window.received).toBeUndefined();
    fixture.accept.mockReturnValue(true);
    fixture.listeners[0]({ data: "accepted" });
    expect(fixture.window.received).toBe("accepted");
  });

  it("executes the real Panel compiler with sentinel plugin data unchanged after static source binding", async () => {
    const payload = { strings: SENTINELS, nested: { text: SENTINELS.join(" | ") } };
    const fixture = compiledRuntime({
      plugin_id: SENTINELS[0],
      plugin_name: "transport sentinel fixture",
      feature_code: SENTINELS[1],
      main_url: "index.html",
      plugin_path: "/fixture",
      expand_height: 0,
      plugin_permissions: ["data"],
      payload,
    });
    try {
      const entered = vi.fn();
      fixture.window.ztools.onPluginEnter(entered);
      fixture.window.dispatchEvent(new fixture.browser.CustomEvent("atools-plugin-enter", { detail: {} }));
      expect(entered).toHaveBeenCalledWith({
        code: SENTINELS[1],
        type: "text",
        payload,
        from: "main",
      });

      const ownedBefore = fixture.transport.post.mock.calls.length;
      const directBefore = fixture.parent.postMessage.mock.calls.length;
      const requestPromise = fixture.window.utools.db.get("sentinel-document");
      const requestCall = fixture.transport.post.mock.calls.slice(ownedBefore)
        .find(([message]) => (message as any)?.__ipc_call__ === true);
      const request = requestCall?.[0];
      expect(request).toMatchObject({
        __ipc_call__: true,
        cmd: "get_plugin_data_item",
        args: { pluginId: SENTINELS[0], docId: "sentinel-document" },
      });
      expect(fixture.parent.postMessage).toHaveBeenCalledTimes(directBefore);

      let response: unknown = "pending";
      let settled = false;
      const observed = requestPromise.then(
        (value: unknown) => { settled = true; response = value; },
        (error: unknown) => { settled = true; response = error; },
      );
      const reply = { __ipc_response__: true, reqId: (request as any).reqId, result: "sentinel-result" };
      fixture.dispatchMessage({}, reply);
      await Promise.resolve();
      expect(settled).toBe(false);
      fixture.dispatchMessage(fixture.parent, reply);
      await observed;
      expect(settled).toBe(true);
      expect(response).toBe("sentinel-result");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps legacy postMessage origin and transfer arguments behind the bound document origin", () => {
    const posts: unknown[][] = [];
    const pageDocumentId = "a".repeat(32), docNonce = "b".repeat(32), parentOrigin = "atools-panel://localhost";
    const transfer = [{ kind: "message-port-sentinel" }];
    const parent = {
      postMessage(...args: unknown[]) {
        if (args.length >= 3 && !Array.isArray(args[2])) throw new TypeError("transfer must be a sequence");
        posts.push(args);
      },
    };
    const window: any = {
      parent,
      __ATOOLS_BOOTSTRAP_HANDOFF__: { runId: pageDocumentId, id: pageDocumentId, docNonce, generation: 7 },
      transfer,
      addEventListener() {},
      removeEventListener() {},
    };
    const context = vm.createContext({
      window,
      document: { readyState: "loading", addEventListener() {} },
      setTimeout,
    });
    const transportScript = pluginFrameTransportScript({ pageDocumentId, parentOrigin });
    vm.runInContext(transportScript.slice("<script>".length, -"</script>".length), context);
    const source = "window.parent.postMessage({kind:'two-args'}, '*');"
      + "window.parent.postMessage({kind:'with-transfer'}, 'https://attacker.invalid', window.transfer);";
    vm.runInContext(bindOwnPluginBridgeTransport(source), context);

    const binding = { pageDocumentId, docNonce, generation: 7 };
    expect(posts).toEqual([
      [{ kind: "two-args", __atoolsDocument: binding }, parentOrigin, []],
      [{ kind: "with-transfer", __atoolsDocument: binding }, parentOrigin, transfer],
    ]);
  });

  it("rejects legacy bridge promises on send failure or disposal while structured posts still return false", async () => {
    let failSend = true;
    const parent = { postMessage() { if (failSend) throw new Error("fixture transport failure"); } };
    const pageDocumentId = "a".repeat(32), docNonce = "b".repeat(32);
    const window: any = {
      parent,
      __ATOOLS_BOOTSTRAP_HANDOFF__: { runId: pageDocumentId, id: pageDocumentId, docNonce, generation: 7 },
      addEventListener() {},
      removeEventListener() {},
    };
    const context = vm.createContext({ window, document: { readyState: "loading", addEventListener() {} }, setTimeout });
    const transportScript = pluginFrameTransportScript({ pageDocumentId, parentOrigin: "atools-panel://localhost" });
    vm.runInContext(transportScript.slice("<script>".length, -"</script>".length), context);
    const legacySend = bindOwnPluginBridgeTransport(
      "new Promise(function(resolve) { window.parent.postMessage({secret:'private payload'}, '*'); resolve('sent'); })",
    );

    expect(vm.runInContext("window.__ATOOLS_FRAME_TRANSPORT__.post({secret:'structured payload'})", context)).toBe(false);
    const sendFailure = await (vm.runInContext(legacySend, context) as Promise<unknown>).catch(error => error as Error);
    expect(sendFailure).toMatchObject({ name: "Error", message: "ERR_ATOOLS_FRAME_TRANSPORT_SEND" });
    expect(String(sendFailure)).not.toContain("private payload");

    failSend = false;
    vm.runInContext("window.__ATOOLS_FRAME_TRANSPORT__.dispose()", context);
    expect(vm.runInContext("window.__ATOOLS_FRAME_TRANSPORT__.post({kind:'after-dispose'})", context)).toBe(false);
    const disposedFailure = await (vm.runInContext(legacySend, context) as Promise<unknown>).catch(error => error as Error);
    expect(disposedFailure).toMatchObject({ name: "Error", message: "ERR_ATOOLS_FRAME_TRANSPORT_SEND" });
    expect(String(disposedFailure)).not.toContain("private payload");
  });

  it("inserts an owned bridge without transforming plugin scripts or their literal data", () => {
    const plugin = `<!doctype html><html><head></head><body><script id="plugin">window.original=${JSON.stringify(SENTINELS)};</script></body></html>`;
    const owned = `<script id="owned">${bindOwnPluginBridgeTransport("window.parent.postMessage({ready:true}, '*');")}</script>`;
    const result = injectPluginHostScripts(plugin, owned);
    expect(result).toContain(`<script id="plugin">window.original=${JSON.stringify(SENTINELS)};</script>`);
    const parsed = new DOMParser().parseFromString(result, "text/html");
    expect(parsed.head.firstElementChild?.id).toBe("owned");
    expect(parsed.querySelector("#plugin")?.textContent).toBe(`window.original=${JSON.stringify(SENTINELS)};`);
    expect(parsed.compatMode).toBe("CSS1Compat");
  });
});

describe("host script document insertion", () => {
  it("preserves leading comments and a standards doctype when document tags are omitted", () => {
    const prefix = "<!-- plugin header -->\n<!DOCTYPE html>";
    const html = `${prefix}<main>original</main>`;
    const result = injectPluginHostScripts(html, '<script id="owned">window.fixture=true;</script>');
    expect(result.startsWith(prefix)).toBe(true);
    const parsed = new DOMParser().parseFromString(result, "text/html");
    expect(parsed.doctype?.name).toBe("html");
    expect(parsed.compatMode).toBe("CSS1Compat");
    expect(parsed.querySelector("main")?.textContent).toBe("original");
    expect(parsed.querySelectorAll("#owned")).toHaveLength(1);
  });

  it.each([
    { name: "explicit head", html: '<!doctype html><html><head data-plugin="head"><title>Plugin</title></head><body><main>original</main></body></html>', parent: "HEAD" },
    { name: "uppercase head", html: '<!DOCTYPE html><HTML><HEAD data-plugin="head"></HEAD><BODY><main>original</main></BODY></HTML>', parent: "HEAD" },
    { name: "body without head", html: '<!doctype html><html><body data-plugin="body"><main>original</main></body></html>', parent: "BODY" },
    { name: "omitted head and body", html: '<!doctype html><main>original</main>', parent: "HEAD" },
  ])("preserves doctype and content for $name", ({ html, parent }) => {
    const injection = '<script id="owned">window.fixture=true;</script>';
    const result = injectPluginHostScripts(html, injection);
    expect(result.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    const parsed = new DOMParser().parseFromString(result, "text/html");
    expect(parsed.doctype?.name).toBe("html");
    expect(parsed.compatMode).toBe("CSS1Compat");
    expect(parsed.querySelector("main")?.textContent).toBe("original");
    expect(parsed.querySelectorAll("#owned")).toHaveLength(1);
    expect(parsed.querySelector("#owned")?.parentElement?.tagName).toBe(parent);
  });
});
