// @vitest-environment node
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginDataBridge, pluginDataBridgeScript } from "../../src/lib/pluginDataBridge";

const endpoint = "http://127.0.0.1:12345/data/" + "a".repeat(64);
const successor = endpoint.replace(/a{64}$/, "b".repeat(64));
const instanceId = "fbe106e1-87f6-430c-b1d0-8688dd88ab14";
const config = { instanceId, endpoint };
const maxBinary = 256 * 1024, maxRequest = 512 * 1024;

class Request {
  static requests: Request[] = [];
  static result: unknown = null;
  status = 200; responseText = ""; asynchronous = false; timeout = 0; aborted = false;
  body = ""; target = "";
  onload?: () => void; onerror?: () => void; ontimeout?: () => void; onabort?: () => void;
  open(method: string, target: string, asynchronous: boolean) {
    expect(method).toBe("POST"); this.target = target; this.asynchronous = asynchronous;
  }
  setRequestHeader(name: string, value: string) { expect([name, value]).toEqual(["Content-Type", "application/json"]); }
  send(body: string) {
    this.body = body; Request.requests.push(this);
    if (!this.asynchronous) this.responseText = JSON.stringify({ ok: true, result: Request.result });
  }
  complete(result: unknown) { this.responseText = JSON.stringify({ ok: true, result }); this.onload?.(); }
  abort() { this.aborted = true; this.onabort?.(); }
}

function native() {
  Request.requests = []; Request.result = null;
  vi.stubGlobal("XMLHttpRequest", Request);
  return createPluginDataBridge(config, vi.fn());
}

function scriptFixture(initial = { instanceId }) {
  const handlers = new Map<string, ((event: any) => void)[]>();
  const parent = { postMessage: vi.fn() };
  const window: any = { utools: {}, ztools: {} };
  const script = pluginDataBridgeScript(initial);
  runInNewContext(script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""), {
    window, parent, TextEncoder, XMLHttpRequest: Request, btoa, atob,
    addEventListener(name: string, callback: (event: any) => void) {
      handlers.set(name, [...handlers.get(name) ?? [], callback]);
    },
  });
  const dispatch = (name: string, event: any = {}) => handlers.get(name)?.forEach(callback => callback(event));
  return { window, parent, script, dispatch };
}

afterEach(() => vi.unstubAllGlobals());

