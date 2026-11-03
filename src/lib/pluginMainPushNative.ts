import type { MainPushCandidate, MainPushDispatch, MainPushInvoke, MainPushOperation, MainPushReply } from "./pluginMainPushProtocol";
import type { TaskRun } from "./types";
type Stop = () => void | Promise<void>;
type Listen = <T>(event: string, receive: (event: { payload: T }) => void) => Promise<Stop>;
type StopHook = { name: string; stop: Stop; closed: boolean };
type Request = { requestId: string; runnerId: string; candidate: MainPushCandidate; operation: MainPushOperation;
  generation: number; inputBytes: number; execute: (dispatch: MainPushDispatch) => Promise<MainPushReply> };

/** Original input/output stays in renderer closures; native receives metadata only. */
export function createPluginMainPushNative(options: { invoke: MainPushInvoke; listen: Listen; invalidated: (pluginId: string | null) => void }) {
  const pending = new Map<string, { request: Request; ticket?: string; waiting: boolean; running: boolean;
    resolve: (reply: MainPushReply) => void; reject: (error: Error) => void; reply?: MainPushReply;
    durable?: boolean; runId?: string; checking?: boolean; poll?: ReturnType<typeof setTimeout> }>();
  let closed = false, subscription: Promise<void> | undefined, closeOperation: Promise<void> | undefined;
  const stops: StopHook[] = [], registered = new Set<string>();
  function register<T>(name: string, receiveEvent: (event: { payload: T }) => void) {
    if (registered.has(name)) return Promise.resolve();
    return Promise.resolve().then(() => options.listen<T>(name, receiveEvent)).then(stop => {
      stops.push({ name, stop, closed: false }); registered.add(name);
    });
  }
  function connect() {
    if (closed) return Promise.reject(Error("ERR_MAIN_PUSH_CLOSED"));
    if (subscription) return subscription;
    const attempt = Promise.allSettled([
      register("plugin-main-push-dispatch", (event: { payload: MainPushDispatch }) => { void receive(event.payload); }),
      register("plugin-main-push-invalidated", (event: { payload: { pluginId: string | null } }) => {
        const id = event.payload?.pluginId; if (id === null || typeof id === "string") options.invalidated(id);
      }),
      register("task-run-updated", (event: { payload: string }) => {
        for (const entry of pending.values()) if (entry.runId === event.payload) void checkRun(entry);
      }),
    ]).then(results => {
      if (results.some(result => result.status === "rejected")) throw Error("ERR_MAIN_PUSH_LISTEN");
    });
    subscription = attempt;
    void attempt.then(() => undefined, () => { if (subscription === attempt) subscription = undefined; });
    return attempt;
  }
  async function stopListeners() {
    const active = stops.filter(hook => !hook.closed);
    const results = await Promise.allSettled(active.map(async hook => { await hook.stop(); hook.closed = true; registered.delete(hook.name); }));
    if (results.some(result => result.status === "rejected")) throw Error("ERR_MAIN_PUSH_LISTENER_CLEANUP");
  }
  type Entry = NonNullable<ReturnType<typeof pending.get>>;
  function finish(entry: Entry) {
    if (!entry.durable || !entry.reply || pending.get(entry.request.requestId) !== entry) return;
    pending.delete(entry.request.requestId); clearTimeout(entry.poll); entry.resolve(entry.reply);
  }
  function fail(entry: Entry, code: string) {
    if (pending.get(entry.request.requestId) !== entry) return;
    pending.delete(entry.request.requestId); clearTimeout(entry.poll); entry.reject(Error(code));
  }
  async function checkRun(entry: Entry) {
    if (!entry.runId || entry.checking || closed || pending.get(entry.request.requestId) !== entry) return;
    entry.checking = true; clearTimeout(entry.poll);
    try {
      const run = await options.invoke<TaskRun | null>("get_task_run", { id: entry.runId });
      if (pending.get(entry.request.requestId) !== entry) return;
      const input = run?.input as Record<string, unknown> | undefined;
      if (!run || run.id !== entry.runId || run.initiator.clientId !== "atools-ui"
        || input?.requestId !== entry.request.requestId || input.runnerId !== entry.request.runnerId) { fail(entry, "ERR_MAIN_PUSH_TASK_IDENTITY"); return; }
      if (run.status === "succeeded") { entry.durable = true; finish(entry); }
      else if (["failed", "cancelled", "partial"].includes(run.status)) fail(entry, "ERR_MAIN_PUSH_NATIVE_TERMINAL");
      else entry.poll = setTimeout(() => { void checkRun(entry); }, 200);
    } catch { fail(entry, "ERR_MAIN_PUSH_TASK_STATE"); }
    finally { entry.checking = false; }
  }
  async function receive(dispatch: MainPushDispatch) {
    const entry = pending.get(dispatch?.requestId);
    if (closed || !entry || entry.running || dispatch.runnerId !== entry.request.runnerId || dispatch.operation !== entry.request.operation
      || dispatch.candidate?.pluginId !== entry.request.candidate.pluginId || dispatch.candidate.featureCode !== entry.request.candidate.featureCode
      || dispatch.candidate.codeRevision !== entry.request.candidate.codeRevision || typeof dispatch.ticket !== "string"
      || dispatch.action?.plugin_id !== entry.request.candidate.pluginId || dispatch.action.feature_code !== entry.request.candidate.featureCode) return;
    entry.running = true; entry.ticket = dispatch.ticket;
    if (entry.waiting) void setWaiting(entry.request.runnerId, true);
    const started = performance.now();
    let reply: MainPushReply;
    try { reply = await entry.request.execute(dispatch); }
    catch { reply = { requestId: dispatch.requestId, outcome: "failed", error: "ERR_MAIN_PUSH_EXECUTION" }; }
    if (closed || pending.get(dispatch.requestId) !== entry) return;
    try {
      await options.invoke("complete_plugin_main_push", { ticket: dispatch.ticket, requestId: dispatch.requestId,
        outcome: dispatch.operation === "query" && reply.outcome === "ready" ? "handled" : reply.outcome,
        rowCount: reply.rows?.length ?? 0, durationMs: Math.min(3600000, Math.max(0, Math.round(performance.now() - started))) });
      if (pending.get(dispatch.requestId) !== entry) return;
      entry.reply = reply; finish(entry);
    } catch { fail(entry, "ERR_MAIN_PUSH_COMPLETION"); }
  }
  async function run(request: Request) {
    if (closed || pending.has(request.requestId)) throw Error("ERR_MAIN_PUSH_CLOSED");
    return new Promise<MainPushReply>((resolve, reject) => {
      const entry: Entry = { request, resolve, reject, waiting: false, running: false };
      pending.set(request.requestId, entry);
      void connect().then(() => {
        if (closed || pending.get(request.requestId) !== entry) return;
        return options.invoke<Record<string, unknown>>("run_plugin_main_push", { requestId: request.requestId, runnerId: request.runnerId,
        pluginId: request.candidate.pluginId, featureCode: request.candidate.featureCode, commandType: request.candidate.commandType,
        codeRevision: request.candidate.codeRevision, operation: request.operation, inputBytes: request.inputBytes, queryGeneration: request.generation,
      }).then(result => {
        if (pending.get(request.requestId) !== entry) return;
        if (result && ["failed", "cancelled", "partial"].includes(String(result.status))) { fail(entry, "ERR_MAIN_PUSH_NATIVE_TERMINAL"); return; }
        if (result?.status === "succeeded") { entry.durable = true; finish(entry); return; }
        if (result?.permission_required === true && typeof result.runId === "string") { entry.runId = result.runId; void checkRun(entry); return; }
        // No native dispatch means no original callback ran. Never fabricate rows.
        fail(entry, "ERR_MAIN_PUSH_NOT_DISPATCHED");
      });
      }).catch(() => { if (pending.get(request.requestId) === entry) { pending.delete(request.requestId); reject(Error("ERR_MAIN_PUSH_NATIVE")); } });
    });
  }
  async function cancel(requestId: string) {
    const entry = pending.get(requestId); if (!entry) return;
    pending.delete(requestId); clearTimeout(entry.poll); entry.resolve({ requestId, outcome: "superseded" });
    await options.invoke("cancel_plugin_main_push", { requestId }).catch(() => undefined);
  }
  async function setWaiting(runnerId: string, waiting: boolean) {
    for (const [requestId, entry] of pending) if (entry.request.runnerId === runnerId) {
      entry.waiting = waiting;
      if (entry.ticket) await options.invoke("set_plugin_main_push_waiting", { requestId, ticket: entry.ticket, waiting }).catch(() => undefined);
    }
  }
  function close() {
    if (closeOperation) return closeOperation;
    closed = true;
    const operation = (async () => {
      await Promise.allSettled([...pending.keys()].map(requestId => cancel(requestId)));
      await subscription?.catch(() => undefined);
      await stopListeners();
    })();
    closeOperation = operation;
    void operation.then(() => { if (closeOperation === operation) closeOperation = undefined; }, () => { if (closeOperation === operation) closeOperation = undefined; });
    return operation;
  }
  return { run, cancel, setWaiting, closeRunner: (runnerId: string) => options.invoke("close_plugin_main_push_runner", { runnerId }), close };
}
