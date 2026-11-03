import type { FeatureAction, TaskRun } from "./types";
import { isCanonicalPluginBackgroundSessionId, isPluginBackgroundCandidate, isPluginBackgroundDispatch, matchesPluginBackgroundTaskOutput,
  matchesPluginBackgroundTaskRun, samePluginBackgroundBootDescriptor } from "./pluginBackgroundSessionProtocol";
import type { PluginBackgroundCandidate, PluginBackgroundDispatch, PluginBackgroundOperation, PluginBackgroundSessionView } from "./pluginBackgroundSessionProtocol";
export type { PluginBackgroundCandidate, PluginBackgroundDispatch, PluginBackgroundOperation, PluginBackgroundSessionView } from "./pluginBackgroundSessionProtocol";
type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type OperationState = { requestId: string; operation: PluginBackgroundOperation; completion: Deferred<void>; ticket?: string;
  runId?: string; tool?: string; checking: boolean; dirty: boolean; completed: boolean; cleanup?: Promise<void>;
  waiting?: boolean; waitingChain?: Promise<void> };
type Session = PluginBackgroundSessionView & { operation?: OperationState; ready: Deferred<void>; cleanupPromise?: Promise<CleanupResult>;
  cleanupFailure?: unknown; cleanupFailed: boolean };
