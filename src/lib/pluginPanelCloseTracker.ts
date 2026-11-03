type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type FailedClose = { command: string; args?: Record<string, unknown>; invoke: Invoke; error: unknown; retryable: boolean };

function trackedCloseFailure(code: string, cause: unknown): Error {
  const failure = new Error(code);
  Object.defineProperties(failure, {
    code: { value: code, enumerable: true },
    cause: { value: cause, enumerable: false },
  });
  return failure;
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("invalid JSON value");
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) throw new Error("invalid JSON array");
    if (Object.keys(value).length !== value.length) throw new Error("sparse JSON array");
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error("sparse JSON array");
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid JSON array property");
      assertJsonValue(descriptor.value, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid JSON object");
    if (Object.getOwnPropertySymbols(value).length) throw new Error("symbol JSON key");
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid JSON property");
      assertJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function freezeJsonValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeJsonValue(child);
  Object.freeze(value);
}

function snapshotCloseArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (args === undefined) return undefined;
  assertJsonValue(args);
  const encoded = JSON.stringify(args);
  if (typeof encoded !== "string") throw new Error("invalid JSON arguments");
  const snapshot: unknown = JSON.parse(encoded);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("invalid JSON arguments");
  freezeJsonValue(snapshot);
  return snapshot as Record<string, unknown>;
}

/** Captures raw owner-close failures, including controllers that intentionally swallow them. */
export function createPluginPanelCloseTracker() {
  let closing = false, retrying: Promise<void> | undefined, budgetFailure: Error | undefined;
  const pending = new Set<Promise<void>>(), failed: FailedClose[] = [];
  const trackedCloseCommands = new Set([
    "close_plugin_page", "close_host_clipboard", "close_plugin_display", "close_plugin_data", "close_plugin_paths",
    "close_plugin_dialogs", "close_plugin_file_drag", "close_plugin_secret_storage",
    "close_plugin_resources", "close_plugin_file_drop", "close_plugin_ai", "close_plugin_node_session", "close_legacy_node",
    "close_plugin_window_source", "cancel_plugin_browser_window_intent",
  ]);

  function observe(invoke: Invoke, command: string, args?: Record<string, unknown>): Promise<unknown> {
    const trackedClose = trackedCloseCommands.has(command);
    let retryArgs: Record<string, unknown> | undefined;
    let snapshotFailed = false;
    if (trackedClose) {
      try { retryArgs = snapshotCloseArgs(args); }
      catch { snapshotFailed = true; }
    }
    let raw: Promise<unknown>;
    try { raw = Promise.resolve(invoke(command, args)); }
    catch (error) { raw = Promise.reject(error); }
    if (!trackedClose) return raw;
    if (pending.size + failed.length >= 32) {
      budgetFailure ??= new Error("ERR_ATOOLS_PLUGIN_CLEANUP_BUDGET");
      const overflowCall = raw.then(value => value, reason => {
        throw trackedCloseFailure("ERR_ATOOLS_PLUGIN_CLEANUP_BUDGET", reason);
      });
      void overflowCall.catch(() => {});
      return overflowCall;
    }
    const record: FailedClose = {
      command, ...(snapshotFailed ? {} : { args: retryArgs }), invoke,
      error: undefined, retryable: !snapshotFailed,
    };
    const trackedCall = raw.then(value => value, reason => {
      const failure = trackedCloseFailure(
        snapshotFailed ? "ERR_ATOOLS_PLUGIN_CLEANUP_ARGS_UNSNAPSHOTTABLE" : "ERR_ATOOLS_PLUGIN_CLOSE_FAILED",
        reason,
      );
      record.error = failure;
      failed.push(record);
      throw failure;
    });
    let tracked!: Promise<void>;
    tracked = trackedCall.then(() => undefined, () => undefined).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return trackedCall;
  }

  function wrap(invoke: Invoke): Invoke {
    return <T>(command: string, args?: Record<string, unknown>) => observe(invoke, command, args) as Promise<T>;
  }

  async function waitForPending() {
    while (pending.size) await Promise.all([...pending]);
  }

  function throwIfFailed() {
    if (failed.length) throw failed[0].error;
    if (budgetFailure) throw budgetFailure;
  }

  async function drain(): Promise<void> {
    closing = true;
    await waitForPending();
    throwIfFailed();
  }

  function retryFailed(): Promise<void> {
    if (!closing) return Promise.reject(new Error("ERR_ATOOLS_PLUGIN_CLEANUP_NOT_STARTED"));
    if (retrying) return retrying;
    retrying = (async () => {
      closing = true;
      await waitForPending();
      const batch = failed.filter(item => item.retryable);
      const results = await Promise.allSettled(batch.map(item => observeRetry(item)));
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        const result = results[index];
        if (result.status === "fulfilled") {
          const at = failed.indexOf(item);
          if (at >= 0) failed.splice(at, 1);
        } else item.error = result.reason;
      }
      await waitForPending();
      throwIfFailed();
    })();
    const current = retrying;
    void current.finally(() => { if (retrying === current) retrying = undefined; }).catch(() => {});
    return current;
  }

  function observeRetry(item: FailedClose) {
    let raw: Promise<unknown>;
    try { raw = Promise.resolve(item.invoke(item.command, item.args)); }
    catch (error) { raw = Promise.reject(error); }
    return raw.catch(reason => {
      const failure = trackedCloseFailure("ERR_ATOOLS_PLUGIN_CLOSE_FAILED", reason);
      item.error = failure;
      throw failure;
    });
  }

  return {
    wrap,
    begin: () => { closing = true; },
    drain,
    retryFailed,
    hasFailedError: (error: unknown) => failed.some(item => item.error === error),
  };
}

export async function closePluginPanelResourcesStrict(
  actions: readonly (() => unknown | Promise<unknown>)[], drain: () => Promise<void>,
  onActionFailures?: (errors: readonly unknown[]) => void,
) {
  const results = await Promise.allSettled(actions.map(action => {
    try { return Promise.resolve(action()); }
    catch (error) { return Promise.reject(error); }
  }));
  let drainFailed = false, drainFailure: unknown;
  try { await drain(); } catch (error) { drainFailed = true; drainFailure = error; }
  const actionFailures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  onActionFailures?.(actionFailures);
  if (actionFailures.length) throw actionFailures[0];
  if (drainFailed) throw drainFailure;
}
