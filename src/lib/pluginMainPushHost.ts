import { MAIN_PUSH_LIMITS, type MainPushEntry, type MainPushReply } from "./pluginMainPushProtocol";
import { isPluginDocumentIdentity, type PluginFrameIdentity, type PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";

/** Correlates frame messages after the existing source/origin/document registry check. */
export function createPluginMainPushHost(options: { runnerId: string; featureCode: string; parentOrigin: string;
  source: () => Window | null; sources: PluginFrameSourceRegistry; mode: (mode: "query" | "select" | "visible") => void }) {
  let epoch = 0, nonce = "", closed = false, booted = false, registered = false, waiting = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let readiness: Promise<void> | undefined;
  const pending = new Map<string, { identity: PluginFrameIdentity; resolve: (reply: MainPushReply) => void; reject: (error: Error) => void;
    remaining: number; started: number; timer?: ReturnType<typeof setTimeout> }>();
  function arm(requestId: string) {
    const request = pending.get(requestId); if (!request || waiting) return;
    request.started = performance.now();
    request.timer = setTimeout(() => { pending.delete(requestId); request.reject(Error("ERR_MAIN_PUSH_TIMEOUT")); }, request.remaining);
  }
  function setWaiting(value: boolean) {
    if (value === waiting) return;
    waiting = value;
    for (const [id, request] of pending) {
      if (value) { clearTimeout(request.timer); request.timer = undefined; request.remaining = Math.max(0, request.remaining - (performance.now() - request.started)); }
      else arm(id);
    }
  }
  function cancel() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error("ERR_MAIN_PUSH_SUPERSEDED")); }
    pending.clear();
    post({ command: "cancel" }); options.mode("query");
  }
  function reset(next: number) {
    cancel(); readyReject?.(Error("ERR_MAIN_PUSH_DOCUMENT_CHANGED"));
    epoch = next; nonce = crypto.randomUUID(); booted = registered = false;
    readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void readiness.catch(() => undefined);
  }
  function configuration() { return { runnerId: options.runnerId, featureCode: options.featureCode, parentOrigin: options.parentOrigin,
    nonce, epoch, queryOnly: true }; }
  function post(data: Record<string, unknown>) {
    const source = options.source(), identity = options.sources.currentIdentityForHost(source);
    return !closed && !!identity && options.sources.reply(source, identity, { __atools_main_push_command__: true,
      runnerId: options.runnerId, nonce, epoch, ...data });
  }
  function receive(event: MessageEvent, identity: PluginFrameIdentity) {
    const data = event.data;
    if (closed || event.source !== options.source() || identity.kind !== "main" || !options.sources.isCurrent(event.source, identity)
      || event.origin !== (isPluginDocumentIdentity(identity) ? identity.expectedOrigin : "null")
      || !data || typeof data !== "object" || data.__atools_main_push__ !== true
      || data.runnerId !== options.runnerId || data.nonce !== nonce || data.epoch !== epoch) return false;
    if (data.registered === true) registered = true;
    if (data.booted === true) booted = true;
    if (booted && registered) readyResolve?.();
    if (typeof data.requestId !== "string") return true;
    const request = pending.get(data.requestId);
    if (!request || request.identity.generation !== identity.generation) return true;
    pending.delete(data.requestId); clearTimeout(request.timer);
    if (!["ready", "handled", "enter", "empty", "failed", "superseded"].includes(data.outcome)) { request.reject(Error("ERR_MAIN_PUSH_RESPONSE")); return true; }
    const rows = data.rows;
    if (rows !== undefined && (!Array.isArray(rows) || rows.length > MAIN_PUSH_LIMITS.rows
      || rows.some(row => !row || typeof row !== "object" || typeof row.handle !== "string" || row.handle.length > 256
        || ["text", "description", "icon"].some(key => typeof row[key] !== "string" || row[key].length > MAIN_PUSH_LIMITS.textLength)))) {
      request.reject(Error("ERR_MAIN_PUSH_RESPONSE")); return true;
    }
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAIN_PUSH_LIMITS.envelopeBytes) { request.reject(Error("ERR_MAIN_PUSH_BYTES")); return true; }
    request.resolve({ requestId: data.requestId, outcome: data.outcome, ...(rows === undefined ? {} : { rows }),
      ...(data.outcome === "failed" ? { error: "ERR_MAIN_PUSH_CALLBACK" } : {}) });
    return true;
  }
  async function request(requestId: string, data: Record<string, unknown>, timeout: number) {
    await readiness;
    const source = options.source(), identity = options.sources.currentIdentityForHost(source);
    if (closed || !identity || pending.size) throw Error("ERR_MAIN_PUSH_NOT_READY");
    return new Promise<MainPushReply>((resolve, reject) => {
      const pendingRequest = { identity, resolve, reject, remaining: timeout, started: performance.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
      pending.set(requestId, pendingRequest); arm(requestId);
      if (!post({ requestId, ...data })) { pending.delete(requestId); clearTimeout(pendingRequest.timer); reject(Error("ERR_MAIN_PUSH_SOURCE")); }
    });
  }
  return { reset, configuration, receive, setWaiting, ready: () => readiness ?? Promise.reject(Error("ERR_MAIN_PUSH_NOT_READY")),
    query: (requestId: string, generation: number, payload: string, type: string) => request(requestId, { command: "query", generation, payload, type }, MAIN_PUSH_LIMITS.queryMs),
    select(requestId: string, queryId: string, generation: number, handle: string) {
      options.mode("select"); return request(requestId, { command: "select", queryId, generation, handle }, MAIN_PUSH_LIMITS.selectMs).finally(() => options.mode("query"));
    },
    promote(entry: MainPushEntry) {
      if (closed || !post({ command: "promote", queryId: entry.queryId, ...(entry.handle === undefined ? {} : { handle: entry.handle }) })) throw Error("ERR_MAIN_PUSH_SOURCE");
      options.mode("visible");
    }, cancel, close() { if (closed) return; cancel(); closed = true; readyReject?.(Error("ERR_MAIN_PUSH_CLOSED")); } };
}
