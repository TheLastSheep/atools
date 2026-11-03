import type { MainPushInvoke } from "./pluginMainPushProtocol";

/** Observes the existing permission flow; never grants or resumes a task itself. */
export function createPluginMainPushPermissionTracker(changed: (waiting: boolean) => void) {
  const pending = new Set<string>();
  let local = false, last = false, closed = false;
  function publish() { const next = !closed && (local || pending.size > 0); if (next !== last) { last = next; changed(next); } }
  return { wrap(invoke: MainPushInvoke): MainPushInvoke {
    return async <T>(command: string, args?: Record<string, unknown>) => {
      const value = await invoke<T>(command, args);
      if (!closed && value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.permission_required === true && typeof record.runId === "string") pending.add(record.runId);
        if (command === "get_task_run" && typeof args?.id === "string"
          && ["succeeded", "failed", "cancelled", "partial"].includes(String(record.status))) pending.delete(args.id);
        publish();
      }
      return value;
    };
  }, setLocal(value: boolean) { local = value; publish(); }, close() { closed = true; pending.clear(); publish(); } };
}
