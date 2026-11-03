// @vitest-environment node
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createPluginLocalStorage } from "../../src/lib/pluginLocalStorage";
import { pluginDataBridgeScript } from "../../src/lib/pluginDataBridge";

const instanceId = "fbe106e1-87f6-430c-b1d0-8688dd88ab14";
const url = "file:///plugins/example/index.html?one=2";
function stringB64(value: string) {
  const bytes = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); bytes[i * 2] = code & 255; bytes[i * 2 + 1] = code >>> 8; }
  return Buffer.from(bytes).toString("base64");
}
function b64String(value: string) {
  const bytes = Buffer.from(value, "base64");
  let result = "";
  for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  return result;
}
function fixture(options: {
  native?: object;
  getterError?: string;
  invoke?: (method: string, args: unknown[]) => unknown;
  invokeAsync?: (method: string, args: unknown[]) => Promise<unknown>;
  storageEventAcceptsProxy?: boolean;
  noStorageEvent?: boolean;
  noCrypto?: boolean;
} = {}) {
  const listeners = new Map<string, Set<(event: any) => void>>(), parent = {}, events: Event[] = [];
  const request = vi.fn(options.invoke ?? (() => null)), requestAsync = vi.fn(options.invokeAsync ?? (async () => null));
  const window: any = {
    parent, location: { href: url }, crypto: options.noCrypto ? undefined : { getRandomValues(bytes: Uint8Array) { bytes.fill(0x2a); return bytes; } },
    Storage: class Storage {
      get length() { return 0; }
      getItem() {}
      setItem() {}
      removeItem() {}
      clear() {}
      key() {}
    }, __ATOOLS_FRAME_TRANSPORT__: { accept: vi.fn(() => true) },
    queueMicrotask,
    addEventListener(name: string, callback: (event: any) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: (event: any) => void) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event: Event) { events.push(event); return true; },
  };
  if (options.native) Object.defineProperty(window, "localStorage", { configurable: true, get: () => options.native });
  else Object.defineProperty(window, "localStorage", { configurable: true, get() {
    throw new DOMException("opaque", options.getterError ?? "SecurityError");
  } });
  class TestStorageEvent extends Event {
    key: string | null; oldValue: string | null; newValue: string | null; url: string; storageArea: unknown;
    constructor(type: string, init: any) {
      super(type);
      if (!options.storageEventAcceptsProxy && init.storageArea !== null) throw new TypeError("StorageEvent requires a Storage object");
      this.key = init.key; this.oldValue = init.oldValue; this.newValue = init.newValue; this.url = init.url; this.storageArea = init.storageArea;
    }
  }
  const context = { window, DOMException, TextEncoder, Uint8Array, Array, Object, String, Number, Math, Set, Map, Proxy, Reflect,
    Symbol, TypeError, Event, ...(options.noStorageEvent ? {} : { StorageEvent: TestStorageEvent }), btoa, atob, setTimeout, clearTimeout };
  const factory = runInNewContext("(" + createPluginLocalStorage.toString() + ")", context) as
    (config: { instanceId: string }, invoke: (method: string, args: unknown[]) => unknown,
      invokeAsync: (method: string, args: unknown[]) => Promise<unknown>) => { installed: boolean; storage?: any; close: () => void };
  const adapter = factory({ instanceId }, request, requestAsync);
  return { window, parent, listeners, events, request, requestAsync, adapter, storageEvent: TestStorageEvent,
    dispatch(name: string, event: any = {}) { for (const callback of [...(listeners.get(name) ?? [])]) callback(event); } };
}
function mapTransport() {
  const values = new Map<string, string>(), calls: [string, unknown[]][] = [];
  const call = (method: string, args: unknown[]) => {
    calls.push([method, args]);
    const [client, source, ...rest] = args as [string, string, ...unknown[]];
    expect(client).toMatch(/^[0-9a-f]{32}$/); expect(source).toBe(url);
    const key = b64String(String(rest[0] ?? ""));
    if (method === "getItem") return values.has(key) ? stringB64(values.get(key)!) : null;
    if (method === "length") return values.size;
    if (method === "keys") return [...values.keys()].map(stringB64);
    if (method === "entries") {
      const offset = Number(rest[0]), all = [...values.entries()], page = all.slice(offset, offset + 64);
      return { entries: page.map(([entryKey, value]) => ({ key: stringB64(entryKey), value: stringB64(value) })),
        nextOffset: offset + page.length < all.length ? offset + page.length : null };
    }
    if (method === "key") {
      const value = [...values.keys()][Number(rest[0])];
      return value === undefined ? null : stringB64(value);
    }
    if (method === "setItem") {
      const value = b64String(String(rest[1])), oldValue = values.has(key) ? stringB64(values.get(key)!) : null;
      values.set(key, value);
      return { key: stringB64(key), oldValue, newValue: stringB64(value), changed: oldValue !== stringB64(value) };
    }
    if (method === "removeItem") {
      const oldValue = values.has(key) ? stringB64(values.get(key)!) : null; values.delete(key);
      return { key: stringB64(key), oldValue, newValue: null, changed: oldValue !== null };
    }
    if (method === "clear") { values.clear(); return { key: null, oldValue: null, newValue: null, changed: true }; }
    throw new Error("unexpected operation " + method);
  };
  return { values, calls, call };
}
function hostEvent(eventId = "b".repeat(32)) {
  return { __atools_web_storage_event__: true, instanceId, eventId };
}

