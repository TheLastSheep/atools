import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFsFileHandleAdapters } from "../../src/lib/nodeFsFileHandles";
import { makeNodeModuleRequire, nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";
import type { EncodedNodeValue, NodeModuleTransport } from "../../src/lib/nodeModuleProtocol";

const sessions: ReturnType<typeof makeNodeModuleRequire>[] = [];

afterEach(() => {
  sessions.splice(0).forEach((session) => session.close());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeAdapters() {
  let closed = false;
  const aliases = new WeakMap<object, object>();
  const registerAlias = vi.fn((wrapper: object, raw: object) => aliases.set(wrapper, raw));
  const adapters = createNodeFsFileHandleAdapters(() => {
    if (closed) throw Object.assign(new Error("session closed"), { code: "ERR_ATOOLS_NODE_SESSION_CLOSED" });
  }, registerAlias);
  return { adapters, aliases, registerAlias, close: () => { closed = true; } };
}

function fileHandle(read?: Function) {
  const rawHandle: { read: Function } = { read: () => undefined };
  rawHandle.read = read ?? function(this: unknown, buffer: ArrayBufferView, offset = 0, length = buffer.byteLength) {
    if (this !== rawHandle) throw new Error("FileHandle receiver was not preserved");
    const copy = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const bytes = Math.min(length, 2);
    new Uint8Array(copy.buffer).set([65, 66].slice(0, bytes), offset);
    return Promise.resolve({ bytesRead: bytes, buffer: copy });
  };
  return rawHandle;
}

function handle(handleId: number, callable = false, keys: string[] = []): EncodedNodeValue {
  return { kind: "handle", handleId, callable, keys };
}

function bufferValue(bytes: Uint8Array): EncodedNodeValue {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { kind: "buffer", data: btoa(binary) };
}

function value(input: string | number | boolean | null): EncodedNodeValue {
  return { kind: "value", value: input };
}

function objectValue(properties: Record<string, EncodedNodeValue>): EncodedNodeValue {
  return { kind: "object", properties };
}

describe("Node FileHandle.read value-copy adapter", () => {
  it("copies only the successful byte range into the original subarray and returns that same view", async () => {
    const rawHandle = fileHandle();
    const { adapters, aliases } = makeAdapters();
    const rawPromises = { open: async () => rawHandle };
    const promises = adapters.wrapModule("node:fs/promises", rawPromises) as typeof rawPromises;
    const opened = await promises.open("fixture", "r") as typeof rawHandle;
    const backing = Uint8Array.from([9, 8, 120, 120, 120, 7, 6]);
    const target = backing.subarray(1, 6);
    const read = opened.read as (buffer: Uint8Array, offset: number, length: number, position: number) => Promise<any>;
    const result = await read(target, 1, 3, 0);

    expect([...backing]).toEqual([9, 8, 65, 66, 120, 7, 6]);
    expect(result.bytesRead).toBe(2);
    expect(result.buffer).toBe(target);
    expect(aliases.get(opened)).toBe(rawHandle);
  });

  it("supports options reads and byte-oriented DataView/subarray targets", async () => {
    const rawHandle = fileHandle(function(this: unknown, options: { buffer: DataView; offset?: number; length?: number }) {
      if (this !== rawHandle) throw new Error("FileHandle receiver was not preserved");
      const { buffer, offset = 0, length = buffer.byteLength } = options;
      const copy = new DataView(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      const bytes = Math.min(length, 2);
      new Uint8Array(copy.buffer).set([67, 68].slice(0, bytes), offset);
      return Promise.resolve({ bytesRead: bytes, buffer: copy });
    });
    const { adapters } = makeAdapters();
    const wrapped = adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any;
    const opened = await wrapped.open("fixture") as any;
    const backing = Uint8Array.from([77, 0, 0, 0, 88]);
    const target = new DataView(backing.buffer, 1, 3);
    const result = await opened.read({ buffer: target, offset: 1, length: 2, position: 0 });

    expect([...backing]).toEqual([77, 0, 67, 68, 88]);
    expect(result.buffer).toBe(target);
  });

  it("supports Node 22 read(buffer, options) with own offset, length, and position fields", async () => {
    const rawRead = vi.fn(function(this: unknown, buffer: Uint8Array, options: { offset: number; length: number; position: number }) {
      if (this !== rawHandle) throw new Error("FileHandle receiver was not preserved");
      const copy = Uint8Array.from(buffer);
      copy.set([71, 72].slice(0, options.length), options.offset);
      return Promise.resolve({ bytesRead: Math.min(2, options.length), buffer: copy });
    });
    const rawHandle = { read: rawRead };
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    const target = Uint8Array.from([9, 9, 9, 9]);
    const options = { offset: 1, length: 2, position: 0 };

    const result = await opened.read(target, options);

    expect(rawRead).toHaveBeenCalledTimes(1);
    expect(rawRead).toHaveBeenCalledWith(target, options);
    expect([...target]).toEqual([9, 71, 72, 9]);
    expect(result.buffer).toBe(target);
  });

  it("uses the buffer+options defaults without rewriting the remote arguments", async () => {
    const options = {};
    const rawRead = vi.fn(function(this: unknown, buffer: Uint8Array, receivedOptions: object) {
      if (this !== rawHandle) throw new Error("FileHandle receiver was not preserved");
      expect(receivedOptions).toBe(options);
      const copy = Uint8Array.from(buffer);
      copy[0] = 73;
      return Promise.resolve({ bytesRead: 1, buffer: copy });
    });
    const rawHandle = { read: rawRead };
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("node:fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    const target = Uint8Array.from([0, 0, 0]);

    const result = await opened.read(target, options);

    expect(rawRead).toHaveBeenCalledTimes(1);
    expect(rawRead).toHaveBeenCalledWith(target, options);
    expect([...target]).toEqual([73, 0, 0]);
    expect(result.buffer).toBe(target);
  });

  it("forwards non-enumerable own data options as codec-visible fields", async () => {
    const rawRead = vi.fn(function(this: unknown, buffer: Uint8Array, options: { offset: number; length: number }) {
      if (this !== rawHandle) throw new Error("FileHandle receiver was not preserved");
      const copy = Uint8Array.from(buffer);
      copy.set([81, 82].slice(0, options.length), options.offset);
      return Promise.resolve({ bytesRead: Math.min(2, options.length), buffer: copy });
    });
    const rawHandle = { read: rawRead };
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    const target = Uint8Array.from([9, 9, 9, 9]);
    const options = { length: 2 } as { offset?: number; length: number };
    Object.defineProperty(options, "offset", { value: 1, configurable: true, writable: true });

    const result = await opened.read(target, options);
    const forwardedOptions = rawRead.mock.calls[0][1] as object;

    expect(forwardedOptions).not.toBe(options);
    expect(Object.getOwnPropertyDescriptor(forwardedOptions, "offset")).toMatchObject({ value: 1, enumerable: true });
    expect([...target]).toEqual([9, 81, 82, 9]);
    expect(result.buffer).toBe(target);
  });

  it.each([null, -1, BigInt(-1), BigInt(0)])("preserves valid Node read positions %s", async (position) => {
    const rawRead = vi.fn((buffer: Uint8Array) => Promise.resolve({ bytesRead: 0, buffer: Uint8Array.from(buffer) }));
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => ({ read: rawRead }) }) as any).open("fixture");
    const target = Uint8Array.from([8, 9]);
    const options = { position };

    const result = await opened.read(target, options);

    expect(rawRead).toHaveBeenCalledWith(target, options);
    expect([...target]).toEqual([8, 9]);
    expect(result.buffer).toBe(target);
  });

  it("leaves no-buffer reads alone and preserves EOF data and identity", async () => {
    const defaultResult = Promise.resolve({ bytesRead: 0, buffer: Uint8Array.from([4, 5]) });
    const rawHandle = { read: vi.fn(() => defaultResult) };
    const { adapters } = makeAdapters();
    const wrapped = adapters.wrapModule("node:fs/promises", { open: async () => rawHandle }) as any;
    const opened = await wrapped.open("fixture") as any;
    expect(opened.read()).toBe(defaultResult);

    const target = Uint8Array.from([10, 11, 12]);
    rawHandle.read.mockResolvedValueOnce({ bytesRead: 0, buffer: Uint8Array.from([99, 98, 97]) });
    const result = await opened.read(target, 1, 2, 0);
    expect([...target]).toEqual([10, 11, 12]);
    expect(result.buffer).toBe(target);
  });

  it("propagates I/O errors once without mutating the view or retrying", async () => {
    const error = Object.assign(new Error("disk failed"), { code: "EIO" });
    const read = vi.fn(() => Promise.reject(error));
    const rawHandle = { read };
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    const target = Uint8Array.from([15, 16, 17]);

    await expect(opened.read(target, 0, 2, 0)).rejects.toBe(error);
    expect([...target]).toEqual([15, 16, 17]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects accessor-based buffer options before I/O instead of reading them twice", async () => {
    let getterCalls = 0;
    const read = vi.fn(() => Promise.resolve({ bytesRead: 0, buffer: Uint8Array.from([0, 0]) }));
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => ({ read }) }) as any).open("fixture");
    const target = Uint8Array.from([5, 6]);
    const options = Object.defineProperty({}, "buffer", {
      enumerable: true,
      configurable: true,
      get() { getterCalls++; return target; },
    });

    expect(() => opened.read(options)).toThrow("Accessor-based FileHandle.read options are unsupported");
    expect(getterCalls).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect([...target]).toEqual([5, 6]);
  });

  it.each(["offset", "length", "position"])("rejects a %s accessor in read(buffer, options) before I/O", async (field) => {
    let getterCalls = 0;
    const read = vi.fn(() => Promise.resolve({ bytesRead: 0, buffer: Uint8Array.from([0, 0]) }));
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => ({ read }) }) as any).open("fixture");
    const target = Uint8Array.from([5, 6]);
    const options = Object.defineProperty({}, field, {
      enumerable: true,
      configurable: true,
      get() { getterCalls++; return 0; },
    });

    expect(() => opened.read(target, options)).toThrow("Accessor-based FileHandle.read options are unsupported");
    expect(getterCalls).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing byte view", { bytesRead: 1, buffer: "bad" }],
    ["mismatched view length", { bytesRead: 1, buffer: Uint8Array.from([1, 2]) }],
    ["invalid byte count", { bytesRead: 3, buffer: Uint8Array.from([1, 2, 3]) }],
  ])("rejects malformed %s responses before mutation", async (_name, malformed) => {
    const read = vi.fn(() => Promise.resolve(malformed));
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("node:fs/promises", { open: async () => ({ read }) }) as any).open("fixture");
    const target = Uint8Array.from([21, 22, 23]);

    await expect(opened.read(target, 1, 1, 0)).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_FILE_HANDLE_READ_RESPONSE" });
    expect([...target]).toEqual([21, 22, 23]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-range request before asynchronous writeback", async () => {
    const read = vi.fn(() => Promise.resolve({ bytesRead: 0, buffer: Uint8Array.from([1, 2, 3, 4]) }));
    const rawHandle = { read };
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    const target = Uint8Array.from([1, 2, 3, 4]);
    expect(() => opened.read(target, 3, 2, 0)).toThrow(RangeError);
    expect(read).not.toHaveBeenCalled();
    expect([...target]).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ["negative offset", { offset: -1, length: 1 }],
    ["offset beyond the view", { offset: 5, length: 0 }],
    ["negative length", { offset: 0, length: -1 }],
    ["length beyond the view", { offset: 1, length: 4 }],
    ["position below Node's current-position sentinel", { offset: 0, length: 1, position: -2 }],
    ["non-integer position", { offset: 0, length: 1, position: "0" }],
  ])("rejects %s before remote read", (description, options) => {
    void description;
    const read = vi.fn(() => Promise.resolve({ bytesRead: 0, buffer: Uint8Array.from([0, 0, 0, 0]) }));
    const { adapters } = makeAdapters();
    const rawPromises = { open: async () => ({ read }) };
    const wrapped = adapters.wrapModule("fs/promises", rawPromises) as typeof rawPromises;
    const target = Uint8Array.from([1, 2, 3, 4]);
    const pendingOpen = wrapped.open("fixture");

    return pendingOpen.then((opened: any) => {
      expect(() => opened.read(target, options)).toThrow(RangeError);
      expect(read).not.toHaveBeenCalled();
      expect([...target]).toEqual([1, 2, 3, 4]);
    });
  });

  it("keeps concurrent reads from overwriting bytes outside each completed range", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const rawHandle = { read: vi.fn((buffer: Uint8Array, offset: number) => new Promise(resolve => {
      const copy = Uint8Array.from(buffer);
      copy[offset] = offset === 0 ? 31 : 42;
      resolvers.push(() => resolve({ bytesRead: 1, buffer: copy }));
    })) };
    const { adapters } = makeAdapters();
    const opened = await (adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    const target = Uint8Array.from([0, 0, 0, 0]);
    const first = opened.read(target, 0, 1, 0);
    const second = opened.read(target, 2, 1, 0);
    resolvers[1]({});
    await second;
    resolvers[0]({});
    await first;
    expect([...target]).toEqual([31, 0, 42, 0]);
  });

  it("does not write back an in-flight read after close and keeps captured wrappers guarded", async () => {
    let finish!: (value: unknown) => void;
    const rawHandle = { read: vi.fn((buffer: Uint8Array) => new Promise(resolve => {
      const copy = Uint8Array.from(buffer); copy[0] = 99; finish = resolve;
    })) };
    const { adapters, close } = makeAdapters();
    const promises = adapters.wrapModule("node:fs/promises", { open: async () => rawHandle }) as any;
    const capturedOpen = promises.open;
    const opened = await capturedOpen("fixture");
    const capturedRead = opened.read;
    const target = Uint8Array.from([1, 2, 3]);
    const pending = capturedRead(target, 0, 1, 0);
    close();
    finish({ bytesRead: 1, buffer: Uint8Array.from([99, 2, 3]) });

    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_SESSION_CLOSED" });
    expect([...target]).toEqual([1, 2, 3]);
    expect(() => capturedOpen("again")).toThrow("session closed");
    expect(() => capturedRead(target, 0, 1, 0)).toThrow("session closed");
  });

  it("wraps reflection results, retains aliases, and does not retain stale getter values", async () => {
    const { adapters, aliases } = makeAdapters();
    let openLookups = 0;
    const rawOpenA = vi.fn(async () => ({ read: vi.fn() }));
    const rawOpenB = vi.fn(async () => ({ read: vi.fn() }));
    let selectedOpen = rawOpenA;
    const rawPromises = Object.defineProperty({}, "open", {
      configurable: true,
      enumerable: true,
      get() { openLookups++; return selectedOpen; },
    });
    const rawFs = Object.defineProperty({}, "promises", {
      configurable: true,
      enumerable: true,
      get() { return rawPromises; },
    });
    const fs = adapters.wrapModule("fs", rawFs) as any;
    const promisesA = fs.promises;
    const openA = promisesA.open;
    expect(promisesA.open).toBe(openA);
    selectedOpen = rawOpenB;
    const openB = promisesA.open;
    expect(openLookups).toBe(3);
    expect(openB).not.toBe(openA);
    expect(Object.getOwnPropertyDescriptor(promisesA, "open")?.value).toBe(openB);
    const opened = await openB();
    expect(Object.getOwnPropertyDescriptor(opened, "read")?.value).toEqual(expect.any(Function));
    expect(aliases.get(fs)).toBe(rawFs);
    expect(aliases.get(promisesA)).toBe(rawPromises);
    expect(aliases.get(openA)).toBe(rawOpenA);
    expect(aliases.get(openB)).toBe(rawOpenB);
  });

  it("keeps open wrappers isolated by their promises owner", async () => {
    const receivers: unknown[] = [];
    const rawOpen = vi.fn(function(this: unknown) {
      receivers.push(this);
      return Promise.resolve({ read: vi.fn() });
    });
    const rawPromisesA = { open: rawOpen };
    const rawPromisesB = { open: rawOpen };
    const { adapters } = makeAdapters();
    const promisesA = adapters.wrapModule("fs/promises", rawPromisesA) as any;
    const promisesB = adapters.wrapModule("node:fs/promises", rawPromisesB) as any;
    const openA = promisesA.open;
    const openB = promisesB.open;

    expect(openA).not.toBe(openB);
    expect(promisesA.open).toBe(openA);
    expect(promisesB.open).toBe(openB);
    await Promise.all([openA(), openB()]);
    expect(receivers).toEqual([rawPromisesA, rawPromisesB]);
  });

  it("leaves readv and unrelated module members delegated without fabricating support", async () => {
    const readv = vi.fn(() => Promise.resolve({ bytesRead: 0, buffers: [] }));
    const rawHandle = { readv, other: 41 };
    const unrelated = { open: vi.fn() };
    const { adapters } = makeAdapters();
    const wrappedHandle = await (adapters.wrapModule("fs/promises", { open: async () => rawHandle }) as any).open("fixture");
    expect(wrappedHandle.readv).toBe(readv);
    expect(wrappedHandle.other).toBe(41);
    expect(adapters.wrapModule("example", unrelated)).toBe(unrelated);
  });

  it("serializes as a self-contained factory", () => {
    const serialized = new Function(`return (${createNodeFsFileHandleAdapters.toString()})`)();
    const factory = serialized(() => {}, () => {});
    expect(factory.wrapModule("other", { value: true })).toEqual({ value: true });
  });
});

