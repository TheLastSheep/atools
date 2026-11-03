// @vitest-environment node
import { Buffer } from "node:buffer";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";

const instanceId = "clipboard-copy-production-fixture";
const endpoint = "http://127.0.0.1:43123/host/" + "b".repeat(64);
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
const pngDataUrl = "data:image/png;base64," + pngBase64;
const pngBytes = Buffer.from(pngBase64, "base64");
const jpegDataUrl = "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 217, ...new Uint8Array(29)]).toString("base64");

type CopyFixtureOptions = { permissions?: string[]; session?: boolean };

function createFrame({ permissions = ["clipboard.write"], session = true }: CopyFixtureOptions = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    url: "https://clipboard-copy-production.invalid/",
  });
  const window = dom.window as any;
  const messages: any[] = [];
  const writes: Array<{ method: string; endpoint: string; async: boolean; body: unknown }> = [];
  Object.assign(window, { Buffer, TextEncoder, TextDecoder });
  Object.defineProperty(window, "postMessage", {
    configurable: true,
    value(data: unknown) { messages.push(data); },
  });
  Object.defineProperty(window, "XMLHttpRequest", {
    configurable: true,
    value: class FixtureXmlHttpRequest {
      status = 200;
      responseText = "";
      private method = "";
      private target = "";
      private async = true;
      open(method: string, target: string, async = true) { this.method = method; this.target = target; this.async = async; }
      setRequestHeader() {}
      send(body: string) {
        writes.push({ method: this.method, endpoint: this.target, async: this.async, body: JSON.parse(body) });
        this.responseText = JSON.stringify({ ok: true, result: null });
      }
    },
  });

  const documentSource = createPluginBridgeDocument({
    action: {
      plugin_id: "clipboard-copy-fixture",
      plugin_name: "Clipboard copy fixture",
      feature_code: "copy",
      main_url: "index.html",
      plugin_path: "/fixture/clipboard-copy",
      expand_height: 0,
      plugin_permissions: permissions,
      payload: null,
    },
    windowType: "main",
    browserWindowId: "",
    geometrySnapshot: null,
    workerScope: "clipboard-copy-production",
    mainPushConfig: null,
    webContentsId: 931,
    subInputEpoch: 0,
    appName: "ATools copy fixture",
    appVersion: "fixture",
    clipboard: {
      instanceId,
      endpoints: session ? { write: endpoint, image_write: endpoint, content_write: endpoint } : {},
    },
  });
  expect(documentSource).not.toContain("__ATOOLS_CLIPBOARD_COPY_FACTORY__");
  const parsed = new window.DOMParser().parseFromString(documentSource, "text/html");
  for (const script of Array.from(parsed.querySelectorAll("script")) as any[]) window.eval(script.textContent ?? "");

  function dispatch(data: unknown) {
    window.dispatchEvent(new window.MessageEvent("message", {
      data,
      source: window.parent,
      origin: "https://clipboard-copy-production.invalid",
    }));
  }
  function close() { dom.window.close(); }
  return { dom, window, messages, writes, dispatch, close };
}

it("runs compiled public copyText, copyFile, and copyImage synchronously in the injected realm", () => {
  const frame = createFrame();
  try {
    const textResult = frame.window.utools.copyText("compiled text");
    const fileResult = frame.window.utools.copyFile(["/tmp/one.txt", "C:\\two.txt"]);
    const viewBuffer = new Uint8Array(pngBytes.byteLength + 6);
    viewBuffer.set(pngBytes, 3);
    const imageView = new Uint8Array(viewBuffer.buffer, 3, pngBytes.byteLength);
    const imageResult = frame.window.utools.copyImage(imageView);

    expect([textResult, fileResult, imageResult]).toEqual([true, true, true]);
    expect(frame.writes.map(write => write.async)).toEqual([false, false, false]);
    expect(frame.writes.map(write => write.body)).toEqual([
      { text: "compiled text" },
      { kind: "files", paths: ["/tmp/one.txt", "C:\\two.txt"] },
      { image: { dataUrl: pngDataUrl, width: 1, height: 1 } },
    ]);
  } finally {
    frame.close();
  }
});

