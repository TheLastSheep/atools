import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { createHostClipboardBridge } from "../../src/lib/hostClipboardBridge";
import { createPluginClipboardApi } from "../../src/lib/pluginUtoolsBridgeSource/clipboard-api";
import { createClipboardHistoryCodec } from "../../src/lib/pluginUtoolsBridgeSource/clipboard-history";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";

const timestamp = 1_700_000_000_000;
const textId = "clip-0123456789abcdef";
const imageId = "clip-image-0123456789abcdef";
const fileId = "clip-file-fedcba9876543210";
const historyReadEndpoint = "http://127.0.0.1:12345/host/" + "a".repeat(64);
const historyDeleteEndpoint = "http://127.0.0.1:12345/host/" + "b".repeat(64);
const contentWriteEndpoint = "http://127.0.0.1:12345/host/" + "c".repeat(64);
const pasteEndpoint = "http://127.0.0.1:12345/host/" + "d".repeat(64);
const textItem = { id: textId, type: "text", timestamp, preview: "text item", content: "text item" };
const imageItem = { id: imageId, type: "image", timestamp, preview: "one image", imagePath: "/tmp/image.png", content: "/tmp/image.png", byteSize: 27 };
const fileItem = { id: fileId, type: "file", timestamp, preview: "two files", files: [
  { path: "/tmp/a.txt", name: "a.txt" }, { path: "C:\\Temp\\b.md" },
], content: ["/tmp/a.txt", "C:\\Temp\\b.md"] };
const mixedItems = [textItem, imageItem, fileItem];

const api = (nativeCall: Parameters<typeof createPluginClipboardApi>[0], getHost: Parameters<typeof createPluginClipboardApi>[1], nonce?: string) =>
  createPluginClipboardApi(nativeCall, getHost, nonce, createClipboardHistoryCodec);

function makeHost(items: Array<Record<string, unknown>> = mixedItems) {
  const content = new Map(items.map(item => [String(item.id), item]));
  return {
    instanceId: "clipboard-media-fixture",
    ensureAccess: vi.fn(async (_access: string) => undefined),
    historyRead: vi.fn((payload: Record<string, unknown>): unknown => {
      if (payload.operation === "getContent") return content.get(String(payload.id)) ?? null;
      return { items: items.slice(0, Number(payload.pageSize)), total: items.length, page: payload.page, pageSize: payload.pageSize };
    }),
    historyDelete: vi.fn((payload: Record<string, unknown>): unknown => payload.operation === "clear"
      ? { deletedCount: 2 } : { deleted: true }),
    writeText: vi.fn((_text: string) => undefined),
    writeContent: vi.fn((_payload: Record<string, unknown>) => undefined),
    paste: vi.fn((_payload: Record<string, unknown>) => undefined),
  };
}

function makeValidatedHost(items: Array<Record<string, unknown>> = mixedItems) {
  const transport = vi.fn((endpoint: string, payload: Record<string, unknown>): unknown => {
    if (endpoint === historyReadEndpoint) {
      if (payload.operation === "getContent") return items.find(item => item.id === payload.id) ?? null;
      return { items: items.slice(0, Number(payload.pageSize)), total: items.length, page: payload.page, pageSize: payload.pageSize };
    }
    if (endpoint === historyDeleteEndpoint) return payload.operation === "clear" ? { deletedCount: 2 } : { deleted: true };
    return null;
  });
  const host = createHostClipboardBridge({ instanceId: "validated-clipboard-media", endpoints: {
    history_read: historyReadEndpoint, history_delete: historyDeleteEndpoint,
    content_write: contentWriteEndpoint, paste: pasteEndpoint,
  } }, vi.fn(), transport);
  return { host, transport };
}

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

function generatedClipboard(host: ReturnType<typeof makeHost>) {
  const browser = createCompiledPluginFrameBrowserGlobals();
  cleanups.add(browser.dispose);
  const listeners = new Map<string, Function[]>();
  const window: any = {
    parent: { postMessage() {} }, top: {}, location: browser.location, history: browser.history,
    Event: browser.Event, CustomEvent: browser.CustomEvent, matchMedia: () => ({ matches: false }),
    __atoolsHostClipboard: host,
    __ATOOLS_FRAME_TRANSPORT__: { post: () => true, accept: () => true },
    addEventListener(name: string, listener: Function) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    removeEventListener(name: string, listener: Function) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)); },
    dispatchEvent(event: Event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
  };
  const document = { readyState: "complete", addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, document, navigator: { platform: "MacIntel" }, TextEncoder,
    Event: browser.Event, CustomEvent: browser.CustomEvent, Date, Math, Number, Promise, setTimeout, clearTimeout, console });
  const source = createPluginBridgeDocument({
    action: { plugin_id: "fixture", plugin_name: "Clipboard fixture", feature_code: "clipboard", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 0, payload: null },
    windowType: "main", browserWindowId: "", geometrySnapshot: null, workerScope: "clipboard-fixture",
    mainPushConfig: null, webContentsId: 1, subInputEpoch: 0, appName: "ATools", appVersion: "fixture", baseBridgeScript: "",
  });
  expect(executeCompiledPluginBridgeScripts(source, context, 3)).toBe(3);
  return window.utools.clipboard as ReturnType<typeof api>;
}

