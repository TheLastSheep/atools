import { createPluginLocalStorage } from "./pluginLocalStorage";
import { createPluginDynamicFeatures } from "./pluginDynamicFeatures";
import { createPluginDataOperationFeedback } from "./pluginDataOperationFeedback";
import { createPluginDataMutationFeedback } from "./pluginDataMutationFeedback";

export type PluginDataUsage = "detected" | "not_detected" | "unknown";
export type PluginDataConfig = { instanceId: string; endpoint?: string; usage?: PluginDataUsage };
type Payload = { method: string; args: unknown[] };
type Transports = {
  sync?: (endpoint: string, payload: Payload) => unknown;
  async?: (endpoint: string, payload: Payload) => Promise<unknown>;
};
type PluginDataOperationFeedback = ReturnType<typeof createPluginDataOperationFeedback>;
type PluginDataOperationFeedbackFactory = () => PluginDataOperationFeedback;
type PluginDataMutationFeedback = ReturnType<typeof createPluginDataMutationFeedback>;
type PluginDataMutationFeedbackFactory = (operationFeedback?: PluginDataOperationFeedback) => PluginDataMutationFeedback;

/** Self-contained: injected before original preload and page scripts. */
export function createPluginDataBridge(
  config: PluginDataConfig, requestPermission: () => void, transports: Transports = {},
  storageFactory?: (config: { instanceId: string }, invoke: (method: string, args: unknown[]) => unknown,
    invokeAsync: (method: string, args: unknown[]) => Promise<unknown>) => { close: () => void },
  operationFeedbackFactory?: PluginDataOperationFeedbackFactory,
  mutationFeedbackFactory?: PluginDataMutationFeedbackFactory,
) {
  const maxRequest = 512 * 1024, maxBinary = 256 * 1024;
  let endpoint: string | undefined, requested = false, closed = false, generation = 0;
  const pending = new Set<XMLHttpRequest>();
  const cancellations = new Set<() => void>();
  const operationFeedback = operationFeedbackFactory?.();
  const mutationFeedback = mutationFeedbackFactory?.(operationFeedback);
  function error(code: string, message: string) {
    return Object.assign(new Error(code + ": " + message), { code });
  }
  function inactive() {
    return closed ? error("ERR_ATOOLS_DATA_CLOSED", "插件数据会话已关闭")
      : error("ERR_ATOOLS_DATA_SESSION", "插件数据会话已变更，请再次操作");
  }
  function reportMutationFailure(method: string, args: unknown[], current: number, sequence: number | undefined) {
    if (!closed && generation === current) mutationFeedback?.failed(method, args, current, sequence);
  }
  function reportMutationResolved(method: string, args: unknown[], current: number, sequence: number | undefined) {
    if (!closed && generation === current) mutationFeedback?.resolved(method, args, current, sequence);
  }
  function cancelPending() {
    for (const cancel of cancellations) cancel();
    cancellations.clear();
    for (const request of pending) request.abort();
    pending.clear();
  }
  function install(next?: string) {
    const match = typeof next === "string"
      ? /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/data\/[0-9a-f]{64}$/.exec(next) : null;
    if (next !== undefined && (!match || Number(match[1]) > 65535)) {
      throw error("ERR_ATOOLS_DATA_CONFIG", "Invalid data endpoint");
    }
    if (closed) return;
    if (endpoint !== next) {
      generation++;
      mutationFeedback?.generationChanged(generation);
      cancelPending();
    }
    endpoint = next;
  }
  install(config.endpoint);
  function authorized() {
    if (closed) throw inactive();
    if (!endpoint) {
      if (!requested) { requested = true; requestPermission(); }
      // Only request the capability. Never retain or replay a document/key.
      throw error("ERR_ATOOLS_DATA_PERMISSION_REQUIRED", "请先允许访问本插件保存的数据，然后重新打开插件");
    }
    return endpoint;
  }
  function json(value: unknown, maximum: number, label: string) {
    const body = JSON.stringify(value);
    if (body === undefined || new TextEncoder().encode(body).length > maximum) {
      throw error("ERR_ATOOLS_DATA_LIMIT", label + " exceeds its byte budget");
    }
    return body;
  }
  function envelope(request: XMLHttpRequest) {
    if (request.status !== 200) throw error("ERR_ATOOLS_DATA_SESSION", "插件数据会话已关闭，请重新打开插件");
    if (new TextEncoder().encode(request.responseText).length > maxRequest) {
      throw error("ERR_ATOOLS_DATA_LIMIT", "Data response exceeds 512 KiB");
    }
    let response;
    try { response = JSON.parse(request.responseText); }
    catch { throw error("ERR_ATOOLS_DATA_RESPONSE", "Invalid data response"); }
    if (!response || response.ok !== true) {
      throw error("ERR_ATOOLS_DATA_REJECTED", "Data operation rejected");
    }
    if (!Object.prototype.hasOwnProperty.call(response, "result")) {
      throw error("ERR_ATOOLS_DATA_RESPONSE", "Missing data response result");
    }
    return response.result;
  }
  function xhr(target: string, body: string, asynchronous: boolean): unknown | Promise<unknown> {
    const request = new XMLHttpRequest();
    request.open("POST", target, asynchronous);
    request.setRequestHeader("Content-Type", "application/json");
    if (!asynchronous) { request.send(body); return envelope(request); }
    return new Promise((resolve, reject) => {
      pending.add(request); request.timeout = 8000;
      const finish = () => { pending.delete(request); };
      const fail = () => { finish(); reject(error("ERR_ATOOLS_DATA_TRANSPORT", "插件数据请求未完成，请再次操作")); };
      request.onload = () => { finish(); try { resolve(envelope(request)); } catch (reason) { reject(reason); } };
      request.onerror = request.ontimeout = request.onabort = fail;
      try { request.send(body); } catch (reason) { finish(); reject(reason); }
    });
  }
  function encodeBinary(value: unknown) {
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else {
      try {
        // The intrinsic getter brand-checks real ArrayBuffers across realms;
        // instanceof fails there, while a toStringTag can be forged.
        const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value);
        bytes = new Uint8Array(value as ArrayBuffer, 0, length);
      } catch { throw new TypeError("Attachment must be an ArrayBuffer or byte view"); }
    }
    if (bytes.length > maxBinary) throw error("ERR_ATOOLS_DATA_LIMIT", "Attachment exceeds 256 KiB");
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  }
  function attachmentArgs(args: unknown[]) {
    if (args.length === 5) return [args[0], encodeBinary(args[3]), args[4], args[2]];
    if (args.length === 4) return [args[0], encodeBinary(args[2]), args[3], args[1]];
    if (args.length === 3) return [args[0], encodeBinary(args[1]), args[2]];
    throw new TypeError("Attachment requires 3, 4 or 5 arguments");
  }
  function decodeAttachment(value: unknown) {
    if (value === null) return null;
    if (!value || typeof value !== "object" || !("base64" in value) || typeof value.base64 !== "string"
      || value.base64.length > Math.ceil(maxBinary / 3) * 4) {
      throw error("ERR_ATOOLS_DATA_RESPONSE", "Invalid attachment response");
    }
    let binary;
    try { binary = atob(value.base64); }
    catch { throw error("ERR_ATOOLS_DATA_RESPONSE", "Invalid attachment encoding"); }
    if (btoa(binary) !== value.base64) throw error("ERR_ATOOLS_DATA_RESPONSE", "Noncanonical attachment encoding");
    if (binary.length > maxBinary) throw error("ERR_ATOOLS_DATA_LIMIT", "Attachment exceeds 256 KiB");
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const buffer = (globalThis as unknown as { Buffer?: { from: (value: Uint8Array) => Uint8Array } }).Buffer;
    return typeof buffer?.from === "function" ? buffer.from(bytes) : bytes;
  }
  function call(method: string, args: unknown[], asynchronous = false): unknown {
    const target = authorized(), current = generation;
    const attachment = method === "db.postAttachment" || method === "db.putAttachment";
    const payload = { method: method.startsWith("webStorage.") ? method : method === "db.putAttachment" ? "db.postAttachment" : method,
      args: attachment ? attachmentArgs(args) : args };
    const body = json(payload, maxRequest, "Data request");
    const request: Payload = JSON.parse(body);
    if (method === "db.put") json(request.args[0], maxBinary, "Document");
    if (method === "db.bulkDocs" && Array.isArray(request.args[0])) {
      if (request.args[0].length > 1000) throw error("ERR_ATOOLS_DATA_LIMIT", "Too many bulk documents");
      for (const doc of request.args[0]) json(doc, maxBinary, "Document");
    }
    if (method === "dbStorage.setItem") json({ _id: request.args[0], value: request.args[1] }, maxBinary, "Storage document");
    if (method.startsWith("webStorage.") && !["webStorage.getItem", "webStorage.setItem", "webStorage.removeItem",
      "webStorage.clear", "webStorage.key", "webStorage.length", "webStorage.keys", "webStorage.entries", "webStorage.event"].includes(method)) {
      throw error("ERR_ATOOLS_DATA_UNSUPPORTED", "Unsupported web storage operation");
    }
    if (closed || generation !== current) throw inactive();
    const sequence = mutationFeedback?.begin(method, request.args, current);
    const decode = (value: unknown) => {
      if (closed || generation !== current) throw inactive();
      if (value && (typeof value === "object" || typeof value === "function")
        && typeof (value as { then?: unknown }).then === "function") {
        throw error("ERR_ATOOLS_DATA_RESPONSE", "Synchronous transport returned a Promise");
      }
      json({ ok: true, result: value }, maxRequest, "Data response");
      const storageMutation = method === "dbStorage.setItem" || method === "dbStorage.removeItem";
      if (storageMutation && value !== null && value !== undefined
        && !(value && typeof value === "object" && "error" in value && (value as { error?: unknown }).error === true)) {
        throw error("ERR_ATOOLS_DATA_RESPONSE", "Invalid storage mutation response");
      }
      if (value && typeof value === "object" && "error" in value && (value as { error?: unknown }).error === true) {
        reportMutationFailure(method, request.args, current, sequence);
      } else reportMutationResolved(method, request.args, current, sequence);
      return method === "db.getAttachment" ? decodeAttachment(value) : value;
    };
    if (!asynchronous) {
      try { return decode(transports.sync ? transports.sync(target, request) : xhr(target, body, false)); }
      catch (reason) { reportMutationFailure(method, request.args, current, sequence); throw reason; }
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (success: boolean, value: unknown) => {
        if (settled) return;
        settled = true; cancellations.delete(cancel);
        if (!success) { reportMutationFailure(method, request.args, current, sequence); reject(value); }
        else {
          try { resolve(decode(value)); }
          catch (reason) { reportMutationFailure(method, request.args, current, sequence); reject(reason); }
        }
      };
      const cancel = () => finish(false, inactive());
      cancellations.add(cancel);
      try {
        const operation = transports.async ? transports.async(target, request) : xhr(target, body, true);
        Promise.resolve(operation).then(value => finish(true, value), reason => finish(false, reason));
      } catch (reason) { finish(false, reason); }
    });
  }
  function methods(asynchronous: boolean) {
    const invoke = (method: string, args: unknown[]) => {
      if (!asynchronous) return call("db." + method, args);
      try { return Promise.resolve(call("db." + method, args, true)); }
      catch (reason) { return Promise.reject(reason); }
    };
    return {
      get: (...args: unknown[]) => invoke("get", args), put: (...args: unknown[]) => invoke("put", args),
      remove: (...args: unknown[]) => invoke("remove", args), allDocs: (...args: unknown[]) => invoke("allDocs", args),
      bulkDocs: (...args: unknown[]) => invoke("bulkDocs", args),
      postAttachment: (...args: unknown[]) => invoke("postAttachment", args),
      putAttachment: (...args: unknown[]) => invoke("putAttachment", args),
      getAttachment: (...args: unknown[]) => invoke("getAttachment", args),
      getAttachmentType: (...args: unknown[]) => invoke("getAttachmentType", args),
    };
  }
  const db = { ...methods(false), promises: methods(true),
    replicateStateFromCloud: () => Promise.reject(error("ERR_ATOOLS_DATA_UNSUPPORTED", "Cloud database replication is unavailable")) };
  const webStorage = {
    getItem: (...args: unknown[]) => call("webStorage.getItem", args),
    setItem: (...args: unknown[]) => call("webStorage.setItem", args),
    removeItem: (...args: unknown[]) => call("webStorage.removeItem", args),
    clear: (...args: unknown[]) => call("webStorage.clear", args),
    key: (...args: unknown[]) => call("webStorage.key", args),
    length: (...args: unknown[]) => call("webStorage.length", args),
    keys: (...args: unknown[]) => call("webStorage.keys", args),
    entries: (...args: unknown[]) => call("webStorage.entries", args),
  };
  const webStorageAsync = {
    event: (...args: unknown[]) => call("webStorage.event", args, true) as Promise<unknown>,
  };
  const startupRegistration = {
    get(): Promise<string[]> {
      return Promise.resolve(call("startup.get", [], true)).then(value => {
        if (!Array.isArray(value) || value.length > 1
          || value.some(item => typeof item !== "string" || !item.length || item.length > 256)) {
          throw error("ERR_ATOOLS_DATA_RESPONSE", "Invalid startup registration response");
        }
        return value.slice();
      });
    },
    set(value: unknown): Promise<null> {
      if (!Array.isArray(value) || value.length > 128
        || value.some(item => typeof item !== "string" || !item.length || item.length > 256)) {
        return Promise.reject(error("ERR_ATOOLS_DATA_ARGUMENT", "Invalid startup registration list"));
      }
      return Promise.resolve(call("startup.set", [value.slice()], true)).then(result => {
        if (result !== null) throw error("ERR_ATOOLS_DATA_RESPONSE", "Startup registration was not durably committed");
        return null;
      });
    },
  };
  function storageResult(value: unknown) {
    if (value === null || value === undefined) return undefined;
    if (value && typeof value === "object" && "error" in value && value.error === true) return value;
    throw error("ERR_ATOOLS_DATA_RESPONSE", "Invalid storage mutation response");
  }
  const adapter = storageFactory?.(config, (method, args) => {
    if (!Object.prototype.hasOwnProperty.call(webStorage, method)) throw error("ERR_ATOOLS_DATA_UNSUPPORTED", "Unsupported web storage operation");
    return (webStorage as Record<string, (...args: unknown[]) => unknown>)[method](...args);
  }, (method, args) => {
    if (method !== "event") return Promise.reject(error("ERR_ATOOLS_DATA_UNSUPPORTED", "Unsupported asynchronous web storage operation"));
    return webStorageAsync.event(...args);
  });
  return {
    db,
    webStorage,
    webStorageAsync,
    startupRegistration,
    dynamicFeatureCall(method: string, args: unknown[]) {
      if (!["features.get", "features.set", "features.remove"].includes(method)) {
        throw error("ERR_ATOOLS_DATA_UNSUPPORTED", "Unsupported dynamic feature operation");
      }
      return call(method, args);
    },
    dbStorage: {
      getItem: (key: unknown) => call("dbStorage.getItem", [key]),
      setItem: (key: unknown, value: unknown) => storageResult(call("dbStorage.setItem", [key, value])),
      removeItem: (key: unknown) => storageResult(call("dbStorage.removeItem", [key])),
    },
    install,
    close() {
      if (closed) return;
      closed = true; endpoint = undefined; generation++; mutationFeedback?.close(); cancelPending();
      try { adapter?.close(); } finally {
        try { operationFeedback?.close(); } catch { /* Cleanup of the notice cannot interrupt bridge shutdown. */ }
      }
    },
  };
}

