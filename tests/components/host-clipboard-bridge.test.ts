import { describe, it, expect, vi } from "vitest";
import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { createHostClipboardController } from "../../src/lib/hostClipboardController";
import { validatePluginClipboardImagePayload } from "../../src/lib/pluginNativeImage";
const readEndpoint = "http://127.0.0.1:12345/host/" + "a".repeat(64);
const writeEndpoint = "http://127.0.0.1:12345/host/" + "b".repeat(64);
const imageEndpoint = "http://127.0.0.1:12345/host/" + "c".repeat(64);
const contentWriteEndpoint = "http://127.0.0.1:12345/host/" + "d".repeat(64);
const pasteEndpoint = "http://127.0.0.1:12345/host/" + "e".repeat(64);
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7w8AAAAASUVORK5CYII=", "base64");
const tinyImage = { dataUrl: `data:image/png;base64,${tinyPng.toString("base64")}`, width: 1, height: 1 };

describe("exact synchronous clipboard host transport", () => {
  it("shares one bounded permission promise per scope and resolves consumers without replaying payloads", async () => {
    const request = vi.fn(), transport = vi.fn();
    const bridge = createHostClipboardBridge({ instanceId: "shared-waiters" }, request, transport);
    const accesses = ["read", "write", "image", "image_write", "content_write", "paste", "history_read", "history_delete"] as const;
    await expect(bridge.ensureAccess("unbounded-scope" as any)).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_CONFIG" });
    const first = accesses.map(access => bridge.ensureAccess(access));
    const second = accesses.map(access => bridge.ensureAccess(access));
    first.forEach((promise, index) => expect(second[index]).toBe(promise));
    expect(request.mock.calls).toEqual(accesses.map(access => [access]));
    expect(transport).not.toHaveBeenCalled();

    bridge.install("history_read", readEndpoint);
    await expect(Promise.all([first[6], second[6]])).resolves.toEqual([undefined, undefined]);
    expect(transport).not.toHaveBeenCalled();
    expect(() => bridge.writeText("private body stays local")).toThrow("PERMISSION_REQUIRED");
    expect(transport).not.toHaveBeenCalled();
    bridge.close();
    const rejected = await Promise.allSettled([first[0], first[1], first[2], first[3], first[4], first[5], first[7]]);
    expect(rejected.every(result => result.status === "rejected"
      && (result.reason as Error & { code?: string }).code === "ERR_ATOOLS_HOST_CLIPBOARD_CLOSED")).toBe(true);
  });
  it("allows retry after denial and rejects all shared consumers on close", async () => {
    const request = vi.fn();
    const bridge = createHostClipboardBridge({ instanceId: "retry-waiters" }, request, vi.fn());
    const denied = [bridge.ensureAccess("history_delete"), bridge.ensureAccess("history_delete")];
    expect(denied[0]).toBe(denied[1]);
    bridge.install("history_delete");
    await expect(Promise.all(denied)).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED" });

    const retry = [bridge.ensureAccess("history_delete"), bridge.ensureAccess("history_delete")];
    expect(retry[0]).toBe(retry[1]);
    expect(request.mock.calls).toEqual([["history_delete"], ["history_delete"]]);
    bridge.close();
    await expect(Promise.all(retry)).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_CLOSED" });
  });
  it("requests only the used direction, never sends private text or automatically retries", () => {
    const request = vi.fn(), transport = vi.fn();
    const bridge = createHostClipboardBridge({ instanceId: "generation" }, request, transport);
    expect(request).not.toHaveBeenCalled();
    expect(() => bridge.writeText("PRIVATE正文")).toThrow("PERMISSION_REQUIRED");
    expect(() => bridge.writeText("ANOTHER_PRIVATE_TEXT")).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([["write"]]);
    expect(transport).not.toHaveBeenCalled();
    bridge.install("write", writeEndpoint);
    expect(transport).not.toHaveBeenCalled();
    bridge.writeText("");
    expect(transport.mock.calls).toEqual([[writeEndpoint, { text: "" }]]);
    expect(() => bridge.readText()).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([["write"], ["read"]]);
  });
  it("keeps audited content-write and explicit paste on distinct host endpoints", () => {
    const transport = vi.fn(() => null);
    const request = vi.fn();
    const bridge = createHostClipboardBridge({ instanceId: "write-paste", endpoints: {
      content_write: contentWriteEndpoint, paste: pasteEndpoint,
    } }, request, transport);
    bridge.writeContent({ kind: "text", text: "copy-only" });
    bridge.paste({ kind: "files", paths: ["/tmp/a", "/tmp/b"] });
    expect(transport.mock.calls).toEqual([
      [contentWriteEndpoint, { kind: "text", text: "copy-only" }],
      [pasteEndpoint, { kind: "files", paths: ["/tmp/a", "/tmp/b"] }],
    ]);
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves whitespace and empty strings synchronously, fresh on every call", () => {
    let text = "";
    const transport = vi.fn((endpoint, payload) => {
      if (endpoint === readEndpoint) return text;
      text = payload.text; return null;
    });
    const bridge = createHostClipboardBridge({ instanceId: "generation", endpoints: { read: readEndpoint, write: writeEndpoint } }, vi.fn(), transport);
    for (const value of ["", " \t\r\n", "  原文🧰\n", "a\0b"]) {
      expect(bridge.writeText(value)).toBeUndefined();
      expect(bridge.readText()).toBe(value);
      text += "fresh";
      expect(bridge.readText()).toBe(value + "fresh");
    }
    expect(transport).toHaveBeenCalledTimes(12);
    expect(() => bridge.readText("selection")).toThrow("UNSUPPORTED");
    expect(() => bridge.writeText("界".repeat(90000))).toThrow("LIMIT");
    bridge.close();
    expect(() => bridge.readText()).toThrow("CLOSED");
  });
  it("uses a distinct image permission, validates the bounded payload, and never retries after approval", () => {
    const request = vi.fn(), transport = vi.fn(() => tinyImage);
    const bridge = createHostClipboardBridge({ instanceId: "image-generation" }, request, transport, validatePluginClipboardImagePayload);
    expect(() => bridge.readImage()).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([["image"]]);
    expect(transport).not.toHaveBeenCalled();
    bridge.install("image", imageEndpoint);
    expect(transport).not.toHaveBeenCalled();
    expect(bridge.readImage()).toEqual(tinyImage);
    expect(transport.mock.calls).toEqual([[imageEndpoint, { format: "image" }]]);
    expect(() => bridge.readImage("selection")).toThrow("UNSUPPORTED");
    bridge.close();
    expect(() => bridge.readImage()).toThrow("CLOSED");
  });
  it("executes the serialized production bridge builder for image access", () => {
    const events: any[] = [], listeners: any[] = [];
    const parent = { postMessage: (message: unknown) => events.push(message) };
    const window: any = { utools: { clipboard: {} } };
    const response = JSON.stringify({ ok: true, result: tinyImage });
    class Xhr {
      status = 200; responseText = response;
      open(method: string, endpoint: string, async: boolean) { expect([method, endpoint, async]).toEqual(["POST", imageEndpoint, false]); }
      setRequestHeader() {}
      send(body: string) { expect(JSON.parse(body)).toEqual({ format: "image" }); }
    }
    const script = hostClipboardBridgeScript({ instanceId: "serialized-image" }).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "parent", "addEventListener", "XMLHttpRequest", script)(window, parent, (_: string, callback: unknown) => listeners.push(callback), Xhr);
    expect(() => window.__atoolsHostClipboard.readImage()).toThrow("PERMISSION_REQUIRED");
    expect(events).toEqual([{ __atools_host_clipboard_open__: true, instanceId: "serialized-image", access: "image" }]);
    listeners[0]({ source: parent, data: { __atools_host_clipboard_session__: true, instanceId: "serialized-image", access: "image", endpoint: imageEndpoint } });
    expect(window.__atoolsHostClipboard.readImage()).toEqual(tinyImage);
  });
  it("executes serialized content_write and paste access with their exact payloads and separate endpoints", () => {
    const events: any[] = [], listeners: any[] = [], requests: Array<{ endpoint: string; body: unknown }> = [];
    const parent = { postMessage: (message: unknown) => events.push(message) };
    const window: any = { utools: { clipboard: {} } };
    class Xhr {
      status = 200;
      responseText = JSON.stringify({ ok: true, result: null });
      endpoint = '';
      open(method: string, endpoint: string, async: boolean) {
        expect([method, async]).toEqual(['POST', false]); this.endpoint = endpoint;
      }
      setRequestHeader() {}
      send(body: string) { requests.push({ endpoint: this.endpoint, body: JSON.parse(body) }); }
    }
    const script = hostClipboardBridgeScript({ instanceId: 'serialized-write-paste' })
      .replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    new Function('window', 'parent', 'addEventListener', 'XMLHttpRequest', script)(
      window, parent, (_: string, listener: unknown) => listeners.push(listener), Xhr,
    );
    expect(() => window.__atoolsHostClipboard.writeContent({ kind: 'text', text: 'copy' })).toThrow('PERMISSION_REQUIRED');
    expect(() => window.__atoolsHostClipboard.paste({ kind: 'text', text: 'paste' })).toThrow('PERMISSION_REQUIRED');
    expect(events).toEqual([
      { __atools_host_clipboard_open__: true, instanceId: 'serialized-write-paste', access: 'content_write' },
      { __atools_host_clipboard_open__: true, instanceId: 'serialized-write-paste', access: 'paste' },
    ]);
    listeners[0]({ source: parent, data: { __atools_host_clipboard_session__: true, instanceId: 'serialized-write-paste', access: 'content_write', endpoint: contentWriteEndpoint } });
    listeners[0]({ source: parent, data: { __atools_host_clipboard_session__: true, instanceId: 'serialized-write-paste', access: 'paste', endpoint: pasteEndpoint } });
    window.__atoolsHostClipboard.writeContent({ kind: 'text', text: 'copy' });
    window.__atoolsHostClipboard.paste({ kind: 'files', paths: ['/tmp/a', '/tmp/b'] });
    expect(requests).toEqual([
      { endpoint: contentWriteEndpoint, body: { kind: 'text', text: 'copy' } },
      { endpoint: pasteEndpoint, body: { kind: 'files', paths: ['/tmp/a', '/tmp/b'] } },
    ]);
  });
  it("rejects an oversized raw image envelope before JSON parsing even when the result is empty", () => {
    const window: any = { utools: { clipboard: {} } }, parent = { postMessage() {} };
    const listeners: any[] = [];
    class Xhr {
      status = 200;
      responseText = JSON.stringify({ ok: true, result: null }) + " ".repeat(700 * 1024);
      open() {}
      setRequestHeader() {}
      send(body: string) { expect(JSON.parse(body)).toEqual({ format: "image" }); }
    }
    const script = hostClipboardBridgeScript({ instanceId: "oversized-image", endpoints: { image: imageEndpoint } })
      .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "parent", "addEventListener", "XMLHttpRequest", "TextEncoder", script)(
      window, parent, (_: string, listener: unknown) => listeners.push(listener), Xhr, TextEncoder,
    );
    expect(() => window.__atoolsHostClipboard.readImage()).toThrow("700 KiB");
  });
  it("rejects non-loopback credentials and malformed values rather than fabricating success", () => {
    for (const endpoint of ["https://example.com/host/" + "a".repeat(64), readEndpoint.replace("host", "node"), "http://localhost:12345/host/" + "a".repeat(64)]) {
      expect(() => createHostClipboardBridge({ instanceId: "g", endpoints: { read: endpoint } }, vi.fn())).toThrow("CONFIG");
    }
    const bridge = createHostClipboardBridge({ instanceId: "g", endpoints: { read: readEndpoint, write: writeEndpoint } }, vi.fn(), () => false);
    expect(() => bridge.readText()).toThrow("RESPONSE");
    expect(() => bridge.writeText("x")).toThrow("RESPONSE");
  });
  it("keeps history read and delete in distinct validated permission sessions", () => {
    const request = vi.fn(), transport = vi.fn((endpoint: string, _payload: Record<string, unknown>) =>
      endpoint === readEndpoint ? { items: [], total: 0, page: 1, pageSize: 10 }
        : _payload.operation === "clear" ? { deletedCount: 2 } : { deleted: true });
    const bridge = createHostClipboardBridge({ instanceId: "history-generation" }, request, transport);
    expect(() => bridge.historyRead({ operation: "list", page: 1, pageSize: 10 })).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([["history_read"]]);
    expect(transport).not.toHaveBeenCalled();
    bridge.install("history_read", readEndpoint);
    expect(bridge.historyRead({ operation: "list", page: 1, pageSize: 10 }))
      .toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    expect(() => bridge.historyRead({ operation: "getContent", id: "bad", extra: "ignored" })).toThrow("ARGUMENT");
    expect(transport.mock.calls).toEqual([[readEndpoint, { operation: "list", page: 1, pageSize: 10 }]]);
    expect(() => bridge.historyDelete({ operation: "clear" })).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([["history_read"], ["history_delete"]]);
    bridge.install("history_delete", writeEndpoint);
    expect(bridge.historyDelete({ operation: "delete", id: "clip-0123456789abcdef" })).toEqual({ deleted: true });
    expect(transport.mock.calls[1]).toEqual([writeEndpoint, { operation: "delete", id: "clip-0123456789abcdef" }]);
    for (const id of ["clip-image-0123456789abcdef", "clip-file-0123456789abcdef"]) {
      expect(bridge.historyDelete({ operation: "delete", id })).toEqual({ deleted: true });
    }
    for (const type of ["all", "text", "image", "file"]) {
      expect(bridge.historyDelete({ operation: "clear", type })).toEqual({ deletedCount: 2 });
    }
    expect(bridge.historyDelete({ operation: "clear" })).toEqual({ deletedCount: 2 });
    expect(() => bridge.historyDelete({ operation: "clear", id: "extra" })).toThrow("ARGUMENT");
    expect(() => bridge.historyDelete({ operation: "clear", type: "html" })).toThrow("ARGUMENT");
    expect(() => bridge.historyDelete({ operation: "clear", type: "image", extra: true })).toThrow("ARGUMENT");
    expect(() => bridge.historyDelete({ operation: "delete", id: "clip-image-0123456789abcdef", extra: true })).toThrow("ARGUMENT");
    bridge.close();
    expect(() => bridge.historyRead({ operation: "list", page: 1, pageSize: 10 })).toThrow("CLOSED");
  });
  it("serializes the history validator with its exact session-bound request", () => {
    const requests: Array<{ endpoint: string; body: string }> = [];
    const window: any = { utools: { clipboard: {} } }, parent = { postMessage() {} };
    class Xhr {
      status = 200;
      responseText = JSON.stringify({ ok: true, result: { items: [], total: 0, page: 1, pageSize: 10 } });
      endpoint = '';
      open(method: string, endpoint: string, async: boolean) { expect([method, async]).toEqual(['POST', false]); this.endpoint = endpoint; }
      setRequestHeader() {}
      send(body: string) { requests.push({ endpoint: this.endpoint, body }); }
    }
    const script = hostClipboardBridgeScript({ instanceId: 'serialized-history', endpoints: { history_read: readEndpoint } })
      .replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    new Function('window', 'parent', 'addEventListener', 'XMLHttpRequest', 'TextEncoder', script)(
      window, parent, () => {}, Xhr, TextEncoder,
    );
    expect(window.__atoolsHostClipboard.historyRead({ operation: 'list', page: 1, pageSize: 10 }))
      .toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    expect(requests).toEqual([{ endpoint: readEndpoint, body: '{"operation":"list","page":1,"pageSize":10}' }]);
    expect(() => window.__atoolsHostClipboard.historyRead({ operation: 'clear' })).toThrow('ARGUMENT');
  });
  it("serializes its factory and binds endpoint delivery to the parent and exact instance", () => {
    const script = hostClipboardBridgeScript({ instanceId: "generation" });
    const messages: any[] = [], listeners: any[] = [];
    const parent = { postMessage: (...args: any[]) => messages.push(args) };
    const window: any = { utools: { clipboard: {} } };
    new Function("window", "parent", "addEventListener", script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""))(window, parent, (_: string, callback: any) => listeners.push(callback));
    expect(() => window.__atoolsHostClipboard.readText()).toThrow("PERMISSION_REQUIRED");
    expect(messages[0][0]).toEqual({ __atools_host_clipboard_open__: true, instanceId: "generation", access: "read" });
    for (const [source, instanceId] of [[{}, "generation"], [parent, "old"]]) {
      listeners[0]({ source, data: { __atools_host_clipboard_session__: true, instanceId, access: "read", endpoint: readEndpoint } });
      expect(() => window.__atoolsHostClipboard.readText()).toThrow("PERMISSION_REQUIRED");
    }
  });
});

