import { describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { pluginElectronAdapterScript, createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";
import { makeNodeModuleRequire } from "../../src/lib/nodeModuleBridge";

const endpoint = "http://127.0.0.1:12345/host/" + "a".repeat(64);
const limit = 256 * 1024;
const envelopeLimit = 512 * 1024;

type Response = { status?: number; body: string };

function wire(bytes: Uint8Array) {
  return { base64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength };
}

function ok(result: unknown): Response {
  return { body: JSON.stringify({ ok: true, result }) };
}

function bridge(transport: (payload: Record<string, unknown>) => unknown, requestPermission = vi.fn()) {
  return createHostClipboardBridge(
    { instanceId: "buffer-test", endpoints: { read: endpoint } },
    requestPermission,
    (_endpoint, payload) => transport(payload),
  ) as ReturnType<typeof createHostClipboardBridge> & { readBuffer(format: string): Uint8Array };
}

function serializedRuntime(
  respond: (payload: Record<string, unknown>) => Response,
  authorizeOnOpen = true,
  nodeBuffer?: { from: (value: Uint8Array) => unknown; isBuffer: (value: unknown) => boolean },
) {
  const requests: Array<{ payload: Record<string, unknown>; asynchronous: boolean }> = [];
  const messages: unknown[] = [];
  const listeners: Array<(event: any) => void> = [];
  const parent = { postMessage: (message: unknown) => messages.push(message) };
  const window: any = {
    parent,
    require: (specifier: string) => specifier === "electron" ? { ipcRenderer: {} } : {},
    utools: { clipboard: {}, getAppName: () => "ATools", getAppVersion: () => "test" },
    console: { error: vi.fn() },
  };
  if (nodeBuffer) {
    window.__atoolsNodeModuleRequire = {
      createLocalBuffer: nodeBuffer.from,
      isLocalBuffer: nodeBuffer.isBuffer,
    };
  }
  class Xhr {
    status = 200;
    responseText = "";
    asynchronous = true;
    open(_method: string, _url: string, asynchronous: boolean) { this.asynchronous = asynchronous; }
    setRequestHeader() {}
    send(body: string) {
      const payload = JSON.parse(body) as Record<string, unknown>;
      requests.push({ payload, asynchronous: this.asynchronous });
      const response = respond(payload);
      this.status = response.status ?? 200;
      this.responseText = response.body;
    }
  }
  const config = {
    instanceId: "serialized-buffer",
    ...(authorizeOnOpen ? { endpoints: { read: endpoint } } : {}),
  };
  const hostScript = hostClipboardBridgeScript(config).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  new Function("window", "parent", "addEventListener", "XMLHttpRequest", "TextEncoder", hostScript)(
    window, parent, (_name: string, listener: (event: any) => void) => listeners.push(listener), Xhr, TextEncoder,
  );
  const adapterScript = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  new Function("window", adapterScript)(window);
  function installRead(endpointValue: string | null = endpoint) {
    listeners[0]({ source: parent, data: {
      __atools_host_clipboard_session__: true,
      instanceId: "serialized-buffer",
      access: "read",
      endpoint: endpointValue ?? undefined,
    } });
  }
  return { window, clipboard: window.require("electron").clipboard, messages, requests, installRead };
}

describe("binary clipboard format bridge", () => {
  it("preserves arbitrary bytes, empty buffers, and the exact 256 KiB limit", () => {
    const arbitrary = Uint8Array.from([0, 255, 128, 1, 0, 239, 191, 192]);
    const payloads: unknown[] = [wire(arbitrary), wire(new Uint8Array()), wire(new Uint8Array(limit).map((_, index) => index & 255))];
    const requests: Record<string, unknown>[] = [];
    const current = bridge((payload) => {
      requests.push(payload);
      return payloads.shift();
    });

    expect([...current.readBuffer("com.example.binary")]).toEqual([...arbitrary]);
    expect([...current.readBuffer("empty format")]).toEqual([]);
    const max = current.readBuffer("x".repeat(256));
    expect(max.byteLength).toBe(limit);
    expect(max[0]).toBe(0);
    expect(max[255]).toBe(255);
    expect(requests).toEqual([
      { operation: "readFormatBuffer", format: "com.example.binary" },
      { operation: "readFormatBuffer", format: "empty format" },
      { operation: "readFormatBuffer", format: "x".repeat(256) },
    ]);
  });

  it("rejects malformed wire objects, noncanonical base64, mismatched lengths, and over-limit bytes", () => {
    const invalid = [
      { byteLength: 0 },
      { base64: "" },
      { base64: "", byteLength: 1 },
      { base64: "A", byteLength: 0 },
      { base64: "AA=", byteLength: 1 },
      { base64: "AB==", byteLength: 1 },
      { base64: "AAB=", byteLength: 2 },
      { base64: "AA-_", byteLength: 3 },
      { base64: "AA==\n", byteLength: 1 },
      { base64: "AA==", byteLength: Number.MAX_SAFE_INTEGER + 1 },
      { base64: "AA==", byteLength: 2 },
      { base64: "", byteLength: limit + 1 },
      { ...wire(new Uint8Array(limit + 1)), byteLength: limit },
      { base64: "", byteLength: 0, extra: true },
    ];
    for (const result of invalid) {
      expect(() => bridge(() => result).readBuffer("custom format")).toThrow(/RESPONSE|LIMIT/);
    }
    expect(() => bridge(() => ({ base64: "A".repeat(envelopeLimit), byteLength: 0 }))
      .readBuffer("custom format")).toThrow("LIMIT");
  });

  it("recovers on the same bridge after one invalid response", () => {
    const result = vi.fn()
      .mockReturnValueOnce({ base64: "AA=", byteLength: 1 })
      .mockReturnValueOnce(wire(Uint8Array.from([0, 0xff])));
    const current = bridge(() => result());
    expect(() => current.readBuffer("custom")).toThrow("RESPONSE");
    expect([...current.readBuffer("custom")]).toEqual([0, 255]);
    expect(result).toHaveBeenCalledTimes(2);
  });

  it("validates format names and Electron readBuffer arity without coercion", () => {
    const readBuffer = vi.fn(() => Uint8Array.from([3]));
    const createBuffer = vi.fn((bytes: Uint8Array) => Buffer.from(bytes));
    const electron = createPluginElectronAdapter({
      application: { name: "ATools", version: "test" },
      clipboard: { readText: () => "", writeText: () => {}, readBuffer } as any,
      createBuffer,
    });
    const clipboard = electron.clipboard as any;
    const coercion = { toString: vi.fn(() => "bad") };

    expect([...clipboard.readBuffer("format with spaces")]).toEqual([3]);
    expect(readBuffer).toHaveBeenCalledWith("format with spaces");
    expect(createBuffer).toHaveBeenCalledOnce();
    expect(() => clipboard.readBuffer()).toThrow("exactly one format");
    expect(() => clipboard.readBuffer("format", "clipboard")).toThrow("exactly one format");
    for (const invalid of ["", "x".repeat(257), "bad\n", "bad\r", "é", coercion]) {
      expect(() => clipboard.readBuffer(invalid)).toThrow("printable ASCII");
    }
    expect(coercion.toString).not.toHaveBeenCalled();
    expect(readBuffer).toHaveBeenCalledTimes(1);
    expect(() => createPluginElectronAdapter({ application: { name: "ATools", version: "test" } })
      .clipboard.readBuffer("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    expect(() => createPluginElectronAdapter({
      application: { name: "ATools", version: "test" },
      clipboard: { readText: () => "", writeText: () => {}, readBuffer } as any,
    }).clipboard.readBuffer("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
  });

  it("requires the host Buffer factory and rejects non-Buffer factory results", () => {
    const bytes = Uint8Array.from([0, 1, 255]);
    const current = createPluginElectronAdapter({
      application: { name: "ATools", version: "test" },
      clipboard: { readText: () => "", writeText: () => {}, readBuffer: () => bytes } as any,
    });
    expect(() => (current.clipboard as any).readBuffer("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    const invalid = createPluginElectronAdapter({
      application: { name: "ATools", version: "test" },
      clipboard: { readText: () => "", writeText: () => {}, readBuffer: () => bytes } as any,
      createBuffer: (value) => value,
    });
    expect(() => (invalid.clipboard as any).readBuffer("format")).toThrow("local Buffer");
  });

  it("serializes the host and Electron adapters and returns a browser Buffer", () => {
    const raw = Uint8Array.from([0, 255, 65, 0, 128]);
    const runtime = serializedRuntime((payload) => {
      expect(payload).toEqual({ operation: "readFormatBuffer", format: "public.binary" });
      return ok(wire(raw));
    });
    const result = runtime.clipboard.readBuffer("public.binary");
    expect([...result]).toEqual([...raw]);
    expect(result.toString("hex")).toBe("00ff410080");
    expect(runtime.requests).toEqual([{
      payload: { operation: "readFormatBuffer", format: "public.binary" },
      asynchronous: false,
    }]);
  });

  it("returns a Buffer recognized by the active Node codec when it is available", () => {
    const raw = Uint8Array.from([0, 0xff, 4]);
    const values = new WeakSet<object>();
    const isLocalBuffer = vi.fn((value: unknown) => !!value && typeof value === "object" && values.has(value as object));
    const nodeBuffer = {
      from: (bytes: Uint8Array) => {
        const value = Buffer.from(bytes);
        values.add(value);
        return value;
      },
      isBuffer: isLocalBuffer,
    };
    const runtime = serializedRuntime(() => ok(wire(raw)), true, nodeBuffer);
    const result = runtime.clipboard.readBuffer("custom");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect([...result]).toEqual([...raw]);
    expect(isLocalBuffer).toHaveBeenCalledWith(result);
  });

  it("uses the production Node module codec identity without invoking Node transport", () => {
    const requestSync = vi.fn(() => { throw new Error("Unexpected Node sync RPC"); });
    const requestAsync = vi.fn(async () => { throw new Error("Unexpected Node async RPC"); });
    const session = makeNodeModuleRequire(
      { endpoint: "http://127.0.0.1:1234/session" },
      { requestSync, requestAsync },
    );
    let result: unknown;
    try {
      const runtime = serializedRuntime(
        () => ok(wire(Uint8Array.from([0, 0xff, 0x41, 0, 7]))),
        true,
        { from: session.createLocalBuffer!, isBuffer: session.isLocalBuffer! },
      );
      result = runtime.clipboard.readBuffer("codec identity");
    } finally {
      session.close();
    }
    expect(session.isLocalBuffer!(result)).toBe(true);
    expect([...result as Uint8Array]).toEqual([0, 255, 65, 0, 7]);
    expect((result as Uint8Array & { toString(encoding: string): string }).toString("hex")).toBe("00ff410007");
    expect(requestSync).not.toHaveBeenCalled();
    expect(requestAsync).not.toHaveBeenCalled();
  });

  it("does not replay the first unauthorized read, then observes revoke and close", () => {
    const raw = Uint8Array.from([7, 0, 255]);
    const runtime = serializedRuntime(() => ok(wire(raw)), false);
    expect(() => runtime.clipboard.readBuffer("private format")).toThrow("PERMISSION_REQUIRED");
    expect(runtime.messages).toEqual([{
      __atools_host_clipboard_open__: true,
      instanceId: "serialized-buffer",
      access: "read",
    }]);
    expect(runtime.requests).toEqual([]);

    runtime.installRead();
    expect(runtime.requests).toEqual([]);
    expect([...runtime.clipboard.readBuffer("private format")]).toEqual([...raw]);
    expect(runtime.requests).toHaveLength(1);
    runtime.installRead(null);
    expect(() => runtime.clipboard.readBuffer("private format")).toThrow("PERMISSION_REQUIRED");
    runtime.installRead();
    runtime.window.__atoolsHostClipboard.close();
    expect(() => runtime.clipboard.readBuffer("private format")).toThrow("CLOSED");
  });
});
