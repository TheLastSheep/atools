import { getContext, setContext } from "svelte";
import { parseRuntimeSession, sameRuntimeSession, type RuntimeSession } from "./pluginRuntimeInventory";

const contextKey = Symbol("plugin-runtime-control");
type Source = { snapshot(): readonly RuntimeSession[]; stop(row: RuntimeSession): Promise<void> };
export type PluginRuntimeControl = ReturnType<typeof createPluginRuntimeControl>;
export function providePluginRuntimeControl(control: PluginRuntimeControl): void { setContext(contextKey, control); }
export function getPluginRuntimeControl(): PluginRuntimeControl | undefined { return getContext(contextKey); }

/** One trusted launcher surface owns the callbacks; no global window or IPC broker. */
export function createPluginRuntimeControl() {
  const sources = new Map<string | symbol, Source>();
  const listeners = new Set<() => void>();
  const pending = new Map<string, { row: RuntimeSession; operation: Promise<void> }>();
  let disposed = false;
  function changed() { if (!disposed) for (const receive of listeners) receive(); }
  function rows(source: Source): RuntimeSession[] {
    return source.snapshot().slice(0, 32).map(parseRuntimeSession);
  }
  function sourceFor(row: RuntimeSession) {
    if (disposed) return undefined;
    for (const source of sources.values()) {
      if (rows(source).some(current => sameRuntimeSession(current, row) && current.phase === "ready")) return source;
    }
    return undefined;
  }
  function canStop(row: RuntimeSession): boolean {
    return row.kind === "background" && row.evidence === "renderer_view" && row.phase === "ready" && !!sourceFor(row);
  }
  function stop(input: RuntimeSession): Promise<void> {
    let row: RuntimeSession;
    try { row = parseRuntimeSession(input); } catch (error) { return Promise.reject(error); }
    const active = pending.get(row.id);
    if (active) return sameRuntimeSession(active.row, row) ? active.operation : Promise.reject(new Error("ERR_PLUGIN_RUNTIME_STALE"));
    const source = canStop(row) ? sourceFor(row) : undefined;
    if (!source) return Promise.reject(new Error("ERR_PLUGIN_RUNTIME_STALE"));
    const operation = Promise.resolve().then(async () => {
      if (sourceFor(row) !== source) throw new Error("ERR_PLUGIN_RUNTIME_STALE");
      await source.stop(row);
      if (rows(source).some(current => sameRuntimeSession(current, row))) throw new Error("ERR_PLUGIN_RUNTIME_STOP_UNCONFIRMED");
    });
    pending.set(row.id, { row, operation });
    void operation.finally(() => { if (pending.get(row.id)?.operation === operation) pending.delete(row.id); changed(); }).catch(() => {});
    return operation;
  }
  return {
    changed, canStop, stop,
    snapshot(): RuntimeSession[] { return disposed ? [] : [...sources.values()].flatMap(rows).slice(0, 128); },
    registerSource(id: string | symbol, source: Source) {
      if (disposed || sources.has(id) || sources.size >= 4) throw new Error("ERR_PLUGIN_RUNTIME_SOURCE");
      sources.set(id, source); changed();
      return () => { if (sources.get(id) === source) { sources.delete(id); changed(); } };
    },
    subscribe(receive: () => void) { if (!disposed) listeners.add(receive); return () => { listeners.delete(receive); }; },
    dispose() { disposed = true; sources.clear(); listeners.clear(); },
  };
}
