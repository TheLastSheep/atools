// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";
import { expect, it } from "vitest";
import { preparePluginPreload } from "../../src/lib/pluginPreload";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../src/lib/pluginPanelBridgeCompiler";

const sourceRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const sourcePackage = sourceRoot ? resolve(sourceRoot, "snipaste") : "";
const releaseFiles = [
  "plugin.json",
  "preload/services.cjs",
  "preload/storage-clipboard.cjs",
  "preload/os-capture.cjs",
  "dist/paster.html",
] as const;
const allowedScratchFsMethods = new Set(["existsSync", "mkdirSync", "readFileSync", "writeFileSync"]);
const nativeWindowA = "snipaste-paster-native-a";
const nativeWindowB = "snipaste-paster-native-b";
const allowedNativeWindowActions = new Set(["setSize", "close"]);
const forbiddenNativeMethods = new Set([
  "screenCapture", "screenColorPick", "copyImage", "copyText", "copyFile",
  "hideMainWindowPasteText", "hideMainWindowPasteImage", "hideMainWindowPasteFile",
]);

type Observed = {
  fsCalls: string[];
  blockedCalls: string[];
  fallbackDomControls: Array<{ method: string; args: unknown[] }>;
  parentMessages: unknown[];
  serviceResizeCalls: Array<[number, number]>;
  createdWindows: Array<{ url: string; options: Record<string, unknown> }>;
  pageErrors: string[];
};

function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createScratchFs(scratchRoot: string, observed: Observed) {
  const fence = (path: unknown) => {
    if (typeof path !== "string" && !(path instanceof URL)) throw new Error(`Unexpected fs path: ${String(path)}`);
    const actual = resolve(String(path));
    if (actual !== scratchRoot && !actual.startsWith(`${scratchRoot}${sep}`)) {
      throw new Error(`Snipaste preload filesystem escaped scratch: ${actual}`);
    }
  };
  return new Proxy(nodeFs, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      const method = typeof property === "string" ? property : String(property);
      if (property === "promises") {
        observed.blockedCalls.push("fs.promises");
        throw new Error("Unexpected fs.promises access in Snipaste window-controls contract");
      }
      if (typeof value !== "function") return value;
      if (!allowedScratchFsMethods.has(method)) {
        return (..._args: unknown[]) => {
          observed.blockedCalls.push(`fs.${method}`);
          throw new Error(`Blocked filesystem method: fs.${method}`);
        };
      }
      return (...args: unknown[]) => {
        fence(args[0]);
        observed.fsCalls.push(`fs.${method}`);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function createBlockedClipboard(observed: Observed) {
  return new Proxy(Object.create(null) as object, {
    get(_target, property) {
      return (..._args: unknown[]) => {
        observed.blockedCalls.push(`clipboard.${String(property)}`);
        throw new Error(`Blocked optional Snipaste side effect: clipboard.${String(property)}`);
      };
    },
  });
}

function createHostRequire(scratchRoot: string, observed: Observed) {
  const requireNode = createRequire(import.meta.url);
  const scratchFs = createScratchFs(scratchRoot, observed);
  const childProcess = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === "then") return undefined;
      return (..._args: unknown[]) => {
        observed.blockedCalls.push(`child_process.${String(property)}`);
        throw new Error(`Blocked optional Snipaste side effect: child_process.${String(property)}`);
      };
    },
  });
  const clipboard = createBlockedClipboard(observed);
  const hostRequire = (specifier: string): unknown => {
    if (specifier === "node:fs" || specifier === "fs") return scratchFs;
    if (specifier === "node:path" || specifier === "path") return requireNode(specifier);
    if (specifier === "node:child_process" || specifier === "child_process") return childProcess;
    if (specifier === "electron") return { clipboard };
    observed.blockedCalls.push(`require.${specifier}`);
    throw new Error(`Blocked unexpected Snipaste host module: ${specifier}`);
  };
  return hostRequire;
}