describe("synchronous SQLite data bridge", () => {
  it("keeps the webStorage API synchronous and exposes only async event lookup", async () => {
    const sync = vi.fn((_endpoint, payload) => payload.method === "webStorage.getItem" ? "AA==" : null);
    const asyncTransport = vi.fn(async (_endpoint, payload) => payload.method === "webStorage.event"
      ? { clientId: "a".repeat(32), url: "file:///other/index.html", key: null, oldValue: null, newValue: null } : null);
    const bridge = createPluginDataBridge(config, vi.fn(), { sync, async: asyncTransport });
    expect(bridge.webStorage.getItem("a".repeat(32), "file:///p", "awA=")).toBe("AA==");
    expect(sync.mock.calls[0][1]).toEqual({ method: "webStorage.getItem", args: ["a".repeat(32), "file:///p", "awA="] });
    expect(bridge.webStorage.keys("client", "url")).toBeNull();
    sync.mockImplementation((_endpoint, payload) => payload.method === "webStorage.entries"
      ? { entries: [], nextOffset: null } : null);
    expect(bridge.webStorage.entries("client", "url", 0)).toEqual({ entries: [], nextOffset: null });
    expect(sync.mock.calls.at(-1)?.[1]).toEqual({ method: "webStorage.entries", args: ["client", "url", 0] });
    const event = bridge.webStorageAsync.event("b".repeat(32), "file:///p", "c".repeat(32));
    expect(event).toBeInstanceOf(Promise);
    await expect(event).resolves.toMatchObject({ clientId: "a".repeat(32) });
    expect(asyncTransport.mock.calls[0][1]).toEqual({ method: "webStorage.event", args: ["b".repeat(32), "file:///p", "c".repeat(32)] });
    expect(sync.mock.calls.some(([, payload]) => payload.method === "webStorage.event")).toBe(false);
    const closed = createPluginDataBridge(config, vi.fn(), { async: () => new Promise(() => {}) });
    const pending = closed.webStorageAsync.event("d".repeat(32), "file:///p", "e".repeat(32));
    const rejected = expect(pending).rejects.toThrow("CLOSED");
    closed.close();
    await rejected;
  });

  it("bounds webStorage transport data before crossing into the synchronous or async bridge", () => {
    const sync = vi.fn(() => null);
    const asyncTransport = vi.fn(async () => null);
    const bridge = createPluginDataBridge(config, vi.fn(), { sync, async: asyncTransport });
    expect(() => bridge.webStorage.setItem("a".repeat(32), "file:///p", "x".repeat(600_000), "v")).toThrow("LIMIT");
    expect(() => bridge.webStorageAsync.event("a".repeat(32), "file:///p", "x".repeat(600_000))).toThrow("LIMIT");
    expect(sync).not.toHaveBeenCalled(); expect(asyncTransport).not.toHaveBeenCalled();
    sync.mockImplementation((_target, payload) => payload.method === "webStorage.entries" ? { entries: [], nextOffset: null } : null);
    expect(bridge.webStorage.entries("client", "url", 0)).toEqual({ entries: [], nextOffset: null });
    expect(sync.mock.calls.at(-1)?.[1].method).toBe("webStorage.entries");
  });

  it("returns real non-Promise values and preserves logical conflict results", () => {
    const sync = vi.fn((_target, payload) => payload.method === "db.get" ? null : { id: "key", error: true, name: "conflict" });
    const bridge = createPluginDataBridge(config, vi.fn(), { sync });
    expect(bridge.db.get("missing")).toBeNull();
    const conflict = bridge.db.put({ _id: "key" });
    expect(conflict).toEqual({ id: "key", error: true, name: "conflict" });
    expect(conflict).not.toBeInstanceOf(Promise);
    expect(bridge.dbStorage.setItem("key", 1)).toEqual(conflict);
    const wrong = createPluginDataBridge(config, vi.fn(), { sync: () => Promise.resolve(null) });
    expect(() => wrong.db.get("key")).toThrow("RESPONSE");
  });

  it("uses asynchronous native I/O for promises rather than wrapping a synchronous call", async () => {
    const bridge = native();
    Request.result = { _id: "sync", value: 1 };
    expect(bridge.db.get("sync")).toEqual(Request.result);
    expect(Request.requests[0].asynchronous).toBe(false);
    const result = bridge.db.promises.get("async") as Promise<unknown>;
    expect(result).toBeInstanceOf(Promise);
    const request = Request.requests[1];
    expect(request.asynchronous).toBe(true); expect(request.timeout).toBe(8000);
    let settled = false; void result.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    request.complete({ _id: "async", value: 2 });
    await expect(result).resolves.toEqual({ _id: "async", value: 2 });
    expect(JSON.parse(request.body)).toEqual({ method: "db.get", args: ["async"] });
  });

  it("requests authorization once without arguments and never queues or replays private calls", async () => {
    const permission = vi.fn(), sync = vi.fn(() => null);
    const bridge = createPluginDataBridge({ instanceId }, permission, { sync });
    const privateDocument = { _id: "PRIVATE_KEY", toJSON: vi.fn(() => ({ private: "PRIVATE_BODY" })) };
    expect(() => bridge.db.put(privateDocument)).toThrow("PERMISSION_REQUIRED");
    await expect(bridge.db.promises.put(privateDocument)).rejects.toThrow("PERMISSION_REQUIRED");
    bridge.install();
    expect(() => bridge.db.get("ANOTHER_PRIVATE_KEY")).toThrow("PERMISSION_REQUIRED");
    expect(permission.mock.calls).toEqual([[]]); expect(privateDocument.toJSON).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled(); bridge.install(endpoint);
    expect(sync).not.toHaveBeenCalled(); bridge.db.get("explicit-new-call");
    expect(sync.mock.calls).toEqual([[endpoint, { method: "db.get", args: ["explicit-new-call"] }]]);
  });

  it("snapshots the serialized request once and stops a call closed by a serialization hook", async () => {
    let saved: unknown;
    const bridge = createPluginDataBridge(config, vi.fn(), { async: async (_endpoint, payload) => { saved = payload; return null; } });
    const document = { _id: "key", value: 1 };
    const request = bridge.db.promises.put(document); document.value = 2;
    await request;
    expect(saved).toEqual({ method: "db.put", args: [{ _id: "key", value: 1 }] });
    const sync = vi.fn(); const closed = createPluginDataBridge(config, vi.fn(), { sync });
    expect(() => closed.db.put({ toJSON() { closed.close(); return { _id: "key" }; } })).toThrow("CLOSED");
    expect(sync).not.toHaveBeenCalled();
  });

  it("keeps dbStorage synchronous and maps only confirmed successful void writes to undefined", () => {
    const sync = vi.fn((_endpoint, payload) => payload.method === "dbStorage.getItem" ? { nested: true } : null);
    const bridge = createPluginDataBridge(config, vi.fn(), { sync });
    expect(bridge.dbStorage.getItem("key")).toEqual({ nested: true });
    expect(bridge.dbStorage.setItem("key", { nested: true })).toBeUndefined();
    expect(bridge.dbStorage.removeItem("key")).toBeUndefined();
    expect(sync.mock.calls.map(([, payload]) => payload.method)).toEqual(["dbStorage.getItem", "dbStorage.setItem", "dbStorage.removeItem"]);
    expect(() => createPluginDataBridge(config, vi.fn(), { sync: () => { throw Error("denied"); } }).dbStorage.setItem("key", 1)).toThrow("denied");
    expect(() => createPluginDataBridge(config, vi.fn(), { sync: () => false }).dbStorage.setItem("key", 1)).toThrow("RESPONSE");
  });
});

