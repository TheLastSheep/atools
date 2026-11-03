import type { EncodedNodeValue, NodeHandleDescriptor } from "./nodeModuleProtocol";
import { createBrowserBuffer, browserBufferFactoryScript } from "./browserBuffer";
import { createNodeModulePayloadBudget } from "./nodeModulePayloadBudget";

type CodecHooks = {
  handle: (descriptor: NodeHandleDescriptor) => unknown;
  promise: (handleId: number) => Promise<unknown>;
  callback: (fn: Function) => string;
  existingHandle: (value: object) => NodeHandleDescriptor | undefined;
};

/** Value copies cross the wire; remote object and function identity stays in handles. */
export function createNodeModuleCodec(
  hooks: CodecHooks,
  createBuffer = createBrowserBuffer,
  createPayloadBudget = createNodeModulePayloadBudget,
) {
  const buffers = new WeakSet<object>();
  const fsValues = new WeakMap<object, "fsStats" | { kind: "fsDirent"; type: number }>();
  const typedArrays = new Set([
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "DataView", "ArrayBuffer",
  ]);

  function base64(bytes: Uint8Array): string {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(text);
  }

  function bytesFromBase64(text: string): Uint8Array {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  }

  const BridgeBuffer = createBuffer();
  const payloadBudget = createPayloadBudget({ existingHandle: hooks.existingHandle, fsValue: (value: object) => fsValues.get(value) });

  // Stats/Dirent are explicit value copies, like Date and Buffer. Each Node stat
  // still performs fresh I/O; only predicates over that returned value run here.
  class BridgeStats {
    [name: string]: any;
    private checkMode(type: number) {
      return typeof this.mode === "bigint" ? (this.mode & 0xf000n) === BigInt(type) : (this.mode & 0xf000) === type;
    }
    isFile() { return this.checkMode(0x8000); }
    isDirectory() { return this.checkMode(0x4000); }
    isSymbolicLink() { return this.checkMode(0xa000); }
    isFIFO() { return this.checkMode(0x1000); }
    isSocket() { return this.checkMode(0xc000); }
    isCharacterDevice() { return this.checkMode(0x2000); }
    isBlockDevice() { return this.checkMode(0x6000); }
  }
  for (const field of ["atime", "mtime", "ctime", "birthtime"]) {
    Object.defineProperty(BridgeStats.prototype, field, {
      configurable: true, enumerable: true,
      get(this: BridgeStats) {
        const date = new Date(Number(this[field + "Ms"]));
        Object.defineProperty(this, field, { value: date, writable: true, enumerable: true, configurable: true });
        return date;
      },
      set(this: BridgeStats, value: Date) { Object.defineProperty(this, field, { value, writable: true, enumerable: true, configurable: true }); },
    });
  }
  class BridgeDirent {
    [name: string]: any;
    isFile() { return (fsValues.get(this) as { type: number })?.type === 1; }
    isDirectory() { return (fsValues.get(this) as { type: number })?.type === 2; }
    isSymbolicLink() { return (fsValues.get(this) as { type: number })?.type === 3; }
    isFIFO() { return (fsValues.get(this) as { type: number })?.type === 4; }
    isSocket() { return (fsValues.get(this) as { type: number })?.type === 5; }
    isCharacterDevice() { return (fsValues.get(this) as { type: number })?.type === 6; }
    isBlockDevice() { return (fsValues.get(this) as { type: number })?.type === 7; }
  }

  // Capture a verified local Buffer once. A later window.Buffer may itself be a
  // remote handle; invoking it while decoding would recursively enter this codec.
  const candidateBuffer = (globalThis as any).Buffer;
  let nativeBuffer: any;
  try {
    if (typeof candidateBuffer?.from === "function" && !hooks.existingHandle(candidateBuffer)
      && candidateBuffer.from("AQ==", "base64")[0] === 1) nativeBuffer = candidateBuffer;
  } catch { /* The lightweight Web shim is not a complete Node Buffer. */ }

  function encode(value: unknown, ancestors = new Set<object>(), snapshots?: WeakMap<object, any>): EncodedNodeValue {
    if (value === undefined) return { kind: "undefined" };
    if (value === null || typeof value === "string" || typeof value === "boolean") return { kind: "value", value };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { kind: "number", value: String(value) as "NaN" | "Infinity" | "-Infinity" };
      return { kind: "value", value };
    }
    if (typeof value === "bigint") return { kind: "bigint", value: String(value) };
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("ERR_ATOOLS_NODE_VALUE: unsupported argument");
    const handle = hooks.existingHandle(value);
    if (handle) return handle;
    if (typeof value === "function") return { kind: "callback", id: hooks.callback(value) };
    if (value instanceof Date) return { kind: "date", value: snapshots?.get(value)?.value ?? value.toISOString() };
    if (value instanceof Error) {
      const snapshot = snapshots?.get(value)?.data;
      const error = value as Error & { code?: string };
      return snapshot ? { kind: "error", ...snapshot } : { kind: "error", name: error.name, message: error.message, code: error.code, stack: error.stack };
    }
    if (value instanceof BridgeBuffer || buffers.has(value) || (typeof nativeBuffer?.isBuffer === "function" && nativeBuffer.isBuffer(value))) {
      return { kind: "buffer", data: base64(value as Uint8Array) };
    }
    if (value instanceof ArrayBuffer) return { kind: "typedArray", name: "ArrayBuffer", data: base64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      return { kind: "typedArray", name: value.constructor.name, data: base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (ancestors.has(value)) throw new TypeError("ERR_ATOOLS_NODE_VALUE: cyclic arguments require a remote handle");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items = snapshots?.get(value)?.items ?? value;
        return { kind: "array", items: items.map((item: unknown) => encode(item, ancestors, snapshots)) };
      }
      const fsValue = fsValues.get(value);
      if (fsValue) {
        const entries = snapshots?.get(value)?.entries ?? Object.entries(value);
        const properties = Object.fromEntries(entries.map(([key, item]: [string, unknown]) => [key, encode(item, ancestors, snapshots)]));
        return fsValue === "fsStats" ? { kind: "fsStats", properties } : { kind: "fsDirent", type: fsValue.type, properties };
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError("ERR_ATOOLS_NODE_VALUE: only plain objects can be copied");
      }
      const entries = snapshots?.get(value)?.entries ?? Object.entries(value);
      return { kind: "object", properties: Object.fromEntries(entries.map(([key, item]: [string, unknown]) => [key, encode(item, ancestors, snapshots)])) };
    } finally { ancestors.delete(value); }
  }

  function encodeMany(values: unknown[]): EncodedNodeValue[] {
    const prepared = payloadBudget.prepareValues(values);
    return values.map((value) => encode(value, new Set<object>(), prepared.snapshots));
  }

  function createLocalBuffer(value: string | Uint8Array, selected?: string): Uint8Array {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
      throw new TypeError("ERR_ATOOLS_NODE_VALUE: local Buffer input must be text or bytes");
    }
    const buffer = BridgeBuffer.from(value, selected);
    buffers.add(buffer);
    return buffer;
  }

  function isLocalBuffer(value: unknown): boolean {
    return !!value && (typeof value === "object" || typeof value === "function") && buffers.has(value as object);
  }

  function encodeOne(value: unknown): EncodedNodeValue { return encodeMany([value])[0]; }

  function decode(value: EncodedNodeValue): any {
    switch (value.kind) {
      case "value": return value.value;
      case "undefined": return undefined;
      case "number": return Number(value.value);
      case "bigint": return BigInt(value.value);
      case "date": return new Date(value.value);
      case "handle": return hooks.handle(value);
      case "promise": return hooks.promise(value.handleId);
      case "array": return value.items.map(decode);
      case "object": return Object.fromEntries(Object.entries(value.properties).map(([key, item]) => [key, decode(item)]));
      case "fsStats":
      case "fsDirent": {
        const result = value.kind === "fsStats" ? new BridgeStats() : new BridgeDirent();
        fsValues.set(result, value.kind === "fsStats" ? "fsStats" : { kind: "fsDirent", type: value.type });
        for (const [key, item] of Object.entries(value.properties)) {
          Object.defineProperty(result, key, { value: decode(item), writable: true, enumerable: true, configurable: true });
        }
        return result;
      }
      case "buffer": {
        const bytes = bytesFromBase64(value.data);
        const result = nativeBuffer ? nativeBuffer.from(bytes) : new BridgeBuffer(bytes);
        buffers.add(result);
        return result;
      }
      case "typedArray": {
        if (!typedArrays.has(value.name)) throw new Error(`ERR_ATOOLS_NODE_TYPED_ARRAY: ${value.name}`);
        const bytes = bytesFromBase64(value.data);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (value.name === "ArrayBuffer") return buffer;
        const Constructor = (globalThis as any)[value.name];
        if (typeof Constructor !== "function") throw new Error(`ERR_ATOOLS_NODE_TYPED_ARRAY: ${value.name} unavailable`);
        return new Constructor(buffer);
      }
      case "error": {
        const error = new Error(value.message) as Error & { code?: string };
        error.name = value.name;
        if (value.code) error.code = value.code;
        if (value.stack) error.stack = value.stack;
        return error;
      }
      default: throw new Error("ERR_ATOOLS_NODE_VALUE: invalid remote value");
    }
  }
  return { encode: encodeOne, encodeMany, decode, createLocalBuffer, isLocalBuffer };
}

/** Include every runtime dependency when this codec is serialized into a frame. */
export function nodeModuleCodecScript(payloadBudgetFactory = `(${createNodeModulePayloadBudget.toString()})`): string {
  return `(hooks => (${createNodeModuleCodec.toString()})(hooks, ${browserBufferFactoryScript()}, ${payloadBudgetFactory}))`;
}
