import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  PluginFrameSourceRegistry, identifyPluginMessageEvent, pluginDocumentEnvelope, postPluginFrameMessageIfCurrent,
  runPluginFrameOperation,
} from "../../src/lib/pluginFrameDocumentIdentity";
import { dispatchPluginInvokeMessage } from "../../src/lib/pluginInvokePolicy";
import { createPluginFrameTransport, pluginFrameTransportScript } from "../../src/lib/pluginFrameTransport";

const ORIGIN = "atools-page://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost";
const PARENT = "atools-panel://localhost", ID = "a".repeat(32), NONCE = "b".repeat(32);
function fixture() {
  const posts: Array<{ data: unknown; origin: string }> = [];
  const source = { postMessage: (data: unknown, origin: string) => posts.push({ data, origin }) };
  const sources = new PluginFrameSourceRegistry();
  const reservation = sources.reserveDocument({ kind: "main", source, pageDocumentId: ID,
    expectedOrigin: ORIGIN, parentOrigin: PARENT });
  return { source, sources, reservation, posts };
}

describe("plugin document identity", () => {
  it("does not authorize reservations, legacy load registration, or source-only lookups", () => {
    const f = fixture();
    expect(f.sources.identify(f.source)).toBeNull();
    expect(f.sources.currentIdentityForHost(f.source)).toBeNull();
    f.sources.setMain(f.source);
    expect(f.sources.isReserved(f.reservation)).toBe(true);
    const identity = f.sources.activateDocument(f.reservation, NONCE)!;
    expect(f.sources.identify(f.source)).toBeNull();
    expect(f.sources.isCurrent(f.source, identity)).toBe(true);
    expect(f.sources.currentIdentityForHost(f.source)).toEqual(identity);
    expect(f.sources.activateDocument(f.reservation, NONCE)).toBeNull();
    f.sources.invalidateDocument(f.reservation);
    expect(f.sources.currentIdentityForHost(f.source)).toBeNull();
  });

  it("requires the exact source, origin, document id, nonce and generation", () => {
    const f = fixture(), identity = f.sources.activateDocument(f.reservation, NONCE)!;
    const data = { __ipc_call__: true, __atoolsDocument: pluginDocumentEnvelope(identity) };
    const event = { source: f.source, origin: ORIGIN, data };
    expect(identifyPluginMessageEvent(f.sources, event)).toEqual(identity);
    for (const change of [{ source: {} }, { origin: "null" }, { origin: PARENT }, { data: {} },
      { data: { ...data, __atoolsDocument: { ...data.__atoolsDocument, pageDocumentId: "other" } } },
      { data: { ...data, __atoolsDocument: { ...data.__atoolsDocument, docNonce: "c".repeat(32) } } },
      { data: { ...data, __atoolsDocument: { ...data.__atoolsDocument, generation: identity.generation + 1 } } }]) {
      expect(identifyPluginMessageEvent(f.sources, { ...event, ...change })).toBeNull();
    }
    f.sources.invalidateDocument(f.reservation);
    const next = f.sources.reserveDocument({ kind: "main", source: f.source, pageDocumentId: ID,
      expectedOrigin: ORIGIN, parentOrigin: PARENT });
    f.sources.activateDocument(next, NONCE);
    expect(identifyPluginMessageEvent(f.sources, event)).toBeNull();
    expect(f.sources.isCurrent(f.source, identity)).toBe(false);
  });

  it("derives reply origin/envelope from the registry and rejects results after cancellation", async () => {
    const f = fixture(), identity = f.sources.activateDocument(f.reservation, NONCE)!;
    expect(postPluginFrameMessageIfCurrent({ ...f, identity, message: { result: 1, __atoolsDocument: { bad: true } }, targetOrigin: "*" })).toBe(true);
    expect(f.posts).toEqual([{ origin: ORIGIN, data: { result: 1, __atoolsDocument: pluginDocumentEnvelope(identity) } }]);
    let complete!: (value: number) => void;
    const operation = runPluginFrameOperation({ ...f, identity, operation: () => new Promise<number>(resolve => { complete = resolve; }) });
    f.sources.invalidateDocument(f.reservation);
    complete(1);
    await expect(operation).rejects.toThrow("no longer active");
    expect(postPluginFrameMessageIfCurrent({ ...f, identity, message: { result: 2 } })).toBe(false);
    expect(f.posts).toHaveLength(1);
  });

  it("requires a captured document identity for invoke, including after permission waits", async () => {
    const f = fixture(), identity = f.sources.activateDocument(f.reservation, NONCE)!;
    let called = 0, authorize!: () => void;
    const options = { ...f, pluginId: "file-tree", message: { cmd: "copy_text", reqId: 1, args: { text: "synthetic" } },
      authorize: () => Promise.resolve(), invoke: async () => { called++; return 1; } };
    expect(await dispatchPluginInvokeMessage(options)).toEqual({ handled: false });
    const pending = dispatchPluginInvokeMessage({ ...options, identity,
      authorize: () => new Promise<void>(resolve => { authorize = resolve; }) });
    f.sources.invalidateDocument(f.reservation); authorize();
    await expect(pending).rejects.toThrow("no longer active");
    expect(called).toBe(0);
  });

  it("retains legacy opaque behavior and cancels a replaced reservation once", () => {
    const f = fixture(); let cancelled = 0;
    f.sources.onDocumentInvalidated(f.reservation, () => cancelled++);
    f.sources.clear(); f.sources.clear();
    expect(cancelled).toBe(1);
    f.sources.setMain(f.source);
    const identity = f.sources.identify(f.source)!;
    expect(f.sources.reply(f.source, identity, "legacy")).toBe(true);
    expect(f.posts).toEqual([{ data: "legacy", origin: "*" }]);
    f.sources.setMain(f.source);
    expect(f.sources.isCurrent(f.source, identity)).toBe(false);
  });
});

