import { validatePluginClipboardImagePayload } from "./pluginNativeImage";
import { createHostClipboardHistoryApi } from "./hostClipboardHistory";

export type ClipboardAccess = "read" | "write" | "image" | "image_write" | "content_write" | "paste" | "history_read" | "history_delete";
export type HostClipboardConfig = {
  instanceId: string;
  endpoints?: Partial<Record<ClipboardAccess, string>>;
  /** One-time hint emitted only by explicit manual reopen; never carries an endpoint/token. */
  restoreImageSession?: boolean;
};
export type ClipboardFileEntry = { name: string; path: string; isFile: boolean; isDirectory: boolean; isDiractory: boolean };
type Transport = (endpoint: string, payload: Record<string, unknown>) => unknown;
type ImageValidator = (value: unknown) => { dataUrl: string; width: number; height: number } | null;
type AccessWaiter = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

/** Self-contained factory, serialized into the opaque frame before preload. */
export function createHostClipboardBridge(
  config: HostClipboardConfig,
  requestPermission: (access: ClipboardAccess) => void,
  transport?: Transport,
  validateImage?: ImageValidator,
  historyFactory: typeof createHostClipboardHistoryApi = createHostClipboardHistoryApi,
) {
  const endpoints: Partial<Record<ClipboardAccess, string>> = {};
  const requested = new Set<ClipboardAccess>();
  const accessWaiters = new Map<ClipboardAccess, AccessWaiter>();
  let closed = false;
  function error(code: string, message: string): Error {
    return Object.assign(new Error(code + ": " + message), { code });
  }
  function install(access: ClipboardAccess, endpoint?: string) {
    if (closed) return;
    if (access !== "read" && access !== "write" && access !== "image" && access !== "image_write"
      && access !== "content_write" && access !== "paste"
      && access !== "history_read" && access !== "history_delete") throw error("ERR_ATOOLS_HOST_CLIPBOARD_CONFIG", "Invalid clipboard scope");
    if (endpoint !== undefined && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/host\/[0-9a-f]{64}$/.test(endpoint)) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_CONFIG", "Invalid clipboard endpoint");
    }
    requested.delete(access);
    if (endpoint) endpoints[access] = endpoint; else delete endpoints[access];
    const waiter = accessWaiters.get(access); accessWaiters.delete(access);
    if (waiter) endpoint ? waiter.resolve() : waiter.reject(error("ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED", "Clipboard permission was not granted"));
  }
  for (const access of ["read", "write", "image", "image_write", "content_write", "paste", "history_read", "history_delete"] as const) if (config.endpoints?.[access]) install(access, config.endpoints[access]);
  function accessName(access: ClipboardAccess): string {
    if (access === "image") return "读取剪贴板图片";
    if (access === "image_write") return "写入剪贴板图片";
    if (access === "history_read") return "读取剪贴板历史（文本、图片和文件）";
    if (access === "history_delete") return "删除剪贴板历史";
    if (access === "content_write") return "写入剪贴板内容";
    if (access === "paste") return "写入并粘贴剪贴板内容";
    return "剪贴板" + (access === "read" ? "读取" : "写入");
  }
  function xhr(endpoint: string, payload: Record<string, unknown>, maxResponseBytes?: number, responseName?: string) {
    const request = new XMLHttpRequest();
    request.open("POST", endpoint, false);
    request.setRequestHeader("Content-Type", "application/json");
    request.send(JSON.stringify(payload));
    if (request.status !== 200) throw error("ERR_ATOOLS_HOST_CLIPBOARD_SESSION", "剪贴板会话已关闭，请重新打开插件");
    if (maxResponseBytes !== undefined && (request.responseText.length > maxResponseBytes
        || new TextEncoder().encode(request.responseText).length > maxResponseBytes)) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", responseName + " exceeds " + (maxResponseBytes / 1024) + " KiB");
    }
    let result;
    try { result = JSON.parse(request.responseText); } catch { throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard response"); }
    if (!result?.ok) throw error("ERR_ATOOLS_HOST_CLIPBOARD_REJECTED", result?.error?.message || "Clipboard operation rejected");
    return result.result;
  }
  function invoke(access: ClipboardAccess, payload: Record<string, unknown>, maxResponseBytes?: number) {
    if (closed) throw error("ERR_ATOOLS_HOST_CLIPBOARD_CLOSED", "剪贴板会话已关闭");
    const endpoint = endpoints[access];
    if (!endpoint) {
      if (!requested.has(access)) { requested.add(access); requestPermission(access); }
      // Never queue the payload or replay this call after the user decides.
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED", "请先允许" + accessName(access) + "，然后再次操作或重新打开插件");
    }
    if (transport) return transport(endpoint, payload);
    const responseLimit = maxResponseBytes ?? (access === "image" ? 700 * 1024 : undefined);
    const responseName = access === "history_read" ? "Clipboard history response"
      : access === "image" ? "Clipboard image response" : "Clipboard format response";
    return xhr(endpoint, payload, responseLimit, responseName);
  }
  function ensureAccess(access: ClipboardAccess): Promise<void> {
    if (closed) return Promise.reject(error("ERR_ATOOLS_HOST_CLIPBOARD_CLOSED", "剪贴板会话已关闭"));
    if (access !== "read" && access !== "write" && access !== "image" && access !== "image_write"
      && access !== "content_write" && access !== "paste"
      && access !== "history_read" && access !== "history_delete") {
      return Promise.reject(error("ERR_ATOOLS_HOST_CLIPBOARD_CONFIG", "Invalid clipboard scope"));
    }
    if (endpoints[access]) return Promise.resolve();
    const existing = accessWaiters.get(access);
    if (existing) return existing.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    accessWaiters.set(access, { promise, resolve, reject });
    if (!requested.has(access)) {
      requested.add(access);
      try { requestPermission(access); }
      catch (cause) {
        accessWaiters.delete(access); requested.delete(access);
        reject(cause instanceof Error ? cause : error("ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED", "Clipboard permission request failed"));
      }
    }
    return promise;
  }
  function selection(type?: string) {
    if (type !== undefined && type !== "clipboard") throw error("ERR_ATOOLS_HOST_CLIPBOARD_UNSUPPORTED", "Selection clipboard is unavailable");
  }
  function clipboardFormat(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Clipboard format must be 1 to 256 printable ASCII bytes");
    }
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 0x20 || code > 0x7e) {
        throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Clipboard format must be 1 to 256 printable ASCII bytes");
      }
    }
    return value;
  }
  function decodeBufferResult(value: unknown): Uint8Array {
    const responseError = () => error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard binary response");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw responseError();
    const row = value as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(row);
    if (keys.length !== 2 || !keys.includes("base64") || !keys.includes("byteLength")
      || Object.getOwnPropertySymbols(row).length > 0
      || typeof row.base64 !== "string" || typeof row.byteLength !== "number"
      || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0) throw responseError();
    if (row.byteLength > 256 * 1024) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard binary data exceeds 256 KiB");

    const encoded = row.base64;
    if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw responseError();
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const decodedLength = encoded.length / 4 * 3 - padding;
    if (decodedLength > 256 * 1024) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard binary data exceeds 256 KiB");
    if (decodedLength !== row.byteLength) throw responseError();
    if (padding === 2 && (alphabet.indexOf(encoded[encoded.length - 3]) & 15) !== 0) throw responseError();
    if (padding === 1 && (alphabet.indexOf(encoded[encoded.length - 2]) & 3) !== 0) throw responseError();

    const bytes = new Uint8Array(decodedLength);
    let offset = 0;
    for (let index = 0; index < encoded.length; index += 4) {
      const a = alphabet.indexOf(encoded[index]), b = alphabet.indexOf(encoded[index + 1]);
      const c = encoded[index + 2] === "=" ? 0 : alphabet.indexOf(encoded[index + 2]);
      const d = encoded[index + 3] === "=" ? 0 : alphabet.indexOf(encoded[index + 3]);
      const value = a << 18 | b << 12 | c << 6 | d;
      if (offset < decodedLength) bytes[offset++] = value >>> 16;
      if (offset < decodedLength) bytes[offset++] = value >>> 8 & 255;
      if (offset < decodedLength) bytes[offset++] = value & 255;
    }
    return bytes;
  }
  function htmlPayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Invalid HTML clipboard content");
    }
    const row = value as Record<string, unknown>;
    const hasText = Object.prototype.hasOwnProperty.call(row, "text");
    if (Object.getOwnPropertyNames(row).some((key) => key !== "kind" && key !== "html" && key !== "text")
      || Object.getOwnPropertySymbols(row).length > 0
      || row.kind !== "html" || typeof row.html !== "string" || (hasText && typeof row.text !== "string")) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "HTML clipboard content must contain HTML and optional text");
    }
    const payload = { kind: "html", html: row.html, ...(hasText ? { text: row.text as string } : {}) };
    const encoder = new TextEncoder();
    if (encoder.encode(payload.html).length + (hasText ? encoder.encode(payload.text as string).length : 0) > 256 * 1024) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "HTML clipboard content exceeds 256 KiB");
    }
    if (encoder.encode(JSON.stringify(payload)).length > 512 * 1024) {
      throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "HTML clipboard wire payload exceeds 512 KiB");
    }
    return payload;
  }
  function writePlainText(text: unknown): void {
    if (typeof text !== "string") throw new TypeError("Clipboard text must be a string");
    if (new TextEncoder().encode(text).length > 256 * 1024) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard text exceeds 256 KiB");
    const result = invoke("write", { text });
    if (result !== null && result !== undefined) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard write response");
  }
  const history = historyFactory(invoke, error);
  return {
    instanceId: config.instanceId,
    ensureAccess,
    readText(type?: string): string {
      selection(type);
      const result = invoke("read", {});
      if (typeof result !== "string") throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard text response");
      return result;
    },
    hasFormat(format: string): boolean {
      const result = invoke("read", { operation: "hasFormat", format: clipboardFormat(format) }, 512 * 1024);
      if (typeof result !== "boolean") throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard format availability response");
      return result;
    },
    readFormat(format: string): string {
      const result = invoke("read", { operation: "readFormat", format: clipboardFormat(format) }, 512 * 1024);
      if (typeof result !== "string") throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard format data response");
      if (new TextEncoder().encode(JSON.stringify({ ok: true, result })).length > 512 * 1024) {
        throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard format response exceeds 512 KiB");
      }
      return result;
    },
    readBuffer(format: string): Uint8Array {
      if (arguments.length !== 1) throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Clipboard readBuffer expects exactly one format");
      const result = invoke("read", { operation: "readFormatBuffer", format: clipboardFormat(format) }, 512 * 1024);
      let envelopeBytes: number;
      try { envelopeBytes = new TextEncoder().encode(JSON.stringify({ ok: true, result })).byteLength; }
      catch { throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard binary response"); }
      if (envelopeBytes > 512 * 1024) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard binary response exceeds 512 KiB");
      return decodeBufferResult(result);
    },
    readFiles(): ClipboardFileEntry[] {
      const result = invoke("read", { format: "files" });
      if (!Array.isArray(result)) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard files response");
      if (result.length > 128) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard files exceed 128 entries");
      const encoder = new TextEncoder(), entries: ClipboardFileEntry[] = [];
      let pathBytes = 0;
      for (const item of result) {
        if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path || item.path.includes("\0")
          || typeof item.name !== "string" || !item.name || item.name.includes("\0")
          || typeof item.isFile !== "boolean" || typeof item.isDirectory !== "boolean" || (item.isFile && item.isDirectory)) {
          throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard file metadata");
        }
        const bytes = encoder.encode(item.path).length;
        pathBytes += bytes;
        if (bytes > 8192 || pathBytes > 64 * 1024) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard file paths exceed limit");
        // Preserve the previous public misspelling as an alias of actual native metadata.
        entries.push({ name: item.name, path: item.path, isFile: item.isFile, isDirectory: item.isDirectory, isDiractory: item.isDirectory });
      }
      if (encoder.encode(JSON.stringify(entries)).length > 256 * 1024) throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard files response exceeds 256 KiB");
      return entries;
    },
    readImage(type?: string): { dataUrl: string; width: number; height: number } | null {
      selection(type);
      if (typeof validateImage !== "function") throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Clipboard image validation is unavailable");
      const result = validateImage(invoke("image", { format: "image" }));
      if (new TextEncoder().encode(JSON.stringify({ ok: true, result })).length > 700 * 1024) {
        throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard image response exceeds 700 KiB");
      }
      return result;
    },
    writeImage(value: unknown): void {
      if (typeof validateImage !== "function") throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Clipboard image validation is unavailable");
      const image = validateImage(value);
      if (!image) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Clipboard image cannot be empty");
      const payload = { image };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 700 * 1024) {
        throw error("ERR_ATOOLS_HOST_CLIPBOARD_LIMIT", "Clipboard image request exceeds 700 KiB");
      }
      const result = invoke("image_write", payload);
      if (result !== null) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard image write response");
    },
    writeText(text: string, type?: string): void {
      selection(type);
      writePlainText(text);
    },
    write(data: { text?: string; html?: string }, type?: string): void {
      selection(type);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Clipboard write must contain text or HTML");
      }
      const row = data as Record<string, unknown>;
      const hasText = Object.prototype.hasOwnProperty.call(row, "text");
      const hasHtml = Object.prototype.hasOwnProperty.call(row, "html");
      if (Object.getOwnPropertyNames(row).some((key) => key !== "text" && key !== "html")
        || Object.getOwnPropertySymbols(row).length > 0 || (!hasText && !hasHtml)
        || (hasText && typeof row.text !== "string")) {
        throw error("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Clipboard write supports only text and HTML");
      }
      if (!hasHtml) {
        writePlainText(row.text);
        return;
      }
      const payload = htmlPayload({ kind: "html", html: row.html, ...(hasText ? { text: row.text } : {}) });
      const result = invoke("content_write", payload);
      if (result !== null && result !== undefined) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard HTML write response");
    },
    writeHTML(markup: string, type?: string): void {
      selection(type);
      const result = invoke("content_write", htmlPayload({ kind: "html", html: markup }));
      if (result !== null && result !== undefined) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard HTML write response");
    },
    writeContent(value: Record<string, unknown>): void {
      const payload = value && typeof value === "object" && value.kind === "html"
        ? htmlPayload(value) : value;
      const result = invoke("content_write", payload);
      if (result !== null && result !== undefined) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard content write response");
    },
    paste(value: Record<string, unknown>): void {
      const payload = value && typeof value === "object" && value.kind === "html"
        ? htmlPayload(value) : value;
      const result = invoke("paste", payload);
      if (result !== null && result !== undefined) throw error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE", "Invalid clipboard paste response");
    },
    historyRead: history.historyRead,
    historyDelete: history.historyDelete,
    install,
    close() {
      closed = true;
      const closedError = error("ERR_ATOOLS_HOST_CLIPBOARD_CLOSED", "剪贴板会话已关闭");
      for (const waiter of accessWaiters.values()) waiter.reject(closedError);
      accessWaiters.clear();
      for (const access of ["read", "write", "image", "image_write", "content_write", "paste", "history_read", "history_delete"] as const) delete endpoints[access];
    },
  };
}

