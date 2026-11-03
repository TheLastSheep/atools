import { describe, expect, it, vi } from "vitest";
import { createPluginHostedIpcRouter, type PluginHostedDocumentLease } from "../../src/lib/pluginHostedIpcRouter";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginNativeBrowserWindowBindings } from "../../src/lib/pluginNativeBrowserWindowBindings";
import { createPluginPanelCloseTracker } from "../../src/lib/pluginPanelCloseTracker";

const RESOURCE_SESSION = "11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE_ONE = "a".repeat(32);
const NONCE_TWO = "b".repeat(32);
const SOURCE_BINDING_ONE = "c".repeat(64);
const SOURCE_BINDING_TWO = "d".repeat(64);
const RESOURCE = {
  sessionId: RESOURCE_SESSION,
  pluginRoot: "/plugins/snipaste",
  instanceId: INSTANCE_ID,
};

type NativeCall = { command: string; args?: Record<string, unknown> };
type NativeInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function nativeInvoke(handler: (call: NativeCall) => unknown | Promise<unknown>) {
  const calls: NativeCall[] = [];
  const invoke: NativeInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    const call = { command, args };
    calls.push(call);
    return await handler(call) as T;
  };
  return { invoke, calls };
}

function hostedDocumentFixture(pageDocumentId = "page-one", nonce = NONCE_ONE) {
  const sources = new PluginFrameSourceRegistry();
  const router = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const source = {};
  const webContentsId = router.reserve({ kind: "main" });

  function activate(pageId: string, documentNonce: string) {
    const reservation = sources.reserveDocument({
      kind: "main",
      source,
      pageDocumentId: pageId,
      expectedOrigin: "https://plugin.example",
      parentOrigin: "https://atools.example",
    });
    if (!sources.activateDocument(reservation, documentNonce)) {
      throw new Error("fixture document reservation could not be activated");
    }
    const identity = router.registerFrame({ kind: "main" }, source, true, true);
    if (!identity) throw new Error("fixture document source was not registered");
    router.handleLifecycle({ source, identity }, {
      __atools_hosted_ipc_document__: true,
      phase: "open",
      webContentsId,
      documentNonce,
    });
    const lease = router.captureDocumentLease({ source, identity }, documentNonce);
    return { reservation, lease: lease as PluginHostedDocumentLease };
  }

  return { sources, router, source, activate, ...activate(pageDocumentId, nonce) };
}

function manager(options: {
  sources: PluginFrameSourceRegistry;
  invoke: NativeInvoke;
  prepare?: () => Promise<typeof RESOURCE>;
}) {
  const prepare = options.prepare ?? vi.fn(async () => RESOURCE);
  const onRevoked = vi.fn();
  const bindings = createPluginNativeBrowserWindowBindings({
    pluginId: () => "snipaste",
    resources: () => ({ prepare }),
    invoke: options.invoke,
    sources: options.sources,
    onRevoked,
  });
  return { bindings, prepare, onRevoked };
}

