export const PLUGIN_CODE_CHANGED_EVENT = "plugin-code-changed";
const MAX_TRACKED_PLUGINS = 256;
const CHANGE_REASONS = new Set(["reset", "installed", "updated", "removed", "disabled", "enabled"]);

export type PluginCodeChange = {
  pluginId: string;
  reason: "reset" | "installed" | "updated" | "removed" | "disabled" | "enabled";
};
export type PluginActivationToken = { generation: number; mutation: number };
export type PluginLifecycleCleanup = () => void | Promise<void>;

export function parsePluginCodeChange(payload: unknown): PluginCodeChange | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { pluginId, reason } = payload as Record<string, unknown>;
  if (typeof pluginId !== "string" || pluginId.length > 512 || !pluginId.trim()
    || pluginId !== pluginId.trim() || /[\u0000-\u001f\u007f]/.test(pluginId)
    || typeof reason !== "string" || !CHANGE_REASONS.has(reason)) return null;
  return { pluginId, reason: reason as PluginCodeChange["reason"] };
}

export function pluginCodeChangeMessage(change: PluginCodeChange): string {
  switch (change.reason) {
    case "reset": return "插件运行环境已重置，请从搜索重新打开。";
    case "removed": return "插件已卸载，可从插件管理重新安装。";
    case "disabled": return "插件已停用，启用后可从搜索重新打开。";
    case "enabled": return "插件已启用，请从搜索重新打开。";
    default: return "插件已更新，请从搜索重新打开。";
  }
}

type LifecycleOptions = {
  subscribe: (receive: (payload: unknown) => void) => Promise<PluginLifecycleCleanup>;
  activePluginId: () => string | null;
  invalidateActivePlugin: (change: PluginCodeChange) => void;
  updateNotice?: (change: PluginCodeChange) => void;
  refreshCatalog: () => Promise<void>;
  onError?: (error: unknown) => void;
};

/** Event-driven lifecycle state. No plugin execution, startup reads, or idle timers. */
export function createPluginCodeLifecycle(options: LifecycleOptions) {
  let disposed = false;
  let generation = 0;
  let mutation = 0;
  let mutationFloor = 0;
  const changedPlugins = new Map<string, number>();
  let subscription: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let unlisten: PluginLifecycleCleanup | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshPending = false;
  let refreshing = false;
  const reportError = (error: unknown) => options.onError?.(error);
  async function cleanup(stop: PluginLifecycleCleanup) {
    try { await stop(); } catch (error) { reportError(error); }
  }

  function scheduleRefresh() {
    if (disposed || refreshing || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (disposed || !refreshPending) return;
      refreshPending = false;
      refreshing = true;
      void Promise.resolve().then(() => disposed ? undefined : options.refreshCatalog()).catch(reportError).finally(() => {
        refreshing = false;
        if (refreshPending) scheduleRefresh();
      });
    }, 0);
  }

  function receive(payload: unknown) {
    if (disposed) return;
    const change = parsePluginCodeChange(payload);
    if (!change) return;
    changedPlugins.delete(change.pluginId);
    changedPlugins.set(change.pluginId, ++mutation);
    if (changedPlugins.size > MAX_TRACKED_PLUGINS) {
      const oldest = changedPlugins.entries().next().value!;
      changedPlugins.delete(oldest[0]);
      mutationFloor = oldest[1];
    }
    if (options.activePluginId() === change.pluginId) options.invalidateActivePlugin(change);
    else options.updateNotice?.(change);
    // A reset can precede a failed installation. The catalog is unchanged.
    if (change.reason !== "reset") {
      refreshPending = true;
      scheduleRefresh();
    }
  }

  return {
    start(): Promise<void> {
      if (disposed) return disposal ?? Promise.resolve();
      return subscription ??= Promise.resolve().then(() => options.subscribe(receive)).then(async stop => {
        if (disposed) await cleanup(stop);
        else unlisten = stop;
      }).catch(reportError);
    },
    beginActivation(): PluginActivationToken {
      return { generation: ++generation, mutation };
    },
    captureActivation(): PluginActivationToken { return { generation, mutation }; },
    isCurrent(token: PluginActivationToken, pluginId?: string): boolean {
      return !disposed && token.generation === generation && token.mutation >= mutationFloor
        && (pluginId === undefined || (changedPlugins.get(pluginId) ?? 0) <= token.mutation);
    },
    cancelActivation() { generation += 1; },
    isDisposed() { return disposed; },
    dispose(): Promise<void> {
      if (disposed) return disposal ?? subscription ?? Promise.resolve();
      disposed = true;
      generation += 1;
      refreshPending = false;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      const stop = unlisten;
      unlisten = undefined;
      changedPlugins.clear();
      return disposal = (async () => {
        if (stop) await cleanup(stop);
        await subscription;
      })();
    },
  };
}