it("asks once for missing manifest permission, returns false, and writes only after an explicit retry", () => {
  const frame = createFrame({ permissions: [] });
  try {
    expect(frame.window.utools.copyText("never replay this")).toBe(false);
    expect(frame.window.utools.copyFile("/tmp/never-replay.txt")).toBe(false);
    expect(frame.window.utools.copyImage(pngDataUrl)).toBe(false);
    const requests = frame.messages.filter(message => message?.__atools_permission_request__ === true);
    expect(requests).toHaveLength(1);
    expect(frame.writes).toHaveLength(0);

    frame.dispatch({ __atools_permission_response__: true, reqId: requests[0].reqId, allowed: true });
    expect(frame.writes).toHaveLength(0);
    expect(frame.window.utools.copyText("explicit retry")).toBe(true);
    expect(frame.writes).toEqual([{
      method: "POST", endpoint, async: false, body: { text: "explicit retry" },
    }]);
  } finally {
    frame.close();
  }
});

it("keeps the host clipboard session gate independent of the manifest grant", () => {
  const frame = createFrame({ session: false });
  try {
    expect(frame.window.utools.copyText("host session missing")).toBe(false);
    expect(frame.window.utools.copyFile("/tmp/host-session-missing.txt")).toBe(false);
    expect(frame.window.utools.copyImage(pngDataUrl)).toBe(false);
    expect(frame.writes).toHaveLength(0);
    expect(frame.messages.filter(message => message?.__atools_permission_request__ === true)).toHaveLength(0);
    const hostRequests = frame.messages.filter(message => message?.__atools_host_clipboard_open__ === true);
    expect(hostRequests.map(message => message.access).sort()).toEqual(["content_write", "image_write", "write"]);

    frame.dispatch({ __atools_host_clipboard_session__: true, instanceId, access: "write", endpoint });
    expect(frame.writes).toHaveLength(0);
    expect(frame.window.utools.copyText("retry after host grant")).toBe(true);
    expect(frame.writes).toHaveLength(1);
    expect(frame.writes[0].body).toEqual({ text: "retry after host grant" });
  } finally {
    frame.close();
  }
});

it("disables captured public copy methods after pagehide or plugin-out", () => {
  for (const eventName of ["pagehide", "atools-plugin-out"]) {
    const frame = createFrame();
    try {
      expect(frame.window.utools.copyText("before lifecycle end")).toBe(true);
      const initialWrites = frame.writes.length;
      frame.window.dispatchEvent(new frame.window.Event(eventName));
      expect(frame.window.utools.copyText("after lifecycle end")).toBe(false);
      expect(frame.writes).toHaveLength(initialWrites);
    } finally {
      frame.close();
    }
  }
});

it("rejects malformed PNG through the production NativeImage adapter and routes JPEG/path calls to the image-session port", () => {
  const frame = createFrame();
  try {
    const electron = frame.window.require("electron");
    expect(() => electron.nativeImage.createFromDataURL("data:image/png;base64,AAAA")).toThrow();
    expect(frame.window.utools.copyImage("data:image/png;base64,AAAA")).toBe(false);
    expect(frame.writes).toHaveLength(0);

    const imageCalls: Array<{ operation: string; params: Record<string, unknown> }> = [];
    frame.window.__atoolsNodeModuleRequire = {
      createLocalBuffer(value: string | Uint8Array, encoding?: string) { return Buffer.from(value as any, encoding as any); },
      isLocalBuffer(value: unknown) { return Buffer.isBuffer(value); },
      nativeImageRequestSync(operation: string, params: Record<string, unknown>) {
        imageCalls.push({ operation, params });
        if (operation === "openBuffer") return { handleId: "jpeg-buffer", format: "jpeg", width: 1, height: 1 };
        if (operation === "openPath") return { handleId: "png-path", format: "png", width: 1, height: 1 };
        return { format: "png", width: 1, height: 1, byteLength: pngBytes.byteLength, dataBase64: pngBytes.toString("base64") };
      },
    };

    let directImageError: unknown;
    try { electron.clipboard.writeImage(electron.nativeImage.createFromDataURL(jpegDataUrl)); }
    catch (error) { directImageError = error; }
    expect(directImageError).toBeUndefined();
    frame.writes.length = 0;
    imageCalls.length = 0;
    expect(frame.window.utools.copyImage(jpegDataUrl)).toBe(true);
    expect(imageCalls.map(call => call.operation)).toEqual(["openBuffer", "encode"]);
    imageCalls.length = 0;
    expect(frame.window.utools.copyImage("/fixture/private/input.png")).toBe(true);
    expect(imageCalls.map(call => call.operation)).toEqual(["openPath", "encode"]);
    expect(imageCalls[0].params).toEqual({ path: "/fixture/private/input.png" });
    expect(frame.writes.map(write => write.body)).toEqual([
      { image: { dataUrl: pngDataUrl, width: 1, height: 1 } },
      { image: { dataUrl: pngDataUrl, width: 1, height: 1 } },
    ]);
  } finally {
    frame.close();
  }
});
