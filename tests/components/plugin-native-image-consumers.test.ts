import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";
import { nodeModuleCodecScript } from "../../src/lib/nodeModuleValues";
import { pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { browserBufferFactoryScript } from "../../src/lib/browserBuffer";

const png = new Uint8Array(readFileSync("ZTools-plugins/plugins/calculation-paper/logo.png"));
const pngBase64 = Buffer.from(png).toString("base64");
const repo = process.cwd();
const productionCodecSource = readFileSync(join(repo, "crates/atools-plugin/src/legacy_node/codec.cjs"), "utf8");
function decodeWithProductionNodeCodec(value: unknown): Buffer {
  const module = { exports: {} as Record<string, any> };
  const context = vm.createContext({ module, exports: module.exports, require, Buffer, process });
  vm.runInContext(`${productionCodecSource}\nmodule.exports.__decodeForTest = decode;`, context, { filename: "legacy_node/codec.cjs" });
  return module.exports.__decodeForTest(value) as Buffer;
}
function makeSerializedBrowserCodec() {
  const context = vm.createContext({ atob, btoa, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer });
  const factory = vm.runInContext(`(${nodeModuleCodecScript()})`, context);
  return factory({ handle: () => undefined, promise: () => Promise.resolve(), callback: () => "unused", existingHandle: () => undefined });
}
const hostWindow = (globalThis as any).window;
const sessions: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  (globalThis as any).window = hostWindow;
});

function originalMethod(file: string, start: string, next: string) {
  const source = readFileSync(join(repo, file), "utf8");
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(next, startAt);
  if (startAt < 0 || endAt < 0) throw new Error(`Original consumer slice not found: ${file}`);
  const method = source.slice(startAt, endAt).trim().replace(/,\s*$/, "");
  return { method, sha256: createHash("sha256").update(method).digest("hex") };
}

function nodeMethodCounts(calls: Array<{ method: string }>) {
  return {
    get: calls.filter(call => call.method === "get").length,
    call: calls.filter(call => call.method === "call").length,
  };
}

function expectCodecHelpersPrivate(session: Function) {
  expect(Object.keys(session)).not.toContain("createLocalBuffer");
  expect(Object.keys(session)).not.toContain("isLocalBuffer");
  for (const key of ["createLocalBuffer", "isLocalBuffer"]) {
    expect(Object.getOwnPropertyDescriptor(session, key)).toMatchObject({ enumerable: false, writable: false, configurable: false });
  }
}

function assertPluginGlobalBufferStillUsesNode(window: any, calls: Array<{ method: string }>, globalBuffer: any) {
  expect(window.Buffer).toBe(globalBuffer);
  const before = nodeMethodCounts(calls);
  const decoded = globalBuffer.from(pngBase64, "base64");
  expect(decoded.toString("base64")).toBe(pngBase64);
  const after = nodeMethodCounts(calls);
  expect(after.get - before.get).toBe(1);
  expect(after.call - before.call).toBe(1);
  expect(window.Buffer).toBe(globalBuffer);
}

