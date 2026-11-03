import {
  requestPluginWorkerShutdown,
  type PluginWorkerShutdownResult,
} from "./pluginWorkerShutdown";

export type PluginWorkerDocumentLifecycleResult = PluginWorkerShutdownResult;
export type PluginWorkerDocumentLifecycleOptions = {
  getSource: () => Window | null;
  shutdown?: typeof requestPluginWorkerShutdown;
  randomUUID?: () => string;
};
export type PluginWorkerDocumentLifecycle = {
  /** Assign a new UUID scope to the next document generation. */
  freshScope: () => string;
  /** Forget the current document scope without affecting already captured shutdowns. */
  clearScope: () => void;
  /** Shut down workers belonging to the source and scope captured at call time. */
  shutdown: () => Promise<PluginWorkerDocumentLifecycleResult>;
  /** Abort all in-flight shutdown handshakes and wait for their bookkeeping to drain. */
  cancel: () => Promise<void>;
  readonly pending: number;
  readonly blocking: boolean;
};

const emptyResult = (): PluginWorkerDocumentLifecycleResult => ({ requested: 0, acknowledged: 0, timedOut: false });
const failedResult = (): PluginWorkerDocumentLifecycleResult => ({ requested: 1, acknowledged: 0, timedOut: true });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeResult(value: PluginWorkerShutdownResult): PluginWorkerShutdownResult {
  if (!value || !Number.isSafeInteger(value.requested) || value.requested < 0
    || !Number.isSafeInteger(value.acknowledged) || value.acknowledged < 0
    || value.acknowledged > value.requested || typeof value.timedOut !== "boolean") return failedResult();
  return { requested: value.requested, acknowledged: value.acknowledged, timedOut: value.timedOut };
}

/**
 * Tracks one opaque iframe document generation at a time. Shutdown handshakes are
 * keyed by source and scope so a late ACK or completion cannot dispose a newer page.
 */
export function createPluginWorkerDocumentLifecycle(
  options: PluginWorkerDocumentLifecycleOptions,
): PluginWorkerDocumentLifecycle {
  const requestShutdown = options.shutdown ?? requestPluginWorkerShutdown;
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  let currentScope: string | undefined;
  let activePending = 0;
  const activeControllers = new Set<AbortController>();
  const flights = new Map<Window, Map<string, Promise<PluginWorkerDocumentLifecycleResult>>>();

  function freshScope() {
    const scope = randomUUID();
    if (typeof scope !== "string" || !UUID_V4.test(scope)) throw new Error("Unable to create a plugin worker document scope");
    currentScope = scope;
    return scope;
  }

  function clearScope() {
    currentScope = undefined;
  }

  function scopeFlights(source: Window) {
    let byScope = flights.get(source);
    if (!byScope) {
      byScope = new Map();
      flights.set(source, byScope);
    }
    return byScope;
  }

  function shutdown(): Promise<PluginWorkerDocumentLifecycleResult> {
    const scope = currentScope;
    let source: Window | null;
    try {
      source = options.getSource();
    } catch {
      return Promise.resolve(failedResult());
    }
    if (!source || !scope) return Promise.resolve(emptyResult());

    const byScope = scopeFlights(source);
    const existing = byScope.get(scope);
    if (existing) return existing;

    const controller = new AbortController();
    activeControllers.add(controller);
    activePending += 1;
    let removeAbortListener = () => {};
    const aborted = new Promise<PluginWorkerDocumentLifecycleResult>(resolve => {
      const onAbort = () => resolve(failedResult());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });

    let flight!: Promise<PluginWorkerDocumentLifecycleResult>;
    let operation: Promise<PluginWorkerDocumentLifecycleResult>;
    try {
      operation = Promise.resolve(requestShutdown([{ source, scopeId: scope }], {
        signal: controller.signal,
      })).then(normalizeResult, () => failedResult());
    } catch {
      operation = Promise.resolve(failedResult());
    }
    flight = Promise.race([operation, aborted]).finally(() => {
      removeAbortListener();
      activeControllers.delete(controller);
      activePending = Math.max(0, activePending - 1);
      if (byScope.get(scope) === flight) byScope.delete(scope);
      if (byScope.size === 0) flights.delete(source);
    });
    byScope.set(scope, flight);
    return flight;
  }

  async function cancel() {
    const pendingFlights = [...flights.values()].flatMap(byScope => [...byScope.values()]);
    for (const controller of activeControllers) controller.abort();
    await Promise.all(pendingFlights);
  }

  return {
    freshScope,
    clearScope,
    shutdown,
    cancel,
    get pending() { return activePending; },
    get blocking() { return activePending > 0; },
  };
}
