import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_FRAME_HTML as HTML,
  NATIVE_FRAME_ID as FRAME_ID,
  NATIVE_GEOMETRY as GEOMETRY,
  compileNativeFrameDocument,
  makeNativeFrameAction as makeAction,
  makeNativeFrameDocumentSourceHost as makeDocumentSourceHost,
} from "./compiledPluginNativeWindowFrameFixture";

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

function compileDocument(html: string) {
  const compiled = compileNativeFrameDocument(html);
  cleanups.add(compiled.dispose);
  return compiled;
}

describe("native BrowserWindow self provenance", () => {
  it("rejects native self process and media identifiers while preserving hosted child fallbacks", async () => {
    const sourceHost = makeDocumentSourceHost();
    const nativeHtml = sourceHost.host.injectBridge(HTML, "browserWindow", FRAME_ID, "", GEOMETRY, "native");
    const native = compileDocument(nativeHtml);
    const nativeSelf = native.window.__testSelfWindowHandle;

    expect(native.window.__testWindowHostKind).toBe("native");
    expect(nativeSelf.id).toBe(FRAME_ID);
    expect(nativeSelf.getBounds()).toEqual(GEOMETRY.bounds);
    for (const getter of [nativeSelf.webContents.getProcessId, nativeSelf.webContents.getOSProcessId,
      nativeSelf.webContents.getMediaSourceId]) {
      expect(() => getter.call(nativeSelf.webContents)).toThrow(expect.objectContaining({
        code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED",
      }));
    }
    await expect(nativeSelf.getMediaSourceId()).rejects.toMatchObject({ code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED" });

    const hostedHtml = sourceHost.host.injectBridge(HTML, "browserWindow", "hosted-child-42", "", {
      ...GEOMETRY, windowId: "hosted-child-42",
    });
    const hosted = compileDocument(hostedHtml);
    const hostedSelf = hosted.window.__testSelfWindowHandle;
    expect(hosted.window.__testWindowHostKind).toBe("hosted");
    expect(hostedSelf.webContents.getProcessId()).toBe(42);
    expect(hostedSelf.webContents.getOSProcessId()).toBe(100042);
    expect(hostedSelf.webContents.getMediaSourceId()).toBe("web-contents:42:0");
    expect(hostedSelf.webContents.getBackgroundThrottling()).toBe(true);
  });

  it("seeds native self WebContents from the compiler preference and keeps setter unsupported", () => {
    const sourceHost = makeDocumentSourceHost();
    const html = sourceHost.host.injectBridge(HTML, "browserWindow", FRAME_ID, "", GEOMETRY,
      "native", "activate", false);
    const native = compileDocument(html);
    const nativeSelf = native.window.__testSelfWindowHandle;
    expect(nativeSelf.webContents.getBackgroundThrottling()).toBe(false);

    const beforeSetter = native.messages.length;
    expect(() => nativeSelf.webContents.setBackgroundThrottling(true)).toThrow(expect.objectContaining({
      code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED",
    }));
    expect(nativeSelf.webContents.getBackgroundThrottling()).toBe(false);
    expect(native.messages.slice(beforeSetter).filter(message => message.__atools_native_call__ === true)).toEqual([]);

    const defaultHtml = sourceHost.host.injectBridge(HTML, "browserWindow", FRAME_ID, "", GEOMETRY, "native");
    const defaultNative = compileDocument(defaultHtml);
    expect(defaultNative.window.__testSelfWindowHandle.webContents.getBackgroundThrottling()).toBe(true);
  });

  it("emits raw action aliases from public native self BrowserWindow methods", async () => {
    const action = makeAction();
    action.plugin_permissions = ["browserWindow"];
    const sourceHost = makeDocumentSourceHost(action);
    const html = sourceHost.host.injectBridge(HTML, "browserWindow", FRAME_ID, "", GEOMETRY, "native");
    const native = compileDocument(html);
    const handle = native.window.__testSelfWindowHandle;
    const before = native.messages.length;

    const load = handle.loadURL("next.html?source=paste#result");
    const reload = handle.reload();
    const getURL = handle.getURL();
    const requests = native.messages.slice(before).filter(message => message.__atools_native_call__ === true);
    expect(requests.map(message => ({ method: message.method, action: (message.args as Record<string, unknown>).action })))
      .toEqual([
        { method: "browserWindowAction", action: "loadURL" },
        { method: "browserWindowAction", action: "reload" },
        { method: "browserWindowAction", action: "getURL" },
      ]);

    const url = "paster.html?id=42&windowRole=paster#paste";
    for (const request of requests) {
      const action = (request.args as Record<string, unknown>).action;
      native.dispatchMessage({ __atools_native_response__: true, reqId: request.reqId,
        result: action === "getURL" ? url : { url: action === "loadURL" ? "next.html?source=paste#result" : url,
          title: "Paste", loading: false, historyIndex: 0, historyLength: 1 } });
    }
    await expect(load).resolves.toMatchObject({ url: "next.html?source=paste#result", title: "Paste" });
    await expect(reload).resolves.toMatchObject({ url, title: "Paste" });
    await expect(getURL).resolves.toBe(url);
  });

  it("keeps the default main/preview bridge hosted through the document source host", () => {
    const sourceHost = makeDocumentSourceHost(makeAction({ srcdoc: HTML }));
    sourceHost.host.loadPreview();
    const main = compileDocument(sourceHost.getIframeSrcDoc());

    expect(main.window.__testWindowHostKind).toBe("hosted");
    expect(main.window.utools.getWindowType()).toBe("main");
    expect(main.window.__testSelfWindowHandle).toBeUndefined();
  });

});
