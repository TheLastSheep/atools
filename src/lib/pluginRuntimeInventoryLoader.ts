import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { getPluginRuntimeControl, type PluginRuntimeControl } from "./pluginRuntimeControl";
import { mergePluginRuntimeSessions, parsePluginRuntimeSnapshot, parseRuntimeSession,
  type RuntimeSession, type RuntimeSnapshot } from "./pluginRuntimeInventory";

export type PluginRuntimeInventoryReadPhase = "idle" | "loading" | "ready" | "error";
export type PluginRuntimeStopResult = "stopped" | "failed" | "stale";
export type PluginRuntimeInventoryLoaderState = Readonly<{
  sessions: readonly RuntimeSession[];
  localSessions: readonly RuntimeSession[];
  phase: PluginRuntimeInventoryReadPhase;
  staleNative: boolean;
  localError: boolean;
  controlAvailable: boolean;
  coverage: RuntimeSnapshot["coverage"];
  truncated: boolean;
}>;

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type Options = { invoke?: Invoke; control?: PluginRuntimeControl | undefined };
const isStaleStopError = (error: unknown) => error instanceof Error && error.message === "ERR_PLUGIN_RUNTIME_STALE";

/** One native inventory read plus event-driven renderer ownership; it never polls. */
export function createPluginRuntimeInventoryLoader(options: Options = {}) {
  const invoke: Invoke = options.invoke ?? ((command, args) => tauriInvoke<unknown>(command, args));
  const control = Object.prototype.hasOwnProperty.call(options, "control") ? options.control : getPluginRuntimeControl();
  const subscribers = new Set<() => void>();
  let localSessions: readonly RuntimeSession[] = [];
  let localError = false;
  let nativeSnapshot: RuntimeSnapshot | undefined;
  let phase: PluginRuntimeInventoryReadPhase = "idle";
  let generation = 0;
  let disposed = false;
  let unsubscribeControl = () => {};

  function readLocal() {
    if (!control) return;
    try {
      localSessions = Object.freeze(control.snapshot().map(parseRuntimeSession));
      localError = false;
    } catch {
      localError = true;
    }
  }
  function notify() {
    if (disposed) return;
    for (const subscriber of subscribers) {
      try { subscriber(); } catch { /* one view cannot break other inventory listeners */ }
    }
  }
  function snapshot(): PluginRuntimeInventoryLoaderState {
    const currentNative = phase === "ready" ? nativeSnapshot : undefined;
    const rows = mergePluginRuntimeSessions(currentNative?.sessions ?? [], localSessions);
    return Object.freeze({
      sessions: Object.freeze(rows), localSessions,
      phase,
      staleNative: Boolean(nativeSnapshot && phase !== "ready"),
      localError, controlAvailable: Boolean(control),
      coverage: currentNative?.coverage ?? Object.freeze([]), truncated: currentNative?.truncated ?? false,
    });
  }
  if (control) {
    readLocal();
    try {
      unsubscribeControl = control.subscribe(() => { if (!disposed) { readLocal(); notify(); } });
    } catch { localError = true; }
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    const request = ++generation;
    phase = "loading";
    notify();
    try {
      const next = parsePluginRuntimeSnapshot(await invoke("list_plugin_runtime_sessions"));
      if (disposed || request !== generation) return;
      nativeSnapshot = next;
      phase = "ready";
    } catch {
      if (disposed || request !== generation) return;
      phase = "error";
    }
    notify();
  }

  async function stop(row: RuntimeSession): Promise<PluginRuntimeStopResult> {
    if (disposed || !control || !control.canStop(row)) return "stale";
    try { await control.stop(row); }
    catch (error) {
      if (!isStaleStopError(error)) return "failed";
      if (!disposed) await refresh();
      return "stale";
    }
    if (!disposed) await refresh();
    return "stopped";
  }

  function subscribe(subscriber: () => void) {
    if (disposed) return () => {};
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    try { unsubscribeControl(); } catch { /* teardown is best effort; no callbacks remain */ }
    subscribers.clear();
  }

  return { snapshot, subscribe, refresh, canStop: (row: RuntimeSession) => !disposed && Boolean(control?.canStop(row)), stop, dispose };
}