describe("attachment compatibility and budgets", () => {
  it("normalizes official three arguments and named four/five argument extensions", () => {
    const sync = vi.fn(() => ({ ok: true, id: "doc", rev: "1-real" }));
    const bridge = createPluginDataBridge(config, vi.fn(), { sync });
    const bytes = new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4);
    bridge.db.postAttachment("doc", bytes, "text/plain");
    bridge.db.postAttachment("doc", "named", bytes, "text/plain");
    bridge.db.putAttachment("doc", "old-revision", "named-5", bytes, "text/plain");
    expect(sync.mock.calls.map(([, payload]) => payload)).toEqual([
      { method: "db.postAttachment", args: ["doc", "YWJj", "text/plain"] },
      { method: "db.postAttachment", args: ["doc", "YWJj", "text/plain", "named"] },
      { method: "db.postAttachment", args: ["doc", "YWJj", "text/plain", "named-5"] },
    ]);
    expect(() => bridge.db.postAttachment("doc", bytes)).toThrow("arguments");
    expect(() => bridge.db.postAttachment("doc", bytes, "x", "x", "x", "x")).toThrow("arguments");
  });

  it("accepts genuine cross-realm ArrayBuffers, views and Node Buffers without extra backing bytes", () => {
    const sync = vi.fn(() => null), bridge = createPluginDataBridge(config, vi.fn(), { sync });
    for (const bytes of [runInNewContext("new Uint8Array([97,98,99]).buffer"), runInNewContext("new DataView(new Uint8Array([0,97,98,99,0]).buffer,1,3)"), Buffer.from("abc")]) {
      bridge.db.postAttachment("doc", bytes, "text/plain");
      expect(sync.mock.calls.at(-1)?.[1].args[1]).toBe("YWJj");
    }
    expect(() => bridge.db.postAttachment("doc", { [Symbol.toStringTag]: "ArrayBuffer" }, "text/plain")).toThrow("ArrayBuffer");
  });

  it("returns binary bytes or null and passes the real metadata object through unchanged", async () => {
    const metadata = { type: "text/plain", length: 3, md5: "actual", digest: "md5-actual", name: "default", revpos: 7 };
    const result = (payload: { method: string; args: unknown[] }) => payload.method === "db.getAttachmentType" ? metadata : payload.args[0] === "missing" ? null : { base64: "YWJj" };
    const bridge = createPluginDataBridge(config, vi.fn(), { sync: (_target, payload) => result(payload), async: async (_target, payload) => result(payload) });
    expect(Array.from(bridge.db.getAttachment("doc") as Uint8Array)).toEqual([97, 98, 99]);
    expect(bridge.db.getAttachment("missing")).toBeNull();
    expect(bridge.db.getAttachmentType("doc")).toBe(metadata);
    expect(await bridge.db.promises.getAttachmentType("doc")).toBe(metadata);
    expect(Array.from(await bridge.db.promises.getAttachment("doc") as Uint8Array)).toEqual([97, 98, 99]);
    for (const value of [undefined, "abc", { base64: "!" }, { base64: "YR==" }]) {
      const malformed = createPluginDataBridge(config, vi.fn(), { sync: () => value });
      expect(() => malformed.db.getAttachment("doc")).toThrow("RESPONSE");
    }
  });

  it("enforces 256KiB binary/document and 512KiB UTF-8 aggregate request/response bounds", () => {
    const sync = vi.fn(() => null), bridge = createPluginDataBridge(config, vi.fn(), { sync });
    bridge.db.postAttachment("exact", new Uint8Array(maxBinary), "x");
    expect(() => bridge.db.postAttachment("overflow", new Uint8Array(maxBinary + 1), "x")).toThrow("LIMIT");
    expect(() => bridge.db.put({ _id: "doc", value: "界".repeat(90_000) })).toThrow("LIMIT");
    expect(() => bridge.dbStorage.setItem("doc", "界".repeat(90_000))).toThrow("LIMIT");
    expect(() => bridge.db.bulkDocs(Array.from({ length: 3 }, (_, index) => ({ _id: String(index), value: "x".repeat(200_000) })))).toThrow("LIMIT");
    expect(sync).toHaveBeenCalledTimes(1);
    const large = createPluginDataBridge(config, vi.fn(), { sync: () => "x".repeat(maxRequest) });
    expect(() => large.db.get("doc")).toThrow("LIMIT");
    const binary = createPluginDataBridge(config, vi.fn(), { sync: () => ({ base64: Buffer.alloc(maxBinary + 1).toString("base64") }) });
    expect(() => binary.db.getAttachment("doc")).toThrow("LIMIT");
  });
});