function browserWindowActionRequests(observed: Observed) {
  return observed.parentMessages.filter((message): message is Record<string, any> =>
    Boolean(message && typeof message === "object" && (message as Record<string, unknown>).__atools_native_call__ === true
      && (message as Record<string, unknown>).method === "browserWindowAction"));
}

function acceptHostMessage(message: unknown, observed: Observed) {
  if (message && typeof message === "object") {
    const call = message as Record<string, any>;
    if (call.__atools_native_call__ === true) {
      const action = call.method === "browserWindowAction" ? call.args?.action : undefined;
      if (forbiddenNativeMethods.has(String(call.method))
        || (call.method === "browserWindowAction" && !allowedNativeWindowActions.has(String(action)))) {
        const blocked = `native.${String(call.method)}${action ? `.${String(action)}` : ""}`;
        observed.blockedCalls.push(blocked);
        throw new Error(`Blocked optional Snipaste side effect: ${blocked}`);
      }
    }
  }
  observed.parentMessages.push(message);
}

function methodRequests(observed: Observed, action: string) {
  return browserWindowActionRequests(observed).filter(message => message.args?.action === action);
}

function replyToNative(dom: JSDOM, parent: Window, request: Record<string, any>, result: unknown) {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: { __atools_native_response__: true, reqId: request.reqId, result },
    origin: "https://fixture.atools.invalid",
    source: parent,
  }));
}

async function flushPageTasks() {
  await Promise.resolve();
  await new Promise(resolveTick => setTimeout(resolveTick, 0));
  await Promise.resolve();
}