function makeHarness() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const writes: Array<{ method: string; url: string; async: boolean; body: string }> = [];
  let openedPathCount = 0;
  const nativeHashes = new Map<number, ReturnType<typeof createHash>>();
  const cjsBufferDecodes: Array<{ kind: unknown; bytes: number; isBuffer: boolean }> = [];
  const localRequire: any = (specifier: string) => specifier === "electron" ? { ipcRenderer: {} } : {};
  const window: any = {
    require: localRequire,
    Buffer,
    console,
    addEventListener() {},
    removeEventListener() {},
    utools: { getAppName: () => "ATools", getAppVersion: () => "test" },
  };
  const context: Record<string, any> = { window, console, TextEncoder, TextDecoder, URL, atob, btoa,
    parent: { postMessage() {} }, addEventListener: window.addEventListener.bind(window) };
  vm.createContext(context);
  (globalThis as any).window = window;
  class FakeXhr {
    status = 0;
    responseText = "";
    method = "";
    url = "";
    async = true;
    open(method: string, url: string, async: boolean) { this.method = method; this.url = url; this.async = async; }
    setRequestHeader() {}
    send(body: string) {
      if (this.url.includes("/host/")) {
        writes.push({ method: this.method, url: this.url, async: this.async, body });
        this.status = 200;
        this.responseText = JSON.stringify({ ok: true, result: null });
        return;
      }
      const request = JSON.parse(body) as { method: string; params: Record<string, any> };
      calls.push(request);
      let result: unknown;
      if (request.method === "nativeImageTransform") {
        const params = request.params;
        if (params.operation === "openPath" && Object.keys(params).sort().join(",") === "operation,path") {
          result = { handleId: `path-${openedPathCount += 1}`, format: "png", width: 200, height: 200 };
        } else if (params.operation === "encode"
          && Object.keys(params).sort().join(",") === "format,handleId,operation,resizePlan"
          && params.format === "png" && Array.isArray(params.resizePlan) && params.resizePlan.length === 0) {
          result = { format: "png", width: 200, height: 200, byteLength: png.byteLength, dataBase64: pngBase64 };
        } else {
          throw new Error(`Unexpected NativeImage transform DTO: ${JSON.stringify(params)}`);
        }
      } else if (request.method === "require" && request.params.specifier === "crypto") {
        result = { kind: "handle", handleId: 40, callable: false, keys: ["createHash"] };
      } else if (request.method === "get" && request.params.handleId === 40 && request.params.property === "createHash") {
        result = { kind: "handle", handleId: 41, callable: true, keys: [] };
      } else if (request.method === "call" && request.params.handleId === 41) {
        const algorithm = request.params.args[0]?.value;
        if (typeof algorithm !== "string") throw new Error("Expected encoded crypto algorithm");
        nativeHashes.set(42, createHash(algorithm));
        result = { kind: "handle", handleId: 42, callable: false, keys: ["update", "digest"] };
      } else if (request.method === "get" && request.params.handleId === 42 && request.params.property === "update") {
        result = { kind: "handle", handleId: 43, callable: true, keys: [] };
      } else if (request.method === "get" && request.params.handleId === 42 && request.params.property === "digest") {
        result = { kind: "handle", handleId: 44, callable: true, keys: [] };
      } else if (request.method === "call" && request.params.handleId === 43) {
        const wireValue = request.params.args[0];
        const decoded = decodeWithProductionNodeCodec(wireValue);
        cjsBufferDecodes.push({ kind: wireValue.kind, bytes: decoded.byteLength, isBuffer: Buffer.isBuffer(decoded) });
        const hash = nativeHashes.get(42);
        if (!hash) throw new Error("Hash context missing");
        hash.update(decoded);
        result = { kind: "handle", handleId: 42, callable: false, keys: ["update", "digest"] };
      } else if (request.method === "call" && request.params.handleId === 44) {
        const hash = nativeHashes.get(42);
        if (!hash) throw new Error("Hash context missing");
        const encoding = request.params.args[0]?.value;
        result = { kind: "value", value: hash.digest(encoding) };
        nativeHashes.delete(42);
      } else if (request.method === "require" && request.params.specifier === "buffer") {
        result = { kind: "handle", handleId: 1, callable: false, keys: ["Buffer"] };
      } else if (request.method === "get" && request.params.handleId === 1 && request.params.property === "Buffer") {
        result = { kind: "handle", handleId: 2, callable: true, keys: ["from"] };
      } else if (request.method === "get" && request.params.handleId === 2 && request.params.property === "from") {
        result = { kind: "handle", handleId: 3, callable: true, keys: [] };
      } else if (request.method === "call" && request.params.handleId === 3) {
        result = { kind: "buffer", data: pngBase64 };
      } else throw new Error(`Unexpected Node bridge request: ${request.method}`);
      this.status = 200;
      this.responseText = JSON.stringify({ ok: true, result });
    }
  }
  context.XMLHttpRequest = FakeXhr;
  const hostClipboardScript = hostClipboardBridgeScript({ instanceId: "batch56-original-consumer" })
    .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  vm.runInContext(hostClipboardScript, context);
  const clipboard = window.__atoolsHostClipboard;
  const adapter = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  vm.runInContext(adapter, context);
  const electron = window.require("electron");
  function installSession() {
    const endpoint = "http://127.0.0.1:1234/node/" + "a".repeat(64);
    const session = vm.runInContext(`(${nodeModuleBridgeScript({ endpoint })})`, context);
    window.__atoolsNodeModuleRequire = session;
    window.require = session;
    window.Buffer = session("buffer").Buffer;
    context.Buffer = window.Buffer;
    sessions.push({ close: () => session.close() });
    return session;
  }
  return { window, context, electron, clipboard, calls, writes, installSession, cjsBufferDecodes };
}