describe("endpoint and session lifetime", () => {
  it("accepts only an exact bounded loopback endpoint", () => {
    for (const value of [endpoint.replace("127.0.0.1", "localhost"), endpoint.replace("http:", "https:"), endpoint.replace(":12345", ":0"), endpoint.replace(":12345", ":65536"), endpoint + "?query", endpoint + "#fragment", endpoint.replace("/data/", "/host/"), endpoint.replace("a".repeat(64), "A".repeat(64)), null, 42]) {
      expect(() => createPluginDataBridge({ instanceId, endpoint: value as string }, vi.fn())).toThrow("CONFIG");
    }
  });

  it("aborts native requests and rejects late results after close without reopening", async () => {
    const bridge = native(); const pending = bridge.db.promises.get("private") as Promise<unknown>;
    const rejected = expect(pending).rejects.toThrow("CLOSED"); const request = Request.requests[0];
    bridge.close(); bridge.close(); await rejected;
    expect(request.aborted).toBe(true); request.complete("late");
    bridge.install(successor); expect(() => bridge.db.get("key")).toThrow("CLOSED");
    await expect(bridge.db.promises.get("key")).rejects.toThrow("CLOSED");
  });

  it("invalidates custom async operations immediately on replacement, including falsy rejections", async () => {
    let resolve!: (value: unknown) => void;
    const bridge = createPluginDataBridge(config, vi.fn(), { async: () => new Promise(done => { resolve = done; }) });
    const pending = bridge.db.promises.get("key") as Promise<unknown>;
    const rejected = expect(pending).rejects.toThrow("SESSION"); bridge.install(successor); await rejected;
    resolve("late"); await Promise.resolve();
    const failure = createPluginDataBridge(config, vi.fn(), { async: () => Promise.reject(undefined) });
    await expect(failure.db.promises.get("key")).rejects.toBeUndefined();
  });

  it("rejects failed, malformed and over-budget native responses without inventing results", async () => {
    for (const [status, text, code] of [[403, "{}", "SESSION"], [200, "{", "RESPONSE"], [200, '{"ok":true}', "RESPONSE"], [200, '{"ok":false,"error":{"message":"PRIVATE"}}', "REJECTED"], [200, "x".repeat(maxRequest + 1), "LIMIT"]] as const) {
      const bridge = native(); const request = bridge.db.promises.get("key") as Promise<unknown>;
      const result = expect(request).rejects.toThrow(code); const xhr = Request.requests[0];
      xhr.status = status; xhr.responseText = text; xhr.onload?.(); await result;
    }
  });
});