export function hostClipboardBridgeScript(config: HostClipboardConfig): string {
  const safe = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<script data-atools-host-clipboard>(function(){
    var config=${safe};
    var validateImage=(${validatePluginClipboardImagePayload.toString()});
    var bridge=(${createHostClipboardBridge.toString()})(config,function(access){
      var message={__atools_host_clipboard_open__:true,instanceId:config.instanceId,access:access};
      if(window.__ATOOLS_FRAME_TRANSPORT__)window.__ATOOLS_FRAME_TRANSPORT__.post(message);else parent.postMessage(message,'*');
    },undefined,validateImage,(${createHostClipboardHistoryApi.toString()}));
    window.__atoolsHostClipboard=bridge;
    addEventListener('message',function(event){
      if(window.__ATOOLS_FRAME_TRANSPORT__&&!window.__ATOOLS_FRAME_TRANSPORT__.accept(event))return;
      var data=event.data;
      if(event.source!==parent||!data||data.__atools_host_clipboard_session__!==true||data.instanceId!==config.instanceId)return;
      bridge.install(data.access,data.endpoint);
    });
    if(window.utools&&window.utools.clipboard) window.utools.clipboard.readText=bridge.readText;
    if(window.utools){window.utools.getCopyedFiles=bridge.readFiles;window.utools.getCopiedFiles=bridge.readFiles;}
  })();<\/script>`;
}
