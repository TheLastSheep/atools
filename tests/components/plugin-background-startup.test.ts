// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { preparePluginPreload } from "../../src/lib/pluginPreload";

const pluginsRoot = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const snipasteRoot = resolve(pluginsRoot, "snipaste");
const pasteRoot = resolve(pluginsRoot, "pasteboard-pro");
const snipasteHash = "77cc3ab6ef4d15a7b6356e61d504fc001fb444e1316b60acd7be8c12e260c577";
const pasteAutoStartHash = "af88f84731177bfc12d84ca2fc401d9161ed2840e7589860ffcc4be67e8a7e18";
const endpoint = (suffix: string) => `http://127.0.0.1:43128/data/${suffix.repeat(64)}`;
const openSuites = existsSync(resolve(snipasteRoot, "preload/services.cjs"))
  && existsSync(resolve(pasteRoot, "apps/ztools/preload/auto-start.ts"));
const disposables = new Set<() => void>();
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

type DataRequest = { method: string; args: unknown[] };
type DataHandler = (request: DataRequest) => unknown;
type StartupWindow = JSDOM["window"] & Record<string, any>;

function hash(source: string | Uint8Array) { return createHash("sha256").update(source).digest("hex"); }
function scriptBody(script: string) { return script.replace(/^<script[^>]*>\s*/, "").replace(/\s*<\/script>\s*$/, ""); }

function createFrame(pluginId: string, handleData: DataHandler, options: { endpoint?: string; entryMode?: "activate" | "preload"; withDataSession?: boolean } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only", url: `https://${pluginId}.fixture.invalid/`,
  });
  const window = dom.window as StartupWindow;
  const requests: DataRequest[] = [], parentMessages: Record<string, unknown>[] = [], blockedOsCalls: string[] = [];
  const instanceId = `startup-${pluginId}`;
  const dataEndpoint = options.endpoint ?? endpoint(pluginId === "snipaste" ? "a" : "b");
  Object.assign(window, { TextEncoder, TextDecoder, Buffer });
  Object.defineProperty(window, "postMessage", { configurable: true, value: (message: Record<string, unknown>) => { parentMessages.push(message); } });
  Object.defineProperty(window, "XMLHttpRequest", {
    configurable: true,
    value: class ControlledDataRequest {
      status = 200;
      responseText = "";
      timeout = 0;
      onload?: () => void;
      onerror?: () => void;
      ontimeout?: () => void;
      onabort?: () => void;
      private async = false;
      private url = "";
      open(method: string, url: string, asynchronous: boolean) {
        if (method !== "POST" || url !== dataEndpoint || !asynchronous) throw new Error("unexpected data transport request");
        this.url = url; this.async = asynchronous;
      }
      setRequestHeader() {}
      send(body: string) {
        if (!this.async || this.url !== dataEndpoint) throw new Error("data transport must stay asynchronous and owner-bound");
        const request = JSON.parse(body) as DataRequest;
        requests.push(request);
        try { this.responseText = JSON.stringify({ ok: true, result: handleData(request) }); }
        catch (error) { this.status = 403; this.responseText = JSON.stringify({ ok: false, error: String(error) }); }
        queueMicrotask(() => this.onload?.());
      }
      abort() { this.onabort?.(); }
    },
  });
  const bridge = createPluginBridgeDocument({
    action: { plugin_id: pluginId, plugin_name: pluginId, feature_code: "boot", main_url: "index.html",
      plugin_path: `/fixture/${pluginId}`, expand_height: 0, payload: null, plugin_permissions: [] },
    entryMode: options.entryMode ?? "preload", windowType: "main", browserWindowId: "", geometrySnapshot: null,
    workerScope: `startup-${pluginId}`, mainPushConfig: null, webContentsId: 101, subInputEpoch: 0,
    appName: "ATools startup contract", appVersion: "test",
    data: { instanceId, ...(options.withDataSession === false ? {} : { endpoint: options.endpoint ?? dataEndpoint }) },
  });
  const parsed = new window.DOMParser().parseFromString(bridge, "text/html");
  for (const script of Array.from(parsed.querySelectorAll("script"))) window.eval(script.textContent ?? "");
  const hostRequire = window.require as (name: string) => unknown;
  window.require = ((specifier: string) => {
    const moduleName = specifier.replace(/^node:/, "");
    if (moduleName === "fs") {
      const fs = hostRequire(specifier) as Record<string, unknown>;
      return new Proxy(fs, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return () => { blockedOsCalls.push(`fs.${String(key)}`); throw new Error("filesystem is disabled in this test"); };
      } });
    }
    if (moduleName === "child_process") return new Proxy({}, { get: (_target, key) => (..._args: unknown[]) => {
      blockedOsCalls.push(`child_process.${String(key)}`); throw new Error("child process is disabled in this test");
    } });
    return hostRequire(specifier);
  }) as StartupWindow["require"];
  const sendHostMessage = (data: Record<string, unknown>) => {
    const event = new window.MessageEvent("message", { data, origin: window.location.origin });
    Object.defineProperty(event, "source", { configurable: true, value: window.parent });
    window.dispatchEvent(event);
  };
  const cleanup = () => dom.window.close();
  disposables.add(cleanup);
  return { dom, window, requests, parentMessages, blockedOsCalls, instanceId, sendHostMessage, cleanup };
}

