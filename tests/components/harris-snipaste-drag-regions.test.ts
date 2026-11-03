import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preparePluginBrowserWindowPreload } from "../../src/lib/pluginBrowserWindowPreload";
import { preparePluginNativeWindowDocument, appendPluginNativeWindowDocumentId } from "../../src/lib/pluginNativeBrowserWindowDocument";
import { createPluginPanelDocumentSourceHost } from "../../src/lib/pluginPanelDocumentSourceHost";
import { preparePluginPreload } from "../../src/lib/pluginPreload";
import type { FeatureAction } from "../../src/lib/types";
import {
  NATIVE_FRAME_ID,
  NATIVE_GEOMETRY,
  makeNativeFrameAction,
} from "./compiledPluginNativeWindowFrameFixture";

const EXPECTED_PASTER_SHA256 = "6a26635394498d34a37646cc18521ea7cd09afa08c04ba780f0cf8977f6857b8";
const RESOURCE_ORIGIN = "https://atools-plugin.localhost";
const RESOURCE_SESSION = "6fd849f2-c8f4-4fb9-91b3-2b9e65c44f1b";
const DOCUMENT_ID = "d".repeat(64);
const DOCUMENT_URL = "paster.html?id=fixture-paste&windowRole=paster&tab=pin#surface";
const TRUST_SEAM_MARKER = "reportError: function(error) { try { console.error('[native BrowserWindow app-region drag]', error); } catch (_) {} }\n      });";

type NativeCall = {
  __atools_native_call__: true;
  reqId: number;
  method: string;
  args: { id?: string; action?: string; args?: unknown[] };
};
type TestWindow = Window & {
  __harrisDragTrust?: boolean[];
  __ATOOLS_FRAME_TRANSPORT__?: unknown;
  services?: {
    readLatestPasterWindowPayload?: unknown;
    resizeCurrentWindowTo?: unknown;
  };
};

let pluginRoot = "";
let originalPasterHash = "";
let preparedHtml = "";
let preparedUrl = "";

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function buildProductionDocument() {
  const configuredPluginsRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
  if (!configuredPluginsRoot) {
    throw new Error("ATOOLS_HARRIS_PLUGIN_SOURCE must point to /Users/harris/Desktop/ZTools-plugins/plugins; this regression must not skip when the source package is unavailable");
  }
  pluginRoot = path.resolve(configuredPluginsRoot, "snipaste");
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")) as {
    version?: unknown;
    main?: unknown;
    preload?: unknown;
  };
  expect(manifest.version).toBe("2.0.1");
  expect(manifest.main).toBe("dist/index.html");
  expect(manifest.preload).toBe("preload/services.cjs");

  const pasterPath = path.join(pluginRoot, "paster.html");
  const distPasterPath = path.join(pluginRoot, "dist/paster.html");
  const sourcePaster = await readFile(pasterPath, "utf8");
  const distPaster = await readFile(distPasterPath, "utf8");
  originalPasterHash = sha256(sourcePaster);
  expect(originalPasterHash).toBe(EXPECTED_PASTER_SHA256);
  expect(distPaster).toBe(sourcePaster);

  const readTextFile = async (file: string) => readFile(file, "utf8");
  const document = await preparePluginNativeWindowDocument({
    pluginRoot,
    mainUrl: String(manifest.main),
    requestedUrl: DOCUMENT_URL,
    resourceSessionId: RESOURCE_SESSION,
    resourceOrigin: RESOURCE_ORIGIN,
    readTextFile,
  });
  expect(document.relativePath).toBe("dist/paster.html");
  expect(document.html).toContain("--atools-native-app-region: drag");
  expect(document.html).toContain("--atools-native-app-region: no-drag");
  expect(document.html).not.toContain("-webkit-app-region: drag");

  const action: FeatureAction = {
    ...makeNativeFrameAction(null, ["browserWindow"]),
    main_url: String(manifest.main),
    plugin_path: pluginRoot,
  };
  const preload = await preparePluginBrowserWindowPreload({
    pluginDir: pluginRoot,
    options: { webPreferences: { preload: String(manifest.preload) } },
    prepare: options => preparePluginPreload(options),
    readTextFile,
    isCurrent: () => true,
  });
  // The real CJS module graph is compiled and injected, but this harness deliberately does not start a Node sidecar or emulate Node fs.
  expect(preload).toContain("window.services = services");

  const ports = {
    action: () => action,
    workerDocument: { freshScope: () => "test-worker-scope", clearScope: () => undefined },
    hostedIpc: { reserve: () => 7 },
    mainPushHost: undefined,
    generation: () => 1,
    pluginPathForPreview: pluginRoot,
    productName: "ATools",
    productVersion: "test",
    clipboard: () => undefined,
    data: () => undefined,
    paths: () => undefined,
    dialogs: () => undefined,
    display: () => undefined,
    bridgeScript: () => undefined,
    smokeEnabled: () => false,
    smokeSampleIndex: () => 0,
    subInputState: () => ({ visible: false, value: "", placeholder: "", sequence: 0,
      generation: 0, epoch: 1, focusRequest: null }),
    setSubInputState: () => undefined,
    iframeSrc: () => undefined,
    iframeSrcDoc: () => undefined,
    setPluginItems: () => undefined,
    setSelectedIndex: () => undefined,
    setLoadError: () => undefined,
  };
  const sourceHost = createPluginPanelDocumentSourceHost(ports as unknown as Parameters<typeof createPluginPanelDocumentSourceHost>[0]);
  preparedHtml = sourceHost.injectBridge(document.html, "browserWindow", NATIVE_FRAME_ID,
    preload, NATIVE_GEOMETRY, "native");
  const resourceUrl = appendPluginNativeWindowDocumentId(document.resourceUrl, DOCUMENT_ID);
  preparedUrl = resourceUrl;
  return { sourcePaster, prepared: document, preload };
}

