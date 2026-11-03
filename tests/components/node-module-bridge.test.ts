import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNodeModuleRequire, nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";
import { createNodeModuleTransport } from "../../src/lib/nodeModuleTransport";
import type { EncodedNodeValue, NodeModuleTransport, NodePollResult } from "../../src/lib/nodeModuleProtocol";

const config = { endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` };
const value = (input: string | number | boolean | null): EncodedNodeValue => ({ kind: "value", value: input });
const handle = (handleId: number, callable = false, keys: string[] = []): EncodedNodeValue => ({ kind: "handle", handleId, callable, keys });
const absent: EncodedNodeValue = { kind: "undefined" };
const localRequireDescriptor = Object.getOwnPropertyDescriptor(window, "require");
const sessions: ReturnType<typeof makeNodeModuleRequire>[] = [];

afterEach(() => {
  sessions.splice(0).forEach((session) => session.close());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (localRequireDescriptor) Object.defineProperty(window, "require", localRequireDescriptor);
  else Reflect.deleteProperty(window, "require");
});

function fakeTransport(handler: (method: string, params: any, async: boolean) => unknown): NodeModuleTransport & {
  requestSync: ReturnType<typeof vi.fn>;
  requestAsync: ReturnType<typeof vi.fn>;
} {
  const release = (params: any) => ({ released: params.handleIds?.length ?? 0, callbacksReleased: params.callbackIds?.length ?? 0 });
  return {
    requestSync: vi.fn((method, params) => method === "release" ? release(params) : handler(method, params, false)),
    requestAsync: vi.fn(async (method, params) => method === "release" ? release(params) : handler(method, params, true)),
  };
}

function session(transport: NodeModuleTransport) {
  const require = makeNodeModuleRequire(config, transport);
  sessions.push(require);
  return require;
}

describe("Node module handles", () => {
  it("preserves module/function/object identity and receiver-bound Hash chaining synchronously", () => {
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, false, ["createHash"]);
      if (method === "get") {
        if (params.handleId === 1 && params.property === "createHash") return handle(2, true);
        if (params.handleId === 3 && params.property === "update") return handle(4, true);
        if (params.handleId === 3 && params.property === "digest") return handle(5, true);
      }
      if (method === "call") {
        if (params.handleId === 2) { expect(params.args).toEqual([value("sha256")]); return handle(3); }
        if (params.handleId === 4) { expect(params.args).toEqual([value("abc")]); return handle(3); }
        if (params.handleId === 5) return value("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      }
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const crypto = require("node:crypto");
    expect(require("node:crypto")).toBe(crypto);
    expect(crypto.createHash).toBe(crypto.createHash);
    const hash = crypto.createHash("sha256");
    expect(hash.update("abc")).toBe(hash);
    expect(hash.digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(crypto.then).toBeUndefined();
    expect(Object.keys(crypto)).toEqual(["createHash"]);
    expect(() => crypto.__proto__).toThrow("Blocked remote property");
    expect(() => { crypto.__proto__ = {}; }).toThrow("Blocked remote property");
  });

  it("constructs remote classes and passes existing handles back without copying", () => {
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "construct") { expect(params.args).toEqual([value("sample")]); return handle(2); }
      if (method === "get") return handle(3, true);
      if (method === "call") { expect(params.args[0].handleId).toBe(2); return handle(2); }
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const Constructor = require("real-package");
    const object = new Constructor("sample");
    expect(object.same(object)).toBe(object);
  });

  it("round-trips binary values, typed-array slices, dates, errors and special numbers", () => {
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "call") return { kind: "array", items: params.args };
      throw new Error(`Unexpected ${method}`);
    });
    const echo = session(transport)("echo-values");
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    const bytes = new Uint16Array([100, 200, 300]).subarray(1);
    const result = echo(Buffer.from("hello"), bytes, new Date("2026-01-01T00:00:00Z"), error, 99n, NaN, Infinity, -Infinity, undefined,
      { nested: [true, null, "text"] }, new DataView(new Uint8Array([1, 2]).buffer), new Uint8Array([3, 4]).buffer);
    expect(Buffer.isBuffer(result[0])).toBe(true);
    expect(result[0].toString("utf8")).toBe("hello");
    expect(result[1]).toBeInstanceOf(Uint16Array);
    expect([...result[1]]).toEqual([200, 300]);
    expect(result[2].toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result[3]).toBeInstanceOf(Error);
    expect(result[3]).toMatchObject({ message: "missing", code: "ENOENT" });
    expect(result.slice(4, 9)).toEqual([99n, NaN, Infinity, -Infinity, undefined]);
    expect(result[9]).toEqual({ nested: [true, null, "text"] });
    expect(result[10]).toBeInstanceOf(DataView);
    expect(result[10].getUint8(1)).toBe(2);
    expect([...new Uint8Array(result[11])]).toEqual([3, 4]);
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(() => echo(cyclic)).toThrow("cyclic arguments");
  });

  it("snapshots aliased objects once while charging each wire occurrence", () => {
    let reads = 0;
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "call") return { kind: "array", items: params.args };
      throw new Error(`Unexpected ${method}`);
    });
    const echo = session(transport)("alias-fixture");
    const shared = { get value() { reads++; return `read-${reads}`; } };
    const result = echo(shared, shared);
    expect(reads).toBe(1);
    expect(result).toEqual([{ value: "read-1" }, { value: "read-1" }]);
  });

  it("provides a Buffer-compatible byte copy when the browser has no native Buffer", () => {
    const transport = fakeTransport(() => ({ kind: "buffer", data: "aGVsbG8=" }));
    vi.stubGlobal("Buffer", undefined);
    const buffer = session(transport)("buffer-export");
    vi.unstubAllGlobals();
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.toString("utf8")).toBe("hello");
    expect(buffer.toString("base64")).toBe("aGVsbG8=");
    expect(buffer.toString("hex")).toBe("68656c6c6f");
  });

  it("keeps Electron in the existing local shim", () => {
    const electron = { clipboard: { local: true } };
    (window as any).require = vi.fn(() => electron);
    const transport = fakeTransport(() => { throw new Error("Must not request Electron remotely"); });
    expect(session(transport)("electron")).toBe(electron);
    expect(transport.requestSync).not.toHaveBeenCalled();
  });
});

describe("Node module request payload budgets", () => {
  function setupPayloadCall() {
    const transport = fakeTransport((method) => method === "require" ? handle(1, true) : absent);
    const remote = session(transport)("payload-fixture");
    return { remote, transport };
  }
  function expectBudgetError(run: () => unknown) {
    let caught: unknown;
    try { run(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "ERR_ATOOLS_NODE_PAYLOAD" });
  }

  it("rejects oversized typed arrays and 16 MiB buffers before base64 conversion or RPC", () => {
    const { remote, transport } = setupPayloadCall();
    const baseline = transport.requestSync.mock.calls.length;
    const encode = vi.spyOn(globalThis, "btoa");
    expectBudgetError(() => remote(new Uint8Array(512 * 1024 + 1)));
    expectBudgetError(() => remote(Buffer.alloc(16 * 1024 * 1024)));
    expect(encode).not.toHaveBeenCalled();
    expect(transport.requestSync).toHaveBeenCalledTimes(baseline);
  });

  it("budgets all arguments together, including nested Unicode JSON escaping", () => {
    const { remote, transport } = setupPayloadCall();
    const baseline = transport.requestSync.mock.calls.length;
    const encode = vi.spyOn(globalThis, "btoa");
    expectBudgetError(() => remote(new Uint8Array(400 * 1024), new Uint8Array(400 * 1024)));
    const sharedBinary = new Uint8Array(400 * 1024);
    expectBudgetError(() => remote(sharedBinary, sharedBinary));
    expectBudgetError(() => remote({ nested: { text: "🙂".repeat(120_000) } }, { nested: { text: "🙂".repeat(120_000) } }));
    expect(encode).not.toHaveBeenCalled();
    expect(transport.requestSync).toHaveBeenCalledTimes(baseline);
  });

  it("rejects excessive nested depth before sending", () => {
    const { remote, transport } = setupPayloadCall();
    const baseline = transport.requestSync.mock.calls.length;
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 70; index++) nested = { child: nested };
    expectBudgetError(() => remote(nested));
    expect(transport.requestSync).toHaveBeenCalledTimes(baseline);
  });
});

describe("Node callbacks and Promise polling", () => {
  it("drains queued notifications before returning and does not poll without active work", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let queued: NodePollResult = { events: [], overflowed: false };
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "call") {
        queued.events.push({ callbackId: params.args[0].id, args: [value("event")] });
        return value("result");
      }
      if (method === "poll") { const events = queued; queued = { events: [], overflowed: false }; return events; }
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const fn = require("notifications");
    expect(vi.getTimerCount()).toBe(0);
    const callback = (text: string) => { order.push(text); };
    expect(fn(callback)).toBe("result");
    order.push("returned");
    expect(order).toEqual(["event", "returned"]);
    expect(vi.getTimerCount()).toBe(1);
    require.releaseCallbacks(callback);
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.requestSync).toHaveBeenLastCalledWith("release", { handleIds: [], callbackIds: ["callback-1"] });
  });

  it("polls Promise handles asynchronously, drains final progress and releases one-call callbacks", async () => {
    vi.useFakeTimers();
    let callbackId = "";
    let polls = 0;
    let finalEventReady = false;
    const progress = vi.fn();
    const transport = fakeTransport((method, params, async) => {
      if (method === "require") return handle(1, true);
      if (method === "call") { callbackId = params.args[0].id; return { kind: "promise", handleId: 20 }; }
      if (method === "poll") {
        const events = finalEventReady ? [{ callbackId, args: [value(100)] }] : [];
        finalEventReady = false;
        return { events, overflowed: false };
      }
      if (method === "pollPromise") {
        expect(async).toBe(true);
        if (++polls === 1) return { state: "pending" };
        finalEventReady = true;
        return { state: "fulfilled", value: value("done") };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const promise = require("async-progress")(progress);
    await vi.advanceTimersByTimeAsync(50);
    expect(progress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe("done");
    expect(progress).toHaveBeenCalledWith(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.requestSync.mock.calls.some(([method]) => method === "pollPromise")).toBe(false);
    expect(transport.requestSync).toHaveBeenLastCalledWith("release", { handleIds: [], callbackIds: [callbackId] });
  });

  it("keeps subscription callbacks until the returned unsubscribe function is called", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "call") return params.handleId === 1 ? { kind: "promise", handleId: 20 } : absent;
      if (method === "poll") return { events: [], overflowed: false };
      if (method === "pollPromise") return { state: "fulfilled", value: handle(3, true) };
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const subscription = require("subscribe")(() => {});
    await vi.advanceTimersByTimeAsync(50);
    const unsubscribe = await subscription;
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("chunks close releases across more than 4096 callbacks and handles", () => {
    const transport = fakeTransport((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "call") return handle(2, true);
      if (method === "poll") return { events: [], overflowed: false };
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const subscribe = require("many-callbacks");
    for (let index = 0; index < 4097; index++) subscribe(() => {});

    require.close();

    const packets = transport.requestAsync.mock.calls
      .filter(([method]) => method === "release")
      .map(([, params]) => params as { handleIds: number[]; callbackIds: string[] });
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.flatMap((packet) => packet.handleIds)).toEqual([1, 2]);
    expect(packets.flatMap((packet) => packet.callbackIds)).toHaveLength(4097);
    expect(packets.every((packet) => packet.handleIds.length + packet.callbackIds.length <= 4096)).toBe(true);
  });

  it("backs off empty subscriptions and stops all work on close/pagehide", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport((method) => {
      if (method === "require") return handle(1, true);
      if (method === "call") return absent;
      if (method === "poll") return { events: [], overflowed: false };
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    require("subscribe")(() => {});
    await vi.advanceTimersByTimeAsync(150);
    expect(transport.requestAsync.mock.calls.filter(([method]) => method === "poll")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport.requestAsync.mock.calls.filter(([method]) => method === "poll")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1 + 250 + 250);
    const polls = transport.requestAsync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.requestAsync.mock.calls).toHaveLength(polls);
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
    expect(() => require("fs")).toThrow("session is closed");
    expect(transport.requestAsync).toHaveBeenLastCalledWith("release", { handleIds: [1], callbackIds: ["callback-1"] });
  });

  it("releases 300 sequential progress callbacks before the next call while retaining a shared live callback", async () => {
    vi.useFakeTimers();
    let nextPromise = 10;
    const remoteCallbacks = new Set<string>();
    const promiseCallbacks = new Map<number, string[]>();
    let queued: NodePollResult = { events: [], overflowed: false };
    const active = vi.fn();
    const progress = vi.fn();
    const transport: NodeModuleTransport = {
      requestSync: vi.fn((method, params: any) => {
        if (method === "require") return handle(1, true);
        if (method === "call") {
          const ids = params.args.map((arg: any) => arg.id);
          ids.forEach((id: string) => remoteCallbacks.add(id));
          if (remoteCallbacks.size > 256) throw new Error("ERR_ATOOLS_NODE_CALLBACK_BUDGET");
          if (ids.length === 1) return absent;
          const handleId = nextPromise++;
          promiseCallbacks.set(handleId, ids);
          queued.events.push(...ids.map((callbackId: string) => ({ callbackId, args: [value(100)] })));
          return { kind: "promise", handleId };
        }
        if (method === "poll") { const events = queued; queued = { events: [], overflowed: false }; return events; }
        if (method === "release") {
          params.callbackIds?.forEach((id: string) => remoteCallbacks.delete(id));
          return { released: 0, callbacksReleased: params.callbackIds?.length ?? 0 };
        }
        throw new Error(`Unexpected ${method}`);
      }),
      requestAsync: vi.fn(async (method, params: any) => {
        if (method === "poll") return { events: [], overflowed: false };
        if (method === "pollPromise") return { state: "fulfilled", value: value("done") };
        if (method === "release") return {};
        throw new Error(`Unexpected ${method}`);
      }),
    };
    const require = session(transport);
    const fn = require("progress-fixture");
    fn(active);
    for (let index = 0; index < 300; index += 1) {
      const result = fn(active, () => progress());
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe("done");
      expect(remoteCallbacks.size).toBe(1);
    }
    expect(promiseCallbacks.size).toBe(300);
    expect(progress).toHaveBeenCalledTimes(300);
    expect(active).toHaveBeenCalledTimes(300);
    expect(remoteCallbacks).toEqual(new Set(["callback-1"]));
    require.releaseCallbacks(active);
    expect(remoteCallbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects the current Promise and closes if remote callback cleanup fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transport: NodeModuleTransport = {
      requestSync(method) {
        if (method === "require") return handle(1, true);
        if (method === "call") return { kind: "promise", handleId: 20 };
        if (method === "poll") return { events: [], overflowed: false };
        throw new Error("Remote cleanup failed");
      },
      async requestAsync(method) {
        if (method === "poll") return { events: [], overflowed: false };
        if (method === "pollPromise") return { state: "fulfilled", value: value("done") };
        return {};
      },
    };
    const require = session(transport);
    const result = expect(require("progress")(() => {})).rejects.toThrow("Remote cleanup failed");
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    expect(() => require("fs")).toThrow("session is closed");
  });

  it("rejects remote failures and outstanding promises on close", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport((method, params) => {
      if (method === "require") return { kind: "promise", handleId: params.specifier === "pending" ? 21 : 20 };
      if (method === "pollPromise") return { state: "rejected", error: { message: "not found", code: "ENOENT" } };
      throw new Error(`Unexpected ${method}`);
    });
    const require = session(transport);
    const failure = expect(require("rejected")).rejects.toMatchObject({ code: "ENOENT", message: "not found" });
    await vi.advanceTimersByTimeAsync(50);
    await failure;
    const cancelled = expect(require("pending")).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_SESSION_CLOSED" });
    require.close();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports callback-only polling failures and closes the session instead of silently retrying", async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = fakeTransport((method, _params, async) => {
      if (method === "require") return handle(1, true);
      if (method === "call") return absent;
      if (method === "poll" && !async) return { events: [], overflowed: false };
      throw new Error("Disconnected worker");
    });
    const require = session(transport);
    require("subscribe")(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("callback polling failed"), expect.any(Error));
    expect(vi.getTimerCount()).toBe(0);
    expect(() => require("fs")).toThrow("session is closed");
  });
});

describe("dedicated session transport", () => {
  it("restricts endpoints and unwraps synchronous responses and remote errors", () => {
    for (const endpoint of ["https://127.0.0.1:43121/node/abc", config.endpoint.replace("127.0.0.1", "evil.example"), `${config.endpoint}?token=extra`]) {
      expect(() => createNodeModuleTransport({ endpoint })).toThrow("dedicated loopback session");
    }
    const open = vi.fn(); const send = vi.fn();
    let body: unknown = { ok: true, result: value("ready") };
    vi.stubGlobal("XMLHttpRequest", class {
      status = 200;
      open = open;
      setRequestHeader = vi.fn();
      send = send;
      get responseText() { return JSON.stringify(body); }
    });
    const transport = createNodeModuleTransport(config);
    expect(transport.requestSync("require", { specifier: "fs" })).toEqual(value("ready"));
    expect(open).toHaveBeenCalledWith("POST", config.endpoint, false);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({ method: "require", params: { specifier: "fs" } });
    body = { ok: false, error: { message: "permission denied", code: "EACCES" } };
    expect(() => transport.requestSync("require", {})).toThrow("permission denied");
  });

  it("uses asynchronous fetch for polling and emits a self-contained iframe bootstrap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { events: [], overflowed: false } }) })));
    await expect(createNodeModuleTransport(config).requestAsync("poll", {})).resolves.toEqual({ events: [], overflowed: false });
    expect(fetch).toHaveBeenCalledWith(config.endpoint, expect.objectContaining({ method: "POST" }));
    vi.stubGlobal("XMLHttpRequest", class {
      status = 200;
      open() {}
      setRequestHeader() {}
      send() {}
      responseText = JSON.stringify({ ok: true, result: value("real module") });
    });
    const require = new Function(`return ${nodeModuleBridgeScript(config)}`)();
    sessions.push(require);
    expect(require("fs")).toBe("real module");
  });

  it("rejects oversized sync and async JSON before constructing XHR or calling fetch", async () => {
    const open = vi.fn(), send = vi.fn(), fetchCall = vi.fn();
    const Xhr = vi.fn().mockImplementation(() => ({ status: 200, open, setRequestHeader: vi.fn(), send, responseText: "{}" }));
    vi.stubGlobal("XMLHttpRequest", Xhr);
    vi.stubGlobal("fetch", fetchCall);
    const transport = createNodeModuleTransport(config);
    const params = { nested: { text: "界".repeat(400 * 1024) } };
    let syncError: unknown;
    try { transport.requestSync("call", params); } catch (error) { syncError = error; }
    expect(syncError).toMatchObject({ code: "ERR_ATOOLS_NODE_PAYLOAD" });
    await expect(transport.requestAsync("call", params)).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_PAYLOAD" });
    expect(Xhr).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(fetchCall).not.toHaveBeenCalled();
  });

  it("keeps the exact serialized UTF-8 request cap as a second transport guard", () => {
    const open = vi.fn(), send = vi.fn();
    const Xhr = vi.fn().mockImplementation(() => ({ status: 200, open, setRequestHeader: vi.fn(), send, responseText: "{}" }));
    vi.stubGlobal("XMLHttpRequest", Xhr);
    const exactGuard = createNodeModuleTransport(config, () => ({ assertJsonRequest() {}, maxRequestBytes: 1 } as any));
    let error: unknown;
    try { exactGuard.requestSync("call", {}); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "ERR_ATOOLS_NODE_PAYLOAD" });
    expect(Xhr).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
