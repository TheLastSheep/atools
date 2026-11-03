import { describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { createPluginElectronAdapter, pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";

const endpoint = "http://127.0.0.1:12345/host/" + "f".repeat(64);
const application = { name: "ATools", version: "test" };

type WireResponse = { status?: number; body: string };

function mountClipboardRuntime(
  respond: (payload: Record<string, unknown>) => WireResponse,
  authorizeOnOpen = true,
) {
  const openMessages: unknown[] = [];
  const requests: Array<{ method: string; url: string; asynchronous: boolean; payload: Record<string, unknown> }> = [];
  const listeners: Array<(event: any) => void> = [];
  const parent = { postMessage: (message: unknown) => openMessages.push(message) };
  const broker = { on: vi.fn() };
  const window: any = {
    require: (specifier: string) => specifier === "electron" ? { ipcRenderer: broker } : {},
    console: { error: vi.fn() },
    parent,
    utools: {
      clipboard: {},
      getAppName: () => application.name,
      getAppVersion: () => application.version,
    },
  };
  class Xhr {
    status = 200;
    responseText = "";
    method = "";
    url = "";
    asynchronous = true;
    open(method: string, url: string, asynchronous: boolean) {
      this.method = method;
      this.url = url;
      this.asynchronous = asynchronous;
    }
    setRequestHeader() {}
    send(body: string) {
      const payload = JSON.parse(body) as Record<string, unknown>;
      requests.push({ method: this.method, url: this.url, asynchronous: this.asynchronous, payload });
      const response = respond(payload);
      this.status = response.status ?? 200;
      this.responseText = response.body;
    }
  }
  const clipboardConfig: any = {
    instanceId: "format-fixture",
    ...(authorizeOnOpen ? { endpoints: { read: endpoint } } : {}),
  };
  const hostScript = hostClipboardBridgeScript(clipboardConfig).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  new Function("window", "parent", "addEventListener", "XMLHttpRequest", "TextEncoder", hostScript)(
    window,
    parent,
    (_name: string, listener: (event: any) => void) => listeners.push(listener),
    Xhr,
    TextEncoder,
  );
  const adapterScript = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  new Function("window", adapterScript)(window);
  const electron = window.require("electron");
  function installRead() {
    listeners[0]({ source: parent, data: {
      __atools_host_clipboard_session__: true,
      instanceId: "format-fixture",
      access: "read",
      endpoint,
    } });
  }
  return { window, electron, openMessages, requests, installRead };
}

function ok(result: unknown): WireResponse {
  return { body: JSON.stringify({ ok: true, result }) };
}

describe("Electron custom clipboard formats", () => {
  it("routes each current format through the synchronous read session without caching", () => {
    const runtime = mountClipboardRuntime((payload) => {
      if (payload.operation === "hasFormat") return ok(payload.format === "public.file-url");
      return ok("read:" + payload.format);
    });
    const clipboard = runtime.electron.clipboard;

    expect(clipboard.has("public.file-url")).toBe(true);
    expect(clipboard.read("public.file-url")).toBe("read:public.file-url");
    expect(clipboard.has("HTML Format", "clipboard")).toBe(false);
    expect(clipboard.read("HTML Format")).toBe("read:HTML Format");
    expect(clipboard.has("public.file-url") instanceof Promise).toBe(false);
    expect(clipboard.read("public.file-url") instanceof Promise).toBe(false);
    expect(runtime.requests).toEqual([
      { method: "POST", url: endpoint, asynchronous: false, payload: { operation: "hasFormat", format: "public.file-url" } },
      { method: "POST", url: endpoint, asynchronous: false, payload: { operation: "readFormat", format: "public.file-url" } },
      { method: "POST", url: endpoint, asynchronous: false, payload: { operation: "hasFormat", format: "HTML Format" } },
      { method: "POST", url: endpoint, asynchronous: false, payload: { operation: "readFormat", format: "HTML Format" } },
      { method: "POST", url: endpoint, asynchronous: false, payload: { operation: "hasFormat", format: "public.file-url" } },
      { method: "POST", url: endpoint, asynchronous: false, payload: { operation: "readFormat", format: "public.file-url" } },
    ]);
  });

  it("requests read permission once without carrying or replaying a format, and fails after close", () => {
    const runtime = mountClipboardRuntime(() => ok("file:///tmp/fresh.txt"), false);
    const clipboard = runtime.electron.clipboard;

    expect(() => clipboard.has("public.file-url")).toThrow("PERMISSION_REQUIRED");
    expect(() => clipboard.read("public.file-url")).toThrow("PERMISSION_REQUIRED");
    expect(runtime.openMessages).toEqual([{
      __atools_host_clipboard_open__: true,
      instanceId: "format-fixture",
      access: "read",
    }]);
    expect(runtime.requests).toEqual([]);

    runtime.installRead();
    expect(runtime.requests).toEqual([]);
    expect(clipboard.read("public.file-url")).toBe("file:///tmp/fresh.txt");
    expect(runtime.requests).toHaveLength(1);
    runtime.window.__atoolsHostClipboard.close();
    expect(() => clipboard.read("public.file-url")).toThrow("CLOSED");
  });

  it("enforces Electron argument counts, supported selection, and printable ASCII formats", () => {
    const hasFormat = vi.fn(() => true);
    const readFormat = vi.fn(() => "payload");
    const electron = createPluginElectronAdapter({
      application,
      clipboard: { readText: () => "", writeText: () => {}, hasFormat, readFormat },
    });
    const clipboard = electron.clipboard;
    const coercion = { toString: vi.fn(() => "coerced") };

    expect(clipboard.has("public.file-url")).toBe(true);
    expect(clipboard.has("x".repeat(256))).toBe(true);
    expect(clipboard.has("format with spaces", undefined)).toBe(true);
    expect(clipboard.has("format with spaces", "clipboard")).toBe(true);
    expect(clipboard.read("public.file-url")).toBe("payload");
    expect(() => clipboard.has()).toThrow("expects a format");
    expect(() => clipboard.has("format", "clipboard", "extra")).toThrow("expects a format");
    expect(() => clipboard.has("format", "selection")).toThrow("Selection clipboard is unavailable");
    expect(() => clipboard.has("format", null)).toThrow("Selection clipboard is unavailable");
    expect(() => clipboard.read()).toThrow("exactly one format");
    expect(() => clipboard.read("format", "clipboard")).toThrow("exactly one format");
    for (const invalid of ["", "x".repeat(257), "has\nnewline", "public.file-url\n", "format\r", "format\u2028", "format\u2029", "é", coercion]) {
      expect(() => clipboard.has(invalid)).toThrow("printable ASCII");
      expect(() => clipboard.read(invalid)).toThrow("printable ASCII");
    }
    expect(coercion.toString).not.toHaveBeenCalled();
    expect(hasFormat.mock.calls).toEqual([["public.file-url"], ["x".repeat(256)], ["format with spaces"], ["format with spaces"]]);
    expect(readFormat.mock.calls).toEqual([["public.file-url"]]);

    const directHost = mountClipboardRuntime(() => ok(true));
    const hostCoercion = { toString: vi.fn(() => "coerced") };
    expect(() => directHost.window.__atoolsHostClipboard.hasFormat(hostCoercion)).toThrow("printable ASCII");
    for (const invalid of ["public.file-url\n", "format\r", "format\u2028", "format\u2029"]) {
      expect(() => directHost.window.__atoolsHostClipboard.readFormat(invalid)).toThrow("printable ASCII");
    }
    expect(hostCoercion.toString).not.toHaveBeenCalled();
    expect(directHost.requests).toEqual([]);
  });

  it("rejects invalid host return types and reports unsupported when format methods are absent", () => {
    const invalidHas = createPluginElectronAdapter({
      application,
      clipboard: { readText: () => "", writeText: () => {}, hasFormat: () => "true" as unknown as boolean },
    });
    const invalidRead = createPluginElectronAdapter({
      application,
      clipboard: { readText: () => "", writeText: () => {}, readFormat: () => Promise.resolve("payload") as unknown as string },
    });
    expect(() => invalidHas.clipboard.has("format")).toThrow("Invalid clipboard format availability response");
    expect(() => invalidRead.clipboard.read("format")).toThrow("Invalid clipboard format data response");

    const missing = createPluginElectronAdapter({ application });
    const partial = createPluginElectronAdapter({ application, clipboard: { readText: () => "", writeText: () => {} } });
    expect(() => missing.clipboard.has("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    expect(() => missing.clipboard.read("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    expect(() => partial.clipboard.has("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    expect(() => partial.clipboard.read("format")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
  });

  it("validates JSON envelopes and operation results before exposing data", () => {
    const malformed = mountClipboardRuntime(() => ({ body: "{" }));
    expect(() => malformed.electron.clipboard.read("format")).toThrow("Invalid clipboard response");

    const rejected = mountClipboardRuntime(() => ({ body: JSON.stringify({ ok: false, error: { message: "format denied" } }) }));
    expect(() => rejected.electron.clipboard.read("format")).toThrow("format denied");

    const invalidBoolean = mountClipboardRuntime(() => ok("true"));
    expect(() => invalidBoolean.electron.clipboard.has("format")).toThrow("Invalid clipboard format availability response");

    const invalidString = mountClipboardRuntime(() => ok(null));
    expect(() => invalidString.electron.clipboard.read("format")).toThrow("Invalid clipboard format data response");

    const closedSession = mountClipboardRuntime(() => ({ status: 410, body: "{}" }));
    expect(() => closedSession.electron.clipboard.read("format")).toThrow("会话已关闭");
  });

  it("limits the full UTF-8 JSON envelope to 512 KiB", () => {
    const maxBytes = 512 * 1024;
    const encoder = new TextEncoder();
    const emptyEnvelopeBytes = encoder.encode(JSON.stringify({ ok: true, result: "" })).byteLength;
    const fittingCount = Math.floor((maxBytes - emptyEnvelopeBytes) / encoder.encode("�").byteLength);
    const fitting = "�".repeat(fittingCount);
    const overLimit = "�".repeat(fittingCount + 1);
    expect(encoder.encode(JSON.stringify({ ok: true, result: fitting })).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(encoder.encode(JSON.stringify({ ok: true, result: overLimit })).byteLength).toBeGreaterThan(maxBytes);

    const accepted = mountClipboardRuntime(() => ok(fitting));
    expect(accepted.electron.clipboard.read("public.file-url")).toBe(fitting);

    const rejected = mountClipboardRuntime(() => ok(overLimit));
    expect(() => rejected.electron.clipboard.read("public.file-url")).toThrow("Clipboard format response exceeds 512 KiB");
  });

  it("enforces the JSON envelope limit for direct transports without imposing a 256 KiB string cap", () => {
    const encoder = new TextEncoder();
    const invalidUtf8ReplacementExpansion = "�".repeat(100 * 1024);
    const replacementEnvelope = JSON.stringify({ ok: true, result: invalidUtf8ReplacementExpansion });
    expect(encoder.encode(invalidUtf8ReplacementExpansion).byteLength).toBeGreaterThan(256 * 1024);
    expect(encoder.encode(replacementEnvelope).byteLength).toBeLessThan(512 * 1024);

    const replacementBridge = createHostClipboardBridge(
      { instanceId: "direct-transport", endpoints: { read: endpoint } },
      vi.fn(),
      vi.fn(() => invalidUtf8ReplacementExpansion),
    );
    expect(replacementBridge.readFormat("public.file-url")).toBe(invalidUtf8ReplacementExpansion);

    const quoteAndNulExpansion = "\0".repeat(80 * 1024) + "\"".repeat(40 * 1024);
    expect(encoder.encode(quoteAndNulExpansion).byteLength).toBeLessThan(256 * 1024);
    expect(encoder.encode(JSON.stringify({ ok: true, result: quoteAndNulExpansion })).byteLength).toBeGreaterThan(512 * 1024);
    const oversizedBridge = createHostClipboardBridge(
      { instanceId: "direct-transport-oversized", endpoints: { read: endpoint } },
      vi.fn(),
      vi.fn(() => quoteAndNulExpansion),
    );
    expect(() => oversizedBridge.readFormat("public.file-url")).toThrow("Clipboard format response exceeds 512 KiB");
  });
});
