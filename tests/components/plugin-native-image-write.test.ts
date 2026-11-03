import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createBrowserBuffer } from "../../src/lib/browserBuffer";
import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { createHostClipboardController, dispatchHostClipboardPermission } from "../../src/lib/hostClipboardController";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { validatePluginClipboardImagePayload } from "../../src/lib/pluginNativeImage";
import { createPluginNativeImageFactories } from "../../src/lib/pluginNativeImageFactories";

const png = readFileSync("ZTools-plugins/plugins/calculation-paper/logo.png");
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const payload = { dataUrl, width: 200, height: 200 };
const endpoint = "http://127.0.0.1:12345/host/" + "d".repeat(64);
const application = { name: "ATools", version: "test" };

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii"), length = Buffer.alloc(4), crcInput = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function pngPaddedTo(totalBytes: number): Buffer {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") break;
    offset += length + 12;
  }
  const beforeEnd = png.subarray(0, offset), end = png.subarray(offset);
  const textLength = totalBytes - beforeEnd.length - end.length - 12;
  if (textLength < 8) throw new Error("Fixture PNG cannot fit target size");
  const text = Buffer.alloc(textLength, 120); text.write("Comment\0", "ascii");
  const result = Buffer.concat([beforeEnd, pngChunk("tEXt", text), end]);
  if (result.length !== totalBytes) throw new Error("Fixture PNG size mismatch");
  return result;
}

function serializedElectron(clipboard: unknown) {
  const BufferFacade = createBrowserBuffer();
  const window: any = {
    Buffer: BufferFacade,
    require: (name: string) => name === "electron" ? { ipcRenderer: {} } : {},
    utools: { getAppName: () => application.name, getAppVersion: () => application.version },
    __atoolsHostClipboard: clipboard,
  };
  const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  new Function("window", script)(window);
  return { electron: window.require("electron"), BufferFacade };
}

