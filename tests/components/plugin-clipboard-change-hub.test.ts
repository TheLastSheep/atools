import { describe, expect, it, vi } from "vitest";
import { createPluginClipboardChangeHub } from "../../src/lib/pluginClipboardChangeHub";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { createHostClipboardController } from "../../src/lib/hostClipboardController";
import { createPluginPanelMessageHost } from "../../src/lib/pluginPanelMessageHost";
import { isPluginDocumentIdentity } from "../../src/lib/pluginFrameDocumentIdentity";
import { productionHostedIpcFixture } from "./pluginHostedIpcProductionFixture";

const nonce = "a".repeat(32), instanceId = "12345678-1234-4234-8234-123456789abc";
const subscriptionId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const itemId = "clip-0123456789abcdef";
const historyProjectedEvent = "clipboard://history-projected";
const invalidatedEvent = "host-clipboard://invalidated";

function setup(controllerOverride?: ReturnType<typeof createHostClipboardController>,
  listenOverride?: (event: string, receive: (event: { payload: unknown }) => void) => Promise<() => void>) {
  const source = { postMessage: vi.fn((_message: unknown, _origin: string) => {}) };
  const sources = new PluginFrameSourceRegistry();
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const webContentsId = hostedIpc.reserve({ kind: "main" });
  const initial = hostedIpc.registerFrame({ kind: "main" }, source, true, true)!;
  hostedIpc.handleLifecycle({ source, identity: initial }, {
    __atools_hosted_ipc_document__: true, phase: "open", webContentsId, documentNonce: nonce,
  });
  const identity = sources.currentIdentityForHost(source)!;
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const defaultListen = async (event: string, receive: (event: { payload: unknown }) => void) => {
    const group = listeners.get(event) ?? new Set(); group.add(receive); listeners.set(event, group);
    return () => group.delete(receive);
  };
  const listen = vi.fn(listenOverride ?? defaultListen);
  let invalidated: (() => void) | undefined;
  const controller = controllerOverride ?? {
    instanceId,
    configuration: () => ({ instanceId, endpoints: { history_read: "http://127.0.0.1:12345/host/" + "a".repeat(64) } }),
    onInvalidated: (callback: () => void) => { invalidated = callback; return () => { invalidated = undefined; }; },
    close: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof createHostClipboardController>;
  const hub = createPluginClipboardChangeHub({ sources, hostedIpc, controller: () => controller,
    pluginId: () => "clipboard-fixture", listen });
  return { source, sources, hostedIpc, identity, listeners, listen, controller, hub, expire: () => invalidated?.() };
}

function message(id = subscriptionId, docNonce = nonce) {
  return { __atools_clipboard_change__: true, operation: "subscribe", subscriptionId: id, instanceId, documentNonce: docNonce };
}

describe("production clipboard change fanout", () => {
  it("shares one lazy opaque listener, authenticates the current hosted document, and sends no item data", async () => {
    vi.useFakeTimers();
    const { source, identity, listeners, listen, hub } = setup();
    listeners.get(historyProjectedEvent)?.forEach(receive => receive({ payload: null })); // pre-subscription change is not replayed
    expect(hub.dispatch(source as unknown as MessageEventSource, identity, message("bad-nonce", "b".repeat(32)))).toBe(true);
    await vi.runAllTimersAsync();
    expect(source.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ __atools_clipboard_change_response__: true, ok: false });
    expect(hub.snapshot().subscriptions).toBe(0);

    hub.dispatch(source as unknown as MessageEventSource, identity, message());
    await vi.waitFor(() => expect(source.postMessage.mock.calls.some(call => (call[0] as any).__atools_clipboard_change_response__ === true
      && (call[0] as any).ok === true)).toBe(true));
    expect(listen).toHaveBeenCalledTimes(2);
    expect(hub.dispatch(source as unknown as MessageEventSource, identity,
      message("fedcba98-7654-4321-8765-fedcba987654"))).toBe(true);
    await vi.waitFor(() => expect(hub.snapshot().subscriptions).toBe(2));
    expect(listen).toHaveBeenCalledTimes(2);

    listeners.get(historyProjectedEvent)?.forEach(receive => receive({ payload: { content: "must not be forwarded", itemId: "clip-secret" } }));
    await vi.advanceTimersByTimeAsync(25);
    const events = source.postMessage.mock.calls.map(call => call[0] as Record<string, unknown>)
      .filter(value => value.__atools_clipboard_change_event__ === true);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({ subscriptionId, instanceId, documentNonce: nonce, sequence: 1 }));
    expect(JSON.stringify(events)).not.toContain("must not be forwarded");
    expect(JSON.stringify(events)).not.toContain("clip-secret");

    hub.close();
    expect(hub.snapshot().subscriptions).toBe(0);
    expect([...listeners.values()].every(group => group.size === 0)).toBe(true);
    vi.useRealTimers();
  });

  it("invalidates on source rotation, session expiry/revocation, and plugin host invalidation", async () => {
    const { source, sources, identity, listeners, hub, expire } = setup();
    hub.dispatch(source as unknown as MessageEventSource, identity, message());
    await vi.waitFor(() => expect(hub.snapshot().subscriptions).toBe(1));
    sources.setMain(source);
    expect(hub.snapshot().subscriptions).toBe(0);

    const expired = setup();
    expired.hub.dispatch(expired.source as unknown as MessageEventSource, expired.identity, message());
    await vi.waitFor(() => expect(expired.hub.snapshot().subscriptions).toBe(1));
    expired.expire();
    expect(expired.hub.snapshot().subscriptions).toBe(0);

    const fresh = setup();
    fresh.hub.dispatch(fresh.source as unknown as MessageEventSource, fresh.identity, message());
    await vi.waitFor(() => expect(fresh.hub.snapshot().subscriptions).toBe(1));
    fresh.listeners.get(invalidatedEvent)?.forEach(receive => receive({ payload: { pluginId: "clipboard-fixture" } }));
    await vi.waitFor(() => expect(fresh.hub.snapshot().subscriptions).toBe(0));
    expect(fresh.controller.close).toHaveBeenCalledTimes(1);
    expect(listeners.get(historyProjectedEvent)?.size).toBe(0);
  });

  it("closes a real once session while the first native listener is still installing", async () => {
    vi.useFakeTimers();
    const endpoint = "http://127.0.0.1:12345/host/" + "d".repeat(64);
    const invoke = vi.fn(async (command: string) => command === "prepare_host_clipboard"
      ? { sessionId: "history-session" }
      : command === "get_host_clipboard_session"
        ? { access: "history_read", endpoint, expiresInMs: 25 }
        : undefined) as any;
    const controller = createHostClipboardController(invoke, "clipboard-fixture", () => true, () => {}, { instanceId });
    await controller.request("history_read");
    let finishListen!: (unlisten: () => void) => void;
    const listen = vi.fn((_event: string, _receive: (event: { payload: unknown }) => void) =>
      new Promise<() => void>(resolve => { finishListen = resolve; }));
    const { source, identity, hub } = setup(controller, listen);
    hub.dispatch(source as unknown as MessageEventSource, identity, message());
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(hub.snapshot().subscriptions).toBe(0);
    expect(controller.configuration().endpoints.history_read).toBeUndefined();
    let lateInvalidation = 0;
    controller.onInvalidated(() => { lateInvalidation++; });
    expect(lateInvalidation).toBe(1);

    const unlisten = vi.fn();
    finishListen(unlisten);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(hub.snapshot()).toMatchObject({ subscriptions: 0, listening: false });
    expect(source.postMessage.mock.calls.some(call => (call[0] as any).ok === true)).toBe(false);
    expect(invoke).toHaveBeenCalledWith("close_host_clipboard", { pluginId: "clipboard-fixture", instanceId });
    vi.useRealTimers();
  });

  it("connects the compiled opaque-frame API through the production parent message host", async () => {
    const endpoint = "http://127.0.0.1:12345/host/" + "c".repeat(64);
    const committed = "captured\ntext 🧭";
    const fixture = await productionHostedIpcFixture({ clipboardTransport: (_endpoint, payload) => {
      expect(_endpoint).toBe(endpoint);
      expect(payload).toEqual({ operation: "list", page: 1, pageSize: 1 });
      return { items: [{ id: itemId, type: "text", timestamp: 1700000000000,
        content: committed, preview: committed }], total: 1, page: 1, pageSize: 1 };
    } });
    const frame = await fixture.frame(undefined, undefined, true, undefined, false, false, false,
      { instanceId, endpoints: { history_read: endpoint } });
    const nativeEvents = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const listenClipboardEvents = async (name: string, receive: (event: { payload: unknown }) => void) => {
      const group = nativeEvents.get(name) ?? new Set(); group.add(receive); nativeEvents.set(name, group);
      return () => group.delete(receive);
    };
    const controller = {
      instanceId,
      configuration: () => ({ instanceId, endpoints: { history_read: endpoint } }),
      onInvalidated: () => () => undefined,
      close: async () => {},
    };
    const action = { plugin_id: "ipc-fixture", plugin_name: "IPC fixture", feature_code: "ipc", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 0, payload: null };
    const ports = new Proxy({ action: () => action, sources: fixture.sources, hostedIpc: fixture.router,
      browserWindows: () => [], creatorFor: () => undefined, activeClipboard: () => controller,
      mainPushMode: () => "visible" as const, receiveMainPush: () => false,
      workerBlocking: () => false, closingActionIsCurrent: () => false, activePage: () => undefined,
      isDocumentIdentity: isPluginDocumentIdentity, listenClipboardEvents,
    }, { get(target, key) { return key in target ? (target as any)[key] : () => undefined; } }) as any;
    const parentHost = createPluginPanelMessageHost(ports);
    fixture.setParentMessageHandler(event => parentHost.handleMessage(event));
    frame.evaluate("window.__changeItem = null; window.__changeUnsubscribe = window.utools.clipboard.onChange(function(item) { window.__changeItem = item; });");
    await vi.waitFor(() => expect(frame.posted.some((value: any) => value.__atools_clipboard_change__ === true
      && value.operation === "subscribe")).toBe(true));
    await fixture.settle();
    expect(fixture.deliveries.some((delivery: any) => delivery.target === frame.id
      && delivery.message.__atools_clipboard_change_response__ === true && delivery.message.ok === true)).toBe(true);
    nativeEvents.get(historyProjectedEvent)?.forEach(receive => receive({ payload: null }));
    await new Promise(resolve => setTimeout(resolve, 40));
    await fixture.settle();
    expect(frame.evaluate("window.__changeItem.content")).toBe(committed);
    const parentEvent = fixture.deliveries.map((item: any) => item.message)
      .find((value: any) => value.__atools_clipboard_change_event__ === true);
    expect(parentEvent).toMatchObject({ instanceId, sequence: 1 });
    expect(JSON.stringify(parentEvent)).not.toContain(committed);
    frame.evaluate("window.__changeUnsubscribe()");
    await fixture.settle();
    expect([...nativeEvents.values()].every(group => group.size === 0)).toBe(true);
    parentHost.close(); fixture.closeRpc();
  });
});
