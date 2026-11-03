/** Synchronous localStorage adapter for opaque plugin documents. */
export function createPluginLocalStorage(
  config: { instanceId: string },
  invoke: (method: string, args: unknown[]) => unknown,
  invokeAsync: (method: string, args: unknown[]) => Promise<unknown>,
) {
  const targetWindow = window as Window & {
    __ATOOLS_FRAME_TRANSPORT__?: { accept: (event: MessageEvent) => boolean };
    Storage?: { prototype: object };
  };
  let closed = false, installed = false, originalDescriptor: PropertyDescriptor | undefined;
  let proxy: object | undefined;
  let descriptorSnapshot: Map<string, string> | null = null;
  const clientId = (() => {
    try {
      const bytes = new Uint8Array(16);
      targetWindow.crypto.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    } catch { return ""; }
  })();
  function exception(name: "QuotaExceededError" | "SecurityError" | "InvalidStateError") {
    const messages = {
      QuotaExceededError: "The quota has been exceeded.",
      SecurityError: "The operation is insecure.",
      InvalidStateError: "The storage session is no longer available.",
    };
    return new DOMException(messages[name], name);
  }
  function failName(value: unknown): "QuotaExceededError" | "SecurityError" | "InvalidStateError" {
    if (value && typeof value === "object") {
      const candidate = value as { name?: unknown; code?: unknown };
      if (candidate.name === "QuotaExceededError" || candidate.code === "ERR_ATOOLS_DATA_LIMIT") return "QuotaExceededError";
      if (candidate.name === "SecurityError" || candidate.code === "ERR_ATOOLS_DATA_PERMISSION_REQUIRED") return "SecurityError";
      if (candidate.name === "InvalidStateError" || candidate.code === "ERR_ATOOLS_DATA_CLOSED"
        || candidate.code === "ERR_ATOOLS_DATA_SESSION") return "InvalidStateError";
    }
    return "InvalidStateError";
  }
  function ensureOpen() { if (closed) throw exception("InvalidStateError"); }
  function toDOMString(value: unknown) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value);
  }
  function requireArgs(args: IArguments | unknown[], count: number) {
    if (args.length < count) throw new TypeError("Not enough arguments");
  }
  function utf8Length(value: string) { return new TextEncoder().encode(value).byteLength; }
  function bytesToBase64(bytes: Uint8Array) {
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  }
  function base64ToBytes(value: unknown) {
    if (typeof value !== "string" || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw exception("InvalidStateError");
    }
    let binary: string;
    try { binary = atob(value); } catch { throw exception("InvalidStateError"); }
    if (btoa(binary) !== value) throw exception("InvalidStateError");
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  function encodeString(value: string, maximumBytes = 128 * 1024) {
    if (value.length * 2 > maximumBytes) throw exception("QuotaExceededError");
    const bytes = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      bytes[index * 2] = code & 0xff;
      bytes[index * 2 + 1] = code >>> 8;
    }
    return bytesToBase64(bytes);
  }
  function encodeKey(value: string) { return encodeString(value, 2 * 1024); }
  function decodeString(value: unknown) {
    const bytes = base64ToBytes(value);
    if (bytes.length % 2 !== 0) throw exception("InvalidStateError");
    let output = "";
    for (let offset = 0; offset < bytes.length; offset += 2) {
      output += String.fromCharCode(bytes[offset] | (bytes[offset + 1] << 8));
    }
    return output;
  }
  function storageCall(method: string, extra: unknown[] = []) {
    ensureOpen();
    let url: string;
    try { url = String(targetWindow.location.href); }
    catch { throw exception("SecurityError"); }
    if (utf8Length(url) > 8192 || !/^[0-9a-f]{32}$/.test(clientId)) throw exception("InvalidStateError");
    let result: unknown;
    try { result = invoke(method, [clientId, url, ...extra]); }
    catch (error) {
      if (error instanceof DOMException && ["QuotaExceededError", "SecurityError", "InvalidStateError"].includes(error.name)) throw error;
      throw exception(failName(error));
    }
    if (result && typeof result === "object" && (result as { error?: unknown }).error === true) {
      throw exception(failName(result));
    }
    return result;
  }
  function clearDescriptorSnapshot() { descriptorSnapshot = null; }
  function readValue(result: unknown) {
    if (result === null) return null;
    try {
      const bytes = base64ToBytes(result);
      if (bytes.length > 128 * 1024) throw exception("QuotaExceededError");
      return decodeString(result);
    } catch (error) {
      if (error instanceof DOMException) throw error;
      throw exception("InvalidStateError");
    }
  }
  function keyExists(key: string) { return readValue(storageCall("getItem", [encodeKey(key)])) !== null; }
  function listEntries() {
    const entries = new Map<string, string>();
    let offset = 0, totalBytes = 0, totalKeyBytes = 0;
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      const result = storageCall("entries", [offset]);
      if (!result || typeof result !== "object" || Array.isArray(result)
        || Object.keys(result).sort().join(",") !== "entries,nextOffset") throw exception("InvalidStateError");
      const serialized = JSON.stringify(result);
      if (serialized === undefined || utf8Length(serialized) > 384 * 1024) throw exception("InvalidStateError");
      const page = result as { entries?: unknown; nextOffset?: unknown };
      if (!Array.isArray(page.entries) || page.entries.length > 4096 - entries.size) throw exception("InvalidStateError");
      for (const raw of page.entries) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || Object.keys(raw).sort().join(",") !== "key,value") throw exception("InvalidStateError");
        const item = raw as { key: unknown; value: unknown };
        const keyBytes = base64ToBytes(item.key), valueBytes = base64ToBytes(item.value);
        if (keyBytes.length % 2 !== 0 || keyBytes.length > 2048 || valueBytes.length % 2 !== 0 || valueBytes.length > 128 * 1024) {
          throw exception("InvalidStateError");
        }
        totalKeyBytes += keyBytes.length;
        totalBytes += keyBytes.length + valueBytes.length;
        if (totalKeyBytes > 256 * 1024 || totalBytes > 5 * 1024 * 1024) throw exception("InvalidStateError");
        const key = decodeString(item.key);
        if (entries.has(key)) throw exception("InvalidStateError");
        entries.set(key, decodeString(item.value));
      }
      if (page.nextOffset === null) return entries;
      const nextOffset = page.nextOffset;
      if (typeof nextOffset !== "number" || !Number.isInteger(nextOffset) || nextOffset < 0 || nextOffset > 0xffffffff
        || page.entries.length === 0 || nextOffset !== offset + page.entries.length
        || nextOffset <= offset || pageNumber === 63) throw exception("InvalidStateError");
      offset = nextOffset;
    }
    throw exception("InvalidStateError");
  }
  function mutation(method: string, key: string | null, value?: string) {
    clearDescriptorSnapshot();
    const args = key === null ? [] : [encodeKey(key), ...(method === "setItem" ? [encodeString(value!)] : [])];
    const result = storageCall(method, args);
    if (!result || typeof result !== "object") throw exception("InvalidStateError");
    const record = result as { error?: unknown; name?: unknown; key?: unknown; oldValue?: unknown; newValue?: unknown; changed?: unknown };
    if (record.error === true) {
      const name = record.name === "QuotaExceededError" || record.name === "SecurityError" || record.name === "InvalidStateError"
        ? record.name : "InvalidStateError";
      throw exception(name);
    }
    if (record.error !== undefined || typeof record.changed !== "boolean") throw exception("InvalidStateError");
    if (Object.keys(record).sort().join(",") !== "changed,key,newValue,oldValue") throw exception("InvalidStateError");
    const decodedKey = record.key === null ? null : decodeString(record.key);
    if (decodedKey !== key) throw exception("InvalidStateError");
    if (record.key !== null && base64ToBytes(record.key).length > 2048) throw exception("InvalidStateError");
    const oldValue = record.oldValue === null ? null : decodeString(record.oldValue);
    const newValue = record.newValue === null ? null : decodeString(record.newValue);
    if (method === "setItem" && newValue !== value) throw exception("InvalidStateError");
    if (method === "removeItem" && newValue !== null) throw exception("InvalidStateError");
    if (method === "clear" && (record.key !== null || record.oldValue !== null || record.newValue !== null)) throw exception("InvalidStateError");
    for (const item of [oldValue, newValue]) if (item !== null && item.length * 2 > 128 * 1024) throw exception("InvalidStateError");
    return record;
  }
  function makeStorageProxy() {
    const methods: Record<string, Function> = {
      getItem: function (key: unknown) { requireArgs(arguments, 1); return readValue(storageCall("getItem", [encodeKey(toDOMString(key))])); },
      setItem: function (key: unknown, value: unknown) { requireArgs(arguments, 2); mutation("setItem", toDOMString(key), toDOMString(value)); },
      removeItem: function (key: unknown) { requireArgs(arguments, 1); mutation("removeItem", toDOMString(key)); },
      clear: function () { mutation("clear", null); },
      key: function (index: unknown) {
        requireArgs(arguments, 1);
        const number = +(index as any);
        const unsigned = Number.isFinite(number) ? ((Math.trunc(number) % 0x100000000) + 0x100000000) % 0x100000000 : 0;
        const value = storageCall("key", [unsigned]);
        if (value === null) return null;
        if (base64ToBytes(value).length > 2048) throw exception("InvalidStateError");
        return decodeString(value);
      },
    };
    const target = Object.create(targetWindow.Storage ? targetWindow.Storage.prototype : null);
    function namedVisible(property: string) {
      if (Object.prototype.hasOwnProperty.call(target, property)) return false;
      let prototype = Object.getPrototypeOf(target);
      while (prototype) {
        if (Object.prototype.hasOwnProperty.call(prototype, property)) return false;
        prototype = Object.getPrototypeOf(prototype);
      }
      return true;
    }
    return new Proxy(target, {
      get(_target, property, receiver) {
        ensureOpen();
        if (property === "length") {
          const value = storageCall("length");
          if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 4096) throw exception("InvalidStateError");
          return value;
        }
        if (typeof property === "string" && Object.prototype.hasOwnProperty.call(methods, property)) return methods[property];
        if (typeof property !== "string") return Reflect.get(target, property, receiver);
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        const result = readValue(storageCall("getItem", [encodeKey(property)]));
        return result === null ? Reflect.get(target, property, receiver) : result;
      },
      set(_target, property, value) {
        ensureOpen();
        if (typeof property === "symbol") return Reflect.set(target, property, value);
        mutation("setItem", property, toDOMString(value));
        return true;
      },
      deleteProperty(_target, property) {
        ensureOpen();
        if (typeof property === "symbol") return Reflect.deleteProperty(target, property);
        if (!namedVisible(property)) return Reflect.deleteProperty(target, property);
        mutation("removeItem", property);
        return true;
      },
      has(_target, property) {
        ensureOpen();
        if (typeof property !== "string") return Reflect.has(target, property);
        if (Reflect.has(target, property)) return true;
        return keyExists(property);
      },
      ownKeys() {
        ensureOpen();
        clearDescriptorSnapshot();
        const entries = listEntries();
        descriptorSnapshot = entries;
        targetWindow.queueMicrotask(() => { clearDescriptorSnapshot(); });
        const visible = [...entries.keys()].filter(namedVisible);
        return [...visible, ...Reflect.ownKeys(target).filter(property => typeof property === "symbol")];
      },
      getOwnPropertyDescriptor(_target, property) {
        ensureOpen();
        const own = Reflect.getOwnPropertyDescriptor(target, property);
        if (own) return own;
        if (typeof property !== "string" || !namedVisible(property)) return undefined;
        if (descriptorSnapshot?.has(property)) {
          const value = descriptorSnapshot.get(property)!;
          descriptorSnapshot.delete(property);
          return { configurable: true, enumerable: true, writable: true, value };
        }
        const value = readValue(storageCall("getItem", [encodeKey(property)]));
        return value === null ? undefined : { configurable: true, enumerable: true, writable: true, value };
      },
    });
  }
  function eventText(value: unknown, allowNull: boolean, maximum = 128 * 1024) {
    if (allowNull && value === null) return null;
    const bytes = base64ToBytes(value);
    if (bytes.length % 2 !== 0 || bytes.length > maximum) throw exception("InvalidStateError");
    return decodeString(value);
  }
  function defineFallbackEvent(change: { key: string | null; oldValue: string | null; newValue: string | null; url: string }) {
    const event = new Event("storage");
    for (const [name, value] of Object.entries({ ...change, storageArea: proxy })) {
      Object.defineProperty(event, name, { configurable: false, enumerable: true, get: () => value });
    }
    return event;
  }
  function defineStorageArea(event: Event) {
    Object.defineProperty(event, "storageArea", { configurable: false, enumerable: true, get: () => proxy });
    return event;
  }
  const seenEvents = new Set<string>();
  function receive(event: MessageEvent) {
    if (closed || event.source !== targetWindow.parent) return;
    const transport = targetWindow.__ATOOLS_FRAME_TRANSPORT__;
    if (transport) {
      try { if (!transport.accept(event)) return; } catch { return; }
    }
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const hasDocumentEnvelope = Object.prototype.hasOwnProperty.call(data, "__atoolsDocument");
    const expectedKeys = hasDocumentEnvelope
      ? "__atoolsDocument,__atools_web_storage_event__,eventId,instanceId"
      : "__atools_web_storage_event__,eventId,instanceId";
    if (Object.keys(data).sort().join(",") !== expectedKeys
      || (hasDocumentEnvelope && (!transport || !data.__atoolsDocument || typeof data.__atoolsDocument !== "object"
        || Array.isArray(data.__atoolsDocument)
        || Object.keys(data.__atoolsDocument).sort().join(",") !== "docNonce,generation,pageDocumentId"
        || typeof data.__atoolsDocument.pageDocumentId !== "string" || !data.__atoolsDocument.pageDocumentId
        || data.__atoolsDocument.pageDocumentId.length > 128
        || typeof data.__atoolsDocument.docNonce !== "string" || !/^[0-9a-f]{32}$/.test(data.__atoolsDocument.docNonce)
        || !Number.isSafeInteger(data.__atoolsDocument.generation) || data.__atoolsDocument.generation < 1))
      || data.__atools_web_storage_event__ !== true || data.instanceId !== config.instanceId
      || typeof data.eventId !== "string" || !/^[0-9a-f]{32}$/.test(data.eventId)
      || seenEvents.has(data.eventId)) return;
    seenEvents.add(data.eventId);
    if (seenEvents.size > 32) seenEvents.delete(seenEvents.values().next().value!);
    const eventId = data.eventId;
    const header = [clientId, String(targetWindow.location.href), eventId];
    if (utf8Length(header[1]) > 8192) return;
    let pending: Promise<unknown>;
    try { pending = invokeAsync("event", header); }
    catch { return; }
    void Promise.resolve(pending).then(result => {
      if (closed || result === null || !result || typeof result !== "object") return;
      const change = result as { clientId?: unknown; url?: unknown; key?: unknown; oldValue?: unknown; newValue?: unknown };
      if (Object.keys(change).sort().join(",") !== "clientId,key,newValue,oldValue,url"
        || typeof change.clientId !== "string" || !/^[0-9a-f]{32}$/.test(change.clientId)
        || change.clientId === clientId || typeof change.url !== "string" || utf8Length(change.url) > 8192) return;
      const key = eventText(change.key, true, 2048);
      const oldValue = eventText(change.oldValue, true), newValue = eventText(change.newValue, true);
      if (key === null && (oldValue !== null || newValue !== null)) return;
      const detail = { key, oldValue, newValue, url: change.url };
      setTimeout(() => {
        if (closed) return;
        let storageEvent: Event;
        try {
          // The proxy has Storage's surface but no native Storage brand. Build
          // the native event with null, then expose the adapter through its
          // own readonly storageArea property.
          storageEvent = defineStorageArea(new StorageEvent("storage", { ...detail, storageArea: null }));
        }
        catch { storageEvent = defineFallbackEvent(detail); }
        targetWindow.dispatchEvent(storageEvent);
      }, 0);
    }).catch(() => {});
  }
  function close() {
    if (closed) return;
    closed = true;
    clearDescriptorSnapshot();
    targetWindow.removeEventListener("message", receive);
    targetWindow.removeEventListener("pagehide", close);
    targetWindow.removeEventListener("atools-plugin-out", close);
    try {
      if (installed && targetWindow.localStorage === proxy) {
        if (originalDescriptor) Object.defineProperty(targetWindow, "localStorage", originalDescriptor);
        else Reflect.deleteProperty(targetWindow, "localStorage");
      }
    } catch { /* Existing references are still revoked by closed checks. */ }
  }
  try {
    try {
      const nativeStorage = targetWindow.localStorage;
      return { installed: false, storage: nativeStorage, close() { closed = true; } };
    } catch (error) {
      if (!(error && typeof error === "object" && (error as { name?: string }).name === "SecurityError")) throw error;
    }
    if (!clientId || typeof targetWindow.location?.href !== "string") return { installed: false, close() { closed = true; } };
    originalDescriptor = Object.getOwnPropertyDescriptor(targetWindow, "localStorage");
    proxy = makeStorageProxy();
    Object.defineProperty(targetWindow, "localStorage", { configurable: true, enumerable: true, value: proxy });
    if (targetWindow.localStorage !== proxy) throw exception("SecurityError");
    installed = true;
    targetWindow.addEventListener("message", receive);
    targetWindow.addEventListener("pagehide", close, { once: true });
    targetWindow.addEventListener("atools-plugin-out", close);
    return { installed, storage: proxy, close };
  } catch {
    return { installed: false, close() { closed = true; } };
  }
}
