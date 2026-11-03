import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge } from "../../src/lib/hostClipboardBridge";
import { createPluginElectronAdapter, pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { createPluginClipboardApi } from "../../src/lib/pluginUtoolsBridgeSource/clipboard-api";
import { createClipboardHistoryCodec } from "../../src/lib/pluginUtoolsBridgeSource/clipboard-history";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";

const application = { name: "ATools", version: "fixture" };
const writeEndpoint = "http://127.0.0.1:12345/host/" + "a".repeat(64);
const contentEndpoint = "http://127.0.0.1:12345/host/" + "b".repeat(64);
const pasteEndpoint = "http://127.0.0.1:12345/host/" + "c".repeat(64);
const html = "  <section data-emoji=\"🧭\"><b>keep&nbsp;exactly</b></section>\n";

function createClipboardHost(endpoints = { write: writeEndpoint, content_write: contentEndpoint, paste: pasteEndpoint }) {
  const requests: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const transport = vi.fn((endpoint: string, payload: Record<string, unknown>) => {
    requests.push({ endpoint, payload });
    return null;
  });
  const requestPermission = vi.fn();
  const host = createHostClipboardBridge({ instanceId: "html-fixture", endpoints }, requestPermission, transport);
  return { host, requests, transport, requestPermission };
}

function createApiHost(ensureAccess = vi.fn(async (_access: string) => undefined)) {
  return {
    instanceId: "html-api-fixture",
    ensureAccess,
    writeText: vi.fn((_text: string) => undefined),
    writeContent: vi.fn((_payload: Record<string, unknown>) => undefined),
    paste: vi.fn((_payload: Record<string, unknown>) => undefined),
  };
}

function api(getHost: () => ReturnType<typeof createApiHost> | undefined) {
  return createPluginClipboardApi(vi.fn(), getHost as never, undefined, createClipboardHistoryCodec);
}

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

function runGeneratedBridge() {
  const browser = createCompiledPluginFrameBrowserGlobals();
  cleanups.add(browser.dispose);
  const requests: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const listeners = new Map<string, Function[]>();
  const addListener = (name: string, listener: Function) => listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  const removeListener = (name: string, listener: Function) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener));
  class FixtureXhr {
    status = 200;
    responseText = JSON.stringify({ ok: true, result: null });
    endpoint = "";
    open(method: string, endpoint: string, async: boolean) {
      expect([method, async]).toEqual(["POST", false]);
      this.endpoint = endpoint;
    }
    setRequestHeader() {}
    send(body: string) { requests.push({ endpoint: this.endpoint, payload: JSON.parse(body) }); }
  }
  const window: any = {
    parent: { postMessage() {} }, top: {}, location: browser.location, history: browser.history,
    Event: browser.Event, CustomEvent: browser.CustomEvent, matchMedia: () => ({ matches: false }),
    __ATOOLS_FRAME_TRANSPORT__: { post: () => true, accept: () => true },
    addEventListener: addListener, removeEventListener: removeListener,
    dispatchEvent(event: Event) { for (const listener of listeners.get(event.type) ?? []) listener(event); return true; },
  };
  const document = { readyState: "complete", addEventListener: addListener, removeEventListener: removeListener,
    dispatchEvent() { return true; } };
  const context = vm.createContext({ window, document, navigator: { platform: "MacIntel" }, TextEncoder,
    XMLHttpRequest: FixtureXhr, Event: browser.Event, CustomEvent: browser.CustomEvent,
    addEventListener: addListener, removeEventListener: removeListener,
    Date, Math, Number, Promise, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, queueMicrotask, console });
  const source = createPluginBridgeDocument({
    action: { plugin_id: "html-fixture", plugin_name: "HTML fixture", feature_code: "html", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 0, payload: null },
    windowType: "main", browserWindowId: "", geometrySnapshot: null, workerScope: "html-fixture",
    mainPushConfig: null, webContentsId: 1, subInputEpoch: 0, appName: application.name, appVersion: application.version,
    clipboard: { instanceId: "html-fixture", endpoints: { write: writeEndpoint, content_write: contentEndpoint, paste: pasteEndpoint } },
    baseBridgeScript: "",
  });
  expect(executeCompiledPluginBridgeScripts(source, context, 4)).toBe(4);
  return { window, requests };
}

