import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { TaskRun } from "./types";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type AiDelta = { kind: "delta"; requestId: string; seq: number; delta: { content?: string; reasoning_content?: string } }
  | { kind: "terminal"; requestId: string; seq: number; status: "succeeded" | "failed" | "cancelled"; outputBytes: number; code?: string };
type NativeOpen = { ok?: boolean; requestId?: string; clientRequestId?: string; model?: string; expiresInMs?: number };
type Pending = { requestId: string; clientRequestId: string; cancelled: boolean; terminal?: Extract<AiDelta, { kind: "terminal" }>; nextSeq: number;
  ack?: { seq: number; resolve: (accepted: boolean) => void }; chain: Promise<void>;
  terminalPromise: Promise<Extract<AiDelta, { kind: "terminal" }>>; resolveTerminal: (event: Extract<AiDelta, { kind: "terminal" }>) => void;
  cancelPromise: Promise<never>; rejectCancel: (error: Error) => void };
type Connection = { source: Window; identity: PluginFrameIdentity; lease: ReturnType<ReturnType<typeof createPluginHostedIpcRouter>["captureReadyDocumentLease"]>;
  port: MessagePort; instanceId: string; unbind: () => void; requests: Map<string, Pending>; modelsInFlight: boolean; closed: boolean };
type Ports = { pluginId: string; invoke?: Invoke; isCurrent: () => boolean; sources: PluginFrameSourceRegistry;
  hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>; targetWindow?: Window; wait?: () => Promise<void> };