describe("opaque plugin localStorage adapter", () => {
  it("preserves usable native storage and installs only for a SecurityError getter", () => {
    const native = { marker: true }, ordinary = fixture({ native });
    expect(ordinary.adapter.installed).toBe(false); expect(ordinary.adapter.storage).toBe(native);
    expect(ordinary.request).not.toHaveBeenCalled();
    const denied = fixture({ getterError: "NotAllowedError" });
    expect(denied.adapter.installed).toBe(false);
    const unavailable = fixture({ noCrypto: true });
    expect(unavailable.adapter.installed).toBe(false);
  });

  it("implements Storage methods, property access, enumeration, deletion and exact UTF-16 wire encoding", () => {
    const backend = mapTransport(), f = fixture({ invoke: backend.call });
    const store = f.window.localStorage, odd = "key\ud800", value = "value\udfff\0";
    expect(f.adapter.installed).toBe(true);
    store.setItem(odd, value);
    expect(store.getItem(odd)).toBe(value); expect(store[odd]).toBe(value);
    expect(store.missing).toBeUndefined(); expect(store.getItem("missing")).toBeNull();
    expect(store.length).toBe(1); expect(store.key(0)).toBe(odd); expect(store.key(1)).toBeNull();
    expect(Object.keys(store)).toEqual([odd]);
    expect(Object.getOwnPropertyDescriptor(store, odd)).toMatchObject({ enumerable: true, configurable: true, writable: true, value });
    expect(odd in store).toBe(true); expect("missing" in store).toBe(false);
    expect(backend.calls[0]).toEqual(["setItem", [expect.stringMatching(/^[0-9a-f]{32}$/), url, stringB64(odd), stringB64(value)]]);
    delete store[odd];
    expect(store.getItem(odd)).toBeNull();
    store.setItem("getItem", "stored method name");
    store.setItem("length", "stored length name");
    store.setItem("toString", "stored prototype name");
    expect(typeof store.getItem).toBe("function");
    expect(store.getItem("getItem")).toBe("stored method name");
    expect(store.length).toBe(3);
    expect(typeof store.toString).toBe("function");
    expect(Object.keys(store)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(store, "getItem")).toBeUndefined();
    delete store.toString;
    expect(store.getItem("toString")).toBe("stored prototype name");
    store.setItem("again", "1"); store.clear();
    expect(store.length).toBe(0);
    expect(backend.calls.some(([method]) => method === "event")).toBe(false);
  });

  it("matches required argument, Symbol, unsigned index and String coercion semantics", () => {
    const backend = mapTransport(), f = fixture({ invoke: backend.call }), store = f.window.localStorage;
    expect(() => store.getItem()).toThrow(TypeError); expect(() => store.setItem("key")).toThrow(TypeError);
    expect(() => store.removeItem()).toThrow(TypeError); expect(() => store.key()).toThrow(TypeError);
    expect(() => store.getItem(Symbol("x"))).toThrow(TypeError);
    expect(() => store.setItem("key", Symbol("x"))).toThrow(TypeError);
    expect(() => store.key(Symbol("x"))).toThrow(expect.objectContaining({ name: "TypeError" }));
    expect(() => store.key(1n)).toThrow(expect.objectContaining({ name: "TypeError" }));
    const objectKey = { [Symbol.toPrimitive](hint: string) { expect(hint).toBe("string"); return 5; } };
    store.setItem(objectKey, { toString: () => "v" });
    expect(store.getItem("5")).toBe("v");
    const cyclic: any = { [Symbol.toPrimitive]() { return cyclic; } };
    expect(() => store.getItem(cyclic)).toThrow(expect.objectContaining({ name: "TypeError" }));
    expect(backend.calls.at(-1)?.[1][2]).toBe(stringB64("5"));
    expect(store.key(-1)).toBeNull();
  });

  it("turns host failures into DOMExceptions and never caches or replays a denied mutation", () => {
    const permission = vi.fn();
    const denied = fixture({ invoke: () => {
      permission(); throw Object.assign(Error("denied"), { code: "ERR_ATOOLS_DATA_PERMISSION_REQUIRED" });
    } });
    const store = denied.window.localStorage;
    expect(() => store.setItem("private-key", "private-value")).toThrow(expect.objectContaining({ name: "SecurityError" }));
    expect(permission).toHaveBeenCalledTimes(1);
    denied.adapter.close();
    expect(() => store.getItem("private-key")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    const quota = fixture({ invoke: () => ({ error: true, name: "QuotaExceededError", message: "fixed" }) });
    expect(() => quota.window.localStorage.setItem("k", "v")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(() => quota.window.localStorage.getItem("k")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    const malformed = fixture({ invoke: () => ({ ok: true }) });
    expect(() => malformed.window.localStorage.setItem("k", "v")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
  });

  it("rejects over-budget host values and key lists without exposing malformed storage", () => {
    const tooLargeValue = fixture({ invoke: () => Buffer.alloc(128 * 1024 + 2).toString("base64") });
    expect(() => tooLargeValue.window.localStorage.getItem("k")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    const tooManyKeys = fixture({ invoke: method => method === "length" ? 4096 : Array.from({ length: 4097 }, () => stringB64("k")) });
    expect(tooManyKeys.window.localStorage.length).toBe(4096);
    expect(() => Object.keys(tooManyKeys.window.localStorage)).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    const tooLongUrl = fixture({ invoke: () => null });
    tooLongUrl.window.location.href = "x".repeat(8193);
    expect(() => tooLongUrl.window.localStorage.getItem("k")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    expect(tooLongUrl.request).not.toHaveBeenCalled();
  });

  it("rejects oversized keys and values before allocating wire bytes or invoking the bridge", () => {
    const f = fixture({ invoke: () => null }), store = f.window.localStorage;
    const longKey = "k".repeat(1025), longValue = "v".repeat(65_537);
    expect(() => store.getItem(longKey)).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(() => store.removeItem(longKey)).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(() => store.setItem(longKey, "v")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(() => store.setItem("k", longValue)).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(() => store[longKey]).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(() => Object.getOwnPropertyDescriptor(store, longKey)).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(f.request).not.toHaveBeenCalled();
  });

  it("enumerates 4096 entries with bounded pagination and consumes same-turn descriptor snapshots", () => {
    const backend = mapTransport();
    for (let index = 0; index < 4096; index++) backend.values.set("k" + index, "v" + index);
    const f = fixture({ invoke: backend.call }), store = f.window.localStorage;
    const keys = Object.keys(store);
    expect(keys).toHaveLength(4096);
    expect(keys[0]).toBe("k0"); expect(keys.at(-1)).toBe("k4095");
    const pages = backend.calls.filter(([method]) => method === "entries");
    expect(pages).toHaveLength(64);
    expect(pages.map(([, args]) => args[2])).toEqual(Array.from({ length: 64 }, (_, index) => index * 64));
    expect(backend.calls.filter(([method]) => method === "getItem")).toHaveLength(0);
  });

  it("uses one live read for a standalone descriptor and clears snapshots on mutation or microtask", async () => {
    const backend = mapTransport(), f = fixture({ invoke: backend.call }), store = f.window.localStorage;
    backend.values.set("k", "before");
    expect(Object.getOwnPropertyDescriptor(store, "k")?.value).toBe("before");
    expect(backend.calls.filter(([method]) => method === "getItem")).toHaveLength(1);

    Reflect.ownKeys(store);
    backend.values.set("k", "external");
    store.setItem("other", "write");
    expect(Object.getOwnPropertyDescriptor(store, "k")?.value).toBe("external");
    Reflect.ownKeys(store);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    backend.values.set("k", "after-turn");
    expect(Object.getOwnPropertyDescriptor(store, "k")?.value).toBe("after-turn");
  });

  it("rejects malformed, non-progressing or over-budget entry pages", () => {
    const invalid = [
      { entries: [{ key: stringB64("k"), value: stringB64("v") }], nextOffset: 0 },
      { entries: [{ key: stringB64("k"), value: stringB64("v") }], nextOffset: 2 },
      { entries: [{ key: stringB64("k"), value: stringB64("v") }, { key: stringB64("k"), value: stringB64("v") }], nextOffset: null },
      { entries: [{ key: stringB64("k"), value: "!" }], nextOffset: null },
    ];
    for (const result of invalid) {
      const f = fixture({ invoke: method => method === "entries" ? result : null });
      expect(() => Object.keys(f.window.localStorage)).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    }
    const oversized = fixture({ invoke: () => ({ entries: [{ key: stringB64("k"), value: stringB64("x".repeat(200 * 1024)) }], nextOffset: null }) });
    expect(() => Object.keys(oversized.window.localStorage)).toThrow(expect.objectContaining({ name: "InvalidStateError" }));

    const tooManyPages = fixture({ invoke: (method, args) => method === "entries"
      ? { entries: [{ key: stringB64("k" + args[2]), value: stringB64("v") }], nextOffset: Number(args[2]) + 1 } : null });
    expect(() => Object.keys(tooManyPages.window.localStorage)).toThrow(expect.objectContaining({ name: "InvalidStateError" }));

    const keyBudgetEntries = Array.from({ length: 129 }, (_, index) => ({
      key: stringB64(String(index).padStart(4, "0") + "x".repeat(2044)), value: stringB64("v"),
    }));
    const tooManyKeyBytes = fixture({ invoke: (_method, args) => {
      const offset = Number(args[2]), page = keyBudgetEntries.slice(offset, offset + 64);
      return { entries: page, nextOffset: offset + page.length < keyBudgetEntries.length ? offset + page.length : null };
    } });
    expect(() => Object.keys(tooManyKeyBytes.window.localStorage)).toThrow(expect.objectContaining({ name: "InvalidStateError" }));

    const tooManyValueBytes = fixture({ invoke: (_method, args) => {
      const offset = Number(args[2]);
      return { entries: [{ key: stringB64("k" + offset), value: stringB64("v".repeat(64 * 1024)) }],
        nextOffset: offset < 40 ? offset + 1 : null };
    } });
    expect(() => Object.keys(tooManyValueBytes.window.localStorage)).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
  });

  it("fetches metadata-only storage events asynchronously and suppresses late results after close", async () => {
    let resolve!: (value: unknown) => void;
    const change = { clientId: "c".repeat(32), url: "file:///other/index.html", key: stringB64("k"), oldValue: null, newValue: stringB64("v") };
    const f = fixture({ invokeAsync: () => new Promise(done => { resolve = done; }) });
    const parentMessage = hostEvent(), store = f.window.localStorage;
    f.dispatch("message", { source: f.parent, data: parentMessage });
    f.dispatch("message", { source: f.parent, data: { ...parentMessage, change } });
    expect(f.requestAsync).toHaveBeenCalledTimes(1);
    expect(f.requestAsync.mock.calls[0]).toEqual(["event", [expect.stringMatching(/^[0-9a-f]{32}$/), url, "b".repeat(32)]]);
    expect(f.events).toHaveLength(0);
    f.adapter.close(); resolve(change);
    await Promise.resolve(); await new Promise(done => setTimeout(done, 0));
    expect(f.events).toHaveLength(0);
    expect(f.listeners.get("message")?.size).toBe(0);
    expect(() => store.getItem("k")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
  });

  it("preserves StorageEvent brand with readonly adapter storageArea and rejects bad sources, raw payloads, writer echoes and duplicates", async () => {
    const f = fixture({ invokeAsync: async () => ({
      clientId: "c".repeat(32), url: "file:///other/index.html",
      key: stringB64("k"), oldValue: null, newValue: stringB64("v"),
    }) });
    const valid = hostEvent("e".repeat(32));
    f.dispatch("message", { source: {}, data: valid });
    f.dispatch("message", { source: f.parent, data: { ...valid, instanceId: "stale" } });
    f.dispatch("message", { source: f.parent, data: { ...valid, change: { clientId: "c".repeat(32), key: stringB64("raw") } } });
    expect(f.requestAsync).not.toHaveBeenCalled();
    const writer = hostEvent("f".repeat(32));
    f.requestAsync.mockImplementationOnce(async () => ({ clientId: "2a".repeat(16), url, key: stringB64("k"), oldValue: null, newValue: stringB64("v") }));
    f.dispatch("message", { source: f.parent, data: writer });
    expect(f.requestAsync).toHaveBeenCalledTimes(1);
    const normal = hostEvent("1".repeat(32));
    f.dispatch("message", { source: f.parent, data: normal });
    f.dispatch("message", { source: f.parent, data: normal });
    expect(f.requestAsync).toHaveBeenCalledTimes(2);
    await new Promise(done => setTimeout(done, 10));
    expect(f.events).toHaveLength(1);
    const event = f.events[0] as StorageEvent;
    expect(event).toBeInstanceOf(f.storageEvent);
    expect(event.type).toBe("storage"); expect((event as any).key).toBe("k");
    expect((event as any).oldValue).toBeNull(); expect((event as any).newValue).toBe("v");
    expect((event as any).storageArea).toBe(f.window.localStorage);
    expect(Object.getOwnPropertyDescriptor(event, "key")?.set).toBeUndefined();
  });

  it("accepts a document envelope only after current transport validation", () => {
    const f = fixture({ invokeAsync: async () => null });
    const transport = f.window.__ATOOLS_FRAME_TRANSPORT__;
    const envelope = { pageDocumentId: "a".repeat(32), docNonce: "b".repeat(32), generation: 7 };
    const message = { __atools_web_storage_event__: true, instanceId, eventId: "c".repeat(32), __atoolsDocument: envelope };
    transport.accept.mockReturnValueOnce(false);
    f.dispatch("message", { source: f.parent, origin: "atools-panel://localhost", data: message });
    expect(f.requestAsync).not.toHaveBeenCalled();
    f.dispatch("message", { source: f.parent, origin: "atools-panel://localhost", data: { ...message, unexpected: true } });
    expect(f.requestAsync).not.toHaveBeenCalled();
    f.dispatch("message", { source: f.parent, origin: "atools-panel://localhost", data: message });
    expect(f.requestAsync).toHaveBeenCalledTimes(1);
    expect(f.requestAsync.mock.calls[0][0]).toBe("event");

    const noTransport = fixture({ invokeAsync: async () => null });
    delete noTransport.window.__ATOOLS_FRAME_TRANSPORT__;
    noTransport.dispatch("message", { source: noTransport.parent, data: message });
    expect(noTransport.requestAsync).not.toHaveBeenCalled();
  });

  it("keeps the readonly Event fallback only when StorageEvent construction is unavailable", async () => {
    const f = fixture({ noStorageEvent: true, invokeAsync: async () => ({ clientId: "c".repeat(32), url,
      key: stringB64("k"), oldValue: null, newValue: stringB64("v") }) });
    f.dispatch("message", { source: f.parent, data: hostEvent("d".repeat(32)) });
    await new Promise(done => setTimeout(done, 5));
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toBeInstanceOf(Event);
    expect(f.events[0]).not.toBeInstanceOf(f.storageEvent);
    expect((f.events[0] as any).storageArea).toBe(f.window.localStorage);
    expect(Object.getOwnPropertyDescriptor(f.events[0], "storageArea")?.set).toBeUndefined();
  });

  it("serializes the adapter after the data bridge and ties it to session close", () => {
    const script = pluginDataBridgeScript({ instanceId, endpoint: "http://127.0.0.1:12345/data/" + "a".repeat(64) });
    expect(script.indexOf("createPluginDataBridge")).toBeLessThan(script.indexOf("createPluginLocalStorage"));
    expect(script).toContain("webStorageAsync"); expect(script).toContain("adapter?.close()");
    expect(script).not.toContain("allow-same-origin");
  });

  it("runs the serialized data bridge before the adapter and revokes retained references on pagehide", () => {
    const listeners = new Map<string, ((event: any) => void)[]>(), calls: any[] = [];
    const parent = {}, utools: any = {}, ztools: any = {};
    class Xhr {
      status = 200; responseText = ""; target = ""; async = false;
      open(_method: string, target: string, async: boolean) { this.target = target; this.async = async; }
      setRequestHeader() {}
      send(body: string) {
        const payload = JSON.parse(body); calls.push({ target: this.target, payload, async: this.async });
        const result = payload.method === "webStorage.getItem" ? stringB64("stored")
          : payload.method === "webStorage.setItem"
            ? { key: payload.args[2], oldValue: null, newValue: payload.args[3], changed: true } : null;
        this.responseText = JSON.stringify({ ok: true, result });
      }
    }
    const window: any = {
      parent, utools, ztools, location: { href: url }, crypto: { getRandomValues(bytes: Uint8Array) { bytes.fill(0x2a); return bytes; } },
    Storage: class Storage {
      get length() { return 0; }
      getItem() {}
      setItem() {}
      removeItem() {}
      clear() {}
      key() {}
    }, __ATOOLS_FRAME_TRANSPORT__: { post: vi.fn(), accept: () => true },
      addEventListener(name: string, callback: (event: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), callback]); },
      removeEventListener(name: string, callback: (event: any) => void) {
        listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== callback));
      },
      dispatchEvent: vi.fn(() => true),
    };
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("opaque", "SecurityError"); } });
    const config = { instanceId, endpoint: "http://127.0.0.1:12345/data/" + "a".repeat(64) };
    const source = pluginDataBridgeScript(config).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    runInNewContext(source, { window, parent, XMLHttpRequest: Xhr, TextEncoder, DOMException, Uint8Array, Array, Object, String,
      Number, Math, Set, Map, Proxy, Reflect, Symbol, TypeError, Event, StorageEvent: class extends Event {},
      btoa, atob, addEventListener: (name: string, callback: (event: any) => void) => window.addEventListener(name, callback) });
    const savedStorage = window.localStorage;
    expect(utools.dbStorage).toBe(ztools.dbStorage);
    expect(savedStorage.getItem("a")).toBe("stored");
    savedStorage.setItem("k", "v");
    expect(calls.map(item => item.payload.method)).toEqual(["webStorage.getItem", "webStorage.setItem"]);
    expect(calls[0].payload.args).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), url, stringB64("a")]);
    expect(calls[1].payload.args).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), url, stringB64("k"), stringB64("v")]);
    for (const callback of listeners.get("pagehide") ?? []) callback({});
    expect(() => savedStorage.getItem("a")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    expect(() => window.localStorage).toThrow(expect.objectContaining({ name: "SecurityError" }));
  });
});