describe("native browser-window source bindings", () => {
  it("binds lazily and shares one pending bind for concurrent ensures of the same document", async () => {
    const fixture = hostedDocumentFixture();
    const resource = deferred<typeof RESOURCE>();
    const bindStarted = deferred<void>();
    const bindResult = deferred<{ sourceBindingId: string }>();
    const { invoke, calls } = nativeInvoke(({ command }) => {
      if (command === "bind_plugin_window_source") {
        bindStarted.resolve();
        return bindResult.promise;
      }
      return undefined;
    });
    const prepare = vi.fn(() => resource.promise);
    const { bindings } = manager({ sources: fixture.sources, invoke, prepare });

    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    const first = bindings.ensure(fixture.lease);
    const concurrent = bindings.ensure(fixture.lease);
    expect(prepare).toHaveBeenCalledTimes(1);

    resource.resolve(RESOURCE);
    await bindStarted.promise;
    expect(calls.filter(call => call.command === "bind_plugin_window_source")).toHaveLength(1);
    bindResult.resolve({ sourceBindingId: SOURCE_BINDING_ONE });
    const [entry, reused] = await Promise.all([first, concurrent]);

    expect(entry).toBe(reused);
    expect(entry.resourceSessionId).toBe(RESOURCE_SESSION);
    expect(entry.instanceId).toBe(INSTANCE_ID);
    expect(calls.find(call => call.command === "bind_plugin_window_source")?.args).toEqual({
      pluginId: "snipaste",
      instanceId: INSTANCE_ID,
      resourceSessionId: RESOURCE_SESSION,
      frameId: "main",
      generation: fixture.lease.identity.generation,
      documentNonce: NONCE_ONE,
    });
    expect(await bindings.ensure(fixture.lease)).toBe(entry);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("closes a source binding returned after its hosted document navigated", async () => {
    const fixture = hostedDocumentFixture();
    const bindStarted = deferred<void>();
    const bindResult = deferred<{ sourceBindingId: string }>();
    const { invoke, calls } = nativeInvoke(({ command }) => {
      if (command === "bind_plugin_window_source") {
        bindStarted.resolve();
        return bindResult.promise;
      }
      return undefined;
    });
    const { bindings } = manager({ sources: fixture.sources, invoke });
    const opening = bindings.ensure(fixture.lease);

    await bindStarted.promise;
    fixture.sources.invalidateDocument(fixture.reservation);
    bindResult.resolve({ sourceBindingId: SOURCE_BINDING_ONE });
    await expect(opening).rejects.toThrow(/stale or missing native document lease/);

    expect(calls).toContainEqual({
      command: "close_plugin_window_source",
      args: { sourceBindingId: SOURCE_BINDING_ONE },
    });
    expect(bindings.entries()).toEqual([]);
  });

  it("reports a swallowed source close failure through the shared strict close tracker", async () => {
    const fixture = hostedDocumentFixture();
    const tracker = createPluginPanelCloseTracker();
    const expectedFailure = new Error("native source close failed");
    const { invoke } = nativeInvoke(({ command }) => {
      if (command === "bind_plugin_window_source") return { sourceBindingId: SOURCE_BINDING_ONE };
      if (command === "close_plugin_window_source") throw expectedFailure;
      return undefined;
    });
    const { bindings } = manager({ sources: fixture.sources, invoke: tracker.wrap(invoke) });
    await bindings.ensure(fixture.lease);

    tracker.begin();
    await expect(bindings.closeAll()).resolves.toBeUndefined();
    await expect(tracker.drain()).rejects.toBe(expectedFailure);
  });

  it("revokes an older generation when the same frame source receives a new document", async () => {
    let nextSourceId = 0;
    const sourceIds = [SOURCE_BINDING_ONE, SOURCE_BINDING_TWO];
    const { sources, source, activate, lease: oldLease } = hostedDocumentFixture();
    const { invoke, calls } = nativeInvoke(({ command }) => {
      if (command === "bind_plugin_window_source") {
        return { sourceBindingId: sourceIds[nextSourceId++] };
      }
      return undefined;
    });
    const { bindings, onRevoked } = manager({ sources, invoke });
    const oldEntry = await bindings.ensure(oldLease);
    bindings.trackIntent(oldEntry, "old-intent");

    const newer = activate("page-two", NONCE_TWO);
    expect(newer.lease.source).toBe(source);
    expect(newer.lease.identity.generation).toBeGreaterThan(oldLease.identity.generation);
    const newEntry = await bindings.ensure(newer.lease);

    expect(newEntry.sourceBindingId).toBe(SOURCE_BINDING_TWO);
    expect(oldEntry.revoked).toBe(true);
    expect(bindings.isEntryCurrent(oldEntry)).toBe(false);
    expect(() => bindings.trackIntent(oldEntry, "too-late")).toThrow(/SOURCE_STALE/);
    expect(calls).toContainEqual({
      command: "cancel_plugin_browser_window_intent",
      args: { intentId: "old-intent" },
    });
    expect(calls).not.toContainEqual({
      command: "close_plugin_browser_windows",
      args: { sourceBindingId: SOURCE_BINDING_ONE },
    });
    expect(calls).toContainEqual({
      command: "close_plugin_window_source",
      args: { sourceBindingId: SOURCE_BINDING_ONE },
    });
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(bindings.entries()).toEqual([newEntry]);
  });

  it("cancels outstanding intents and closes the source binding on unload", async () => {
    const fixture = hostedDocumentFixture();
    const { invoke, calls } = nativeInvoke(({ command }) => {
      if (command === "bind_plugin_window_source") return { sourceBindingId: SOURCE_BINDING_ONE };
      return undefined;
    });
    const { bindings, onRevoked } = manager({ sources: fixture.sources, invoke });
    const entry = await bindings.ensure(fixture.lease);
    bindings.trackIntent(entry, "intent-to-cancel");
    bindings.trackIntent(entry, "intent-already-finished");
    bindings.finishIntent(entry, "intent-already-finished");
    bindings.trackWindow(entry, "native-window-1");

    await bindings.closeAll();

    expect(calls).toContainEqual({
      command: "cancel_plugin_browser_window_intent",
      args: { intentId: "intent-to-cancel" },
    });
    expect(calls).not.toContainEqual({
      command: "cancel_plugin_browser_window_intent",
      args: { intentId: "intent-already-finished" },
    });
    expect(calls).not.toContainEqual({
      command: "close_plugin_browser_windows",
      args: { sourceBindingId: SOURCE_BINDING_ONE },
    });
    expect(calls).toContainEqual({
      command: "close_plugin_window_source",
      args: { sourceBindingId: SOURCE_BINDING_ONE },
    });
    expect(entry.revoked).toBe(true);
    expect(bindings.isEntryCurrent(entry)).toBe(false);
    expect(bindings.entries()).toEqual([]);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });
});
