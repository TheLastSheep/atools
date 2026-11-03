import type { ClipboardHistoryCodecFactory, ClipboardHistoryItem } from "./clipboard-history";

type ClipboardHost = {
  instanceId?: string;
  ensureAccess?: (access: "history_read" | "history_delete" | "content_write" | "paste") => Promise<void>;
  historyRead?: (payload: Record<string, unknown>) => unknown;
  historyDelete?: (payload: Record<string, unknown>) => unknown;
  writeText?: (text: string) => unknown;
  writeContent?: (payload: Record<string, unknown>) => unknown;
  paste?: (payload: Record<string, unknown>) => unknown;
};

type NativeCall = (method: string, payload?: unknown) => unknown;

/** Public clipboard subset backed by the permissioned host session. */
export function createPluginClipboardApi(
  nativeCall: NativeCall,
  getHost: () => ClipboardHost | undefined,
  documentNonce: string | undefined,
  createHistoryCodec: ClipboardHistoryCodecFactory,
) {
  const maxTextBytes = 256 * 1024;
  const maxResponseBytes = 512 * 1024;
  function failure(code: string, message: string): Error {
    return Object.assign(new Error(code + ": " + message), { code });
  }
  const historyCodec = createHistoryCodec(failure);
  function hostCallOn(host: ClipboardHost, name: "historyRead" | "historyDelete" | "writeText", payload: unknown) {
    if (name === "writeText") {
      if (typeof payload !== "string" || typeof host.writeText !== "function") {
        throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Permissioned clipboard session is unavailable");
      }
      return host.writeText(payload);
    }
    if (name === "historyRead" && typeof host.historyRead === "function") {
      return host.historyRead(payload as Record<string, unknown>);
    }
    if (name === "historyDelete" && typeof host.historyDelete === "function") {
      return host.historyDelete(payload as Record<string, unknown>);
    }
    throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Permissioned clipboard session is unavailable");
  }
  function historyCall(access: "history_read" | "history_delete", payload: Record<string, unknown>, expectedHost?: ClipboardHost): Promise<unknown> {
    return Promise.resolve().then(async function() {
      const host = expectedHost || getHost();
      const method = access === "history_read" ? "historyRead" : "historyDelete";
      if (!host || getHost() !== host || typeof host[method] !== "function") {
        throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Permissioned clipboard session is unavailable");
      }
      if (typeof host.ensureAccess === "function") {
        await host.ensureAccess(access);
      } else if (typeof host.instanceId === "string") {
        // Real host bridges identify their session and must provide the authorization gate.
        throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard permission transport is unavailable");
      }
      if (getHost() !== host) {
        throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Permissioned clipboard session changed before the operation");
      }
      return hostCallOn(host, method, payload);
    });
  }
  function boundedResponse(value: unknown) {
    if (new TextEncoder().encode(JSON.stringify(value)).length > maxResponseBytes) {
      throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Clipboard response exceeds 512 KiB");
    }
    return value;
  }
  function copyText(text: string, expectedHost?: ClipboardHost) {
    if (new TextEncoder().encode(text).length > maxTextBytes) throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Clipboard text exceeds 256 KiB");
    const host = expectedHost || getHost();
    if (!host || getHost() !== host) throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard session changed before the operation");
    hostCallOn(host, "writeText", text);
    return { success: true };
  }
  async function contentCall(payload: Record<string, unknown>, shouldPaste: boolean, expectedHost?: ClipboardHost) {
    const host = expectedHost || getHost();
    const access = shouldPaste ? "paste" : "content_write";
    const method = shouldPaste ? "paste" : "writeContent";
    if (!host || getHost() !== host || typeof host[method] !== "function") {
      throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Permissioned clipboard write session is unavailable");
    }
    if (typeof host.ensureAccess === "function") await host.ensureAccess(access);
    else if (typeof host.instanceId === "string") {
      throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard permission transport is unavailable");
    }
    if (getHost() !== host) {
      throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard session changed before the operation");
    }
    const result = host[method](payload);
    if (result !== null && result !== undefined) {
      throw failure("ERR_ATOOLS_CLIPBOARD_RESPONSE", "Invalid clipboard write response");
    }
    return { success: true };
  }
  function normalizeImageContent(content: unknown) {
    const maxPngBytes = 512 * 1024;
    const maxPathBytes = 8192;
    let dataUrl: unknown = content;
    if (typeof content === "string" && !content.startsWith("data:")) {
      let path = content;
      if (path.startsWith("file://")) path = path.slice(7);
      if (!path || path.length > maxPathBytes || path.includes("\0") || !path.startsWith("/")) {
        throw failure("ERR_ATOOLS_IMAGE_PATH_INVALID", "Image path must be a bounded absolute local path");
      }
      const node = (window as Window & { __atoolsNodeModuleRequire?: { readPngPath?: (path: string) => unknown } }).__atoolsNodeModuleRequire;
      if (!node || typeof node.readPngPath !== "function") {
        throw failure("ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE", "Image path requires an active permissioned file-read session");
      }
      const bytes = node.readPngPath(path);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > maxPngBytes) {
        throw failure("ERR_ATOOLS_IMAGE_PATH_RESPONSE", "Bounded image reader returned an invalid PNG");
      }
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!signature.every((byte, index) => bytes[index] === byte) || bytes[12] !== 73 || bytes[13] !== 72
          || bytes[14] !== 68 || bytes[15] !== 82 || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13) {
        throw failure("ERR_ATOOLS_IMAGE_PATH_RESPONSE", "Image path must contain a valid PNG");
      }
      const width = bytes[16] * 0x1000000 + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
      const height = bytes[20] * 0x1000000 + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
      if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_000_000) {
        throw failure("ERR_ATOOLS_IMAGE_PATH_RESPONSE", "Image dimensions exceed the supported limit");
      }
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
      }
      dataUrl = "data:image/png;base64," + btoa(binary);
      return { dataUrl, width, height };
    }
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")
        || dataUrl.length > 700 * 1024) {
      throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Image content must be a bounded PNG data URL or readable local path");
    }
    const encoded = dataUrl.slice("data:image/png;base64,".length);
    if (!encoded || encoded.length % 4 !== 0 || encoded.length > Math.ceil(maxPngBytes / 3) * 4
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Image data exceeds the supported PNG limit");
    }
    let header: string;
    try { header = atob(encoded.slice(0, 32)); }
    catch { throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid PNG data URL"); }
    if (header.length < 24) throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid PNG data URL");
    const headerBytes = Uint8Array.from(header, character => character.charCodeAt(0));
    const width = headerBytes[16] * 0x1000000 + (headerBytes[17] << 16) + (headerBytes[18] << 8) + headerBytes[19];
    const height = headerBytes[20] * 0x1000000 + (headerBytes[21] << 16) + (headerBytes[22] << 8) + headerBytes[23];
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_000_000) {
      throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Image dimensions exceed the supported limit");
    }
    return { dataUrl, width, height };
  }
  function contentPayload(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid clipboard content");
    }
    const value = data as Record<string, unknown>;
    const hasUnexpectedKeys = (record: Record<string, unknown>, allowed: string[]) =>
      Object.getOwnPropertyNames(record).some(key => !allowed.includes(key)) || Object.getOwnPropertySymbols(record).length > 0;
    if (value.type === "text" && typeof value.content === "string") {
      if (new TextEncoder().encode(value.content).length > maxTextBytes) {
        throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Clipboard text exceeds 256 KiB");
      }
      return { kind: "text", text: value.content };
    }
    if (value.type === "html") {
      const content = value.content;
      if (hasUnexpectedKeys(value, ["type", "content"])
        || !content || typeof content !== "object" || Array.isArray(content)) {
        throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid HTML clipboard content");
      }
      const htmlValue = content as Record<string, unknown>;
      const hasText = Object.prototype.hasOwnProperty.call(htmlValue, "text");
      if (hasUnexpectedKeys(htmlValue, ["html", "text"])
        || !Object.prototype.hasOwnProperty.call(htmlValue, "html") || typeof htmlValue.html !== "string"
        || (hasText && typeof htmlValue.text !== "string")) {
        throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "HTML clipboard content must contain HTML and optional text");
      }
      const payload = { kind: "html", html: htmlValue.html, ...(hasText ? { text: htmlValue.text as string } : {}) };
      const encoder = new TextEncoder();
      if (encoder.encode(payload.html).length + (hasText ? encoder.encode(payload.text as string).length : 0) > maxTextBytes) {
        throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "HTML clipboard content exceeds 256 KiB");
      }
      if (encoder.encode(JSON.stringify(payload)).length > maxResponseBytes) {
        throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "HTML clipboard wire payload exceeds 512 KiB");
      }
      return payload;
    }
    if (value.type === "image") {
      return { kind: "image", image: normalizeImageContent(value.content ?? value.imagePath) };
    }
    if (value.type === "file" || value.type === "files") {
      const raw = value.content ?? value.paths;
      const paths = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      const isAbsolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
      if (!paths.length || paths.length > 20 || paths.some(path => typeof path !== "string" || !path
          || new TextEncoder().encode(path).length > 8192 || path.includes("\0") || !isAbsolutePath(path))) {
        throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Clipboard files must contain 1 to 20 bounded paths");
      }
      const byteLength = paths.reduce((sum, path) => sum + new TextEncoder().encode(path as string).length, 0);
      if (byteLength > 64 * 1024) throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Clipboard file paths exceed 64 KiB");
      return { kind: "files", paths };
    }
    throw failure("ERR_ATOOLS_CLIPBOARD_UNSUPPORTED", "Clipboard content type is not supported");
  }
  function getContent(id: unknown, expectedHost?: ClipboardHost) {
    return Promise.resolve().then(function() {
      if (!historyCodec.validId(id)) throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid clipboard item id");
      return historyCall("history_read", { operation: "getContent", id }, expectedHost).then(function(value) {
        const result = boundedResponse(value) as unknown;
        if (result === null) return null;
        const item = historyCodec.validateItem(result, true);
        if (item.id !== id) {
          throw failure("ERR_ATOOLS_CLIPBOARD_RESPONSE", "Clipboard content id does not match the request");
        }
        return boundedResponse(item) as ClipboardHistoryItem;
      });
    });
  }
  type HistoryPageResult = { items: ClipboardHistoryItem[]; total: number; page: number; pageSize: number };
  let requestHistoryPage: (page: unknown, pageSize: unknown, query?: unknown) => Promise<HistoryPageResult> = function(_page: unknown, _pageSize: unknown, _query?: unknown) { return Promise.reject(failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard history handler is not ready")); };
  type ChangeSub = { callback: (item: unknown) => void; active: boolean; posted: boolean; disposed: boolean;
    lastSequence: number; dirty: boolean; draining: boolean; resolve: () => void; reject: (error: Error) => void;
    ready: Promise<void>; onPageHide: () => void };
  const changeSubs = new Map<string, ChangeSub>();
  const frameWindow = window as Window & { __ATOOLS_FRAME_TRANSPORT__?: {
    post: (message: Record<string, unknown>) => boolean; accept: (event: MessageEvent) => boolean;
  } };
  let changeListenersAttached = false;
  function attachChangeListeners() {
    if (changeListenersAttached) return;
    changeListenersAttached = true;
    window.addEventListener("message", receiveChange);
    window.addEventListener("pagehide", closeChangeSubscriptions);
  }
  function detachChangeListeners() {
    if (!changeListenersAttached || changeSubs.size > 0) return;
    changeListenersAttached = false;
    window.removeEventListener("message", receiveChange);
    window.removeEventListener("pagehide", closeChangeSubscriptions);
  }
  function postChange(message: Record<string, unknown>) {
    if (frameWindow.__ATOOLS_FRAME_TRANSPORT__) return frameWindow.__ATOOLS_FRAME_TRANSPORT__.post(message);
    frameWindow.parent.postMessage(message, "*"); return true;
  }
  function disposeChange(id: string, sub: ChangeSub) {
    if (sub.disposed) return;
    const pending = !sub.active;
    sub.disposed = true; sub.active = false; changeSubs.delete(id);
    if (pending) sub.reject(failure("ERR_ATOOLS_CLIPBOARD_SUBSCRIPTION", "Clipboard change subscription was closed"));
    if (sub.posted) postChange({ __atools_clipboard_change__: true, operation: "unsubscribe",
      subscriptionId: id, instanceId: getHost()?.instanceId, documentNonce });
    window.removeEventListener("pagehide", sub.onPageHide);
    detachChangeListeners();
  }
  function drainChange(id: string, sub: ChangeSub) {
    if (sub.draining || !sub.active || sub.disposed) return;
    sub.draining = true;
    void (async function() {
      try {
        while (sub.dirty && sub.active && !sub.disposed) {
          sub.dirty = false;
          const page = await requestHistoryPage(1, 1);
          if (sub.disposed || !sub.active) return;
          const item = page.items[0];
          if (!item) continue;
          try { sub.callback(item); } catch { console.warn("Clipboard change callback failed"); }
        }
      } catch {
        disposeChange(id, sub);
        console.warn("Clipboard change subscription closed");
      } finally { sub.draining = false; if (sub.dirty && sub.active && !sub.disposed) drainChange(id, sub); }
    })();
  }
  function receiveChange(event: MessageEvent) {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object"
      || (frameWindow.__ATOOLS_FRAME_TRANSPORT__ && !frameWindow.__ATOOLS_FRAME_TRANSPORT__.accept(event))) return;
    const data = event.data as Record<string, unknown>;
    if (data.__atools_clipboard_change_response__ === true) {
      const id = String(data.subscriptionId || ""), sub = changeSubs.get(id);
      if (!sub || sub.disposed || data.instanceId !== getHost()?.instanceId || data.documentNonce !== documentNonce) return;
      if (data.ok !== true) {
        sub.reject(failure("ERR_ATOOLS_CLIPBOARD_SUBSCRIPTION", "Clipboard change subscription was rejected"));
        disposeChange(id, sub);
      } else { sub.active = true; sub.resolve(); }
      return;
    }
    if (data.__atools_clipboard_change_event__ !== true || data.instanceId !== getHost()?.instanceId
      || data.documentNonce !== documentNonce || typeof data.subscriptionId !== "string"
      || !Number.isSafeInteger(data.sequence) || Number(data.sequence) < 1) return;
    const sub = changeSubs.get(data.subscriptionId);
    if (sub && sub.active && !sub.disposed && Number(data.sequence) > sub.lastSequence) {
      sub.lastSequence = Number(data.sequence); sub.dirty = true; drainChange(data.subscriptionId, sub);
    }
  }
  function closeChangeSubscriptions() { for (const [id, sub] of [...changeSubs]) disposeChange(id, sub); }
  const api = {
    readText: function() { return nativeCall("readClipboardText"); },
    history: function(query: unknown, limit: unknown) {
      return nativeCall("listClipboardHistory", {
        query: String(query || ""), limit: Number.isFinite(Number(limit)) ? Number(limit) : 50
      });
    },
    getHistory: function(page: unknown, pageSize: unknown, query?: unknown) {
      return Promise.resolve().then(function() {
        if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 1000001
          || typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
          || (page - 1) * pageSize > 10000000) {
          throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid clipboard history page");
        }
        if (query !== undefined && (typeof query !== "string" || new TextEncoder().encode(query).length > 256)) {
          throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Clipboard query exceeds 256 bytes");
        }
        const payload: Record<string, unknown> = { operation: "list", page, pageSize };
        if (query !== undefined) payload.query = query;
        return historyCall("history_read", payload).then(function(value) {
          const result = boundedResponse(value) as {
            items?: unknown; total?: unknown; page?: unknown; pageSize?: unknown;
          };
          if (!result || typeof result !== "object" || !Array.isArray(result.items)
            || typeof result.total !== "number" || !Number.isSafeInteger(result.total) || result.total < 0
            || result.page !== page || result.pageSize !== pageSize || result.items.length > Number(pageSize)) {
            throw failure("ERR_ATOOLS_CLIPBOARD_RESPONSE", "Invalid clipboard history page");
          }
          const items = result.items.map((item: unknown) => historyCodec.validateItem(item));
          const pageResult = { items, total: result.total, page, pageSize };
          if (new TextEncoder().encode(JSON.stringify(pageResult)).length > maxResponseBytes) {
            throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Clipboard page serialization exceeds 512 KiB");
          }
          return pageResult;
        });
      });
    },
    getContent,
    delete: function(id: unknown) {
      return Promise.resolve().then(function() {
        if (!historyCodec.validId(id)) throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid clipboard item id");
        return historyCall("history_delete", { operation: "delete", id }).then(function(value) {
          const result = boundedResponse(value) as { deleted?: unknown };
          if (!result || typeof result !== "object" || typeof result.deleted !== "boolean") {
            throw failure("ERR_ATOOLS_CLIPBOARD_RESPONSE", "Invalid clipboard delete response");
          }
          return { success: result.deleted };
        });
      });
    },
    clear: function(type?: unknown) {
      return Promise.resolve().then(function() {
        if (type !== undefined && typeof type !== "string") throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid clipboard history type");
        if (type !== undefined && type !== "all" && type !== "text" && type !== "image" && type !== "file") {
          throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Invalid clipboard history type");
        }
        const payload: Record<string, unknown> = { operation: "clear" };
        if (type !== undefined) payload.type = type;
        return historyCall("history_delete", payload).then(function(value) {
          const result = boundedResponse(value) as { deletedCount?: unknown };
          if (!result || typeof result !== "object" || typeof result.deletedCount !== "number"
            || !Number.isSafeInteger(result.deletedCount) || result.deletedCount < 0) {
            throw failure("ERR_ATOOLS_CLIPBOARD_RESPONSE", "Invalid clipboard clear response");
          }
          return { success: true, count: result.deletedCount };
        });
      });
    },
    write: function(id: unknown, paste?: unknown) {
      const operationHost = getHost();
      return Promise.resolve().then(function() {
        if (!operationHost || getHost() !== operationHost) {
          throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard session changed before the operation");
        }
        return getContent(id, operationHost).then(function(item: ClipboardHistoryItem | null) {
          if (getHost() !== operationHost) {
            throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Clipboard session changed before the operation");
          }
          if (!item) throw failure("ERR_ATOOLS_CLIPBOARD_NOT_FOUND", "Clipboard item no longer exists");
          if (item.type === "text" && paste === false) return copyText(item.content, operationHost);
          return contentCall(contentPayload(item), paste !== false, operationHost);
        });
      });
    },
    writeContent: function(data: unknown, paste?: unknown) {
      return Promise.resolve().then(function() {
        return contentCall(contentPayload(data), paste !== false);
      });
    },
    onChange: function(callback: unknown) {
      if (typeof callback !== "function") throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Clipboard change callback must be a function");
      const host = getHost();
      if (!host || typeof host.ensureAccess !== "function" || typeof host.instanceId !== "string"
        || typeof documentNonce !== "string" || !/^[0-9a-f]{32}$/.test(documentNonce)) {
        throw failure("ERR_ATOOLS_CLIPBOARD_UNAVAILABLE", "Authenticated clipboard change transport is unavailable");
      }
      if (changeSubs.size >= 16) throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Too many clipboard change subscriptions");
      const id = crypto.randomUUID();
      let resolve!: () => void, reject!: (error: Error) => void;
      const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      void ready.catch(() => undefined);
      let sub!: ChangeSub;
      sub = { callback: callback as (item: unknown) => void, active: false, posted: false, disposed: false,
        lastSequence: 0, dirty: false, draining: false, resolve, reject, ready, onPageHide: () => disposeChange(id, sub) };
      changeSubs.set(id, sub); attachChangeListeners(); window.addEventListener("pagehide", sub.onPageHide, { once: true });
      const dispose = (() => disposeChange(id, sub)) as (() => void) & { ready: Promise<void> };
      dispose.ready = ready;
      void host.ensureAccess("history_read").then(() => {
        if (sub.disposed) return;
        sub.posted = true;
        postChange({ __atools_clipboard_change__: true, operation: "subscribe", subscriptionId: id,
          instanceId: host.instanceId, documentNonce });
      }).catch(() => {
        if (!sub.disposed) { reject(failure("ERR_ATOOLS_CLIPBOARD_PERMISSION", "Clipboard history permission was not granted")); disposeChange(id, sub); }
      });
      return dispose;
    },

    search: function(query: unknown) {
      return Promise.resolve().then(function() {
        if (query !== undefined && typeof query !== "string") throw failure("ERR_ATOOLS_CLIPBOARD_ARGUMENT", "Clipboard query must be text");
        return requestHistoryPage(1, 1000, query === undefined ? "" : query).then(function(result) {
          if (result.total > 1000) throw failure("ERR_ATOOLS_CLIPBOARD_LIMIT", "Clipboard search exceeds 1000 items");
          return result.items;
        });
      });
    },
  };
  requestHistoryPage = api.getHistory;
  return api;
}