function withSyntheticGestureGate(html: string): string {
  if (!html.includes(TRUST_SEAM_MARKER) || html.indexOf(TRUST_SEAM_MARKER) !== html.lastIndexOf(TRUST_SEAM_MARKER)) {
    throw new Error("Expected one production native drag bootstrap site before adding the test-only trust seam");
  }
  return html.replace(TRUST_SEAM_MARKER,
    "reportError: function(error) { try { console.error('[native BrowserWindow app-region drag]', error); } catch (_) {} },\n"
    + "        isTrustedPointerDown: function(event) { window.__harrisDragTrust.push(event.isTrusted); return event.isTrusted === false; }\n"
    + "      });");
}

function openDocument(html: string, fixedNow = 1_782_000_000_123) {
  const nativeCalls: NativeCall[] = [];
  const jsdomErrors: string[] = [];
  const consoleErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => jsdomErrors.push(error.message));
  virtualConsole.on("error", (...args) => consoleErrors.push(args.map(String).join(" ")));
  const dom = new JSDOM(html, {
    url: preparedUrl,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const testWindow = window as TestWindow;
      testWindow.__harrisDragTrust = [];
      Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
      Object.defineProperty(window, "TextDecoder", { configurable: true, value: TextDecoder });
      window.Date.now = () => fixedNow;
      const nativePostMessage = window.postMessage.bind(window);
      Object.defineProperty(window, "postMessage", {
        configurable: true,
        writable: true,
        value(message: unknown, targetOrigin?: string, transfer?: Transferable[]) {
          if (message && typeof message === "object" && (message as NativeCall).__atools_native_call__ === true) {
            const call = message as NativeCall;
            nativeCalls.push(call);
            const result = call.args?.action === "close" ? { closed: true } : {};
            nativePostMessage({ __atools_native_response__: true, reqId: call.reqId, result }, "*");
            return;
          }
          if (transfer) return nativePostMessage(message, targetOrigin || "*", transfer);
          return nativePostMessage(message, targetOrigin || "*");
        },
      });
    },
  });
  return { dom, nativeCalls, jsdomErrors, consoleErrors };
}