it.skipIf(!sourceRoot)("executes Harris Snipaste 2.0.1 paster controls through the compiled native DOM bridge", async () => {
  const manifestBytes = await readFile(join(sourcePackage, "plugin.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  expect(manifest).toMatchObject({ author: "harris", version: "2.0.1", preload: "preload/services.cjs", main: "dist/index.html" });

  const sourceDigests = new Map<string, string>();
  const scratchRoot = await mkdtemp(join(tmpdir(), "atools-harris-snipaste-window-controls-"));
  const pluginRoot = join(scratchRoot, "plugin");
  const preloadPath = join(pluginRoot, "preload", "services.cjs");
  const graphReads = new Set<string>();
  const observed: Observed = {
    fsCalls: [], blockedCalls: [], fallbackDomControls: [], parentMessages: [], serviceResizeCalls: [], createdWindows: [], pageErrors: [],
  };
  let parentDom: JSDOM | undefined;
  let childResizeDom: JSDOM | undefined;
  let childCloseDom: JSDOM | undefined;
  const domCleanups = new Set<() => void>();
  const childWindows = new Set<Window>();
  const captureDomCleanup = (window: Window, isChild = false) => {
    domCleanups.add(window.close.bind(window));
    if (isChild) childWindows.add(window);
  };

  try {
    for (const relative of releaseFiles) {
      const sourcePath = join(sourcePackage, relative);
      const bytes = await readFile(sourcePath);
      sourceDigests.set(sourcePath, digest(bytes));
      const scratchPath = join(pluginRoot, relative);
      await mkdir(dirname(scratchPath), { recursive: true });
      await writeFile(scratchPath, bytes);
      expect(digest(await readFile(scratchPath)), `faithful scratch copy: ${relative}`).toBe(digest(bytes));
    }

    const parentAction: Record<string, any> = {
      plugin_id: "snipaste", plugin_name: "Snipaste Pro", feature_code: "snipaste/paster-fixture",
      main_url: "dist/index.html", plugin_path: pluginRoot, expand_height: 0, payload: null,
      plugin_permissions: ["browserWindow"], plugin_providers: {}, entry_type: "text",
    };
    async function prepareScratchPreload() {
      return preparePluginPreload({
        pluginDir: pluginRoot,
        preloadPath,
        readTextFile: async path => {
          const actual = resolve(path);
          if (actual !== scratchRoot && !actual.startsWith(`${scratchRoot}${sep}`)) {
            throw new Error(`Preload graph escaped scratch: ${actual}`);
          }
          graphReads.add(actual);
          return readFile(actual, "utf8");
        },
      });
    }

    const preloadScript = await prepareScratchPreload();
    const parentZtools = {
      getCursorScreenPoint: () => ({ x: 100, y: 200 }),
      getDisplayNearestPoint: () => ({ id: "scratch-display", scaleFactor: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
      createBrowserWindow: (url: string, options: Record<string, unknown>) => {
        observed.createdWindows.push({ url, options: { ...options } });
        return { id: `mock-child-${observed.createdWindows.length}` };
      },
      hideMainWindow: (...args: unknown[]) => {
        observed.blockedCalls.push("ztools.hideMainWindow");
        throw new Error(`Unexpected launcher hide: ${String(args)}`);
      },
      outPlugin: (...args: unknown[]) => {
        observed.blockedCalls.push("ztools.outPlugin");
        throw new Error(`Unexpected plugin unload: ${String(args)}`);
      },
    };
    // This exercises source/bridge contracts in jsdom only; createBrowserWindow and
    // the native calls below are captured and acknowledged in memory, not by Wry/OS.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", error => observed.pageErrors.push(error.message));
    const parentHtml = injectPluginBridgeHtml("<!doctype html><html><head></head><body></body></html>", preloadScript);
    parentDom = new JSDOM(parentHtml, {
      url: "https://fixture.atools.invalid/parent.html",
      runScripts: "dangerously",
      virtualConsole,
      beforeParse(window) {
        captureDomCleanup(window);
        Object.defineProperty(window, "require", { configurable: true, value: createHostRequire(scratchRoot, observed) });
        Object.defineProperty(window, "utools", { configurable: true, value: parentZtools });
        Object.defineProperty(window, "ztools", { configurable: true, value: parentZtools });
        Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
        Object.defineProperty(window, "TextDecoder", { configurable: true, value: TextDecoder });
        Object.defineProperty(window, "Buffer", { configurable: true, value: Buffer });
        Object.defineProperty(window, "fetch", { configurable: true, value: (..._args: unknown[]) => {
          observed.blockedCalls.push("fetch"); throw new Error("Network is disabled in this test");
        } });
      },
    });
    Object.defineProperty(parentDom.window, "postMessage", {
      configurable: true,
      value: (message: unknown) => acceptHostMessage(message, observed),
    });

    const firstPayload = {
      id: "window-controls-resize-001", title: "Resize contract", dataUrl: "data:image/png;base64,c25pcGFzdGU=",
      width: 400, height: 300, screenX: -40, screenY: 170, alwaysOnTop: true,
    };
    const secondPayload = {
      id: "window-controls-close-002", title: "Close contract", dataUrl: "data:image/png;base64,c25pcGFzdGU=",
      width: 240, height: 180, screenX: 40, screenY: 70, alwaysOnTop: true,
    };
    expect(parentDom.window.services.spawnStandalonePasterWindow(firstPayload)).toMatchObject({ ok: true, mode: "os-browser-window", width: 400, height: 300 });
    expect(parentDom.window.services.spawnStandalonePasterWindow(secondPayload)).toMatchObject({ ok: true, mode: "os-browser-window", width: 240, height: 180 });
    expect(observed.createdWindows).toHaveLength(2);
    const resizeUrl = observed.createdWindows[0]!.url;
    const closeUrl = observed.createdWindows[1]!.url;
    expect(new URL(resizeUrl, "https://fixture.atools.invalid").searchParams.get("id")).toBe(firstPayload.id);
    expect(new URL(closeUrl, "https://fixture.atools.invalid").searchParams.get("id")).toBe(secondPayload.id);

    const pasterHtml = await readFile(join(pluginRoot, "dist/paster.html"), "utf8");
    function compiledChildHtml(nativeWindowId: string) {
      const geometrySnapshot = {
        windowId: nativeWindowId, clientCreateId: `create-${nativeWindowId}`, ownerKey: "harris-snipaste-fixture",
        instanceNonce: "fixture-instance", documentGeneration: 1, documentNonce: "0123456789abcdef0123456789abcdef",
        revision: 1, bounds: { x: 0, y: 0, width: 400, height: 300 }, minimumSize: [0, 0], maximumSize: [0, 0],
      };
      const bridge = createPluginBridgeDocument({
        action: parentAction,
        windowType: "browserWindow",
        windowHostKind: "native",
        browserWindowId: nativeWindowId,
        geometrySnapshot,
        workerScope: `window-controls-${nativeWindowId}`,
        mainPushConfig: null,
        webContentsId: 7,
        subInputEpoch: 1,
        appName: "ATools",
        appVersion: "fixture",
      });
      return injectPluginBridgeHtml(pasterHtml, `${bridge}${preloadScript}`);
    }

    function createChild(html: string, relativeUrl: string) {
      return new JSDOM(html, {
        url: new URL(relativeUrl, "https://fixture.atools.invalid/").href,
        runScripts: "dangerously",
        virtualConsole,
        beforeParse(window) {
          captureDomCleanup(window, true);
          Object.defineProperty(window, "parent", { configurable: true, value: parentDom!.window });
          Object.defineProperty(window, "require", { configurable: true, value: createHostRequire(scratchRoot, observed) });
          Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
          Object.defineProperty(window, "TextDecoder", { configurable: true, value: TextDecoder });
          Object.defineProperty(window, "Buffer", { configurable: true, value: Buffer });
          Object.defineProperty(window, "__atoolsHostClipboard", { configurable: true, value: createBlockedClipboard(observed) });
          Object.defineProperty(window, "fetch", { configurable: true, value: (..._args: unknown[]) => {
            observed.blockedCalls.push("fetch"); throw new Error("Network is disabled in this test");
          } });
          Object.defineProperty(window, "XMLHttpRequest", { configurable: true, value: function XMLHttpRequest() {
            observed.blockedCalls.push("XMLHttpRequest"); throw new Error("Network is disabled in this test");
          } });
          Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
          Object.defineProperty(window, "resizeTo", { configurable: true, value: (...args: unknown[]) => {
            observed.fallbackDomControls.push({ method: "resizeTo", args });
          } });
          Object.defineProperty(window, "close", { configurable: true, value: (...args: unknown[]) => {
            observed.fallbackDomControls.push({ method: "close", args });
          } });
        },
      });
    }

    childResizeDom = createChild(compiledChildHtml(nativeWindowA), resizeUrl);
    const originalResize = childResizeDom.window.services.resizeCurrentWindowTo;
    childResizeDom.window.services.resizeCurrentWindowTo = function(width: number, height: number) {
      observed.serviceResizeCalls.push([width, height]);
      return originalResize.call(this, width, height);
    };
    for (let index = 0; index < 3; index++) {
      childResizeDom.window.dispatchEvent(new childResizeDom.window.WheelEvent("wheel", { deltaY: -10, cancelable: true }));
    }
    await flushPageTasks();
    const firstResizeBatch = methodRequests(observed, "setSize");
    expect(firstResizeBatch.length, "only one native resize may be in flight while wheel updates merge").toBe(1);
    const firstSizeArgs = firstResizeBatch[0]!.args.args;
    const latestWheelSize = [520, 390];
    if (JSON.stringify(firstSizeArgs) !== JSON.stringify(latestWheelSize)) {
      expect(firstSizeArgs).toEqual([440, 330]);
      replyToNative(childResizeDom, parentDom.window, firstResizeBatch[0]!, [440, 330]);
      await flushPageTasks();
      const mergedResize = methodRequests(observed, "setSize");
      expect(mergedResize).toHaveLength(2);
      expect(mergedResize[1]!.args.args).toEqual(latestWheelSize);
      replyToNative(childResizeDom, parentDom.window, mergedResize[1]!, latestWheelSize);
      await flushPageTasks();
    } else {
      expect(firstSizeArgs).toEqual(latestWheelSize);
      replyToNative(childResizeDom, parentDom.window, firstResizeBatch[0]!, latestWheelSize);
      await flushPageTasks();
    }
    expect(observed.serviceResizeCalls).toEqual([[440, 330], [480, 360], [520, 390]]);
    expect(observed.fallbackDomControls.filter(call => call.method === "resizeTo")).toHaveLength(0);

    childResizeDom.window.document.getElementById("btn-reset")!.dispatchEvent(new childResizeDom.window.MouseEvent("click", { bubbles: true }));
    await flushPageTasks();
    const resetRequest = methodRequests(observed, "setSize").at(-1);
    expect(resetRequest?.args.args).toEqual([400, 300]);
    replyToNative(childResizeDom, parentDom.window, resetRequest!, [400, 300]);
    await flushPageTasks();
    expect(childResizeDom.window.resizeTo(401, 301)).toBeUndefined();
    await flushPageTasks();
    const directResizeRequest = methodRequests(observed, "setSize").at(-1);
    expect(directResizeRequest?.args.args).toEqual([401, 301]);
    replyToNative(childResizeDom, parentDom.window, directResizeRequest!, [401, 301]);
    await flushPageTasks();
    const resizeRequestsBeforeLifecycle = methodRequests(observed, "setSize").length;
    childResizeDom.window.dispatchEvent(new childResizeDom.window.Event("atools-plugin-out"));
    childResizeDom.window.resizeTo(800, 600);
    childResizeDom.window.close();
    await flushPageTasks();
    expect(methodRequests(observed, "setSize")).toHaveLength(resizeRequestsBeforeLifecycle);
    expect(methodRequests(observed, "close")).toHaveLength(0);

    childCloseDom = createChild(compiledChildHtml(nativeWindowB), closeUrl);
    const closePage = childCloseDom.window;
    closePage.dispatchEvent(new closePage.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    closePage.document.getElementById("btn-close")!.dispatchEvent(new closePage.MouseEvent("click", { bubbles: true }));
    expect(closePage.close()).toBeUndefined();
    await flushPageTasks();
    const closeRequests = methodRequests(observed, "close");
    expect(closeRequests).toHaveLength(1);
    expect(closeRequests[0]!.args).toMatchObject({ id: nativeWindowB, action: "close", args: [] });
    replyToNative(childCloseDom, parentDom.window, closeRequests[0]!, { closed: true });
    await flushPageTasks();

    childCloseDom.window.dispatchEvent(new childCloseDom.window.Event("atools-plugin-out"));
    childCloseDom.window.resizeTo(800, 600);
    childCloseDom.window.close();
    await flushPageTasks();
    expect(methodRequests(observed, "setSize")).toHaveLength(resizeRequestsBeforeLifecycle);
    expect(methodRequests(observed, "close")).toHaveLength(1);
    expect(observed.blockedCalls).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
    expect([...graphReads].sort()).toEqual([
      join(pluginRoot, "preload/os-capture.cjs"),
      join(pluginRoot, "preload/services.cjs"),
      join(pluginRoot, "preload/storage-clipboard.cjs"),
    ].sort());
    expect(observed.fsCalls).toEqual(expect.arrayContaining(["fs.mkdirSync", "fs.writeFileSync", "fs.existsSync", "fs.readFileSync"]));
  } finally {
    for (const childWindow of childWindows) {
      try {
        childWindow.dispatchEvent(new childWindow.Event("atools-plugin-out"));
      } catch {
        // A failing page must not prevent the remaining JSDOM instances from closing.
      }
    }
    for (const closeJSDOM of domCleanups) {
      try {
        closeJSDOM();
      } catch {
        // Continue releasing all captured JSDOM instances after an earlier close error.
      }
    }
    await rm(scratchRoot, { recursive: true, force: true });
    for (const [path, before] of sourceDigests) expect(digest(await readFile(path)), `unchanged published source: ${path}`).toBe(before);
  }
});