describe("serialized opaque-frame script", () => {
  it("runs in a VM, exposes both aliases and checks the exact parent and instance", () => {
    Request.requests = []; Request.result = { _id: "ready" };
    const f = scriptFixture();
    expect(f.window.utools.db).toBe(f.window.ztools.db);
    expect(() => f.window.utools.db.put({ _id: "SECRET", text: "BODY" })).toThrow("PERMISSION_REQUIRED");
    expect(f.parent.postMessage.mock.calls).toEqual([[{ __atools_plugin_data_open__: true, instanceId }, "*"]]);
    for (const [source, id, marker] of [[{}, instanceId, true], [f.parent, "stale", true], [f.parent, instanceId, 1]]) {
      f.dispatch("message", { source, data: { __atools_plugin_data_session__: marker, instanceId: id, endpoint } });
      expect(() => f.window.utools.db.get("private")).toThrow("PERMISSION_REQUIRED");
    }
    f.dispatch("message", { source: f.parent, data: { __atools_plugin_data_session__: true, instanceId, endpoint } });
    expect(Request.requests).toHaveLength(0); expect(f.window.utools.db.get("ready")).toEqual({ _id: "ready" });
    f.dispatch("pagehide"); expect(() => f.window.ztools.db.get("key")).toThrow("CLOSED");
  });

  it("escapes executable config text and closes on out or an invalid trusted delivery", () => {
    const malicious = '</script><script>globalThis.pwned=true</script>\u2028\u2029';
    const f = scriptFixture({ instanceId: malicious });
    expect(f.script.match(/<\/script>/g)).toHaveLength(1);
    expect(f.script).not.toContain("<script>globalThis.pwned");
    expect(() => f.window.utools.db.get("key")).toThrow("PERMISSION_REQUIRED");
    expect(f.parent.postMessage.mock.calls[0][0].instanceId).toBe(malicious);
    for (const end of ["out", "invalid"]) {
      const frame = scriptFixture();
      if (end === "out") frame.dispatch("atools-plugin-out");
      else frame.dispatch("message", { source: frame.parent, data: { __atools_plugin_data_session__: true, instanceId, endpoint: "https://invalid" } });
      expect(() => frame.window.utools.db.get("key")).toThrow("CLOSED");
    }
  });
});