describe("bounded Electron NativeImage write path", () => {
  it("uses the production serialized adapter and Buffer facade, and writes only registered immutable images", () => {
    const request = vi.fn(), transport = vi.fn(() => null);
    const bridge = createHostClipboardBridge({ instanceId: "write-generation", endpoints: { image_write: endpoint } }, request, transport, validatePluginClipboardImagePayload);
    const { electron, BufferFacade } = serializedElectron(bridge);
    const mutable = BufferFacade.from(png);
    const image = electron.nativeImage.createFromBuffer(mutable);
    expect(electron.nativeImage.createFromBuffer).toBeTypeOf("function");
    mutable.fill(0);
    expect(image.getSize()).toEqual({ width: 200, height: 200 });
    expect(image.toDataURL()).toBe(dataUrl);
    expect(Buffer.from(image.toPNG())).toEqual(png);
    expect(electron.clipboard.writeImage(image)).toBeUndefined();
    expect(electron.clipboard.writeImage(image, "clipboard")).toBeUndefined();
    expect(() => electron.clipboard.writeImage(image, "selection")).toThrow("Selection clipboard");
    expect(transport.mock.calls).toEqual([[endpoint, { image: payload }], [endpoint, { image: payload }]]);
    expect(request).not.toHaveBeenCalled();
    expect(() => electron.clipboard.writeImage({ isEmpty: () => false, toPNG: () => png, toDataURL: () => dataUrl, getSize: () => ({ width: 1, height: 1 }) }))
      .toThrow("requires an ATools NativeImage");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("supports createFromDataURL and readImage round-trip but rejects empty, mutated and fabricated images", () => {
    const transport = vi.fn((_url: string, request: any) => "format" in request ? payload : null);
    const bridge = createHostClipboardBridge({ instanceId: "roundtrip", endpoints: { image: endpoint, image_write: endpoint } }, vi.fn(), transport, validatePluginClipboardImagePayload);
    const { electron } = serializedElectron(bridge);
    const fromDataUrl = electron.nativeImage.createFromDataURL(dataUrl);
    expect(Object.isFrozen(fromDataUrl)).toBe(true);
    let pathError: unknown;
    try { electron.nativeImage.createFromPath("/tmp/image.png"); } catch (error) { pathError = error; }
    expect(pathError).toMatchObject({ code: "ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE" });
    expect(transport).not.toHaveBeenCalled();
    expect(() => electron.nativeImage.createFromBitmap(png)).toThrow("nativeImage.createFromBitmap");
    expect(fromDataUrl.getSize()).toEqual({ width: 200, height: 200 });
    expect((fromDataUrl as any).resize({ width: 100 }).getSize()).toEqual({ width: 100, height: 100 });
    expect(electron.clipboard.writeImage(fromDataUrl)).toBeUndefined();
    const fromRead = electron.clipboard.readImage();
    expect(fromRead.toDataURL()).toBe(dataUrl);
    expect(electron.clipboard.writeImage(fromRead)).toBeUndefined();
    expect(() => electron.clipboard.writeImage(electron.nativeImage.createEmpty())).toThrow("rejects an empty");
    expect(() => electron.nativeImage.createFromDataURL("data:image/jpeg;base64," + png.toString("base64"))).toThrow("does not match its bytes");
    expect(() => electron.nativeImage.createFromDataURL(dataUrl + " ")).toThrow();
  });

  it("keeps image-write permission separate, requires an explicit retry, and never queues the first image", () => {
    const requested = vi.fn(), transport = vi.fn(() => null);
    const bridge = createHostClipboardBridge({ instanceId: "permission-generation" }, requested, transport, validatePluginClipboardImagePayload);
    const { electron } = serializedElectron(bridge);
    const image = electron.nativeImage.createFromDataURL(dataUrl);
    expect(() => electron.clipboard.writeImage(image)).toThrow("PERMISSION_REQUIRED");
    expect(requested.mock.calls).toEqual([["image_write"]]);
    expect(transport).not.toHaveBeenCalled();
    bridge.install("write", endpoint);
    bridge.install("image", endpoint);
    expect(() => electron.clipboard.writeImage(image)).toThrow("PERMISSION_REQUIRED");
    expect(requested).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    bridge.install("image_write", endpoint);
    expect(transport).not.toHaveBeenCalled();
    expect(electron.clipboard.writeImage(image)).toBeUndefined();
    expect(transport.mock.calls).toEqual([[endpoint, { image: payload }]]);
    bridge.close();
    expect(() => electron.clipboard.writeImage(image)).toThrow("CLOSED");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("serializes the exact image_write endpoint request and accepts only null acknowledgement", () => {
    const events: any[] = [], listeners: any[] = [];
    const parent = { postMessage: (message: unknown) => events.push(message) };
    const window: any = { utools: { clipboard: {} } };
    const response = JSON.stringify({ ok: true, result: null });
    class Xhr {
      status = 200; responseText = response;
      open(method: string, url: string, async: boolean) { expect([method, url, async]).toEqual(["POST", endpoint, false]); }
      setRequestHeader(name: string, value: string) { expect([name, value]).toEqual(["Content-Type", "application/json"]); }
      send(body: string) { expect(JSON.parse(body)).toEqual({ image: payload }); }
    }
    const script = hostClipboardBridgeScript({ instanceId: "serialized-write" }).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "parent", "addEventListener", "XMLHttpRequest", "TextEncoder", script)(
      window, parent, (_: string, listener: unknown) => listeners.push(listener), Xhr, TextEncoder,
    );
    expect(() => window.__atoolsHostClipboard.writeImage(payload)).toThrow("PERMISSION_REQUIRED");
    expect(events).toEqual([{ __atools_host_clipboard_open__: true, instanceId: "serialized-write", access: "image_write" }]);
    listeners[0]({ source: parent, data: { __atools_host_clipboard_session__: true, instanceId: "serialized-write", access: "image_write", endpoint } });
    expect(window.__atoolsHostClipboard.writeImage(payload)).toBeUndefined();
  });

  it("rejects invalid acknowledgements and malformed input without a second transport call", () => {
    const request = vi.fn(), transport = vi.fn(() => false);
    const bridge = createHostClipboardBridge({ instanceId: "bad-ack", endpoints: { image_write: endpoint } }, request, transport, validatePluginClipboardImagePayload);
    expect(() => bridge.writeImage(payload)).toThrow("Invalid clipboard image write response");
    expect(() => bridge.writeImage({ ...payload, width: 2 })).toThrow("dimensions do not match");
    expect(() => bridge.writeImage({ ...payload, dataUrl: "data:image/jpeg;base64," + png.toString("base64") })).toThrow("data URL");
    expect(transport).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("classifies maximum-plus-one buffers before copying and preserves the supported cap", () => {
    const BufferFacade = createBrowserBuffer();
    const factories = createPluginNativeImageFactories(validatePluginClipboardImagePayload, (url, width, height, bytes) => ({
      isEmpty: () => url === null, toDataURL: () => url || "data:image/png;base64,", toPNG: () => bytes || new Uint8Array(), getSize: () => ({ width, height }),
    }), () => BufferFacade);
    const tooLarge = BufferFacade.alloc(512 * 1024 + 1);
    const originalFrom = BufferFacade.from;
    const from = vi.fn(originalFrom);
    BufferFacade.from = from;
    expect(() => factories.createFromBuffer(tooLarge)).toThrow("supported limit");
    expect(from).not.toHaveBeenCalled();
    BufferFacade.from = originalFrom;
  });

  it("keeps a complete 512 KiB PNG within the exact 700 KiB serialized request envelope", () => {
    const nearCap = pngPaddedTo(512 * 1024);
    const largePayload = { dataUrl: `data:image/png;base64,${nearCap.toString("base64")}`, width: 200, height: 200 };
    const transport = vi.fn((_url: string, body: any) => { expect(body.image).toEqual(largePayload); return null; });
    const bridge = createHostClipboardBridge({ instanceId: "near-cap", endpoints: { image_write: endpoint } }, vi.fn(), transport, validatePluginClipboardImagePayload);
    expect(Buffer.byteLength(JSON.stringify({ image: largePayload }), "utf8")).toBeLessThan(700 * 1024);
    expect(bridge.writeImage(largePayload)).toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("image-write host permission lifecycle", () => {
  it("keeps prepareGranted text-only, requests the exact write grant, and does not restore it on reopen", async () => {
    const calls: any[] = [], status = vi.fn();
    const invoke: any = vi.fn(async (command: string, args: any) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") return args.access === "image_write"
        ? { sessionId: args.instanceId === "old" ? "old-image-write" : "new-image-write" }
        : { unavailable: true };
      if (command === "get_host_clipboard_session") return { endpoint, access: args.sessionId === "old-image-write" ? "image_write" : "image_write" };
      if (command === "rotate_host_clipboard") return null;
    });
    const controller = createHostClipboardController(invoke, "paintbrush", () => true, status, { instanceId: "old" }, async () => {});
    await controller.prepareGranted();
    expect(calls.filter(([command]) => command === "prepare_host_clipboard").map(([, args]) => args.access)).toEqual(["read", "write"]);
    await controller.request("image_write");
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", access: "image_write", message: "写入剪贴板图片已允许，请再次操作或重新打开插件" }));
    expect(calls.find(([command, args]) => command === "prepare_host_clipboard" && args.access === "image_write")[1])
      .toEqual({ pluginId: "paintbrush", instanceId: "old", access: "image_write", requestPermission: true });
    const next = await controller.reopen();
    expect(next).toEqual({ instanceId: expect.any(String) });
    expect(calls.find(([command]) => command === "rotate_host_clipboard")[1].nextInstanceId).toBe(next.instanceId);
    const reopened = createHostClipboardController(invoke, "paintbrush", () => true, vi.fn(), next, async () => {});
    await reopened.prepareGranted();
    expect(calls.filter(([command]) => command === "prepare_host_clipboard").map(([, args]) => args.access)).toEqual([
      "read", "write", "image_write", "read", "write",
    ]);
    expect(await reopened.request("image_write")).toBe(endpoint);
    expect(calls.filter(([command, args]) => command === "prepare_host_clipboard" && args.access === "image_write").at(-1)?.[1])
      .toEqual({ pluginId: "paintbrush", instanceId: next.instanceId, access: "image_write", requestPermission: true });
    await reopened.close();
    await controller.close();
  });

  it("routes only the current authenticated frame's image_write prompt", async () => {
    const calls: any[] = [], sources = new PluginFrameSourceRegistry();
    const source = { postMessage: vi.fn() };
    sources.setMain(source);
    const identity = sources.currentIdentityForHost(source)!;
    const controller = createHostClipboardController(async (command, args) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") return { sessionId: "session" };
      if (command === "get_host_clipboard_session") return { endpoint, access: args.sessionId === "session" ? "image_write" : "write" };
      return null;
    }, "plugin", () => true, vi.fn(), undefined, async () => {});
    const event = { __atools_host_clipboard_open__: true, instanceId: controller.instanceId, access: "image_write" };
    expect(dispatchHostClipboardPermission({ controller, message: event, source, identity, sources })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContainEqual(["prepare_host_clipboard", { pluginId: "plugin", instanceId: controller.instanceId, access: "image_write", requestPermission: true }]);
    expect(source.postMessage).toHaveBeenCalledWith({ __atools_host_clipboard_session__: true, instanceId: controller.instanceId, access: "image_write", endpoint }, "*");
    await controller.close();
  });
});
