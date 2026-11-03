/**
 * Restore Node's in-place FileHandle.read contract across the value-copying
 * module bridge. The returned wrapper aliases the original remote handle so
 * it can still be passed back through the codec without inventing an RPC.
 *
 * Keep this factory self-contained: nodeModuleBridgeScript serializes it into
 * an isolated plugin frame.
 */
export function createNodeFsFileHandleAdapters(
  assertOpen: () => void,
  registerAlias: (wrapper: object, raw: object) => void,
) {
  type ReadTarget = { view: ArrayBufferView; offset: number; length: number; remoteArgs: unknown[] };
  type CacheKind = "fs" | "promises" | "fileHandle";

  const wrappers = new WeakMap<object, Map<CacheKind, object>>();
  const openFunctions = new WeakMap<Function, WeakMap<object, Function>>();
  const readFunctions = new WeakMap<Function, WeakMap<object, Function>>();
  const openWrapperSources = new WeakMap<Function, Function>();
  const readWrapperSources = new WeakMap<Function, Function>();
  const fsSpecifiers = new Set(["fs", "node:fs"]);
  const promisesSpecifiers = new Set(["fs/promises", "node:fs/promises"]);

  function isObjectLike(value: unknown): value is object {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  function protocolError(message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = "NodeModuleBridgeError";
    error.code = "ERR_ATOOLS_NODE_FILE_HANDLE_READ_RESPONSE";
    return error;
  }

  function optionsError(): Error & { code: string } {
    const error = new Error("Accessor-based FileHandle.read options are unsupported across the value-copy bridge") as Error & { code: string };
    error.name = "NodeModuleBridgeError";
    error.code = "ERR_ATOOLS_NODE_FILE_HANDLE_READ_OPTIONS";
    return error;
  }

  function rangeError(field: string): RangeError & { code: string } {
    const error = new RangeError(`FileHandle.read ${field} is out of range`) as RangeError & { code: string };
    error.code = "ERR_OUT_OF_RANGE";
    return error;
  }

  function cachedWrapper<T extends object>(raw: object, kind: CacheKind, create: () => T): T {
    let byKind = wrappers.get(raw);
    if (!byKind) {
      byKind = new Map();
      wrappers.set(raw, byKind);
    }
    const existing = byKind.get(kind);
    if (existing) return existing as T;
    const wrapper = create();
    byKind.set(kind, wrapper);
    let byWrapper = wrappers.get(wrapper);
    if (!byWrapper) {
      byWrapper = new Map();
      wrappers.set(wrapper, byWrapper);
    }
    byWrapper.set(kind, wrapper);
    registerAlias(wrapper, raw);
    return wrapper;
  }

  function viewByteLength(view: ArrayBufferView): number {
    return view.byteLength;
  }

  function readTarget(args: unknown[]): ReadTarget | undefined {
    const first = args[0];
    let candidate: unknown;
    let offsetValue: unknown = 0;
    let lengthValue: unknown;
    let positionValue: unknown;
    let remoteArgs = args;

    if (ArrayBuffer.isView(first)) {
      candidate = first;
      const second = args[1];
      if (second !== null && typeof second === "object") {
        const parsed = readOptions(second, ["offset", "length", "position"]);
        offsetValue = parsed.values.offset;
        lengthValue = parsed.values.length;
        positionValue = parsed.values.position;
        if (parsed.forwarded !== second) {
          remoteArgs = args.slice();
          remoteArgs[1] = parsed.forwarded;
        }
      } else {
        offsetValue = second;
        lengthValue = args[2];
        positionValue = args[3];
      }
    } else if (first && typeof first === "object") {
      const parsed = readOptions(first, ["buffer", "offset", "length", "position"]);
      if (!Object.prototype.hasOwnProperty.call(parsed.values, "buffer")) return undefined;
      candidate = parsed.values.buffer;
      offsetValue = parsed.values.offset;
      lengthValue = parsed.values.length;
      positionValue = parsed.values.position;
      if (parsed.forwarded !== first) {
        remoteArgs = args.slice();
        remoteArgs[0] = parsed.forwarded;
      }
    } else {
      return undefined;
    }

    if (!ArrayBuffer.isView(candidate)) return undefined;
    const view = candidate as ArrayBufferView;
    const byteLength = viewByteLength(view);
    const offset = offsetValue === undefined ? 0 : offsetValue;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > byteLength) {
      throw rangeError("offset");
    }
    const length = lengthValue === undefined ? byteLength - (offset as number) : lengthValue;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > byteLength - (offset as number)) {
      throw rangeError("length");
    }
    validatePosition(positionValue);
    return { view, offset: offset as number, length: length as number, remoteArgs };
  }

  function readOptions(options: object, keys: string[]): { values: Record<string, unknown>; forwarded: object } {
    const descriptors = new Map<string, PropertyDescriptor>();
    const values: Record<string, unknown> = Object.create(null);
    let needsEnumerableCopy = false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (descriptor && !("value" in descriptor)) throw optionsError();
      if (!descriptor) continue;
      descriptors.set(key, descriptor);
      values[key] = descriptor.value;
      if (!descriptor.enumerable) needsEnumerableCopy = true;
    }
    if (!needsEnumerableCopy) return { values, forwarded: options };

    // The module codec copies enumerable own fields only. Promote recognized
    // non-enumerable data options so local writeback and Node see the same range.
    const forwarded: Record<string, unknown> = {};
    for (const [key, descriptor] of descriptors) {
      Object.defineProperty(forwarded, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: descriptor.value,
      });
    }
    return { values, forwarded };
  }

  function validatePosition(position: unknown): void {
    if (position === undefined || position === null || position === -1 || position === BigInt(-1)) return;
    if (typeof position === "bigint") {
      if (position < BigInt(-1)) throw rangeError("position");
      return;
    }
    if (typeof position !== "number") throw rangeError("position");
    if (!Number.isSafeInteger(position) || position < 0) throw rangeError("position");
  }

  function wrapRead(rawRead: Function, rawHandle: object): Function {
    const sourceRead = readWrapperSources.get(rawRead) ?? rawRead;
    let byOwner = readFunctions.get(sourceRead);
    if (!byOwner) {
      byOwner = new WeakMap();
      readFunctions.set(sourceRead, byOwner);
    }
    const existing = byOwner.get(rawHandle);
    if (existing) return existing;
    const wrapped = function(this: unknown, ...args: unknown[]) {
      assertOpen();
      const target = readTarget(args);
      const pending = Reflect.apply(sourceRead, rawHandle, target?.remoteArgs ?? args);
      if (!target) return pending;
      return Promise.resolve(pending).then((result: unknown) => {
        // Do not copy into a caller-owned view after the session has closed.
        assertOpen();
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw protocolError("Invalid FileHandle.read response");
        }
        const response = result as { bytesRead?: unknown; buffer?: unknown };
        const returnedBuffer = response.buffer;
        if (!ArrayBuffer.isView(returnedBuffer)) throw protocolError("FileHandle.read response has no byte view");
        const source = returnedBuffer as ArrayBufferView;
        const targetByteLength = target.view.byteLength;
        if (source.byteLength !== targetByteLength) throw protocolError("FileHandle.read response byte length does not match its target");
        const bytesRead = response.bytesRead;
        if (!Number.isSafeInteger(bytesRead) || (bytesRead as number) < 0 || (bytesRead as number) > target.length) {
          throw protocolError("FileHandle.read byte count is invalid");
        }

        if (bytesRead) {
          const targetBytes = new Uint8Array(target.view.buffer, target.view.byteOffset, targetByteLength);
          const sourceBytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
          targetBytes.set(sourceBytes.subarray(target.offset, target.offset + (bytesRead as number)), target.offset);
        }
        // A remote result object is a handle proxy. Mutating .buffer would send
        // an additional set RPC and still would not change that returned copy.
        // Node's FileHandle.read result has only these two own fields.
        return { bytesRead, buffer: target.view };
      });
    };
    byOwner.set(rawHandle, wrapped);
    readWrapperSources.set(wrapped, sourceRead);
    registerAlias(wrapped, sourceRead);
    return wrapped;
  }

  function wrapFileHandle(raw: unknown): unknown {
    if (!isObjectLike(raw)) return raw;
    return cachedWrapper(raw, "fileHandle", () => new Proxy(raw, {
      get(target, property) {
        assertOpen();
        const value = Reflect.get(target, property, target);
        return property === "read" && typeof value === "function" ? wrapRead(value, target) : value;
      },
      getOwnPropertyDescriptor(target, property) {
        assertOpen();
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (!descriptor || property !== "read") return descriptor;
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return descriptor;
        return { configurable: true, enumerable: descriptor.enumerable ?? false, writable: true, value: wrapRead(value, target) };
      },
      ownKeys(target) { assertOpen(); return Reflect.ownKeys(target); },
    }));
  }

  function wrapOpen(rawOpen: Function, rawPromises: object): Function {
    const sourceOpen = openWrapperSources.get(rawOpen) ?? rawOpen;
    let byOwner = openFunctions.get(sourceOpen);
    if (!byOwner) {
      byOwner = new WeakMap();
      openFunctions.set(sourceOpen, byOwner);
    }
    const existing = byOwner.get(rawPromises);
    if (existing) return existing;
    const wrapped = function(this: unknown, ...args: unknown[]) {
      assertOpen();
      const pending = Reflect.apply(sourceOpen, rawPromises, args);
      return Promise.resolve(pending).then((fileHandle: unknown) => {
        assertOpen();
        return wrapFileHandle(fileHandle);
      });
    };
    byOwner.set(rawPromises, wrapped);
    openWrapperSources.set(wrapped, sourceOpen);
    registerAlias(wrapped, sourceOpen);
    return wrapped;
  }

  function wrapPromises(raw: unknown): unknown {
    if (!isObjectLike(raw)) return raw;
    return cachedWrapper(raw, "promises", () => new Proxy(raw, {
      get(target, property) {
        assertOpen();
        const value = Reflect.get(target, property, target);
        return property === "open" && typeof value === "function" ? wrapOpen(value, target) : value;
      },
      getOwnPropertyDescriptor(target, property) {
        assertOpen();
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (!descriptor || property !== "open") return descriptor;
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return descriptor;
        return { configurable: true, enumerable: descriptor.enumerable ?? false, writable: true, value: wrapOpen(value, target) };
      },
      ownKeys(target) { assertOpen(); return Reflect.ownKeys(target); },
    }));
  }

  function wrapFs(raw: unknown): unknown {
    if (!isObjectLike(raw)) return raw;
    return cachedWrapper(raw, "fs", () => new Proxy(raw, {
      get(target, property) {
        assertOpen();
        const value = Reflect.get(target, property, target);
        return property === "promises" ? wrapPromises(value) : value;
      },
      getOwnPropertyDescriptor(target, property) {
        assertOpen();
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (!descriptor || property !== "promises") return descriptor;
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          writable: true,
          value: wrapPromises(Reflect.get(target, property, target)),
        };
      },
      ownKeys(target) { assertOpen(); return Reflect.ownKeys(target); },
    }));
  }

  function wrapModule(specifier: string, raw: unknown): unknown {
    assertOpen();
    if (fsSpecifiers.has(specifier)) return wrapFs(raw);
    if (promisesSpecifiers.has(specifier)) return wrapPromises(raw);
    return raw;
  }

  return { wrapModule };
}
