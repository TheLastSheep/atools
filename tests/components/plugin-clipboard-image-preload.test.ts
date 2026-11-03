import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { createHostClipboardController, dispatchHostClipboardPermission } from "../../src/lib/hostClipboardController";
import { pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { createBrowserBuffer } from "../../src/lib/browserBuffer";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginInvokePolicy";

const originalPreloadPath = path.resolve("ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js");
const originalPreload = readFileSync(originalPreloadPath, "utf8");
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7w8AAAAASUVORK5CYII=", "base64");
const image = { dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`, width: 1, height: 1 };
const endpoint = "http://127.0.0.1:12345/host/" + "d".repeat(64);
const reopenedEndpoint = "http://127.0.0.1:12346/host/" + "e".repeat(64);

function scriptBody(script: string) { return script.replace(/^<script[^>]*>\n?/, "").replace(/\n?<\/script>$/, ""); }

function createPreloadHarness(options: { result?: unknown; rejected?: boolean; canceled?: boolean; instanceId?: string; endpoints?: Record<string, string> } = {}) {
  const instanceId = options.instanceId || "paintbrush-fixture";
  const activeImageEndpoint = options.endpoints?.image || endpoint;
  const notifications: string[] = [], writes: Array<{ path: string; bytes: Uint8Array }> = [], parentMessages: unknown[] = [], frameMessages: unknown[] = [], listeners: Function[] = [];
  let requestCount = 0;
  const nativeBuffer = createBrowserBuffer();
  let wroteBrowserBuffer = false;
  const fs = {
    writeFileSync: vi.fn((file: string, bytes: Uint8Array) => {
      wroteBrowserBuffer = nativeBuffer.isBuffer(bytes);
      writes.push({ path: file, bytes: Uint8Array.from(bytes) });
    }),
    existsSync: () => false,
    copyFileSync: vi.fn(),
    readFile: (_file: string, callback: Function) => callback(new Error("unused")),
  };
  const electron = { ipcRenderer: { on: vi.fn() } };
  const localRequire = (specifier: string) => {
    if (specifier === "electron") return electron;
    if (specifier === "fs") return fs;
    if (specifier === "path") return path;
    if (specifier === "os") return { tmpdir: () => "/tmp" };
    throw new Error("Unexpected preload require: " + specifier);
  };
  const ztools = {
    getAppName: () => "ATools", getAppVersion: () => "fixture",
    hideMainWindow: vi.fn(), outPlugin: vi.fn(),
    getPath: () => "/downloads",
    showSaveDialog: () => options.canceled ? "" : "/downloads/clipboard.png",
    showNotification: (text: string) => notifications.push(text),
  };
  const context: any = {
    console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    Buffer: nativeBuffer,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder,
    TextDecoder,
    Image: class {},
    localStorage: { setItem() {}, removeItem() {}, getItem() { return null; } },
    setTimeout: () => 1,
    clearTimeout: () => {},
    require: localRequire,
    XMLHttpRequest: class {
      status = 200;
      responseText = "";
      open(method: string, target: string, asynchronous: boolean) {
        expect([method, target, asynchronous]).toEqual(["POST", activeImageEndpoint, false]);
      }
      setRequestHeader() {}
      send(body: string) {
        expect(JSON.parse(body)).toEqual({ format: "image" });
        requestCount++;
        this.responseText = JSON.stringify(options.rejected
          ? { ok: false, error: { message: "private clipboard operation denied" } }
          : { ok: true, result: options.result === undefined ? image : options.result });
      }
    },
    addEventListener: (_name: string, listener: Function) => listeners.push(listener),
    parent: { postMessage: (message: unknown) => parentMessages.push(message) },
    postMessage: (message: unknown) => frameMessages.push(message),
    utools: { clipboard: {}, getAppName: ztools.getAppName, getAppVersion: ztools.getAppVersion },
    ztools,
  };
  context.window = context;
  const realm = vm.createContext(context);
  vm.runInContext(scriptBody(hostClipboardBridgeScript({ instanceId, ...(options.endpoints ? { endpoints: options.endpoints as any } : {}) })), realm);
  vm.runInContext(scriptBody(pluginElectronAdapterScript()), realm);
  vm.runInContext(originalPreload, realm, { filename: originalPreloadPath });
  const authorizeImage = (imageEndpoint = endpoint) => listeners[0]({ source: context.parent, data: {
    __atools_host_clipboard_session__: true, instanceId, access: "image", endpoint: imageEndpoint,
  } });
  const saveClipboard = () => context.exports["save-clipboard"].args.enter();
  const receiveBridgeMessage = (message: unknown) => listeners[0]({ source: context.parent, data: message });
  return { frame: context, authorizeImage, receiveBridgeMessage, saveClipboard, notifications, writes, parentMessages, frameMessages, fs, nativeBuffer,
    get requestCount() { return requestCount; }, get wroteBrowserBuffer() { return wroteBrowserBuffer; } };
}

describe("unchanged paintbrush preload through production Electron and clipboard script builders", () => {
  it("does not replay the first permission-denied action; a later explicit save writes the exact PNG once", () => {
    const harness = createPreloadHarness();
    harness.saveClipboard();
    expect(harness.parentMessages).toEqual([{ __atools_host_clipboard_open__: true, instanceId: "paintbrush-fixture", access: "image" }]);
    expect(harness.requestCount).toBe(0);
    expect(harness.writes).toHaveLength(0);
    harness.authorizeImage();
    expect(harness.writes).toHaveLength(0);
    expect(harness.requestCount).toBe(0);
    harness.saveClipboard();
    expect(harness.requestCount).toBe(1);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].path).toBe("/downloads/clipboard.png");
    expect(harness.wroteBrowserBuffer).toBe(true);
    expect(Buffer.from(harness.writes[0].bytes)).toEqual(imageBytes);
  });

  it("restores only an explicitly granted image session through manual reopen, then runs the original preload again", async () => {
    const first = createPreloadHarness();
    const calls: Array<[string, any]> = [];
    const invoke: any = vi.fn(async (command: string, args: any = {}) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") {
        if (args.access !== "image") return { unavailable: true };
        return { sessionId: args.instanceId === "paintbrush-fixture" ? "first-image-session" : "reopened-image-session" };
      }
      if (command === "get_host_clipboard_session") return {
        access: "image", endpoint: args.instanceId === "paintbrush-fixture" ? endpoint : reopenedEndpoint,
      };
      return undefined;
    });
    const sourceRegistry = new PluginFrameSourceRegistry();
    sourceRegistry.setMain(first.frame);
    const firstController = createHostClipboardController(invoke, "paintbrush", () => true, vi.fn(), { instanceId: "paintbrush-fixture" }, async () => {});

    first.saveClipboard();
    const identity = { kind: "main" as const, generation: 1 };
    expect(dispatchHostClipboardPermission({ controller: firstController, message: first.parentMessages[0] as any,
      source: first.frame, identity, sources: sourceRegistry })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.frameMessages).toEqual([expect.objectContaining({ __atools_host_clipboard_session__: true, access: "image", endpoint })]);
    first.receiveBridgeMessage(first.frameMessages[0]);
    expect(first.writes).toHaveLength(0);
    expect(first.requestCount).toBe(0);
    first.saveClipboard();
    expect(first.writes).toHaveLength(1);

    const handoff = await firstController.reopen();
    expect(handoff).toEqual({ instanceId: expect.any(String), restoreImageSession: true });
    expect(handoff).not.toHaveProperty("endpoints");
    const nextController = createHostClipboardController(invoke, "paintbrush", () => true, vi.fn(), handoff, async () => {});
    const restored = await nextController.prepareGranted();
    expect(restored).toEqual({ instanceId: handoff.instanceId, endpoints: { image: reopenedEndpoint } });
    expect(calls.filter(([command, args]) => command === "prepare_host_clipboard" && args.access === "image").map(([, args]) => args.requestPermission))
      .toEqual([true, false]);
    expect(calls.some(([command, args]) => command === "prepare_host_clipboard" && args.access === "image" && args.requestPermission === false)).toBe(true);

    const reopened = createPreloadHarness({ instanceId: restored.instanceId, endpoints: restored.endpoints });
    reopened.saveClipboard();
    expect(reopened.parentMessages).toHaveLength(0);
    expect(reopened.requestCount).toBe(1);
    expect(reopened.writes).toHaveLength(1);
    expect(Buffer.from(reopened.writes[0].bytes)).toEqual(imageBytes);
  });

  it.each([
    ["empty clipboard", { result: null }],
    ["permission rejection", { rejected: true }],
    ["oversized response", { result: { dataUrl: `data:image/png;base64,${"A".repeat(720 * 1024)}`, width: 1, height: 1 } }],
    ["save cancellation", { canceled: true }],
  ])("does not write a file for %s", (_name, options) => {
    const harness = createPreloadHarness(options as { result?: unknown; rejected?: boolean; canceled?: boolean });
    harness.authorizeImage();
    harness.saveClipboard();
    expect(harness.writes).toHaveLength(0);
    expect(harness.fs.writeFileSync).not.toHaveBeenCalled();
  });
});