describe("permissioned image/file clipboard history", () => {
  it("passes typed history and image/file clear through the real host request validator", async () => {
    const { host, transport } = makeValidatedHost();
    const clipboard = api(vi.fn(), () => host as never);
    await expect(clipboard.getHistory(1, 3)).resolves.toEqual({ items: mixedItems, total: 3, page: 1, pageSize: 3 });
    await expect(clipboard.getContent(imageId)).resolves.toEqual(imageItem);
    await expect(clipboard.getContent(fileId)).resolves.toEqual(fileItem);
    await expect(clipboard.delete(imageId)).resolves.toEqual({ success: true });
    await expect(clipboard.delete(fileId)).resolves.toEqual({ success: true });
    await expect(clipboard.clear("image")).resolves.toEqual({ success: true, count: 2 });
    await expect(clipboard.clear("file")).resolves.toEqual({ success: true, count: 2 });
    expect(transport.mock.calls).toEqual([
      [historyReadEndpoint, { operation: "list", page: 1, pageSize: 3 }],
      [historyReadEndpoint, { operation: "getContent", id: imageId }],
      [historyReadEndpoint, { operation: "getContent", id: fileId }],
      [historyDeleteEndpoint, { operation: "delete", id: imageId }],
      [historyDeleteEndpoint, { operation: "delete", id: fileId }],
      [historyDeleteEndpoint, { operation: "clear", type: "image" }],
      [historyDeleteEndpoint, { operation: "clear", type: "file" }],
    ]);
  });

  it("normalizes mixed pages and preserves the same typed records for search and getContent", async () => {
    const host = makeHost();
    const clipboard = api(vi.fn(), () => host);
    await expect(clipboard.getHistory(1, 3, "needle")).resolves.toEqual({
      items: mixedItems, total: 3, page: 1, pageSize: 3,
    });
    await expect(clipboard.search("needle")).resolves.toEqual(mixedItems);
    for (const item of mixedItems) await expect(clipboard.getContent(item.id)).resolves.toEqual(item);
    for (const item of mixedItems) await expect(clipboard.delete(item.id)).resolves.toEqual({ success: true });
    await expect(clipboard.clear("image")).resolves.toEqual({ success: true, count: 2 });
    await expect(clipboard.clear("file")).resolves.toEqual({ success: true, count: 2 });
    expect(host.historyRead).toHaveBeenCalledWith({ operation: "list", page: 1, pageSize: 3, query: "needle" });
    expect(host.historyDelete).toHaveBeenCalledWith({ operation: "clear", type: "image" });
    expect(host.historyDelete).toHaveBeenCalledWith({ operation: "clear", type: "file" });
  });

  it("accepts legacy text getContent without preview but rejects typed-id mismatches and forged media fields", async () => {
    const legacyHost = makeHost([textItem]);
    legacyHost.historyRead.mockReturnValueOnce({ id: textId, type: "text", timestamp, content: "legacy text" });
    await expect(api(vi.fn(), () => legacyHost).getContent(textId)).resolves.toEqual({
      id: textId, type: "text", timestamp, preview: "legacy text", content: "legacy text",
    });

    const invalidRows = [
      { ...imageItem, id: textId },
      { ...imageItem, imagePath: "data:image/png;base64,AAAA", content: "data:image/png;base64,AAAA" },
      { ...imageItem, dataUrl: "data:image/png;base64,AAAA" },
      { ...fileItem, content: ["/tmp/forged.txt", "C:\\Temp\\b.md"] },
      { ...fileItem, files: [{ path: "relative.txt" }] , content: ["relative.txt"] },
      { ...fileItem, files: [{ path: "/tmp/a.txt", payload: "forged" }], content: ["/tmp/a.txt"] },
      { ...imageItem, byteSize: -1 },
      { ...imageItem, preview: "🙂".repeat(257) },
    ];
    for (const item of invalidRows) {
      const host = makeHost([item]);
      await expect(api(vi.fn(), () => host).getHistory(1, 1)).rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });
    }
    const mismatchedContentHost = makeHost([textItem]);
    mismatchedContentHost.historyRead.mockReturnValueOnce({ ...imageItem, id: "clip-image-fedcba9876543210" });
    await expect(api(vi.fn(), () => mismatchedContentHost).getContent(imageId))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });
  });

  it("enforces text, query, path-count, total-path, and serialized-page budgets", async () => {
    const host = makeHost();
    const clipboard = api(vi.fn(), () => host);
    await expect(clipboard.getHistory(1, 3, "x".repeat(257))).rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_ARGUMENT" });

    const oversizedText = { ...textItem, content: "x".repeat(256 * 1024 + 1), preview: "x".repeat(256) };
    const oversizedTextHost = makeHost([oversizedText]);
    await expect(api(vi.fn(), () => oversizedTextHost).getHistory(1, 1))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });

    const tooManyFiles = { ...fileItem, files: Array.from({ length: 21 }, (_, index) => ({ path: `/tmp/${index}` })),
      content: Array.from({ length: 21 }, (_, index) => `/tmp/${index}`) };
    const tooManyFilesHost = makeHost([tooManyFiles]);
    await expect(api(vi.fn(), () => tooManyFilesHost).getHistory(1, 1))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });

    const oversizedPath = "/" + "p".repeat(8192);
    const tooLongPath = { ...fileItem, files: [{ path: oversizedPath }], content: [oversizedPath] };
    const tooLongPathHost = makeHost([tooLongPath]);
    await expect(api(vi.fn(), () => tooLongPathHost).getHistory(1, 1))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });

    const longPath = "/" + "p".repeat(8191);
    const tooManyPathBytes = { ...fileItem, files: Array.from({ length: 9 }, () => ({ path: longPath })),
      content: Array.from({ length: 9 }, () => longPath) };
    const tooManyPathBytesHost = makeHost([tooManyPathBytes]);
    await expect(api(vi.fn(), () => tooManyPathBytesHost).getHistory(1, 1))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });

    const largeRows = [textId, "clip-1123456789abcdef", "clip-2123456789abcdef"].map(id => ({
      id, type: "text", timestamp, content: "z".repeat(180 * 1024), preview: "z".repeat(256),
    }));
    const largeRowsHost = makeHost(largeRows);
    await expect(api(vi.fn(), () => largeRowsHost).getHistory(1, 3))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_LIMIT" });
  });

  it("keeps media metadata through onChange history refresh", async () => {
    const instanceId = "clipboard-media-fixture";
    const host = makeHost([imageItem]);
    const post = vi.fn((_message: Record<string, unknown>) => true);
    const original = Object.getOwnPropertyDescriptor(window, "__ATOOLS_FRAME_TRANSPORT__");
    Object.defineProperty(window, "__ATOOLS_FRAME_TRANSPORT__", { configurable: true, value: { post, accept: () => true } });
    try {
      const callback = vi.fn();
      const clipboard = api(vi.fn(), () => host, "a".repeat(32));
      const dispose = clipboard.onChange(callback) as (() => void) & { ready: Promise<void> };
      await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ operation: "subscribe" })));
      const subscription = post.mock.calls[0][0];
      window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: {
        __atools_clipboard_change_response__: true, subscriptionId: subscription.subscriptionId,
        instanceId, documentNonce: "a".repeat(32), ok: true,
      } }));
      await dispose.ready;
      window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: {
        __atools_clipboard_change_event__: true, subscriptionId: subscription.subscriptionId,
        instanceId, documentNonce: "a".repeat(32), sequence: 1,
      } }));
      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(imageItem));
      dispose();
    } finally {
      if (original) Object.defineProperty(window, "__ATOOLS_FRAME_TRANSPORT__", original);
      else delete (window as Window & { __ATOOLS_FRAME_TRANSPORT__?: unknown }).__ATOOLS_FRAME_TRANSPORT__;
    }
  });

  it("writes file history through content/paste and never replays across host replacement", async () => {
    const host = makeHost([fileItem]);
    const clipboard = api(vi.fn(), () => host);
    await expect(clipboard.write(fileId, false)).resolves.toEqual({ success: true });
    expect(host.ensureAccess).toHaveBeenCalledWith("content_write");
    expect(host.writeContent).toHaveBeenCalledWith({ kind: "files", paths: fileItem.content });
    await expect(clipboard.write(fileId, true)).resolves.toEqual({ success: true });
    expect(host.ensureAccess).toHaveBeenCalledWith("paste");
    expect(host.paste).toHaveBeenCalledWith({ kind: "files", paths: fileItem.content });

    for (const paste of [false, true]) {
      let resolveContent!: (value: unknown) => void;
      const oldHost = makeHost([fileItem]);
      oldHost.historyRead.mockImplementation((payload: Record<string, unknown>) => payload.operation === "getContent"
        ? new Promise(resolve => { resolveContent = resolve; })
        : { items: [fileItem], total: 1, page: payload.page, pageSize: payload.pageSize });
      const nextHost = makeHost([fileItem]);
      let current = oldHost;
      const pending = api(vi.fn(), () => current).write(fileId, paste);
      await vi.waitFor(() => expect(oldHost.historyRead).toHaveBeenCalledWith({ operation: "getContent", id: fileId }));
      current = nextHost;
      resolveContent(fileItem);
      await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_UNAVAILABLE" });
      expect(oldHost.writeContent).not.toHaveBeenCalled();
      expect(oldHost.paste).not.toHaveBeenCalled();
      expect(nextHost.writeContent).not.toHaveBeenCalled();
      expect(nextHost.paste).not.toHaveBeenCalled();
    }
  });

  it("executes the generated production bridge with the serialized media history codec", async () => {
    const host = makeHost([imageItem, fileItem]);
    const clipboard = generatedClipboard(host);
    await expect(clipboard.getHistory(1, 2)).resolves.toMatchObject({
      items: [imageItem, fileItem], total: 2, page: 1, pageSize: 2,
    });
  });
});
