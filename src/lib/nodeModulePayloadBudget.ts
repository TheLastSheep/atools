type HandleLookup = (value: object) => { handleId: number; callable: boolean; keys: string[] } | undefined;
type FsLookup = (value: object) => "fsStats" | { kind: "fsDirent"; type: number } | undefined;

/** Bounded preflight shared by the value codec and the loopback transport. */
export function createNodeModulePayloadBudget(options: { existingHandle?: HandleLookup; fsValue?: FsLookup } = {}) {
  const MAX_REQUEST_BYTES = 1024 * 1024;
  const MAX_BINARY_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 900 * 1024;
  const MAX_DEPTH = 64;
  const MAX_NODES = 8192;
  const NODE_OVERHEAD_BYTES = 64;
  function fail(): never {
    const error = new Error("Node module payload exceeds the local request budget") as Error & { code: string };
    error.name = "NodeModuleBridgeError";
    error.code = "ERR_ATOOLS_NODE_PAYLOAD";
    throw error;
  }

  function utf8JsonStringBytes(text: string, stopAt: number): number {
    let bytes = 2;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
      else if (code < 32) bytes += 6;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
        else bytes += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
      else if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else bytes += 3;
      if (bytes > stopAt) fail();
    }
    return bytes;
  }

  function binaryLength(value: object): number | undefined {
    try { return Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value); }
    catch { /* Not an ArrayBuffer. */ }
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return undefined;
  }

  /** Snapshots enumerable values once so accessor side effects are not repeated during encoding. */
  function prepareValues(values: unknown[]) {
    const snapshots = new WeakMap<object, any>();
    const ancestors = new Set<object>();
    let estimatedBytes = 128; // call method, ids, JSON-RPC envelope, and endpoint metadata
    let nodes = 0;

    function add(bytes: number) {
      estimatedBytes += bytes;
      if (estimatedBytes > MAX_VALUE_BYTES) fail();
    }
    function visit(value: unknown, depth: number, arraySlot = false): void {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail();
      add(NODE_OVERHEAD_BYTES);
      if (value === undefined) { if (arraySlot) add(4); return; }
      if (value === null || typeof value === "boolean") { add(value === null ? 4 : 5); return; }
      if (typeof value === "string") { add(utf8JsonStringBytes(value, MAX_VALUE_BYTES - estimatedBytes)); return; }
      if (typeof value === "number") { add(Number.isFinite(value) ? String(value).length : 12); return; }
      if (typeof value === "bigint") {
        const magnitude = value < 0n ? -value : value;
        if ((magnitude >> BigInt(MAX_VALUE_BYTES * 3)) !== 0n) fail();
        add(utf8JsonStringBytes(value.toString(), MAX_VALUE_BYTES - estimatedBytes)); return;
      }
      if (typeof value === "function") { add(40); return; }
      if (typeof value !== "object") fail();

      const handle = options.existingHandle?.(value);
      if (handle) {
        add(48 + String(handle.handleId).length + (handle.callable ? 4 : 5));
        for (const key of handle.keys) add(utf8JsonStringBytes(key, MAX_VALUE_BYTES - estimatedBytes) + 1);
        return;
      }
      if (ancestors.has(value)) throw new TypeError("ERR_ATOOLS_NODE_VALUE: cyclic arguments require a remote handle");
      const cached = snapshots.get(value);
      if (cached) {
        // Count the same serialized value again for each alias while reusing its
        // first snapshot, so enumerable getters run once per call.
        addCached(cached, depth);
        return;
      }
      ancestors.add(value);
      try {
        const size = binaryLength(value);
        if (size !== undefined) {
          if (size > MAX_BINARY_BYTES) fail();
          snapshots.set(value, { kind: "binary", size });
          add(64 + Math.ceil(size / 3) * 4);
          return;
        }
        if (value instanceof Date) {
          const date = Date.prototype.toISOString.call(value);
          snapshots.set(value, { kind: "date", value: date });
          add(utf8JsonStringBytes(date, MAX_VALUE_BYTES - estimatedBytes));
          return;
        }
        if (value instanceof Error) {
          const error = value as Error & { code?: unknown };
          const data = { name: error.name, message: error.message, code: error.code, stack: error.stack };
          snapshots.set(value, { kind: "error", data });
          for (const field of [data.name, data.message, data.code, data.stack]) {
            if (typeof field === "string") add(utf8JsonStringBytes(field, MAX_VALUE_BYTES - estimatedBytes));
          }
          return;
        }
        if (Array.isArray(value)) {
          if (value.length > MAX_NODES - nodes) fail();
          const items = new Array(value.length);
          for (let index = 0; index < value.length; index++) {
            if (!Object.prototype.hasOwnProperty.call(value, index)) { add(4); continue; }
            const item = value[index];
            items[index] = item;
            visit(item, depth + 1, true);
          }
          snapshots.set(value, { kind: "array", items });
          return;
        }
        const fsValue = options.fsValue?.(value);
        if (!fsValue && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail();
        const entries: [string, unknown][] = [];
        const record = value as Record<string, unknown>;
        for (const key in record) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (!descriptor?.enumerable) continue;
          const item = record[key];
          entries.push([key, item]);
          add(utf8JsonStringBytes(key, MAX_VALUE_BYTES - estimatedBytes) + 1);
          visit(item, depth + 1);
        }
        snapshots.set(value, { kind: fsValue ? "fs" : "object", entries });
      } finally { ancestors.delete(value); }
    }

    function addCached(cached: any, depth: number): void {
      if (cached.kind === "binary") { add(64 + Math.ceil(cached.size / 3) * 4); return; }
      if (cached.kind === "date") { add(utf8JsonStringBytes(cached.value, MAX_VALUE_BYTES - estimatedBytes)); return; }
      if (cached.kind === "error") {
        for (const field of [cached.data.name, cached.data.message, cached.data.code, cached.data.stack]) {
          if (typeof field === "string") add(utf8JsonStringBytes(field, MAX_VALUE_BYTES - estimatedBytes));
        }
        return;
      }
      if (cached.kind === "array") {
        for (let index = 0; index < cached.items.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(cached.items, index)) { add(4); continue; }
          visit(cached.items[index], depth + 1, true);
        }
        return;
      }
      if (cached.kind === "object" || cached.kind === "fs") {
        for (const [key, item] of cached.entries as [string, unknown][]) {
          add(utf8JsonStringBytes(key, MAX_VALUE_BYTES - estimatedBytes) + 1);
          visit(item, depth + 1);
        }
      }
    }

    for (const value of values) visit(value, 0);
    return { snapshots, estimatedBytes };
  }

  /** Fast bounded walk before JSON.stringify; exact UTF-8 size is checked afterward. */
  function assertJsonRequest(method: string, params: unknown): void {
    let bytes = 0, nodes = 0;
    const ancestors = new Set<object>();
    function add(amount: number) { bytes += amount; if (bytes > MAX_REQUEST_BYTES) fail(); }
    function walk(value: unknown, depth: number, arraySlot = false): void {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail();
      if (value === undefined) { if (arraySlot) add(4); return; }
      if (value === null) { add(4); return; }
      if (typeof value === "string") { add(utf8JsonStringBytes(value, MAX_REQUEST_BYTES - bytes)); return; }
      if (typeof value === "boolean") { add(value ? 4 : 5); return; }
      if (typeof value === "number") { add(Number.isFinite(value) ? String(value).length : 4); return; }
      if (typeof value !== "object") fail();
      if (ancestors.has(value)) throw new TypeError("ERR_ATOOLS_NODE_VALUE: cyclic request parameters");
      ancestors.add(value);
      try {
        if (ArrayBuffer.isView(value)) { add(32 + Math.min(value.byteLength, MAX_BINARY_BYTES + 1) * 2); return; }
        if (Array.isArray(value)) {
          if (value.length > MAX_NODES - nodes) fail();
          for (const item of value) walk(item, depth + 1, true);
          return;
        }
        const record = value as Record<string, unknown>;
        for (const key in record) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          add(utf8JsonStringBytes(key, MAX_REQUEST_BYTES - bytes) + 1);
          walk(record[key], depth + 1);
        }
      } finally { ancestors.delete(value); }
    }
    add(32 + utf8JsonStringBytes(method, MAX_REQUEST_BYTES - 32));
    walk(params, 0);
  }

  return { prepareValues, assertJsonRequest, maxRequestBytes: MAX_REQUEST_BYTES };
}