describe("clipboard authorization lifetime controller", () => {
  it("prepares only saved grants without opening a prompt and deduplicates an explicit scope request", async () => {
    const calls: any[] = [], status = vi.fn();
    let release!: () => void;
    const waiting = new Promise<void>((r) => { release = r; });
    const invoke: any = vi.fn(async (command, args) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") return args.requestPermission ? { permission_required: true, runId: "run", tool: "tool" } : { unavailable: true };
      if (command === "get_task_run") return { id: "run", capabilityId: "tool", initiator: { clientId: "atools-ui" }, status: "succeeded", output: { sessionId: "session" } };
      if (command === "get_host_clipboard_session") return { endpoint: readEndpoint, access: "read" };
    });
    const controller = createHostClipboardController(invoke, "plugin", () => true, status, undefined, () => waiting);
    await controller.prepareGranted();
    expect(calls.map(([, args]) => args.requestPermission)).toEqual([false, false]);
    const first = controller.request("read"), second = controller.request("read");
    expect(first).toBe(second);
    await Promise.resolve(); release();
    expect(await first).toBe(readEndpoint);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", access: "read" }));
    expect(calls.filter(([command]) => command === "prepare_host_clipboard")).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain("text");
    await controller.close();
  });
  it("does not prepare the independent image grant until readImage explicitly requests it", async () => {
    const calls: any[] = [];
    const invoke: any = vi.fn(async (command, args) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") return args.requestPermission
        ? { sessionId: "image-session" }
        : { unavailable: true };
      if (command === "get_host_clipboard_session") return { endpoint: imageEndpoint, access: "image" };
    });
    const controller = createHostClipboardController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {});
    const prepared = await controller.prepareGranted();
    expect(prepared.endpoints).toEqual({});
    expect(calls.filter(([command]) => command === "prepare_host_clipboard").map(([, args]) => args.access)).toEqual(["read", "write"]);
    expect(await controller.request("image")).toBe(imageEndpoint);
    expect(calls.find(([command, args]) => command === "prepare_host_clipboard" && args.access === "image")[1])
      .toEqual({ pluginId: "plugin", instanceId: controller.instanceId, access: "image", requestPermission: true });
    await controller.close();
  });
  it("opens an explicitly requested history-delete grant through its own access id", async () => {
    const calls: any[] = [];
    const invoke: any = vi.fn(async (command, args) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") return { permission_required: true, runId: "history-run", tool: "history-tool" };
      if (command === "get_task_run") return { id: "history-run", capabilityId: "history-tool", initiator: { clientId: "atools-ui" }, status: "succeeded", output: { sessionId: "session-history_delete" } };
      if (command === "get_host_clipboard_session") return { endpoint: writeEndpoint, access: "history_delete" };
    });
    const controller = createHostClipboardController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {});
    expect(await controller.request("history_delete")).toBe(writeEndpoint);
    expect(calls[0]).toEqual(["prepare_host_clipboard", {
      pluginId: "plugin", instanceId: controller.instanceId, access: "history_delete", requestPermission: true,
    }]);
    expect(calls.map(([command]) => command)).toEqual(["prepare_host_clipboard", "get_task_run", "get_host_clipboard_session"]);
    await controller.close();
  });
  it("closes a once session at the native remaining deadline without extending it on reuse", async () => {
    vi.useFakeTimers();
    const monotonicTime = 100;
    const calls: any[] = [], endpoint = "http://127.0.0.1:12345/host/" + "d".repeat(64);
    const invoke: any = vi.fn(async (command, args) => {
      calls.push([command, args]);
      if (command === "prepare_host_clipboard") return { permission_required: true, runId: "once-run", tool: "once-tool" };
      if (command === "get_task_run") return { id: "once-run", capabilityId: "once-tool",
        initiator: { clientId: "atools-ui" }, status: "succeeded", output: { sessionId: "once-session" } };
      if (command === "get_host_clipboard_session") return { endpoint, access: "history_read", expiresInMs: 50 };
    });
    const controller = createHostClipboardController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {}, () => monotonicTime);
    let invalidations = 0; controller.onInvalidated(() => { invalidations++; });
    await controller.request("history_read");
    await controller.request("history_read");
    await vi.advanceTimersByTimeAsync(49);
    expect(invalidations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidations).toBe(1);
    expect(calls.filter(([command]) => command === "get_host_clipboard_session")).toHaveLength(1);
    expect(calls.filter(([command]) => command === "close_host_clipboard")).toHaveLength(1);
    vi.useRealTimers();
  });
  it("subtracts session IPC time from the native once deadline and closes expired replies", async () => {
    vi.useFakeTimers();
    let now = 100, invalidations = 0;
    const endpoint = "http://127.0.0.1:12345/host/" + "e".repeat(64);
    const invoke: any = vi.fn(async (command: string) => {
      if (command === "prepare_host_clipboard") return { sessionId: "delayed-once" };
      if (command === "get_host_clipboard_session") { now += 40; return { access: "history_read", endpoint, expiresInMs: 100 }; }
    });
    const delayed = createHostClipboardController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {}, () => now);
    delayed.onInvalidated(() => { invalidations++; });
    await delayed.request("history_read");
    await vi.advanceTimersByTimeAsync(59);
    expect(invalidations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidations).toBe(1);

    now = 500;
    const expiredInvoke: any = vi.fn(async (command: string) => {
      if (command === "prepare_host_clipboard") return { sessionId: "already-expired" };
      if (command === "get_host_clipboard_session") { now += 41; return { access: "history_read", endpoint, expiresInMs: 40 }; }
    });
    const expired = createHostClipboardController(expiredInvoke, "plugin", () => true, vi.fn(), undefined, async () => {}, () => now);
    await expect(expired.request("history_read")).rejects.toThrow("已过期");
    expect(expired.configuration().endpoints.history_read).toBeUndefined();
    expect(expiredInvoke).toHaveBeenCalledWith("close_host_clipboard", { pluginId: "plugin", instanceId: expired.instanceId });
    vi.useRealTimers();
  });
  it("ignores a late approval after close, never requests an endpoint and closes its exact generation", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((r) => { release = r; });
    const invoke: any = vi.fn(async (command) => command === "prepare_host_clipboard" ? { permission_required: true, runId: "run", tool: "tool" } : undefined);
    const status = vi.fn();
    const controller = createHostClipboardController(invoke, "plugin", () => true, status, undefined, () => waiting);
    const request = controller.request("write");
    await Promise.resolve(); await controller.close(); release();
    await expect(request).rejects.toThrow("cancelled");
    expect(invoke.mock.calls.map(([name]: any) => name)).toEqual(["prepare_host_clipboard", "close_host_clipboard"]);
    expect(status).not.toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }));
  });
  it("rotates once only on manual reopen and closes the successor if switching away during rotation", async () => {
    let live = true, release!: () => void;
    const waiting = new Promise<void>((r) => { release = r; });
    const invoke: any = vi.fn(async (command) => { if (command === "rotate_host_clipboard") await waiting; });
    const controller = createHostClipboardController(invoke, "plugin", () => live, vi.fn(), { instanceId: "old", endpoints: { read: readEndpoint } });
    const reopen = controller.reopen();
    live = false; await controller.close(); release();
    await expect(reopen).rejects.toThrow("cancelled");
    const calls = invoke.mock.calls;
    expect(calls[0][0]).toBe("rotate_host_clipboard");
    expect(calls[0][1].nextInstanceId).not.toBe("old");
    expect(calls).toContainEqual(["close_host_clipboard", { pluginId: "plugin", instanceId: calls[0][1].nextInstanceId }]);
  });
});