export function pluginDataBridgeScript(config: PluginDataConfig): string {
  const safe = JSON.stringify(config).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return '<script data-atools-plugin-data>(function(){var config=' + safe + ';var bridge=('
    + createPluginDataBridge.toString() + ')(config,function(){var message={__atools_plugin_data_open__:true,instanceId:config.instanceId};if(window.__ATOOLS_FRAME_TRANSPORT__)window.__ATOOLS_FRAME_TRANSPORT__.post(message);else parent.postMessage(message,"*");},undefined,(' + createPluginLocalStorage.toString() + '),(' + createPluginDataOperationFeedback.toString() + '),(' + createPluginDataMutationFeedback.toString() + '));'
    + 'var features=(' + createPluginDynamicFeatures.toString() + ')(bridge.dynamicFeatureCall);'
    + 'window.__atoolsPluginData=bridge;if(window.utools){window.utools.db=bridge.db;window.utools.dbStorage=bridge.dbStorage;Object.assign(window.utools,features);}'
    + 'if(window.ztools){window.ztools.db=bridge.db;window.ztools.dbStorage=bridge.dbStorage;Object.assign(window.ztools,features);}'
    + 'addEventListener("message",function(event){if(window.__ATOOLS_FRAME_TRANSPORT__&&!window.__ATOOLS_FRAME_TRANSPORT__.accept(event))return;var data=event.data;if(event.source!==parent||!data||data.__atools_plugin_data_session__!==true||data.instanceId!==config.instanceId)return;try{bridge.install(data.endpoint);}catch{bridge.close();}});'
    + 'addEventListener("atools-plugin-out",function(){bridge.close();});addEventListener("pagehide",function(){bridge.close();},{once:true});})();<\/script>';
}