function assertBridgeBootstrap(dom: JSDOM, jsdomErrors: string[], consoleErrors: string[]) {
  expect((dom.window as unknown as TestWindow).__ATOOLS_FRAME_TRANSPORT__).toBeDefined();
  expect(typeof (dom.window as unknown as TestWindow).services?.readLatestPasterWindowPayload).toBe("function");
  expect(typeof (dom.window as unknown as TestWindow).services?.resizeCurrentWindowTo).toBe("function");
  expect(jsdomErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

async function waitForLoad(dom: JSDOM) {
  if (dom.window.document.readyState === "complete") return;
  await new Promise<void>(resolve => dom.window.addEventListener("load", () => resolve(), { once: true }));
}

async function flushTasks() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await Promise.resolve();
}

function pointerDown(dom: JSDOM, target: Element, values: Record<string, unknown> = {}) {
  const event = new dom.window.Event("pointerdown", { bubbles: true, composed: true, cancelable: true });
  for (const [name, value] of Object.entries({
    pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, ctrlKey: false, ...values,
  })) Object.defineProperty(event, name, { configurable: true, value });
  target.dispatchEvent(event);
  return event;
}

function nativeDragCalls(calls: NativeCall[]) {
  return calls.filter(call => call.method === "browserWindowAction" && call.args.action === "startDragging");
}

describe("Snipaste 2.0.1 native drag regions through production document and bridge compilation", () => {
  beforeAll(async () => { await buildProductionDocument(); }, 20_000);

  afterAll(async () => {
    if (!pluginRoot || !originalPasterHash) return;
    const after = sha256(await readFile(path.join(pluginRoot, "paster.html"), "utf8"));
    expect(after).toBe(originalPasterHash);
    expect(after).toBe(EXPECTED_PASTER_SHA256);
  });

  it("prepares the unchanged original page with the native CSS rewrite and rejects synthetic pointer input by default", async () => {
    const html = preparedHtml;
    expect(html).toContain('data-atools-plugin-preload="true"');
    expect(preparedUrl.startsWith(`${RESOURCE_ORIGIN}/${RESOURCE_SESSION}/dist/paster.html?`)).toBe(true);
    expect(preparedUrl).toContain("id=fixture-paste&windowRole=paster&tab=pin");
    expect(preparedUrl).toContain(`__atools_window_document=${DOCUMENT_ID}`);

    const { dom, nativeCalls, jsdomErrors, consoleErrors } = openDocument(html);
    try {
      await waitForLoad(dom);
      assertBridgeBootstrap(dom, jsdomErrors, consoleErrors);
      const surface = dom.window.document.querySelector("#drag-surface")!;
      expect(dom.window.location.search).toContain("id=fixture-paste");
      expect(dom.window.location.search).toContain("windowRole=paster");
      expect(dom.window.document.querySelector("#status-badge")!.textContent).toContain("100% · 100%");
      expect(dom.window.getComputedStyle(surface).getPropertyValue("--atools-native-app-region").trim()).toBe("drag");

      const synthetic = pointerDown(dom, surface);
      expect(synthetic.isTrusted).toBe(false);
      dom.window.document.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 2, clientY: 3 }));
      dom.window.document.dispatchEvent(new dom.window.Event("pointermove", { bubbles: true, composed: true }));
      await flushTasks();
      expect(nativeDragCalls(nativeCalls)).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it("routes only the original drag surface through the explicit synthetic test seam while preserving page controls", async () => {
    const { dom, nativeCalls, jsdomErrors, consoleErrors } = openDocument(withSyntheticGestureGate(preparedHtml));
    try {
      await waitForLoad(dom);
      assertBridgeBootstrap(dom, jsdomErrors, consoleErrors);
      const window = dom.window;
      const surface = window.document.querySelector("#drag-surface")!;
      const hudButton = window.document.querySelector("#btn-reset")!;
      const contextMenu = window.document.querySelector("#ctx-menu")!;

      expect(window.getComputedStyle(surface).getPropertyValue("--atools-native-app-region").trim()).toBe("drag");
      expect(window.getComputedStyle(window.document.querySelector(".hud-actions")!).getPropertyValue("--atools-native-app-region").trim()).toBe("no-drag");
      expect(window.getComputedStyle(contextMenu).getPropertyValue("--atools-native-app-region").trim()).toBe("no-drag");

      window.document.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
      window.document.dispatchEvent(new window.Event("pointermove", { bubbles: true, composed: true }));
      expect(nativeDragCalls(nativeCalls)).toHaveLength(0);

      const dragEvent = pointerDown(dom, surface);
      expect(dragEvent.isTrusted).toBe(false);
      await flushTasks();
      expect((window as unknown as TestWindow).__harrisDragTrust).toEqual([false]);
      expect(nativeDragCalls(nativeCalls)).toEqual([expect.objectContaining({
        args: expect.objectContaining({ id: NATIVE_FRAME_ID, action: "startDragging", args: [{ startedAtMs: 1_782_000_000_123 }] }),
      })]);

      pointerDown(dom, hudButton);
      pointerDown(dom, surface, { button: 2, buttons: 2 });
      const contextEvent = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 24, clientY: 32 });
      surface.dispatchEvent(contextEvent);
      expect(contextEvent.defaultPrevented).toBe(true);
      expect((contextMenu as HTMLElement).style.display).toBe("flex");
      pointerDown(dom, contextMenu, { button: 2, buttons: 2 });

      const zoom = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 });
      window.dispatchEvent(zoom);
      expect(zoom.defaultPrevented).toBe(true);
      await flushTasks();
      expect(window.document.querySelector("#status-badge")!.textContent).toContain("110% · 100%");
      const opacity = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 1, altKey: true });
      window.dispatchEvent(opacity);
      expect(opacity.defaultPrevented).toBe(true);
      expect(window.document.querySelector("#status-badge")!.textContent).toContain("110% · 95%");
      expect(nativeDragCalls(nativeCalls)).toHaveLength(1);

      surface.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await flushTasks();
      expect(nativeCalls.some(call => call.method === "browserWindowAction" && call.args.action === "close")).toBe(true);
      pointerDown(dom, surface);
      await flushTasks();
      expect(nativeDragCalls(nativeCalls)).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it("invalidates captured drag handling when the original document leaves", async () => {
    const { dom, nativeCalls, jsdomErrors, consoleErrors } = openDocument(withSyntheticGestureGate(preparedHtml));
    try {
      await waitForLoad(dom);
      assertBridgeBootstrap(dom, jsdomErrors, consoleErrors);
      const surface = dom.window.document.querySelector("#drag-surface")!;
      pointerDown(dom, surface);
      await flushTasks();
      expect(nativeDragCalls(nativeCalls)).toHaveLength(1);

      dom.window.dispatchEvent(new dom.window.Event("pagehide"));
      pointerDown(dom, surface);
      dom.window.dispatchEvent(new dom.window.CustomEvent("atools-plugin-out"));
      pointerDown(dom, surface);
      await flushTasks();
      expect(nativeDragCalls(nativeCalls)).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });
});