describe("permissioned HTML clipboard writes", () => {
  it("routes plain text through the old write endpoint and rich writes through content_write", () => {
    const { host, requests, requestPermission } = createClipboardHost();
    const electron = createPluginElectronAdapter({ application, clipboard: host });

    expect(electron.clipboard.write({ text: "plain-only" })).toBeUndefined();
    expect(electron.clipboard.writeHTML(html)).toBeUndefined();
    expect(electron.clipboard.write({ html, text: "plain fallback" }, "clipboard")).toBeUndefined();
    expect(electron.clipboard.write({ html, text: "" })).toBeUndefined();
    expect(() => electron.clipboard.write({ text: "plain" }, "selection")).toThrow("Selection clipboard");
    expect(() => electron.clipboard.writeHTML(html, "selection")).toThrow("Selection clipboard");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(requests).toEqual([
      { endpoint: writeEndpoint, payload: { text: "plain-only" } },
      { endpoint: contentEndpoint, payload: { kind: "html", html } },
      { endpoint: contentEndpoint, payload: { kind: "html", html, text: "plain fallback" } },
      { endpoint: contentEndpoint, payload: { kind: "html", html, text: "" } },
    ]);
  });

  it("preserves optional text and rejects selection, unknown formats, nulls, extra keys, and malformed HTML", () => {
    const { host, requests } = createClipboardHost();
    expect(() => host.write({ html, text: null } as never)).toThrow("ARGUMENT");
    expect(() => host.write({ html, text: undefined } as never)).toThrow("ARGUMENT");
    expect(() => host.write({ html, rtf: "rich text" } as never)).toThrow("ARGUMENT");
    expect(() => host.write({ html, text: "plain", extra: true } as never)).toThrow("ARGUMENT");
    expect(() => host.writeHTML(null as never)).toThrow("ARGUMENT");
    expect(() => host.writeHTML(html, "selection")).toThrow("Selection clipboard");
    expect(() => host.write({ text: "plain" }, "selection")).toThrow("Selection clipboard");
    expect(() => host.writeContent({ kind: "html", html, text: null })).toThrow("ARGUMENT");
    expect(() => host.writeContent({ kind: "html", html, extra: true })).toThrow("ARGUMENT");
    expect(() => host.paste({ kind: "html", html: 10 } as never)).toThrow("ARGUMENT");
    expect(requests).toEqual([]);
  });

  it("enforces the UTF-8 content and JSON wire budgets without altering HTML", () => {
    const { host, requests } = createClipboardHost();
    const text = "🙂";
    const exactHtml = "x".repeat(256 * 1024 - new TextEncoder().encode(text).length);
    expect(() => host.write({ html: exactHtml, text })).not.toThrow();
    expect(requests[0]).toEqual({ endpoint: contentEndpoint, payload: { kind: "html", html: exactHtml, text } });
    expect(() => host.writeHTML("x".repeat(256 * 1024 + 1))).toThrow("LIMIT");
    const escapedWireOverflow = "\u0001".repeat(90 * 1024);
    expect(new TextEncoder().encode(escapedWireOverflow).length).toBeLessThan(256 * 1024);
    expect(() => host.writeHTML(escapedWireOverflow)).toThrow("512 KiB");
    expect(requests).toHaveLength(1);
  });

  it("rejects missing permission synchronously and never replays after grant or close", () => {
    const requests: unknown[] = [], requestPermission = vi.fn((access: string) => requests.push(access));
    const transport = vi.fn(() => null);
    const host = createHostClipboardBridge({ instanceId: "no-replay" }, requestPermission, transport);
    expect(() => host.writeHTML(html)).toThrow("PERMISSION_REQUIRED");
    expect(requestPermission.mock.calls).toEqual([["content_write"]]);
    expect(transport).not.toHaveBeenCalled();
    host.install("content_write", contentEndpoint);
    expect(transport).not.toHaveBeenCalled();
    host.writeHTML(html);
    expect(transport.mock.calls).toEqual([[contentEndpoint, { kind: "html", html }]]);
    host.close();
    expect(() => host.write({ text: "after-close" })).toThrow("CLOSED");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("sends validated writeContent HTML through copy, paste, and entry-host identity checks", async () => {
    const host = createApiHost();
    const clipboard = api(() => host);
    const rich = { type: "html", content: { html, text: "copy fallback" } };
    await expect(clipboard.writeContent(rich, false)).resolves.toEqual({ success: true });
    await expect(clipboard.writeContent(rich, true)).resolves.toEqual({ success: true });
    await expect(clipboard.writeContent({ type: "html", content: { html } }, false)).resolves.toEqual({ success: true });
    expect(host.ensureAccess.mock.calls).toEqual([["content_write"], ["paste"], ["content_write"]]);
    expect(host.writeContent.mock.calls).toEqual([
      [{ kind: "html", html, text: "copy fallback" }], [{ kind: "html", html }],
    ]);
    expect(host.paste.mock.calls).toEqual([[{ kind: "html", html, text: "copy fallback" }]]);

    const beforeInvalid = host.ensureAccess.mock.calls.length;
    for (const content of [null, { html, text: null }, { html, rtf: "unsupported" }]) {
      await expect(clipboard.writeContent({ type: "html", content }, false))
        .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_ARGUMENT" });
    }
    await expect(clipboard.writeContent({ type: "html", content: { html: "x".repeat(256 * 1024 + 1) } }, false))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_LIMIT" });
    await expect(clipboard.writeContent({ type: "html", content: { html: "\u0001".repeat(90 * 1024) } }, false))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_LIMIT" });
    expect(host.ensureAccess).toHaveBeenCalledTimes(beforeInvalid);
  });

  it("does not write or paste when the entry host changes while permission is pending", async () => {
    for (const paste of [false, true]) {
      let resolveAccess!: () => void;
      const access = new Promise<void>(resolve => { resolveAccess = resolve; });
      const oldHost = createApiHost(vi.fn(() => access));
      const nextHost = createApiHost();
      let current = oldHost;
      const clipboard = api(() => current);
      const pending = clipboard.writeContent({ type: "html", content: { html, text: "plain" } }, paste);
      await vi.waitFor(() => expect(oldHost.ensureAccess).toHaveBeenCalledOnce());
      current = nextHost;
      resolveAccess();
      await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_UNAVAILABLE" });
      expect(oldHost.writeContent).not.toHaveBeenCalled();
      expect(oldHost.paste).not.toHaveBeenCalled();
      expect(nextHost.writeContent).not.toHaveBeenCalled();
      expect(nextHost.paste).not.toHaveBeenCalled();
    }
  });

  it("executes the generated plugin bridge, host clipboard bridge, and Electron adapter together", async () => {
    const { window, requests } = runGeneratedBridge();
    const electronClipboard = window.require("electron").clipboard;
    expect(electronClipboard.write({ text: "plain-only" })).toBeUndefined();
    expect(electronClipboard.writeHTML(html)).toBeUndefined();
    await expect(window.utools.clipboard.writeContent({ type: "html", content: { html, text: "plain" } }, false))
      .resolves.toEqual({ success: true });
    await expect(window.utools.clipboard.writeContent({ type: "html", content: { html } }, true))
      .resolves.toEqual({ success: true });
    expect(requests).toEqual([
      { endpoint: writeEndpoint, payload: { text: "plain-only" } },
      { endpoint: contentEndpoint, payload: { kind: "html", html } },
      { endpoint: contentEndpoint, payload: { kind: "html", html, text: "plain" } },
      { endpoint: pasteEndpoint, payload: { kind: "html", html } },
    ]);
  });
});