describe("bridge integration for fs aliases and handle identity", () => {
  it("uses all four fs entry points with shared wrappers, preserves wrapped handles, and adds no ordinary RPC", async () => {
    vi.useFakeTimers();
    let openCalls = 0;
    const requestSync = vi.fn((method: string, params: any): EncodedNodeValue => {
      if (method === "release") return objectValue({ released: value(0), callbacksReleased: value(0) });
      if (method === "require") {
        if (["fs", "node:fs"].includes(params.specifier)) return handle(1, false, ["promises", "readFileSync"]);
        if (["fs/promises", "node:fs/promises"].includes(params.specifier)) return handle(2, false, ["open"]);
        if (params.specifier === "echo") return handle(20, true);
        if (params.specifier === "unrelated") return value("plain");
      }
      if (method === "get" && params.handleId === 1 && params.property === "promises") return handle(2, false, ["open"]);
      if (method === "get" && params.handleId === 2 && params.property === "open") return handle(3, true);
      if (method === "get" && params.handleId === 5 && params.property === "read") return handle(6, true);
      if (method === "get" && params.handleId === 8 && params.property === "read") return handle(6, true);
      if (method === "get" && params.handleId === 7 && params.property === "bytesRead") return value(2);
      if (method === "get" && params.handleId === 7 && params.property === "buffer") return bufferValue(Uint8Array.from([0, 90, 91, 0]));
      if (method === "call" && params.handleId === 3) return { kind: "promise", handleId: openCalls++ === 0 ? 30 : 32 };
      if (method === "call" && params.handleId === 6) {
        expect(params.args[0].kind).toBe("buffer");
        const copy = Uint8Array.from(Buffer.from(params.args[0].data, "base64"));
        copy.set([90, 91], 1);
        return { kind: "promise", handleId: 31 };
      }
      if (method === "call" && params.handleId === 20) return params.args[0];
      throw new Error(`Unexpected sync ${method} ${JSON.stringify(params)}`);
    });
    const requestAsync = vi.fn(async (method: string, params: any): Promise<any> => {
      if (method === "release") return { released: params.handleIds?.length ?? 0, callbacksReleased: params.callbackIds?.length ?? 0 };
      if (method === "poll") return { events: [], overflowed: false };
      if (method === "pollPromise" && params.handleId === 30) return { state: "fulfilled", value: handle(5, false, ["read", "close"]) };
      if (method === "pollPromise" && params.handleId === 32) return { state: "fulfilled", value: handle(8, false, ["read", "close"]) };
      if (method === "pollPromise" && params.handleId === 31) return { state: "fulfilled", value: handle(7, false, ["bytesRead", "buffer"]) };
      throw new Error(`Unexpected async ${method} ${JSON.stringify(params)}`);
    });
    const transport: NodeModuleTransport = { requestSync, requestAsync };
    const require = makeNodeModuleRequire({ endpoint: `http://127.0.0.1:43121/node/${"b".repeat(64)}` }, transport);
    sessions.push(require);

    const fs = require("fs");
    expect(require("node:fs")).toBe(fs);
    const promises = fs.promises;
    expect(require("fs/promises")).toBe(promises);
    expect(require("node:fs/promises")).toBe(promises);
    const ordinaryBefore = requestSync.mock.calls.length;
    expect(require("unrelated")).toBe("plain");
    expect(requestSync.mock.calls.slice(ordinaryBefore)).toEqual([["require", { specifier: "unrelated" }]]);

    const openFunction = promises.open;
    expect(promises.open).toBe(openFunction);
    const openResult = openFunction("fixture", "r");
    await vi.advanceTimersByTimeAsync(50);
    const file = await openResult;
    const echoed = require("echo")(file);
    expect(echoed).toBe(file);
    const readFunction = file.read;
    expect(file.read).toBe(readFunction);
    expect(file.read).toBe(readFunction);
    const otherOpenResult = promises.open("fixture-two", "r");
    await vi.advanceTimersByTimeAsync(50);
    const otherFile = await otherOpenResult;
    const otherReadFunction = otherFile.read;
    expect(otherReadFunction).not.toBe(readFunction);
    expect(otherFile.read).toBe(otherReadFunction);
    const target = Buffer.from([1, 2, 3, 4]);
    const readPending = readFunction(target, { offset: 1, length: 2, position: 0 });
    await vi.advanceTimersByTimeAsync(50);
    const readResult = await readPending;
    expect([...target]).toEqual([1, 90, 91, 4]);
    expect(readResult.buffer).toBe(target);
    expect(requestSync.mock.calls.filter(([method]) => method === "set")).toHaveLength(0);
    expect(requestSync.mock.calls.filter(([method, params]) => method === "call" && params.handleId === 6)).toHaveLength(1);
    expect(requestSync.mock.calls.filter(([method]) => method === "require")).toHaveLength(6);
  });

  it("embeds the file-handle adapter in the isolated-frame script", () => {
    const script = nodeModuleBridgeScript({ endpoint: `http://127.0.0.1:43121/node/${"c".repeat(64)}` });
    expect(script).toContain("createNodeFsFileHandleAdapters");
    expect(script).toContain("FileHandle.read");
    expect(script).toContain("registerAlias");
  });
});
