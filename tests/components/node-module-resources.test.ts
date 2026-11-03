import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNodeModuleRequire } from "../../src/lib/nodeModuleBridge";
import type { NodeModuleTransport } from "../../src/lib/nodeModuleProtocol";

const config = { endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` };
const handle = (handleId: number, callable = false) => ({ kind: "handle", handleId, callable, keys: [] });
const sessions: ReturnType<typeof makeNodeModuleRequire>[] = [];
afterEach(() => { sessions.splice(0).forEach(session => session.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });

// GC timing is deliberately nondeterministic. Drive only the weak-reference
// notifications in this test; the production path uses the native GC.
function controlledGc() {
  const references = new Map<object, { current?: object }>();
  const registrations: { value: object; id: number }[] = [];
  let notify: (id: number) => void;
  vi.stubGlobal("WeakRef", class {
    record: { current?: object };
    constructor(value: object) { this.record = { current: value }; references.set(value, this.record); }
    deref() { return this.record.current; }
  });
  vi.stubGlobal("FinalizationRegistry", class {
    constructor(callback: (id: number) => void) { notify = callback; }
    register(value: object, id: number) { registrations.push({ value, id }); }
  });
  return {
    markUnreachable(value: object) { references.get(value)!.current = undefined; },
    finalize(value: object) { notify(registrations.find(entry => entry.value === value)!.id); },
  };
}

function setup(handler?: (method: string, params: any) => any) {
  const transport: NodeModuleTransport = {
    requestSync: vi.fn((method, params) => {
      if (method === "release") return { released: (params.handleIds as number[]).length };
      return handler?.(method, params) ?? (method === "require" ? handle(1, true) : handle(2));
    }),
    requestAsync: vi.fn(async (method, params) => method === "release" ? {} : handler?.(method, params)),
  };
  const require = makeNodeModuleRequire(config, transport);
  sessions.push(require);
  return { require, transport };
}

describe("Remote handle lifetime", () => {
  it("keeps ordinary fields and mutable methods live while a captured function retains its identity", () => {
    let current = 2, count = 0;
    const { require } = setup((method, params) => {
      if (method === "require") return handle(1);
      if (method === "get") return params.property === "method" ? handle(current, true) : { kind: "value", value: ++count };
      if (method === "call") return { kind: "value", value: params.handleId === 2 ? "original" : "replacement" };
    });
    const module = require("mutable"), captured = module.method;
    expect(module.field).toBe(1);
    current = 3;
    expect(module.field).toBe(2);
    expect(module.method()).toBe("replacement");
    expect(captured()).toBe("original");
  });

  it("reclaims unreachable temporary handles only at the next explicit request, with no idle timer", () => {
    vi.useFakeTimers();
    const gc = controlledGc(), { require, transport } = setup();
    const factory = require("fixture"), temporary = factory();
    gc.markUnreachable(temporary);
    gc.finalize(temporary);
    const before = vi.mocked(transport.requestSync).mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(transport.requestSync).toHaveBeenCalledTimes(before);
    factory();
    expect(vi.mocked(transport.requestSync).mock.calls.slice(before).map(([method]) => method)).toEqual(["release", "call"]);
    expect(vi.mocked(transport.requestSync).mock.calls[before][1]).toEqual({ handleIds: [2], callbackIds: [] });
  });

  it("does not release a replacement proxy when the older finalizer arrives late", () => {
    const gc = controlledGc(), { require, transport } = setup();
    const factory = require("fixture"), old = factory();
    gc.markUnreachable(old);
    const replacement = factory();
    gc.finalize(old);
    expect(factory()).toBe(replacement);
    expect(vi.mocked(transport.requestSync).mock.calls.some(([method]) => method === "release")).toBe(false);
  });

  it("keeps callback event descriptors valid until their subscription is explicitly released", () => {
    vi.useFakeTimers();
    let nextHandle = 2;
    const gc = controlledGc(), { require, transport } = setup((method, params) => {
      if (method === "require") return handle(1, true);
      if (method === "poll") return { events: [], overflowed: false };
      if (method === "call" && params.args.length) return { kind: "undefined" };
      return handle(nextHandle++);
    });
    const factory = require("fixture"), temporary = factory(), callback = () => {};
    factory(callback);
    gc.markUnreachable(temporary); gc.finalize(temporary);
    factory();
    expect(vi.mocked(transport.requestSync).mock.calls.some(([method]) => method === "release")).toBe(false);
    require.releaseCallbacks(callback);
    factory();
    expect(vi.mocked(transport.requestSync).mock.calls.filter(([method]) => method === "release").map(([, params]) => params))
      .toEqual([{ handleIds: [], callbackIds: ["callback-1"] }, { handleIds: [2], callbackIds: [] }]);
  });

  it("retains stable identity on engines without WeakRef instead of releasing live objects", () => {
    vi.stubGlobal("WeakRef", undefined);
    const { require } = setup(), factory = require("fixture");
    expect(factory()).toBe(factory());
  });

  it("replaces historical key snapshots instead of growing a permanent union", () => {
    let name = "old";
    const { require } = setup((method) => method === "require" ? handle(1, true)
      : { kind: "handle", handleId: 2, callable: false, keys: [name] });
    const factory = require("fixture"), object = factory();
    expect(Object.keys(object)).toEqual(["old"]);
    name = "current";
    expect(factory()).toBe(object);
    expect(Object.keys(object)).toEqual(["current"]);
  });

  it("closes the bridge if automatic remote cleanup fails", () => {
    const gc = controlledGc(), { require, transport } = setup();
    const factory = require("fixture"), temporary = factory();
    gc.markUnreachable(temporary); gc.finalize(temporary);
    vi.mocked(transport.requestSync).mockImplementationOnce(() => { throw Error("cleanup failed"); });
    expect(() => factory()).toThrow("cleanup failed");
    expect(() => factory()).toThrow("session is closed");
  });
});
