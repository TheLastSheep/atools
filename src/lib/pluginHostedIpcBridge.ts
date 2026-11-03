type HostedIpcOptions = {
  webContentsId: number;
  invoke: (method: string, args: Record<string, unknown>) => Promise<unknown>;
  reportError?: (error: unknown) => void;
};

/** Serialized with the original broker. No timers, polling, or transport while idle. */
export function createPluginHostedIpcBridge(hostWindow: Window & {
  __ATOOLS_FRAME_TRANSPORT__?: { post: (message: Record<string, unknown>) => unknown; accept: (event: MessageEvent) => boolean };
}, options: HostedIpcOptions) {
  const listeners = new Map<string, Array<{ listener: (...args: unknown[]) => void; once: boolean }>>();
  let disposed = false;
  let pendingSends = 0;
  const nonceBytes = new Uint8Array(16);
  if (typeof hostWindow.crypto?.getRandomValues === "function") hostWindow.crypto.getRandomValues(nonceBytes);
  else for (let index = 0; index < nonceBytes.length; index++) nonceBytes[index] = Math.floor(Math.random() * 256);
  const documentNonce = Array.from(nonceBytes, value => value.toString(16).padStart(2, "0")).join("");
  const invalid = (message: string) => new Error("ERR_ATOOLS_HOSTED_IPC: " + message);
  const channelName = (channel: unknown) => {
    if (typeof channel !== "string" || !channel.trim() || channel.length > 128 || channel.includes("\0")) throw invalid("invalid channel");
    return channel;
  };
  if (!Number.isSafeInteger(options.webContentsId) || options.webContentsId <= 0) throw invalid("invalid document ID");
  function report(error: unknown) {
    try { if (options.reportError) options.reportError(error); else console.error("[ATools hosted ipcRenderer.sendTo]", error); }
    catch { /* Diagnostic failures cannot become unhandled transport rejections. */ }
  }
  function remove(channel: string, listener: (...args: unknown[]) => void) {
    const remaining = (listeners.get(channel) || []).filter(entry => entry.listener !== listener);
    if (remaining.length) listeners.set(channel, remaining); else listeners.delete(channel);
    return ipcRenderer;
  }
  function add(channel: unknown, listener: unknown, once: boolean) {
    const key = channelName(channel);
    if (disposed) throw invalid("document is disposed");
    if (typeof listener !== "function") throw invalid("listener must be a function");
    const entries = listeners.get(key) || [];
    if (listeners.size >= 64 && !listeners.has(key) || entries.length >= 64) throw invalid("listener budget exceeded");
    entries.push({ listener: listener as (...args: unknown[]) => void, once });
    listeners.set(key, entries);
    return ipcRenderer;
  }
  function emit(channel: string, args: unknown[], senderId?: number) {
    if (disposed) return;
    const entries = (listeners.get(channel) || []).slice();
    const event = { channel, sender: null, senderFrame: null, senderId, returnValue: undefined };
    for (const entry of entries) {
      if (entry.once) remove(channel, entry.listener);
      try { entry.listener(event, ...args); } catch (error) { report(error); }
    }
  }
  function snapshot(args: unknown[]) {
    if (args.length > 32) throw invalid("at most 32 JSON arguments are allowed");
    const seen = new Set<object>();
    let nodes = 0, estimatedBytes = 0;
    const encoder = new TextEncoder();
    function charge(value: string) {
      if (value.length > 16_384 || (estimatedBytes += encoder.encode(value).byteLength) > 16_384) throw invalid("message exceeds 16384 bytes");
    }
    function copy(value: unknown, depth: number): unknown {
      if (++nodes > 1024) throw invalid("JSON node budget exceeds 1024");
      if (depth > 12) throw invalid("JSON depth exceeds 12");
      if (typeof value === "string") { charge(value); return value; }
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (!value || typeof value !== "object" || seen.has(value)) throw invalid("arguments must be finite acyclic JSON");
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw invalid("arguments must be plain JSON");
      seen.add(value);
      const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null);
      if (Array.isArray(value)) {
        if (value.length > 1024) throw invalid("JSON array budget exceeds 1024");
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) throw invalid("JSON requires own data properties");
          (result as unknown[]).push(copy(descriptor.value, depth + 1));
        }
      } else for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (++nodes > 1024) throw invalid("JSON node budget exceeds 1024");
        charge(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) throw invalid("JSON requires own data properties");
        (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
      }
      seen.delete(value);
      return result;
    }
    return copy(args, 0) as unknown[];
  }
  const ipcRenderer = {
    on: (channel: unknown, listener: unknown) => add(channel, listener, false),
    addListener: (channel: unknown, listener: unknown) => add(channel, listener, false),
    once: (channel: unknown, listener: unknown) => add(channel, listener, true),
    off: (channel: string, listener: (...args: unknown[]) => void) => remove(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => remove(channel, listener),
    removeAllListeners(channel?: string) { if (channel === undefined) listeners.clear(); else listeners.delete(channel); return ipcRenderer; },
    sendTo(targetId: unknown, channel: unknown, ...args: unknown[]): void {
      if (disposed) throw invalid("document is disposed");
      if (pendingSends >= 32) throw invalid("pending message budget exceeded");
      if (!Number.isSafeInteger(targetId) || Number(targetId) <= 0) throw invalid("target ID must be a positive safe integer");
      const key = channelName(channel), values = snapshot(args);
      if (new TextEncoder().encode(JSON.stringify({ channel: key, args: values })).byteLength > 16_384) throw invalid("message exceeds 16384 bytes");
      pendingSends++;
      try { void Promise.resolve(options.invoke("sendTo", { targetId, channel: key, args: values }))
        .then(() => { pendingSends--; }, error => { pendingSends--; report(error); }); }
      catch (error) { pendingSends--; report(error); }
    },
  };
  function onMessage(event: MessageEvent) {
    if (event.source !== hostWindow.parent || !event.data || event.data.__atools_hosted_ipc__ !== true) return;
    if (hostWindow.__ATOOLS_FRAME_TRANSPORT__ && !hostWindow.__ATOOLS_FRAME_TRANSPORT__.accept(event)) return;
    const data = event.data;
    if (data.targetDocumentNonce !== documentNonce || !Number.isSafeInteger(data.senderId) || data.senderId <= 0 || !Array.isArray(data.args)) return;
    try { emit(channelName(data.channel), data.args, data.senderId); } catch (error) { report(error); }
  }
  function postLifecycle(phase: "open" | "close") {
    const message = { __atools_hosted_ipc_document__: true, webContentsId: options.webContentsId, documentNonce, phase };
    if (hostWindow.__ATOOLS_FRAME_TRANSPORT__) hostWindow.__ATOOLS_FRAME_TRANSPORT__.post(message);
    else hostWindow.parent.postMessage(message, "*");
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    postLifecycle("close");
    listeners.clear();
    hostWindow.removeEventListener("message", onMessage);
    hostWindow.removeEventListener("pagehide", dispose);
    hostWindow.removeEventListener("atools-plugin-out", dispose);
  }
  hostWindow.addEventListener("message", onMessage);
  hostWindow.addEventListener("pagehide", dispose);
  hostWindow.addEventListener("atools-plugin-out", dispose);
  postLifecycle("open");
  return { ipcRenderer, emit, dispose, documentNonce, getWebContentsId: () => options.webContentsId };
}
