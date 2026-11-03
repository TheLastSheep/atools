export type PluginNativeTextReadResult =
  | { handled: false }
  | { handled: true; value: string };
export type PluginNativeTextWriteResult = { handled: false } | { handled: true };

export type PluginNodeFsModule = {
  readFileSync: (...args: unknown[]) => unknown;
  writeFileSync: (...args: unknown[]) => unknown;
  [key: string]: unknown;
};

export function createPluginNodeFs(
  nativeRead: ((path: string) => unknown) | undefined,
  hostFs: () => object,
  nativeWrite?: (path: string, text: string) => unknown,
): { module: PluginNodeFsModule; close: () => void } {
  const MAX_NATIVE_PATH_BYTES = 8 * 1024;
  const MAX_NATIVE_TEXT_BYTES = 512 * 1024;
  let closed = false;
  let hostModuleResolved = false;
  let hostModule: object | undefined;
  let readFileSyncWrapper: ((...args: unknown[]) => unknown) | undefined;
  let writeFileSyncWrapper: ((...args: unknown[]) => unknown) | undefined;

  function closedError(): Error & { code: string } {
    const error = new Error("Plugin fs facade is closed") as Error & { code: string };
    error.code = "ERR_ATOOLS_PLUGIN_FS_CLOSED";
    return error;
  }

  function assertOpen(): void {
    if (closed) throw closedError();
  }

  function nativeResponseError(): never {
    const error = new Error("Invalid native fs response") as Error & { code: string };
    error.code = "ERR_ATOOLS_NATIVE_FS_RESPONSE";
    throw error;
  }

  function getHostModule(): object {
    assertOpen();
    if (!hostModuleResolved) {
      hostModule = hostFs();
      hostModuleResolved = true;
    }
    return hostModule!;
  }

  function utf8WithinBudget(value: string, maxBytes: number, rejectNul: boolean, rejectUnpairedSurrogates: boolean): boolean {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0 && rejectNul) return false;
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < value.length
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        if (rejectUnpairedSurrogates) return false;
        bytes += 3;
      } else bytes += 3;
      if (bytes > maxBytes) return false;
    }
    return true;
  }

  function utf8PathWithinBudget(path: string): boolean {
    return path.startsWith("/")
      && utf8WithinBudget(path, MAX_NATIVE_PATH_BYTES, true, false);
  }

  function utf8WritePathWithinBudget(path: string): boolean {
    return path.startsWith("/")
      && utf8WithinBudget(path, MAX_NATIVE_PATH_BYTES, true, true);
  }

  function decodeNativeResponse(response: unknown): PluginNativeTextReadResult {
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      return nativeResponseError();
    }
    const keys = Reflect.ownKeys(response);
    const handledDescriptor = Reflect.getOwnPropertyDescriptor(response, "handled");
    if (!handledDescriptor || !("value" in handledDescriptor)) return nativeResponseError();
    if (handledDescriptor.value === false && keys.length === 1 && keys[0] === "handled") {
      return { handled: false };
    }
    const valueDescriptor = Reflect.getOwnPropertyDescriptor(response, "value");
    if (handledDescriptor.value === true
      && keys.length === 2
      && keys.includes("handled")
      && keys.includes("value")
      && valueDescriptor
      && "value" in valueDescriptor
      && typeof valueDescriptor.value === "string") {
      return { handled: true, value: valueDescriptor.value };
    }
    return nativeResponseError();
  }

  function delegateReadFileSync(args: unknown[]): unknown {
    const module = getHostModule();
    const method = Reflect.get(module, "readFileSync", module);
    return Reflect.apply(method, module, args);
  }

  function decodeNativeWriteResponse(response: unknown): PluginNativeTextWriteResult {
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      return nativeResponseError();
    }
    const keys = Reflect.ownKeys(response);
    const handledDescriptor = Reflect.getOwnPropertyDescriptor(response, "handled");
    if (!handledDescriptor
      || !("value" in handledDescriptor)
      || keys.length !== 1
      || keys[0] !== "handled"
      || (handledDescriptor.value !== true && handledDescriptor.value !== false)) {
      return nativeResponseError();
    }
    return handledDescriptor.value ? { handled: true } : { handled: false };
  }

  function delegateWriteFileSync(args: unknown[]): unknown {
    const module = getHostModule();
    const method = Reflect.get(module, "writeFileSync", module);
    return Reflect.apply(method, module, args);
  }

  function readFileSync(...args: unknown[]): unknown {
    assertOpen();
    if (nativeRead
      && args.length === 2
      && typeof args[0] === "string"
      && utf8PathWithinBudget(args[0])
      && (args[1] === "utf8" || args[1] === "utf-8")) {
      const response = decodeNativeResponse(nativeRead(args[0]));
      if (response.handled) return response.value;
    }
    return delegateReadFileSync(args);
  }

  function writeFileSync(...args: unknown[]): unknown {
    assertOpen();
    const hasSupportedEncoding = args.length === 2
      || (args.length === 3 && (args[2] === "utf8" || args[2] === "utf-8"));
    if (nativeWrite
      && hasSupportedEncoding
      && typeof args[0] === "string"
      && utf8WritePathWithinBudget(args[0])
      && typeof args[1] === "string"
      && utf8WithinBudget(args[1], MAX_NATIVE_TEXT_BYTES, false, true)) {
      const response = decodeNativeWriteResponse(nativeWrite(args[0], args[1]));
      if (response.handled) return undefined;
    }
    return delegateWriteFileSync(args);
  }

  const module = new Proxy(Object.create(null) as PluginNodeFsModule, {
    get(_target, property) {
      assertOpen();
      if (property === "readFileSync") {
        if (!nativeRead) {
          const host = getHostModule();
          return Reflect.get(host, property, host);
        }
        readFileSyncWrapper ??= readFileSync;
        return readFileSyncWrapper;
      }
      if (property === "writeFileSync" && nativeWrite) {
        writeFileSyncWrapper ??= writeFileSync;
        return writeFileSyncWrapper;
      }
      const host = getHostModule();
      return Reflect.get(host, property, host);
    },
    has(_target, property) {
      assertOpen();
      return Reflect.has(getHostModule(), property);
    },
    ownKeys() {
      assertOpen();
      return Reflect.ownKeys(getHostModule());
    },
    getOwnPropertyDescriptor(_target, property) {
      assertOpen();
      const host = getHostModule();
      const descriptor = Reflect.getOwnPropertyDescriptor(host, property);
      if (!descriptor) return undefined;
      if (property === "readFileSync" && nativeRead && "value" in descriptor) {
        readFileSyncWrapper ??= readFileSync;
        return { ...descriptor, configurable: true, value: readFileSyncWrapper };
      }
      if (property === "writeFileSync" && nativeWrite && "value" in descriptor) {
        writeFileSyncWrapper ??= writeFileSync;
        return { ...descriptor, configurable: true, value: writeFileSyncWrapper };
      }
      // The facade target is empty and extensible, so reflected borrowed host
      // members must stay configurable here even when the host member is not.
      return { ...descriptor, configurable: true };
    },
  });

  return {
    module,
    close(): void {
      if (closed) return;
      closed = true;
      hostModule = undefined;
      readFileSyncWrapper = undefined;
      writeFileSyncWrapper = undefined;
    },
  };
}