async function prepareOriginalPreload(pluginRoot: string, preloadRelativePath: string) {
  const root = resolve(pluginRoot);
  const preloadPath = resolve(root, preloadRelativePath);
  const reads: string[] = [];
  const script = await preparePluginPreload({
    pluginDir: root,
    preloadPath,
    readTextFile: async path => {
      const actual = resolve(path);
      if (actual !== root && !actual.startsWith(root + "/")) throw new Error("preload graph escaped the original package");
      reads.push(actual);
      return readFile(actual, "utf8");
    },
  });
  return { body: scriptBody(script), reads };
}

afterEach(() => { for (const cleanup of disposables) cleanup(); disposables.clear(); });

describe.skipIf(!openSuites)("Harris background startup IPC and persistent feature entries", () => {
  it("runs the unchanged Snipaste 2.0.1 registration preload through production compiler and preload preparation", async () => {
    const sourcePath = resolve(snipasteRoot, "preload/services.cjs");
    const source = await readFile(sourcePath, "utf8");
    expect(hash(source)).toBe(snipasteHash);
    const values: string[] = [];
    const frame = createFrame("snipaste", request => {
      if (request.method === "startup.get" && request.args.length === 0) return values.slice();
      if (request.method === "startup.set" && request.args.length === 1 && Array.isArray(request.args[0])) {
        values.splice(0, values.length, ...(request.args[0] as string[])); return null;
      }
      throw new Error(`unsupported startup operation: ${request.method}`);
    });
    try {
      const prepared = await prepareOriginalPreload(snipasteRoot, "preload/services.cjs");
      frame.window.eval(`window.__filename=${JSON.stringify(sourcePath)};\n${prepared.body}`);
      await flush();
      expect(frame.window.services.ensureAutoStartPlugin).toEqual(expect.any(Function));
      expect(values).toEqual(["snipaste"]);
      expect(frame.requests).toEqual([
        { method: "startup.get", args: [] },
        { method: "startup.set", args: [["snipaste"]] },
      ]);
      expect(prepared.reads).toContain(sourcePath);
      expect(prepared.reads).toContain(resolve(snipasteRoot, "preload/os-capture.cjs"));
      expect(prepared.reads).toContain(resolve(snipasteRoot, "preload/storage-clipboard.cjs"));
      await expect(frame.window.services.ensureAutoStartPlugin()).resolves.toMatchObject({ ok: true, registered: true });
      expect(frame.requests).toHaveLength(3);
      expect(frame.requests[2]).toEqual({ method: "startup.get", args: [] });
      expect(frame.blockedOsCalls).toEqual([]);
    } finally { frame.cleanup(); disposables.delete(frame.cleanup); }
  });

  it("requests the existing PluginData approval and does not replay a preload IPC call without a session", async () => {
    const sourcePath = resolve(snipasteRoot, "preload/services.cjs");
    const source = await readFile(sourcePath, "utf8");
    expect(hash(source)).toBe(snipasteHash);
    const frame = createFrame("snipaste", () => { throw new Error("no data request is allowed without a session"); }, { withDataSession: false });
    try {
      const prepared = await prepareOriginalPreload(snipasteRoot, "preload/services.cjs");
      frame.window.eval(`window.__filename=${JSON.stringify(sourcePath)};\n${prepared.body}`);
      await flush();
      expect(frame.parentMessages.filter(message => message.__atools_plugin_data_open__ === true)).toHaveLength(1);
      expect(frame.requests).toEqual([]);
      expect(frame.window.services.ensureAutoStartPlugin).toEqual(expect.any(Function));
    } finally { frame.cleanup(); disposables.delete(frame.cleanup); }
  });

  it("transpiles the hash-pinned Paste helper and denies foreign keys, malformed lists and non-durable replies", async () => {
    const sourcePath = resolve(pasteRoot, "apps/ztools/preload/auto-start.ts");
    const source = await readFile(sourcePath, "utf8");
    expect(hash(source)).toBe(pasteAutoStartHash);
    const transpiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const values: string[] = [];
    let durable = true;
    const frame = createFrame("pasteboard-pro", request => {
      if (request.method === "startup.get" && request.args.length === 0) return values.slice();
      if (request.method === "startup.set" && request.args.length === 1 && Array.isArray(request.args[0])) {
        const list = request.args[0] as string[];
        if (list.some(item => item !== "pasteboard-pro")) throw new Error("foreign plugin name");
        if (durable) values.splice(0, values.length, ...list);
        return durable ? null : false;
      }
      throw new Error(`unsupported startup operation: ${request.method}`);
    });
    try {
      const virtualPath = resolve(pasteRoot, "apps/ztools/preload/auto-start-contract.cjs");
      const prepared = await preparePluginPreload({ pluginDir: pasteRoot, preloadPath: virtualPath,
        readTextFile: async path => resolve(path) === virtualPath ? transpiled : Promise.reject(new Error("unexpected virtual preload read")) });
      frame.window.eval(scriptBody(prepared));
      const helper = frame.window.services.ensureZToolsAutoStart;
      const ipc = frame.window.require("electron").ipcRenderer;
      await expect(helper(ipc)).resolves.toBe(true);
      await expect(helper(ipc)).resolves.toBe(false);
      expect(values).toEqual(["pasteboard-pro"]);
      expect(frame.requests).toEqual([
        { method: "startup.get", args: [] }, { method: "startup.set", args: [["pasteboard-pro"]] },
        { method: "startup.get", args: [] },
      ]);
      await expect(ipc.invoke("ztools:db-get", "other-key")).rejects.toThrow("auto-start-plugin key");
      await expect(ipc.invoke("ztools:db-put", "auto-start-plugin", ["snipaste"])).rejects.toThrow("ERR_ATOOLS_DATA_SESSION");
      await expect(frame.window.__atoolsPluginData.startupRegistration.set(["bad", 3])).rejects.toThrow("Invalid startup registration list");
      durable = false;
      await expect(frame.window.__atoolsPluginData.startupRegistration.set(["pasteboard-pro"])).rejects.toThrow("not durably committed");
      expect(frame.blockedOsCalls).toEqual([]);
    } finally { frame.cleanup(); disposables.delete(frame.cleanup); }
  });

  it("reuses the authenticated lifecycle for hide, ordered reentry, and terminal kill without replaying stale feature callbacks", async () => {
    const values: string[] = [];
    const frame = createFrame("snipaste", request => request.method === "startup.get" ? values.slice() : null);
    try {
      const entered: unknown[] = [], callbacks: Array<(items: unknown[]) => void> = [], out = [] as boolean[];
      frame.window.exports = { selected: { mode: "list", args: { enter: (action: unknown, update: (items: unknown[]) => void) => {
        entered.push(action); callbacks.push(update);
      } } } };
      const closeMessages = frame.parentMessages;
      frame.window.utools.onPluginOut((isKill: boolean) => out.push(isKill));
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-hide" });
      expect(out).toEqual([false]);
      await expect(frame.window.__atoolsPluginData.startupRegistration.get()).resolves.toEqual([]);
      const action = { code: "selected", type: "regex", payload: { text: "保留😀" }, from: "main", option: { id: 7 }, inputState: { tab: "exact" } };
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action, activationId: 1 });
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action, activationId: 1 });
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action, activationId: 0 });
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action, activationId: 1.5 });
      expect(entered).toEqual([action]);
      const secondAction = { ...action, payload: { text: "second" } };
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action: secondAction, activationId: 2 });
      callbacks[0]([{ title: "stale" }]);
      callbacks[1]([{ title: "current" }]);
      await flush();
      expect(entered).toEqual([action, secondAction]);
      const listPosts = closeMessages.filter(message => message.__atools_feature_exports__ === true);
      expect(listPosts.at(-1)?.rows).toEqual([{ index: 0, title: "current", description: "", icon: "" }]);
      const genericEnter = vi.fn();
      frame.window.exports = {};
      frame.window.ztools.onPluginReady(genericEnter);
      const fallbackAction = { code: "legacy", type: "text", payload: "generic payload", from: "main" };
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action: fallbackAction, activationId: 3 });
      await flush();
      expect(genericEnter).toHaveBeenCalledOnce();
      expect(genericEnter).toHaveBeenCalledWith(fallbackAction);
      frame.window.utools.outPlugin();
      frame.window.utools.outPlugin(false);
      frame.window.utools.outPlugin(true);
      frame.window.utools.outPlugin({ title: "legacy" });
      frame.window.utools.outPlugin([{ title: "legacy-array" }]);
      expect(closeMessages.filter(message => message.__ipc_close__ === true).map(message => message.isKill)).toEqual([false, false, true]);
      expect(closeMessages.filter(message => message.__ipc_out__ === true).map(message => message.data)).toEqual([
        [{ title: "legacy" }], [{ title: "legacy-array" }],
      ]);
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-out", isKill: true });
      expect(out).toEqual([false, true]);
      expect(() => frame.window.__atoolsPluginData.startupRegistration.get()).toThrow("ERR_ATOOLS_DATA_CLOSED");
      const deliveredBeforeDispose = entered.length;
      frame.sendHostMessage({ __atools_lifecycle__: true, event: "plugin-enter", action: secondAction, activationId: 4 });
      expect(entered).toHaveLength(deliveredBeforeDispose);
    } finally { frame.cleanup(); disposables.delete(frame.cleanup); }
  });
});