function deviceLinkConsumer(repository: unknown, clipboard: unknown, nativeImage: unknown) {
  const { method, sha256 } = originalMethod(
    "ZTools-plugins/plugins/device-link/preload/services.js", "async copyMessage(messageId) {", "\n  async openAttachment(attachmentId)",
  );
  const factory = new Function("repository", "clipboard", "nativeImage", "ztools",
    `return ({${method}}).copyMessage;`);
  return { fn: factory(repository, clipboard, nativeImage, {}), sha256 };
}

describe("original PNG copy consumers with the production adapter and Node bridge", () => {
  it("marks local image bytes with the session codec identity recognized by the real Node CJS decoder", () => {
    const codec = makeSerializedBrowserCodec();
    const local = codec.createLocalBuffer(png);
    expect(codec.isLocalBuffer(local)).toBe(true);
    const wire = codec.encode(local);
    expect(wire).toEqual({ kind: "buffer", data: pngBase64 });
    const nodeBytes = decodeWithProductionNodeCodec(wire);
    expect(Buffer.isBuffer(nodeBytes)).toBe(true);
    expect(createHash("sha256").update(nodeBytes).digest("hex")).toBe("390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353");

    const independentBuffer = vm.runInContext(`(${browserBufferFactoryScript()})()`, vm.createContext({ atob, btoa, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer }));
    const oldWire = codec.encode(independentBuffer.from(png));
    expect(oldWire.kind).toBe("typedArray");
    expect(() => decodeWithProductionNodeCodec(oldWire)).toThrow("ERR_ATOOLS_NODE_TYPED_ARRAY_UNSUPPORTED");
  });

  it("IdeaDock uses openPath/encode, requires a session and image_write grant, and retries only on a new call", () => {
    const { electron, clipboard, calls, writes, installSession, window, cjsBufferDecodes } = makeHarness();
    const { method, sha256 } = originalMethod(
      "ZTools-plugins/plugins/ideadock/preload.js", "copyEntryImage(file) {", "\n  copyEntryFiles(paths)",
    );
    expect(sha256).toBe("c032f678eaff50984fa60061d64144e40d44fffed6f18606e64fab3d03b905f7");
    const factory = new Function("path", "CLIP_DIR", "nativeImage", "clipboard", "md5",
      `let _clipLastSig = ""; return ({${method}}).copyEntryImage;`);
    const md5 = (bytes: Uint8Array) => window.require("crypto").createHash("md5").update(bytes).digest("hex");
    const fn = factory(require("node:path"), "/tmp/ideadock", electron.nativeImage, electron.clipboard, md5);
    const imageCalls = () => calls.filter(call => call.method === "nativeImageTransform");
    expect(fn("entry.png")).toBe(false);
    expect(imageCalls()).toHaveLength(0);
    expect(writes).toHaveLength(0);

    const session = installSession();
    expectCodecHelpersPrivate(session);
    const globalBuffer = window.Buffer;
    const bufferRpcBaseline = nodeMethodCounts(calls);
    expect(imageCalls()).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(fn("entry.png")).toBe(false);
    expect(nodeMethodCounts(calls)).toEqual(bufferRpcBaseline);
    expect(window.Buffer).toBe(globalBuffer);
    expect(imageCalls().map(call => call.params)).toEqual([
      { operation: "openPath", path: "/tmp/ideadock/entry.png" },
      { operation: "encode", handleId: "path-1", resizePlan: [], format: "png" },
    ]);
    expect(writes).toHaveLength(0);

    clipboard.install("image_write", "http://127.0.0.1:1234/host/" + "a".repeat(64));
    expect(writes).toHaveLength(0);
    expect(fn("entry.png")).toBe(true);
    expect(imageCalls().map(call => call.params)).toEqual([
      { operation: "openPath", path: "/tmp/ideadock/entry.png" },
      { operation: "encode", handleId: "path-1", resizePlan: [], format: "png" },
      { operation: "openPath", path: "/tmp/ideadock/entry.png" },
      { operation: "encode", handleId: "path-2", resizePlan: [], format: "png" },
      { operation: "encode", handleId: "path-2", resizePlan: [], format: "png" },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ method: "POST", url: "http://127.0.0.1:1234/host/" + "a".repeat(64), async: false,
      body: JSON.stringify({ image: { dataUrl: `data:image/png;base64,${pngBase64}`, width: 200, height: 200 } }) });
    expect(nodeMethodCounts(calls).get - bufferRpcBaseline.get).toBe(3);
    expect(nodeMethodCounts(calls).call - bufferRpcBaseline.call).toBe(3);
    expect(cjsBufferDecodes).toEqual([{ kind: "buffer", bytes: png.byteLength, isBuffer: true }]);
    assertPluginGlobalBufferStillUsesNode(window, calls, globalBuffer);

    session.close();
    expect(fn("entry.png")).toBe(false);
    expect(imageCalls()).toHaveLength(5);
    expect(writes).toHaveLength(1);
    expect(window.__atoolsNodeModuleRequire).toBe(session);
  });

  it("Device Link's original image branch reads through openPath and writes only after an acknowledged image_write grant", async () => {
    const { electron, clipboard, calls, writes, installSession } = makeHarness();
    const repository = { listMessages: vi.fn(async () => [{ id: "message-1", attachments: [
      { path: "/tmp/device-link/attachment.png", mime: "image/png" },
    ] }]) };
    const consumer = deviceLinkConsumer(repository, electron.clipboard, electron.nativeImage);
    const imageCalls = () => calls.filter(call => call.method === "nativeImageTransform");
    expect(consumer.sha256).toBe("d8aa03db53052c5f6234e2f46cf9fec6dba4ca9d80fc5163ec02a734eabc254f");
    await expect(consumer.fn("message-1")).rejects.toMatchObject({ code: "ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE" });
    expect(imageCalls()).toHaveLength(0);
    expect(writes).toHaveLength(0);

    const session = installSession();
    expectCodecHelpersPrivate(session);
    const globalBuffer = (globalThis as any).window.Buffer;
    const bufferRpcBaseline = nodeMethodCounts(calls);
    expect(imageCalls()).toHaveLength(0);
    expect(writes).toHaveLength(0);
    await expect(consumer.fn("message-1")).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED" });
    expect(nodeMethodCounts(calls)).toEqual(bufferRpcBaseline);
    expect((globalThis as any).window.Buffer).toBe(globalBuffer);
    expect(imageCalls().map(call => call.params)).toEqual([
      { operation: "openPath", path: "/tmp/device-link/attachment.png" },
      { operation: "encode", handleId: "path-1", resizePlan: [], format: "png" },
    ]);
    expect(writes).toHaveLength(0);

    clipboard.install("image_write", "http://127.0.0.1:1234/host/" + "b".repeat(64));
    expect(writes).toHaveLength(0);
    await expect(consumer.fn("message-1")).resolves.toBe(true);
    expect(repository.listMessages).toHaveBeenCalledTimes(3);
    expect(imageCalls().map(call => call.params)).toEqual([
      { operation: "openPath", path: "/tmp/device-link/attachment.png" },
      { operation: "encode", handleId: "path-1", resizePlan: [], format: "png" },
      { operation: "openPath", path: "/tmp/device-link/attachment.png" },
      { operation: "encode", handleId: "path-2", resizePlan: [], format: "png" },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ method: "POST", url: "http://127.0.0.1:1234/host/" + "b".repeat(64), async: false,
      body: JSON.stringify({ image: { dataUrl: `data:image/png;base64,${pngBase64}`, width: 200, height: 200 } }) });
    expect(nodeMethodCounts(calls)).toEqual(bufferRpcBaseline);
    assertPluginGlobalBufferStillUsesNode((globalThis as any).window, calls, globalBuffer);

    session.close();
    await expect(consumer.fn("message-1")).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_SESSION_CLOSED" });
    expect(repository.listMessages).toHaveBeenCalledTimes(4);
    expect(imageCalls()).toHaveLength(4);
    expect(writes).toHaveLength(1);
  });
});