const UUID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_BODY}$`), TASK_RUN_ID = new RegExp(`^run-${UUID_BODY}$`);
const PERMISSION_REQUEST_ID = new RegExp(`^agent-confirm-${UUID_BODY}$`);
const MAX_REQUEST_BYTES = 3 * 1024 * 1024, MAX_DELTA_BYTES = 16 * 1024, MAX_RESULT_BYTES = 1024 * 1024;
const MAX_DELTA_RELAY_BYTES = MAX_DELTA_BYTES + 9; // Internal kind + request-id key add exactly 9 JSON bytes.
const MAX_RESULT_WIRE_BYTES = 6 * MAX_RESULT_BYTES + 1024;
const fail = (code: string) => Object.assign(new Error(code), { code });

/** Parent-side owner/document gate and bounded command adapter for the private AI channel. */
export function createPluginAiController(ports: Ports) {
  const call = ports.invoke ?? tauriInvoke;
  const hostWindow = ports.targetWindow ?? window;
  const wait = ports.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 200)));
  const connections = new Map<Window, Connection>();
  let closed = false;
  const current = () => !closed && ports.isCurrent();
  function owner(connection: Connection) {
    connection.lease.assertCurrent();
    if (!current() || connection.closed || !ports.sources.isCurrent(connection.source, connection.identity)
      || connections.get(connection.source) !== connection) throw fail("ERR_ATOOLS_PLUGIN_AI_DOCUMENT_STALE");
    return { pluginId: ports.pluginId, instanceId: connection.instanceId,
      ...(connection.lease.pageDocumentId ? { pageDocumentId: connection.lease.pageDocumentId } : {}),
      frameGeneration: connection.identity.generation, documentNonce: connection.lease.documentNonce };
  }
  function safeCode(error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && /^ERR_ATOOLS_PLUGIN_AI_[A-Z_]+$/.test(code) ? code : "ERR_ATOOLS_PLUGIN_AI_FAILED";
  }
  function post(connection: Connection, data: Record<string, unknown>) {
    owner(connection); connection.port.postMessage(data);
  }
  function awaitRequest<T>(request: Pending, operation: Promise<T>): Promise<T> {
    return Promise.race([operation, request.cancelPromise]);
  }
  function withinDeadline<T>(request: Pending, operation: Promise<T>, deadline: number, code: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(fail(code));
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([awaitRequest(request, operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail(code)), remaining);
    })]).finally(() => clearTimeout(timer));
  }
  async function toolName() {
    if (!globalThis.crypto?.subtle) throw fail("ERR_ATOOLS_PLUGIN_AI_UNAVAILABLE");
    const bytes = new TextEncoder().encode(ports.pluginId);
    if (!bytes.byteLength || bytes.byteLength > 256) throw fail("ERR_ATOOLS_PLUGIN_AI_UNAVAILABLE");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return "atools.plugin.ai." + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
  }
  function ensureJsonBound(value: unknown) {
    const budget = { chars: 0, nodes: 0 };
    const inspect = (node: unknown, depth: number): void => {
      if (++budget.nodes > 100_000 || depth > 48) throw fail("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE");
      if (typeof node === "string") { budget.chars += node.length; if (budget.chars > MAX_REQUEST_BYTES) throw fail("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE"); return; }
      if (node === null || typeof node === "boolean" || (typeof node === "number" && Number.isFinite(node))) return;
      if (Array.isArray(node)) { for (const item of node) inspect(item, depth + 1); return; }
      if (!node || typeof node !== "object") throw fail("ERR_ATOOLS_PLUGIN_AI_INVALID_REQUEST");
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) { budget.chars += key.length; if (budget.chars > MAX_REQUEST_BYTES) throw fail("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE"); inspect(record[key], depth + 1); }
    };
    inspect(value, 0);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || serialized.length > MAX_REQUEST_BYTES
      || new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw fail("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE");
    return serialized;
  }
  function validateRequest(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("ERR_ATOOLS_PLUGIN_AI_INVALID_REQUEST");
    const request = value as Record<string, unknown>;
    if (Object.keys(request).some(key => key !== "messages" && key !== "model") || !Array.isArray(request.messages)
      || request.messages.length < 1 || request.messages.length > 64
      || (request.model !== undefined && (typeof request.model !== "string" || !request.model || request.model.length > 256))) {
      throw fail("ERR_ATOOLS_PLUGIN_AI_UNSUPPORTED_OPTIONS");
    }
    ensureJsonBound(request);
    return { messages: request.messages, ...(request.model === undefined ? {} : { model: request.model }) };
  }
  function validModels(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
    const result = value as { configured?: unknown; models?: unknown };
    if (typeof result.configured !== "boolean" || !Array.isArray(result.models) || result.models.length > 1
      || result.configured !== (result.models.length === 1)) throw fail("ERR_ATOOLS_PLUGIN_AI_MODEL_RESPONSE");
    return result;
  }
  async function models(connection: Connection) {
    const result = validModels(await call("list_plugin_ai_models", owner(connection)));
    return { configured: result.configured, models: result.models };
  }
  function sendReply(connection: Connection, callId: string, ok: boolean, value?: unknown, code?: string) {
    post(connection, { kind: "reply", callId, ok, ...(ok ? { value } : { code: code ?? "ERR_ATOOLS_PLUGIN_AI_FAILED" }) });
  }
  function resolveAck(request: Pending, data: Record<string, unknown>) {
    if (!request.ack || data.clientRequestId !== request.clientRequestId || data.seq !== request.ack.seq
      || typeof data.accepted !== "boolean") return;
    const pending = request.ack; request.ack = undefined; pending.resolve(data.accepted);
  }
  async function acceptNativeEvent(connection: Connection, request: Pending, event: AiDelta) {
    owner(connection);
    if (event.requestId !== request.requestId || !Number.isSafeInteger(event.seq) || event.seq !== request.nextSeq) throw fail("ERR_ATOOLS_PLUGIN_AI_CHANNEL_INVALID");
    if (event.kind === "delta") {
      if (Object.keys(event).some(key => !["kind", "requestId", "seq", "delta"].includes(key))
        || !event.delta || typeof event.delta !== "object" || Array.isArray(event.delta)
        || Object.keys(event.delta).some(key => key !== "content" && key !== "reasoning_content")
        || Object.values(event.delta).some(value => typeof value !== "string" || value.length > MAX_DELTA_BYTES)) throw fail("ERR_ATOOLS_PLUGIN_AI_CHANNEL_INVALID");
    } else if (!["succeeded", "failed", "cancelled"].includes(event.status) || !Number.isSafeInteger(event.outputBytes)
      || event.outputBytes < 0 || event.outputBytes > MAX_RESULT_BYTES
      || Object.keys(event).some(key => !["kind", "requestId", "seq", "status", "outputBytes", "code"].includes(key))
      || (event.code !== undefined && (typeof event.code !== "string" || !/^[a-z_]{1,64}$/.test(event.code)))) {
      throw fail("ERR_ATOOLS_PLUGIN_AI_CHANNEL_INVALID");
    }
    const relay = event.kind === "delta"
      ? { kind: "ai-delta", clientRequestId: request.clientRequestId, seq: event.seq, delta: event.delta }
      : { kind: "ai-terminal", clientRequestId: request.clientRequestId, seq: event.seq,
        status: event.status, outputBytes: event.outputBytes, ...(event.code ? { code: event.code } : {}) };
    if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_DELTA_BYTES
      || new TextEncoder().encode(JSON.stringify(relay)).byteLength > MAX_DELTA_RELAY_BYTES) throw fail("ERR_ATOOLS_PLUGIN_AI_CHANNEL_INVALID");
    request.nextSeq += 1;
    const accepted = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { request.ack = undefined; reject(fail("ERR_ATOOLS_PLUGIN_AI_ACK_TIMEOUT")); }, 5000);
      request.ack = { seq: event.seq, resolve: value => { clearTimeout(timer); resolve(value); } };
    });
    post(connection, relay);
    if (!await accepted) throw fail("ERR_ATOOLS_PLUGIN_AI_CALLBACK_FAILED");
    await call("ack_plugin_ai_delta", { ...owner(connection), requestId: request.requestId, seq: event.seq });
    if (event.kind === "terminal") { request.terminal = event; request.resolveTerminal(event); }
  }
  function channelFor(connection: Connection, request: Pending) {
    const channel = new Channel<AiDelta>();
    channel.onmessage = event => {
      request.chain = request.chain.then(() => acceptNativeEvent(connection, request, event)).catch(error => {
        if (!request.cancelled) { request.cancelled = true;
          try { post(connection, { kind: "ai-failed", clientRequestId: request.clientRequestId, code: safeCode(error) }); } catch { /* stale frame */ }
          void call("cancel_plugin_ai_request", { ...connectionOwnerEvenIfStale(connection), requestId: request.requestId }).catch(() => undefined); }
      });
    };
    return channel;
  }
  function validateTaskRun(run: TaskRun | null, runId: string, tool: string, requestId: string) {
    const input = run?.input;
    if (!run || run.id !== runId || run.capabilityId !== tool || run.initiator?.type !== "human"
      || run.initiator.clientId !== "atools-ui" || !input || typeof input !== "object" || Array.isArray(input)
      || (input as Record<string, unknown>).operation !== "execute" || (input as Record<string, unknown>).requestId !== requestId
      || Object.keys(input).length !== 2) throw fail("ERR_ATOOLS_PLUGIN_AI_TASK_BINDING");
    return run;
  }
  async function waitForApproval(connection: Connection, pending: Record<string, unknown>, request: Pending, requestId: string, tool: string) {
    const runId = pending.runId;
    const input = pending.arguments as Record<string, unknown> | undefined;
    if (pending.permission_required !== true || typeof runId !== "string" || !TASK_RUN_ID.test(runId) || pending.tool !== tool
      || pending.client_id !== "atools-ui" || typeof pending.request_id !== "string" || !PERMISSION_REQUEST_ID.test(pending.request_id)
      || !Array.isArray(pending.scopes) || pending.scopes.length !== 1 || pending.scopes[0] !== "network"
      || pending.retry_after_grant !== true || !input || input.operation !== "execute" || input.requestId !== requestId
      || Object.keys(input).length !== 2) throw fail("ERR_ATOOLS_PLUGIN_AI_PERMISSION_ENVELOPE");
    const approvalDeadline = Date.now() + 120_000;
    let runningDeadline: number | undefined;
    while (true) {
      if (request.cancelled || connection.closed) throw fail("ERR_ATOOLS_PLUGIN_AI_CANCELLED");
      const deadline = runningDeadline ?? approvalDeadline;
      if (Date.now() >= deadline) throw fail(runningDeadline ? "ERR_ATOOLS_PLUGIN_AI_RUNNING_TIMEOUT" : "ERR_ATOOLS_PLUGIN_AI_PERMISSION_TIMEOUT");
      const timeoutCode = runningDeadline ? "ERR_ATOOLS_PLUGIN_AI_RUNNING_TIMEOUT" : "ERR_ATOOLS_PLUGIN_AI_PERMISSION_TIMEOUT";
      await withinDeadline(request, wait(), deadline, timeoutCode); owner(connection);
      const run = await withinDeadline(request, call<TaskRun | null>("get_task_run", { id: runId }), deadline, timeoutCode); owner(connection);
      const checked = validateTaskRun(run, runId, tool, requestId);
      if (checked.status === "succeeded") {
        const output = checked.output as Record<string, unknown> | null;
        if (!output || output.requestId !== requestId || output.status !== "completed" || !Number.isSafeInteger(output.outputBytes)
          || Number(output.outputBytes) < 0 || Number(output.outputBytes) > MAX_RESULT_BYTES
          || !Number.isSafeInteger(output.deltaCount) || Number(output.deltaCount) < 0) throw fail("ERR_ATOOLS_PLUGIN_AI_TASK_OUTPUT");
        return checked;
      }
      if (checked.status === "running" && runningDeadline === undefined) runningDeadline = Date.now() + 120_000;
      if (["failed", "cancelled", "partial"].includes(checked.status)) throw fail("ERR_ATOOLS_PLUGIN_AI_PERMISSION_DENIED");
    }
  }
  async function startRequest(connection: Connection, clientRequestId: string, rawRequest: unknown, mode: unknown) {
    let requestId: string | undefined;
    let resolveTerminal!: (event: Extract<AiDelta, { kind: "terminal" }>) => void;
    const terminalPromise = new Promise<Extract<AiDelta, { kind: "terminal" }>>(resolve => { resolveTerminal = resolve; });
    let rejectCancel!: (error: Error) => void;
    const cancelPromise = new Promise<never>((_, reject) => { rejectCancel = reject; });
    const item: Pending = { clientRequestId, requestId: "", cancelled: false, nextSeq: 1, chain: Promise.resolve(), terminalPromise, resolveTerminal, cancelPromise, rejectCancel };
    connection.requests.set(clientRequestId, item);
    const assertActive = () => { owner(connection); if (item.cancelled || connection.requests.get(clientRequestId) !== item) throw fail("ERR_ATOOLS_PLUGIN_AI_CANCELLED"); };
    try {
      if (!UUID.test(clientRequestId) || (mode !== "stream" && mode !== "collect")) throw fail("ERR_ATOOLS_PLUGIN_AI_INVALID_REQUEST");
      const request = validateRequest(rawRequest), modelConfig = validModels(await awaitRequest(item, call("list_plugin_ai_models", owner(connection))));
      assertActive();
      const configured = (modelConfig.models as Array<{ id?: unknown; value?: unknown }>)[0];
      if (!modelConfig.configured || !configured || typeof configured.value !== "string"
        || (request.model !== undefined && request.model !== configured.value)) throw fail("ERR_ATOOLS_PLUGIN_AI_MODEL_UNAVAILABLE");
      const clientTool = await toolName(); assertActive();
      const opened = await awaitRequest(item, call<NativeOpen>("prepare_plugin_ai_request", { ...owner(connection), clientRequestId, request, mode }));
      if (item.cancelled || !current()) { await call("cancel_plugin_ai_request", { ...connectionOwnerEvenIfStale(connection), clientRequestId }).catch(() => undefined); throw fail("ERR_ATOOLS_PLUGIN_AI_CANCELLED"); }
      if (!opened || opened.ok !== true || opened.clientRequestId !== clientRequestId || typeof opened.requestId !== "string"
        || !UUID.test(opened.requestId) || opened.model !== configured.value || opened.expiresInMs !== 120_000) throw fail("ERR_ATOOLS_PLUGIN_AI_PREPARE_INVALID");
      requestId = opened.requestId; item.requestId = requestId; assertActive();
      const channel = channelFor(connection, item);
      const execution = await awaitRequest(item, call<Record<string, unknown>>("execute_plugin_ai_request", { ...owner(connection), requestId, onDelta: channel }));
      assertActive();
      if (execution && execution.permission_required === true) {
        const run = await waitForApproval(connection, execution, item, requestId, clientTool);
        if (run.status !== "succeeded") throw fail("ERR_ATOOLS_PLUGIN_AI_PERMISSION_DENIED");
      } else if (!execution || execution.status !== "completed" || execution.requestId !== requestId
        || execution.model !== configured.value || !Number.isSafeInteger(execution.outputBytes) || Number(execution.outputBytes) > MAX_RESULT_BYTES
        || !Number.isSafeInteger(execution.deltaCount) || Number(execution.deltaCount) < 0) {
        throw fail("ERR_ATOOLS_PLUGIN_AI_EXECUTION_INVALID");
      }
      let terminalTimer: ReturnType<typeof setTimeout> | undefined;
      const terminal = await awaitRequest(item, Promise.race([item.terminalPromise, new Promise<never>((_, reject) => {
        terminalTimer = setTimeout(() => reject(fail("ERR_ATOOLS_PLUGIN_AI_TERMINAL_TIMEOUT")), 5000);
      })]).finally(() => clearTimeout(terminalTimer)));
      await item.chain; assertActive();
      if (terminal.status !== "succeeded" || terminal.requestId !== requestId) throw fail("ERR_ATOOLS_PLUGIN_AI_TERMINAL_MISSING");
      let message: unknown;
      if (mode === "collect") {
        const result = await awaitRequest(item, call<Record<string, unknown>>("take_plugin_ai_result", { ...owner(connection), requestId })); assertActive();
        if (!result || result.requestId !== requestId || result.model !== configured.value || !Number.isSafeInteger(result.outputBytes)
          || Number(result.outputBytes) < 0 || Number(result.outputBytes) > MAX_RESULT_BYTES || !result.message || typeof result.message !== "object"
          || Array.isArray(result.message)) throw fail("ERR_ATOOLS_PLUGIN_AI_RESULT_INVALID");
        const parsedMessage = result.message as Record<string, unknown>;
        const contentLength = typeof parsedMessage.content === "string" ? parsedMessage.content.length : -1;
        const reasoningLength = typeof parsedMessage.reasoning_content === "string" ? parsedMessage.reasoning_content.length : 0;
        if (contentLength < 0 || contentLength + reasoningLength > MAX_RESULT_BYTES) throw fail("ERR_ATOOLS_PLUGIN_AI_RESULT_INVALID");
        const contentBytes = typeof parsedMessage.content === "string" ? new TextEncoder().encode(parsedMessage.content).byteLength : -1;
        const reasoningBytes = typeof parsedMessage.reasoning_content === "string" ? new TextEncoder().encode(parsedMessage.reasoning_content).byteLength : 0;
        const serializedMessage = JSON.stringify(parsedMessage);
        if (parsedMessage.role !== "assistant" || typeof parsedMessage.content !== "string"
          || (parsedMessage.reasoning_content !== undefined && typeof parsedMessage.reasoning_content !== "string")
          || Object.keys(parsedMessage).some(key => !["role", "content", "reasoning_content"].includes(key))
          || contentBytes < 0 || contentBytes + reasoningBytes > MAX_RESULT_BYTES
          || typeof serializedMessage !== "string" || new TextEncoder().encode(serializedMessage).byteLength > MAX_RESULT_WIRE_BYTES
          || Number(result.outputBytes) !== contentBytes + reasoningBytes) throw fail("ERR_ATOOLS_PLUGIN_AI_RESULT_INVALID");
        message = result.message;
      }
      post(connection, { kind: "ai-complete", clientRequestId, mode, ...(mode === "collect" ? { message } : {}) });
    } catch (error) {
      if (current() && !connection.closed) try { post(connection, { kind: "ai-failed", clientRequestId, code: safeCode(error) }); } catch { /* stale frame */ }
      if (requestId) await call("cancel_plugin_ai_request", { ...connectionOwnerEvenIfStale(connection), requestId }).catch(() => undefined);
    } finally {
      if (connection.requests.get(clientRequestId) === item) connection.requests.delete(clientRequestId);
    }
  }
  async function onPortMessage(connection: Connection, event: MessageEvent) {
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
    const data = event.data as Record<string, unknown>;
    try {
      owner(connection);
      if (data.kind === "disconnect") { closeConnection(connection); return; }
      if (data.kind === "request" && typeof data.callId === "string" && UUID.test(data.callId) && data.operation === "models") {
        if (connection.modelsInFlight) {
          sendReply(connection, data.callId, false, undefined, "ERR_ATOOLS_PLUGIN_AI_BUSY"); return;
        }
        connection.modelsInFlight = true;
        try { sendReply(connection, data.callId, true, await models(connection)); }
        finally { connection.modelsInFlight = false; }
        return;
      }
      if (data.kind === "ai-start" && typeof data.clientRequestId === "string" && UUID.test(data.clientRequestId)) {
        if (connection.requests.size >= 1) {
          post(connection, { kind: "ai-failed", clientRequestId: data.clientRequestId, code: "ERR_ATOOLS_PLUGIN_AI_BUSY" });
          return;
        }
        void startRequest(connection, data.clientRequestId, data.request, data.mode); return;
      }
      if (data.kind === "ai-ack" && typeof data.clientRequestId === "string") {
        const request = connection.requests.get(data.clientRequestId); if (request) resolveAck(request, data); return;
      }
      if (data.kind === "cancel" && typeof data.clientRequestId === "string") {
        const request = connection.requests.get(data.clientRequestId);
        if (request) {
          request.cancelled = true;
          connection.requests.delete(data.clientRequestId);
          request.ack?.resolve(false);
          request.rejectCancel(fail("ERR_ATOOLS_PLUGIN_AI_CANCELLED"));
        }
        void call("cancel_plugin_ai_request", { ...owner(connection), clientRequestId: data.clientRequestId,
          ...(request?.requestId ? { requestId: request.requestId } : {}) }).catch(() => undefined);
      }
    } catch (error) {
      if (data.kind === "request" && typeof data.callId === "string" && UUID.test(data.callId)) {
        try { sendReply(connection, data.callId, false, undefined, safeCode(error)); } catch { /* stale document */ }
      } else if (data.kind === "ai-start" && typeof data.clientRequestId === "string") {
        try { post(connection, { kind: "ai-failed", clientRequestId: data.clientRequestId, code: safeCode(error) }); } catch { /* stale document */ }
      }
    }
  }
  function closeConnection(connection: Connection) {
    if (connection.closed) return;
    connection.closed = true; connection.unbind(); connections.delete(connection.source);
    for (const request of connection.requests.values()) {
      request.cancelled = true;
      request.rejectCancel(fail("ERR_ATOOLS_PLUGIN_AI_DISCONNECTED"));
      request.ack?.resolve(false);
      void call("cancel_plugin_ai_request", { ...connectionOwnerEvenIfStale(connection), clientRequestId: request.clientRequestId,
        ...(request.requestId ? { requestId: request.requestId } : {}) }).catch(() => undefined);
    }
    connection.requests.clear();
    try { connection.port.postMessage({ kind: "closed" }); } catch { /* peer already gone */ }
    connection.port.onmessage = null; connection.port.onmessageerror = null; connection.port.close();
  }
  function connectionOwnerEvenIfStale(connection: Connection) {
    return { pluginId: ports.pluginId, instanceId: connection.instanceId,
      ...(connection.lease.pageDocumentId ? { pageDocumentId: connection.lease.pageDocumentId } : {}),
      frameGeneration: connection.identity.generation, documentNonce: connection.lease.documentNonce };
  }
  async function receive(event: MessageEvent) {
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const raw = data as Record<string, unknown>;
    if (raw.__atools_plugin_ai_connect__ !== true) return;
    const transferred = event.ports ?? [];
    if (!current() || !event.source || transferred.length !== 1) { for (const port of transferred) port.close(); return; }
    const port = transferred[0];
    if (raw.pluginId !== ports.pluginId || typeof raw.connectId !== "string" || !UUID.test(raw.connectId)
      || Object.keys(raw).some(key => !["__atools_plugin_ai_connect__", "pluginId", "connectId", "__atoolsDocument"].includes(key))) { port.close(); return; }
    const source = event.source as Window;
    let identity: PluginFrameIdentity | null;
    try { identity = ports.sources.identifyEvent(event); } catch { port.close(); return; }
    if (!identity || !ports.sources.isCurrent(source, identity)) { port.close(); return; }
    if ("expectedOrigin" in identity && event.origin !== identity.expectedOrigin) { port.close(); return; }
    let lease: ReturnType<typeof ports.hostedIpc.captureReadyDocumentLease>;
    try { lease = ports.hostedIpc.captureReadyDocumentLease(source); } catch { port.close(); return; }
    if (lease.identity.generation !== identity.generation || lease.documentNonce !== ("docNonce" in identity ? identity.docNonce : lease.documentNonce)
      || lease.pageDocumentId !== ("pageDocumentId" in identity ? identity.pageDocumentId : undefined)) { port.close(); return; }
    const old = connections.get(source); if (old) closeConnection(old);
    const connection: Connection = { source, identity, lease, port, instanceId: crypto.randomUUID(), closed: false,
      requests: new Map(), modelsInFlight: false, unbind: () => undefined };
    connection.unbind = ports.sources.onFrameInvalidated(source, identity, () => closeConnection(connection));
    connections.set(source, connection);
    port.onmessage = message => { void onPortMessage(connection, message); };
    port.onmessageerror = () => closeConnection(connection);
    try { port.start(); port.postMessage({ kind: "connected", connectId: raw.connectId }); }
    catch { closeConnection(connection); }
  }
  hostWindow.addEventListener("message", receive);
  function close() {
    if (closed) return;
    closed = true; hostWindow.removeEventListener("message", receive);
    for (const connection of [...connections.values()]) closeConnection(connection);
  }
  return { close };
}
