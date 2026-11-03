export type PluginAiModel = { id: string; value: string; label: string };
export type PluginAiMessage = { role: "assistant"; content: string; reasoning_content?: string };
export type PluginAiHandle = Promise<PluginAiMessage | void> & { abort: () => void };

/** Page-side ZTools API. It speaks only over an owner-bound private MessagePort. */
export function createPluginAiBridge(pluginId: string, target: Window, transport: {
  post: (message: Record<string, unknown>, transfer?: Transferable[]) => boolean;
}) {
  const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
  type Call = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  type Active = { resolve: (value: PluginAiMessage | void) => void; reject: (error: Error) => void;
    callback?: (delta: { content?: string; reasoning_content?: string }) => void; ended: boolean; seq: number; timer?: ReturnType<typeof setTimeout> };
  let port: MessagePort | undefined, connection: Promise<MessagePort> | undefined, disposed = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectConnect: ((reason: Error) => void) | undefined;
  const calls = new Map<string, Call>(), active = new Map<string, Active>();
  function error(code: string) { return Object.assign(new Error(code), { code }); }
  function id() { return target.crypto.randomUUID(); }
  function jsonBound(value: unknown) {
    const budget = { chars: 0, nodes: 0 };
    const inspect = (node: unknown, depth: number): void => {
      if (++budget.nodes > 100_000 || depth > 48) throw error("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE");
      if (typeof node === "string") { budget.chars += node.length; if (budget.chars > MAX_REQUEST_BYTES) throw error("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE"); return; }
      if (node === null || typeof node === "boolean" || (typeof node === "number" && Number.isFinite(node))) return;
      if (Array.isArray(node)) { for (const item of node) inspect(item, depth + 1); return; }
      if (!node || typeof node !== "object") throw error("ERR_ATOOLS_PLUGIN_AI_UNSUPPORTED_OPTIONS");
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) { budget.chars += key.length; if (budget.chars > MAX_REQUEST_BYTES) throw error("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE"); inspect(record[key], depth + 1); }
    };
    inspect(value, 0);
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || encoded.length > MAX_REQUEST_BYTES
      || new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_BYTES) throw error("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE");
    return encoded;
  }
  function receive(event: MessageEvent) {
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (data.kind === "closed") { close(error("ERR_ATOOLS_PLUGIN_AI_DISCONNECTED"), false); return; }
    if (data.kind === "connected" && connection && event.currentTarget === port) return;
    if (data.kind === "reply" && typeof data.callId === "string") {
      const call = calls.get(data.callId); if (!call) return; calls.delete(data.callId); clearTimeout(call.timer);
      if (data.ok === true) call.resolve(data.value);
      else call.reject(error(typeof data.code === "string" ? data.code : "ERR_ATOOLS_PLUGIN_AI_FAILED"));
      return;
    }
    if (data.kind === "ai-delta" && typeof data.clientRequestId === "string") {
      const current = active.get(data.clientRequestId);
      if (!current || current.ended || data.seq !== current.seq + 1 || !data.delta || typeof data.delta !== "object"
        || Object.keys(data.delta).some(key => key !== "content" && key !== "reasoning_content")
        || Object.values(data.delta).some(value => typeof value !== "string" || value.length > 16 * 1024)) return;
      current.seq = data.seq;
      let accepted = true;
      try {
        if (current.callback) current.callback(data.delta);
      } catch { accepted = false; }
      port?.postMessage({ kind: "ai-ack", clientRequestId: data.clientRequestId, seq: data.seq, accepted });
      if (!accepted) finishFailure(data.clientRequestId, error("ERR_ATOOLS_PLUGIN_AI_CALLBACK_FAILED"));
      return;
    }
    if (data.kind === "ai-terminal" && typeof data.clientRequestId === "string") {
      const current = active.get(data.clientRequestId);
      if (!current || current.ended || data.seq !== current.seq + 1
        || !["succeeded", "failed", "cancelled"].includes(data.status)) return;
      current.seq = data.seq;
      port?.postMessage({ kind: "ai-ack", clientRequestId: data.clientRequestId, seq: data.seq, accepted: true });
      return;
    }
    if (data.kind === "ai-complete" && typeof data.clientRequestId === "string") {
      const current = active.get(data.clientRequestId); if (!current || current.ended) return;
      current.ended = true; clearTimeout(current.timer); active.delete(data.clientRequestId);
      current.resolve(data.mode === "collect" ? data.message as PluginAiMessage : undefined);
      return;
    }
    if (data.kind === "ai-failed" && typeof data.clientRequestId === "string") {
      finishFailure(data.clientRequestId, error(typeof data.code === "string" ? data.code : "ERR_ATOOLS_PLUGIN_AI_FAILED"));
    }
  }
  function finishFailure(clientRequestId: string, reason: Error, notifyHost = true) {
    const current = active.get(clientRequestId); if (!current || current.ended) return;
    current.ended = true; clearTimeout(current.timer); active.delete(clientRequestId); current.reject(reason);
    if (notifyHost) try { port?.postMessage({ kind: "cancel", clientRequestId }); } catch { /* document closed */ }
  }
  function connect(): Promise<MessagePort> {
    if (disposed) return Promise.reject(error("ERR_ATOOLS_PLUGIN_AI_CLOSED"));
    if (connection) return connection;
    if (port) return Promise.resolve(port);
    connection = new Promise<MessagePort>((resolve, reject) => {
      if (typeof MessageChannel !== "function" || !target.crypto?.randomUUID) { reject(error("ERR_ATOOLS_PLUGIN_AI_UNAVAILABLE")); return; }
      const channel = new MessageChannel();
      const connectId = id();
      port = channel.port1;
      channel.port1.onmessage = receive;
      channel.port1.onmessageerror = () => close(error("ERR_ATOOLS_PLUGIN_AI_DISCONNECTED"), false);
      channel.port1.start();
      rejectConnect = reject;
      connectTimer = setTimeout(() => {
        channel.port1.close(); port = undefined; connectTimer = undefined; rejectConnect = undefined;
        reject(error("ERR_ATOOLS_PLUGIN_AI_CONNECT_TIMEOUT"));
      }, 5000);
      channel.port1.addEventListener("message", function ready(event) {
      if (event.data?.kind !== "connected" || event.data.connectId !== connectId) return;
        clearTimeout(connectTimer); connectTimer = undefined; rejectConnect = undefined;
        channel.port1.removeEventListener("message", ready); resolve(channel.port1);
      });
      if (!transport.post({ __atools_plugin_ai_connect__: true, pluginId, connectId }, [channel.port2])) {
        clearTimeout(connectTimer); connectTimer = undefined; rejectConnect = undefined;
        channel.port1.close(); port = undefined; reject(error("ERR_ATOOLS_PLUGIN_AI_CONNECT_FAILED"));
      }
    }).catch(reason => { connection = undefined; throw reason; });
    return connection;
  }
  async function request(operation: string, value: Record<string, unknown>) {
    if (calls.size >= 1) throw error("ERR_ATOOLS_PLUGIN_AI_BUSY");
    const callId = id();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { calls.delete(callId); reject(error("ERR_ATOOLS_PLUGIN_AI_REQUEST_TIMEOUT")); }, 30_000);
      calls.set(callId, { resolve, reject, timer });
      void connect().then(channel => {
        if (!calls.has(callId)) return;
        channel.postMessage({ kind: "request", callId, operation, ...value });
      }).catch(reason => {
        const pending = calls.get(callId); if (!pending) return;
        clearTimeout(pending.timer); calls.delete(callId);
        pending.reject(reason instanceof Error ? reason : error("ERR_ATOOLS_PLUGIN_AI_DISCONNECTED"));
      });
    });
  }
  function validateAiOptions(value: unknown, callback: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ai expects an options object");
    const options = value as Record<string, unknown>;
    if (Object.keys(options).some(key => key !== "messages" && key !== "model") || !Array.isArray(options.messages)
      || options.messages.length < 1 || options.messages.length > 64
      || (options.model !== undefined && (typeof options.model !== "string" || options.model.length > 256))
      || (callback !== undefined && typeof callback !== "function")) throw error("ERR_ATOOLS_PLUGIN_AI_UNSUPPORTED_OPTIONS");
    jsonBound({ messages: options.messages, ...(options.model === undefined ? {} : { model: options.model }) });
    return { messages: options.messages, ...(options.model === undefined ? {} : { model: options.model }) };
  }
  function ai(value: unknown, callback?: (delta: { content?: string; reasoning_content?: string }) => void): PluginAiHandle {
    if (active.size >= 1) throw error("ERR_ATOOLS_PLUGIN_AI_BUSY");
    const request = validateAiOptions(value, callback), clientRequestId = id();
    let resolve!: (value: PluginAiMessage | void) => void, reject!: (error: Error) => void;
    const promise = new Promise<PluginAiMessage | void>((yes, no) => { resolve = yes; reject = no; }) as PluginAiHandle;
    const state: Active = { resolve, reject, callback, ended: false, seq: 0 };
    active.set(clientRequestId, state);
    void connect().then(channel => {
      if (state.ended) { channel.postMessage({ kind: "cancel", clientRequestId }); return; }
      channel.postMessage({ kind: "ai-start", clientRequestId, request, mode: callback ? "stream" : "collect" });
    }).catch(reason => finishFailure(clientRequestId, reason instanceof Error ? reason : error("ERR_ATOOLS_PLUGIN_AI_CONNECT_FAILED")));
    promise.abort = () => {
      const current = active.get(clientRequestId);
      if (!current || current.ended) return;
      current.ended = true; clearTimeout(current.timer); active.delete(clientRequestId);
      try { port?.postMessage({ kind: "cancel", clientRequestId }); } catch { /* document closed */ }
      current.reject(Object.assign(error("ERR_ATOOLS_PLUGIN_AI_ABORTED"), { name: "AbortError" }));
    };
    state.timer = setTimeout(() => finishFailure(clientRequestId, error("ERR_ATOOLS_PLUGIN_AI_TIMEOUT")), 250_000);
    return promise;
  }
  async function allAiModels(): Promise<PluginAiModel[]> {
    const result = await request("models", {});
    if (!result || typeof result !== "object" || Array.isArray(result)) throw error("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
    const value = result as { configured?: unknown; models?: unknown };
    if (typeof value.configured !== "boolean" || !Array.isArray(value.models) || value.models.length > 1) throw error("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
    const models = value.models.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw error("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
      const model = item as Record<string, unknown>;
      if (typeof model.id !== "string" || model.id !== model.value || model.value !== model.label || !model.id || model.id.length > 256
        || Object.keys(model).sort().join(",") !== "id,label,value") throw error("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
      return { id: model.id, value: model.value, label: model.label };
    });
    if (value.configured !== (models.length === 1)) throw error("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
    return models;
  }
  function close(reason = error("ERR_ATOOLS_PLUGIN_AI_CLOSED"), notifyHost = true) {
    if (disposed) return;
    disposed = true;
    for (const [clientRequestId, current] of active) {
      current.ended = true; clearTimeout(current.timer); current.reject(reason);
      if (notifyHost) try { port?.postMessage({ kind: "cancel", clientRequestId }); } catch { /* document closed */ }
    }
    if (notifyHost) try { port?.postMessage({ kind: "disconnect" }); } catch { /* document closed */ }
    active.clear(); for (const [, call] of calls) { clearTimeout(call.timer); call.reject(reason); } calls.clear();
    clearTimeout(connectTimer); connectTimer = undefined;
    rejectConnect?.(reason); rejectConnect = undefined; connection = undefined;
    target.removeEventListener("atools-plugin-out", onPluginOut);
    target.removeEventListener("pagehide", onPageHide);
    port?.close(); port = undefined;
  }
  const onPluginOut = () => close();
  const onPageHide = () => close();
  target.addEventListener("atools-plugin-out", onPluginOut);
  target.addEventListener("pagehide", onPageHide, { once: true });
  return { allAiModels, ai, close };
}

export function pluginAiBridgeScript(pluginId: string) {
  const serialized = JSON.stringify(pluginId).replace(/</g, "\\u003c");
  return `<script data-atools-plugin-ai>(function(){var transport=window.__ATOOLS_FRAME_TRANSPORT__;if(!transport)return;` +
    `var api=(${createPluginAiBridge.toString()})(${serialized},window,transport);` +
    `var target=window.ztools||window.utools;if(!target)return;target.allAiModels=api.allAiModels;target.ai=api.ai;})();</script>`;
}