type RunReply = { runId: string; tool: string; status: string; permission_required?: boolean };
type CleanupResult = { succeeded: true } | { succeeded: false; reason: unknown };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export function createPluginBackgroundSessionPool(options: {
  invoke: Invoke; listen: Listen; changed: (sessions: PluginBackgroundSessionView[]) => void;
  closePanelStrict: (sessionId: string, retry?: boolean) => Promise<void>;
  activatePanel: (sessionId: string, action: FeatureAction) => Promise<boolean> | boolean;
  setPanelVisible: (sessionId: string, visible: boolean) => void;
  releaseTransientForPanel?: (preservedRunnerId?: string) => Promise<void>;
  preservedMainPushRunnerId?: () => string | undefined;
  onInvalidated?: (pluginId: string | null) => void; uuid?: () => string;
}) {
  const sessions = new Map<string, Session>();
  const attemptedPlugins = new Set<string>();
  const foregrounding = new Map<string, { action: FeatureAction; token: number; completion: Promise<boolean> }>();
  const foregroundTokens = new Map<string, number>();
  const activatedActions = new Map<string, FeatureAction>();
  const stops: Array<() => void> = [];
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  let closed = false, startupAttempts = 0, startupRunning = false, discoveryRequested = false, startupSuppressed = false;
  let connection: Promise<void> | undefined;

  function toView(session: Session): PluginBackgroundSessionView {
    return { sessionId: session.sessionId, pluginId: session.pluginId, pluginName: session.pluginName,
      codeRevision: session.codeRevision, action: session.action, stage: session.stage,
      visible: session.visible, mountReady: session.mountReady };
  }

  function publish() { options.changed([...sessions.values()].map(toView)); }

  function isCurrent(session: Session, operation?: OperationState) {
    return !closed && sessions.get(session.sessionId) === session && !session.cleanupFailed && !session.cleanupPromise
      && (!operation || session.operation === operation && !operation.cleanup);
  }
  function errorCode(error: unknown) { return error instanceof Error ? error.message : String(error); }

  function invalidateForegroundExcept(pluginId?: string) {
    for (const [id, token] of foregroundTokens) if (id !== pluginId) foregroundTokens.set(id, token + 1);
    for (const id of activatedActions.keys()) if (id !== pluginId) activatedActions.delete(id);
  }

  async function emergencyClose(session: Session, retry = false): Promise<CleanupResult> {
    const tasks: Promise<unknown>[] = [];
    if (sessions.get(session.sessionId) === session) {
      try { tasks.push(Promise.resolve(options.closePanelStrict(session.sessionId, retry))); }
      catch (error) { tasks.push(Promise.reject(error)); }
    }
    try { tasks.push(options.invoke("close_plugin_background_session", { sessionId: session.sessionId })); }
    catch (error) { tasks.push(Promise.reject(error)); }
    const results = await Promise.allSettled(tasks);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") {
      console.warn("[PluginBackground] emergency teardown was incomplete:", failure.reason);
      return { succeeded: false, reason: failure.reason };
    }
    return { succeeded: true };
  }

  function closeOwnedResources(session: Session, retry = false): Promise<CleanupResult> {
    if (session.cleanupPromise) return session.cleanupPromise;
    const cleanup = emergencyClose(session, retry).then(result => {
      if (session.cleanupPromise === cleanup) session.cleanupPromise = undefined;
      return result;
    });
    session.cleanupPromise = cleanup;
    return cleanup;
  }

  function setCleanupFailed(session: Session, reason: unknown) {
    if (sessions.get(session.sessionId) !== session) return;
    session.cleanupFailed = true;
    session.cleanupFailure = reason;
    session.stage = "cleanup-failed";
    session.visible = false;
    activatedActions.delete(session.pluginId);
    foregroundTokens.set(session.pluginId, (foregroundTokens.get(session.pluginId) ?? 0) + 1);
    try { options.setPanelVisible(session.sessionId, false); } catch { /* teardown must still run */ }
    publish();
  }

  function removeSession(session: Session): boolean {
    if (sessions.get(session.sessionId) !== session) return false;
    sessions.delete(session.sessionId);
    publish();
    return true;
  }

  async function failOperation(session: Session, operation: OperationState, reason: unknown) {
    if (operation.cleanup) return operation.cleanup;
    if (!isCurrent(session, operation)) return;
    operation.cleanup = (async () => {
      session.ready.reject(reason);
      session.visible = false;
      activatedActions.delete(session.pluginId);
      foregroundTokens.set(session.pluginId, (foregroundTokens.get(session.pluginId) ?? 0) + 1);
      try { options.setPanelVisible(session.sessionId, false); } catch { /* strict resource close still proceeds */ }
      publish();
      if (operation.ticket && !operation.completed) {
        operation.completed = true;
        await options.invoke("complete_plugin_background", { requestId: operation.requestId, ticket: operation.ticket,
          sessionId: session.sessionId, outcome: "failed" }).catch(() => undefined);
      }
      await options.invoke("cancel_plugin_background", { requestId: operation.requestId }).catch(() => undefined);
      session.stage = "stopping";
      const cleanup = await closeOwnedResources(session);
      if (cleanup.succeeded) removeSession(session);
      else setCleanupFailed(session, cleanup.reason);
      // A failed owner remains in the snapshot and keeps its resident slot until
      // an explicit cleanup retry confirms both panel and native owner closure.
      operation.completion.reject(cleanup.succeeded ? reason : cleanup.reason);
    })();
    return operation.cleanup;
  }

  async function checkTaskRun(session: Session, operation: OperationState) {
    if (!isCurrent(session, operation) || !operation.runId) return;
    if (operation.checking) { operation.dirty = true; return; }
    operation.checking = true;
    try {
      do {
        operation.dirty = false;
        const run = await options.invoke<TaskRun | null>("get_task_run", { id: operation.runId });
        if (!isCurrent(session, operation)) return;
        if (!run || !matchesPluginBackgroundTaskRun(run, session, operation)) { await failOperation(session, operation, Error("ERR_PLUGIN_BACKGROUND_TASK_IDENTITY")); return; }
        if (run.status === "succeeded") {
          if (!matchesPluginBackgroundTaskOutput(run, session, operation)) { await failOperation(session, operation, Error("ERR_PLUGIN_BACKGROUND_TASK_OUTPUT")); return; }
          if (operation.operation === "start") session.stage = "ready";
          operation.completion.resolve();
          publish();
          if (operation.operation === "stop") removeSession(session);
          return;
        }
        if (run.status === "failed" || run.status === "cancelled" || run.status === "partial") {
          await failOperation(session, operation, Error("ERR_PLUGIN_BACKGROUND_TASK_TERMINAL")); return;
        }
      } while (operation.dirty && isCurrent(session, operation));
    } catch (error) {
      await failOperation(session, operation, error);
    } finally { operation.checking = false; }
  }

  async function complete(session: Session, operation: OperationState, outcome: "ready" | "closed" | "failed") {
    if (!isCurrent(session, operation) || !operation.ticket || operation.completed) return;
    await options.invoke("complete_plugin_background", { requestId: operation.requestId, ticket: operation.ticket,
      sessionId: session.sessionId, outcome });
    operation.completed = true;
  }

  async function receiveDispatch(input: unknown) {
    if (!isPluginBackgroundDispatch(input)) return;
    const dispatch = input;
    const session = sessions.get(dispatch.sessionId), operation = session?.operation;
    if (!session || !isCurrent(session, operation) || !operation || operation.requestId !== dispatch.requestId || operation.operation !== dispatch.operation
      || session.pluginId !== dispatch.pluginId || session.codeRevision !== dispatch.codeRevision || operation.ticket
      || !samePluginBackgroundBootDescriptor(session.action, dispatch.action)
      || dispatch.action.feature_code !== "" || dispatch.action.payload != null || dispatch.action.auto_detach !== false) return;
    operation.ticket = dispatch.ticket;
    if (dispatch.operation === "start") {
      session.stage = "loading"; session.mountReady = false; publish();
      try {
        await options.releaseTransientForPanel?.(options.preservedMainPushRunnerId?.());
        if (!isCurrent(session, operation)) return;
        session.mountReady = true; publish();
        await session.ready.promise;
        if (!isCurrent(session, operation)) return;
        await complete(session, operation, "ready");
        void checkTaskRun(session, operation);
      } catch (error) {
        await failOperation(session, operation, error);
      }
      return;
    }
    session.stage = "stopping"; publish();
    try {
      await options.closePanelStrict(session.sessionId, false);
      if (!isCurrent(session, operation)) return;
      await complete(session, operation, "closed");
      void checkTaskRun(session, operation);
    } catch (error) { await failOperation(session, operation, error); }
  }

  async function beginOperation(session: Session, operation: PluginBackgroundOperation) {
    const state: OperationState = { requestId: uuid(), operation, completion: deferred<void>(), checking: false, dirty: false, completed: false };
    session.operation = state;
    if (operation === "stop") session.stage = "stopping";
    publish();
    void options.invoke<RunReply>("run_plugin_background", { requestId: state.requestId, sessionId: session.sessionId,
      pluginId: session.pluginId, codeRevision: session.codeRevision, operation })
      .then(reply => {
        if (!isCurrent(session, state)) return;
        if (!reply || typeof reply.runId !== "string" || typeof reply.tool !== "string"
          || !reply.tool.startsWith("atools.host.plugin-background.") || !reply.tool.endsWith(`.${operation}`)
          || !["created", "awaiting_permission", "running", "succeeded", "failed", "cancelled", "partial"].includes(reply.status)
          || (reply.permission_required !== undefined && typeof reply.permission_required !== "boolean")) {
          void failOperation(session, state, Error("ERR_PLUGIN_BACKGROUND_RUN_REPLY")); return;
        }
        state.runId = reply.runId; state.tool = reply.tool;
        void checkTaskRun(session, state);
      }).catch(error => { void failOperation(session, state, error); });
    return state.completion.promise;
  }

  async function startCandidate(candidate: PluginBackgroundCandidate) {
    const sessionId = uuid();
    if (!isCanonicalPluginBackgroundSessionId(sessionId) || sessions.has(sessionId)) {
      console.warn(`[PluginBackground] startup skipped for ${candidate.pluginId}: invalid or occupied session identity`);
      return;
    }
    const session: Session = { sessionId, pluginId: candidate.pluginId, pluginName: candidate.pluginName,
      codeRevision: candidate.codeRevision, action: candidate.action, stage: "admitting", visible: false,
      mountReady: false, ready: deferred<void>(), cleanupFailed: false };
    sessions.set(session.sessionId, session); publish();
    try { await beginOperation(session, "start"); }
    catch (error) { console.warn(`[PluginBackground] startup failed for ${candidate.pluginId}:`, errorCode(error)); }
  }

  async function discover() {
    discoveryRequested = true;
    if (startupRunning || closed) return;
    startupRunning = true;
    try {
      while (discoveryRequested && startupAttempts < 2 && !startupSuppressed && !closed) {
        discoveryRequested = false;
        const candidates = await options.invoke<PluginBackgroundCandidate[]>("list_plugin_background_candidates");
        if (!Array.isArray(candidates) || candidates.length > 128) throw Error("ERR_PLUGIN_BACKGROUND_CANDIDATES");
        for (const candidate of candidates) {
          if (startupAttempts >= 2 || startupSuppressed || closed) break;
          if (!isPluginBackgroundCandidate(candidate) || attemptedPlugins.has(candidate.pluginId)) continue;
          attemptedPlugins.add(candidate.pluginId); startupAttempts += 1;
          await startCandidate(candidate);
        }
      }
    } catch (error) { console.warn("[PluginBackground] candidate discovery failed:", errorCode(error)); }
    finally { startupRunning = false; if (discoveryRequested && startupAttempts < 2 && !startupSuppressed && !closed) void discover(); }
  }

  async function invalidate(pluginId: string | null) {
    const affected = [...sessions.values()].filter(session => pluginId === null || session.pluginId === pluginId);
    for (const session of affected) {
      const operation = session.operation;
      if (operation) {
        await failOperation(session, operation, Error("ERR_PLUGIN_BACKGROUND_INVALIDATED"));
      } else {
        session.visible = false;
        session.stage = "stopping";
        try { options.setPanelVisible(session.sessionId, false); } catch { /* strict resource close still proceeds */ }
        const cleanup = await closeOwnedResources(session);
        if (cleanup.succeeded) removeSession(session);
        else setCleanupFailed(session, cleanup.reason);
      }
    }
    if (affected.length) options.onInvalidated?.(pluginId);
  }

  function connect(): Promise<void> {
    if (connection) return connection;
    connection = (async () => {
    const attach = async <T>(eventName: string, receive: (event: { payload: T }) => void) => {
      const unlisten = await options.listen<T>(eventName, receive);
      if (closed) unlisten(); else stops.push(unlisten);
    };
    await Promise.all([
      attach<PluginBackgroundDispatch>("plugin-background-dispatch", event => { void receiveDispatch(event.payload); }),
      attach<{ pluginId: string | null }>("plugin-background-invalidated", event => {
        const pluginId = event.payload?.pluginId;
        if (pluginId === null || typeof pluginId === "string") void invalidate(pluginId);
      }),
      attach<string>("task-run-updated", event => {
        for (const session of sessions.values()) if (session.operation?.runId === event.payload) void checkTaskRun(session, session.operation);
      }),
      attach<unknown>("builtin-plugins-loaded", () => { void discover(); }),
    ]);
    if (!closed) await discover();
    })().catch(error => { connection = undefined; throw error; });
    return connection;
  }

  async function cancelPending(session: Session) {
    if (!isCurrent(session)) return;
    const operation = session.operation;
    if (operation && !operation.ticket && operation.operation === "start") {
      await failOperation(session, operation, Error("ERR_PLUGIN_BACKGROUND_SUPERSEDED"));
    }
  }

  async function foreground(action: FeatureAction): Promise<boolean> {
    startupSuppressed = true;
    invalidateForegroundExcept(action.plugin_id);
    const existing = foregrounding.get(action.plugin_id);
    if (existing && existing.token === foregroundTokens.get(action.plugin_id) && existing.action === action) return existing.completion;
    const session = [...sessions.values()].find(item => item.pluginId === action.plugin_id);
    for (const other of sessions.values()) {
      if (other !== session && other.operation?.operation === "start" && !other.operation.ticket) {
        void cancelPending(other).catch(error => console.warn("[PluginBackground] pending startup cancellation failed:", error));
      }
    }
    for (const other of sessions.values()) if (other.visible && other !== session) {
      other.visible = false; activatedActions.delete(other.pluginId); options.setPanelVisible(other.sessionId, false); publish();
    }
    if (!session) return false;
    if (session.visible && activatedActions.get(session.pluginId) === action) return true;
    const operation = session.operation;
    const token = (foregroundTokens.get(action.plugin_id) ?? 0) + 1;
    foregroundTokens.set(action.plugin_id, token);
    const isLatest = () => foregroundTokens.get(action.plugin_id) === token;
    const completion = (async () => {
      if (session.stage === "admitting" && !operation?.ticket) { await cancelPending(session); return false; }
        if (!operation || operation.operation !== "start") return false;
      try {
        if (session.stage === "loading") {
          await session.ready.promise;
          if (!isCurrent(session) || !isLatest()) return false;
          // Frame readiness is only a receipt. Do not expose the cached panel until
          // the native postcheck has made the admission TaskRun terminal-success.
          await operation.completion.promise;
        }
        if (!isCurrent(session) || !isLatest() || session.stage !== "ready") return false;
        await options.releaseTransientForPanel?.(options.preservedMainPushRunnerId?.());
        if (!isCurrent(session) || !isLatest()) return false;
        const result = await options.invoke<{ valid: boolean }>("verify_plugin_background_session", {
          sessionId: session.sessionId, pluginId: session.pluginId, codeRevision: session.codeRevision,
        });
        if (!isCurrent(session) || !isLatest()) return false;
        if (result?.valid !== true) { await invalidate(session.pluginId); return false; }
        if (!await options.activatePanel(session.sessionId, action)) { await invalidate(session.pluginId); return false; }
        if (!isCurrent(session)) return false;
        activatedActions.set(session.pluginId, action);
        session.visible = true; publish(); return true;
      } catch { if (isCurrent(session)) await invalidate(session.pluginId); return false; }
    })();
    foregrounding.set(action.plugin_id, { action, token, completion });
    try { return await completion; }
    finally { if (foregrounding.get(action.plugin_id)?.completion === completion) foregrounding.delete(action.plugin_id); }
  }

  function hideAllExcept(pluginId?: string) {
    invalidateForegroundExcept(pluginId);
    let changed = false;
    for (const session of sessions.values()) if (session.visible && session.pluginId !== pluginId && session.stage !== "stopping") {
      session.visible = false; activatedActions.delete(session.pluginId); options.setPanelVisible(session.sessionId, false); changed = true;
    }
    if (changed) publish();
  }

  async function stop(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || !isCurrent(session) || session.stage !== "ready") return;
    session.visible = false;
    activatedActions.delete(session.pluginId);
    foregroundTokens.set(session.pluginId, (foregroundTokens.get(session.pluginId) ?? 0) + 1);
    options.setPanelVisible(session.sessionId, false);
    publish();
    try { await beginOperation(session, "stop"); }
    catch (error) { console.warn(`[PluginBackground] stop failed for ${session.pluginId}:`, errorCode(error)); }
  }

  function setWaiting(sessionId: string, waiting: boolean) {
    const session = sessions.get(sessionId), operation = session?.operation;
    if (!session || !operation || !isCurrent(session, operation) || !operation.ticket || operation.completed || operation.operation !== "start") return;
    if (operation.waiting === waiting) return operation.waitingChain;
    operation.waiting = waiting;
    const previous = operation.waitingChain ?? Promise.resolve();
    operation.waitingChain = previous.then(async () => {
      if (!isCurrent(session, operation) || operation.completed || !operation.ticket) return;
      await options.invoke("set_plugin_background_waiting", { requestId: operation.requestId, ticket: operation.ticket, waiting });
    }).catch(error => { void failOperation(session, operation, error); });
    return operation.waitingChain;
  }

  async function panelFailed(sessionId: string, error: unknown) {
    const session = sessions.get(sessionId);
    if (!session || !isCurrent(session)) return;
    session.ready.reject(error);
  }

  async function retryCleanup(sessionId: string): Promise<boolean> {
    const session = sessions.get(sessionId);
    if (!session || !session.cleanupFailed) return false;
    const cleanup = await closeOwnedResources(session, true);
    if (sessions.get(sessionId) !== session) return !sessions.has(sessionId);
    if (!cleanup.succeeded) {
      setCleanupFailed(session, cleanup.reason);
      return false;
    }
    session.cleanupFailure = undefined;
    session.cleanupFailed = false;
    return removeSession(session);
  }

  let closeTask: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closeTask) return closeTask;
    const firstClose = !closed;
    if (firstClose) {
      closed = true;
      for (const stop of stops.splice(0)) { try { stop(); } catch { /* continue releasing owned sessions */ } }
    }
    const task = (async () => {
      let hasFailure = false;
      let firstFailure: unknown;
      for (const session of [...sessions.values()]) {
        if (sessions.get(session.sessionId) !== session) continue;
        const operation = session.operation;
        session.ready.reject(Error("ERR_PLUGIN_BACKGROUND_HOST_CLOSED"));
        session.visible = false;
        activatedActions.delete(session.pluginId);
        foregroundTokens.set(session.pluginId, (foregroundTokens.get(session.pluginId) ?? 0) + 1);
        try { options.setPanelVisible(session.sessionId, false); } catch { /* strict resource close still proceeds */ }
        publish();
        if (firstClose && operation && !operation.completed) {
          await options.invoke("cancel_plugin_background", { requestId: operation.requestId }).catch(() => undefined);
        }

        if (operation?.cleanup && !session.cleanupFailed) {
          await operation.cleanup;
          if (sessions.get(session.sessionId) !== session) continue;
          if (session.cleanupFailed) {
            if (!hasFailure) firstFailure = session.cleanupFailure;
            hasFailure = true;
            operation.completion.reject(session.cleanupFailure);
            continue;
          }
        }

        session.stage = "stopping";
        const cleanup = await closeOwnedResources(session, session.cleanupFailed);
        if (cleanup.succeeded) removeSession(session);
        else {
          setCleanupFailed(session, cleanup.reason);
          if (!hasFailure) firstFailure = cleanup.reason;
          hasFailure = true;
        }
        operation?.completion.reject(cleanup.succeeded ? Error("ERR_PLUGIN_BACKGROUND_HOST_CLOSED") : cleanup.reason);
      }
      publish();
      if (hasFailure) throw firstFailure;
    })();
    const shared = task.finally(() => { if (closeTask === shared) closeTask = undefined; });
    closeTask = shared;
    void shared.catch(() => undefined);
    return shared;
  }

  return { connect, discover, foreground, hideAllExcept, stop, setWaiting, panelReady: (sessionId: string) => {
    const session = sessions.get(sessionId); if (session && isCurrent(session) && session.stage === "loading") session.ready.resolve();
  }, panelFailed, close, retryCleanup, snapshot: () => [...sessions.values()].map(toView) };
}