describe("host-generated frame transport", () => {
  function transportFixture(documentMode = true) {
    const posts: Array<{ data: unknown; origin: string }> = [], listeners = new Map<string, EventListenerOrEventListenerObject>();
    const parent = { postMessage: (data: unknown, origin: string) => posts.push({ data, origin }) };
    const target = { parent, __ATOOLS_BOOTSTRAP_HANDOFF__: { runId: ID, id: ID, docNonce: NONCE, generation: 7 },
      addEventListener: (kind: string, callback: EventListenerOrEventListenerObject) => listeners.set(kind, callback),
      removeEventListener: (kind: string) => listeners.delete(kind) };
    const transport = createPluginFrameTransport(target as unknown as Window,
      documentMode ? { pageDocumentId: ID, parentOrigin: PARENT } : {});
    return { target, parent, posts, listeners, transport };
  }
  it("binds own bridge messages without replacing parent.postMessage", () => {
    const f = transportFixture(), original = f.parent.postMessage;
    f.transport.post({ __ipc_call__: true, __atoolsDocument: { forged: true } });
    expect(f.parent.postMessage).toBe(original);
    const envelope = { pageDocumentId: ID, docNonce: NONCE, generation: 7 };
    expect(f.posts).toEqual([{ origin: PARENT, data: { __ipc_call__: true, __atoolsDocument: envelope } }]);
    const valid = { source: f.parent, origin: PARENT, data: { __atoolsDocument: envelope } } as unknown as MessageEvent;
    expect(f.transport.accept(valid)).toBe(true);
    for (const change of [{ source: {} }, { origin: "null" }, { data: {} },
      { data: { __atoolsDocument: { ...envelope, docNonce: "c".repeat(32) } } },
      { data: { __atoolsDocument: { ...envelope, generation: 8 } } }]) {
      expect(f.transport.accept({ ...valid, ...change } as MessageEvent)).toBe(false);
    }
    f.target.__ATOOLS_BOOTSTRAP_HANDOFF__ = { runId: ID, id: ID, docNonce: "c".repeat(32), generation: 8 };
    expect(f.transport.accept(valid)).toBe(true);
    expect(f.transport.ready()).toBe(true); expect(f.transport.ready()).toBe(false);
    f.transport.dispose();
    expect(f.transport.post({ result: 2 })).toBe(false);
    expect(f.transport.accept(valid)).toBe(false);
  });
  it("fails closed without the matching handoff and supports the opaque adapter", () => {
    expect(() => createPluginFrameTransport(window, { pageDocumentId: ID, parentOrigin: PARENT })).toThrow("BINDING");
    const f = transportFixture(false); f.transport.post({ legacy: true });
    expect(f.posts).toEqual([{ data: { legacy: true }, origin: "*" }]);
    expect(f.transport.ready()).toBe(false);
    expect(f.transport.accept({ source: {} } as MessageEvent)).toBe(false);
    expect(pluginFrameTransportScript({ pageDocumentId: "</script>" })).not.toContain('"</script>"');
  });
  it("executes the injected factory and reports ready after the original DOMContentLoaded handlers", () => {
    const f = transportFixture(), handlers: Array<() => void> = [], timers: Array<() => void> = [], order: string[] = [];
    f.parent.postMessage = (data, origin) => { order.push("post"); f.posts.push({ data, origin }); };
    const script = pluginFrameTransportScript({ pageDocumentId: ID, parentOrigin: PARENT });
    runInNewContext(script.slice("<script>".length, -"</script>".length), {
      window: f.target, document: { readyState: "loading", addEventListener: (_: string, callback: () => void) => handlers.push(callback) },
      setTimeout: (callback: () => void) => timers.push(callback),
    });
    expect(f.posts).toHaveLength(0);
    handlers.push(() => order.push("plugin-DOMContentLoaded"));
    for (const callback of handlers) callback();
    expect(f.posts).toHaveLength(0);
    for (const callback of timers) callback();
    expect(order).toEqual(["plugin-DOMContentLoaded", "post"]);
    expect(f.posts[0]?.data).toMatchObject({ kind: "atools-bootstrap-payload-ready", runId: ID, id: ID,
      __atoolsDocument: { pageDocumentId: ID, docNonce: NONCE, generation: 7 } });
  });
});
