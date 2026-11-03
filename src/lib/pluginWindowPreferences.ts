export type PluginWindowPreferencesState = {
  open: boolean;
  pluginId: string | null;
  autoDetach: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  errorAction: "load" | "save" | null;
  saveIntent: "toggle" | "reset" | null;
  notice: string | null;
};

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function emptyPluginWindowPreferencesState(): PluginWindowPreferencesState {
  return {
    open: false,
    pluginId: null,
    autoDetach: false,
    loaded: false,
    loading: false,
    saving: false,
    error: null,
    errorAction: null,
    saveIntent: null,
    notice: null,
  };
}

/** Keeps preference requests scoped to the plugin and dialog generation that started them. */
export function createPluginWindowPreferencesController(ports: {
  invoke: Invoke;
  onChange: (state: PluginWindowPreferencesState) => void;
  currentPluginId?: () => string;
}) {
  let state = emptyPluginWindowPreferencesState();
  let generation = 0;
  let disposed = false;
  let retryAutoDetach: boolean | null = null;

  const publish = (next: PluginWindowPreferencesState) => {
    if (disposed) return;
    state = next;
    ports.onChange({ ...next });
  };
  const isPluginActive = (pluginId: string) => !ports.currentPluginId || ports.currentPluginId() === pluginId;
  const current = (request: number, pluginId: string) =>
    !disposed && generation === request && state.open && state.pluginId === pluginId
      && isPluginActive(pluginId);

  function responseAutoDetach(value: unknown): boolean {
    if (typeof value !== "object" || value === null || typeof (value as { autoDetach?: unknown }).autoDetach !== "boolean") {
      throw new Error("插件窗口设置响应无效");
    }
    return (value as { autoDetach: boolean }).autoDetach;
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error) return error;
    return "保存插件窗口设置失败，请重试。";
  }

  async function load(request: number, pluginId: string): Promise<void> {
    publish({ ...state, loading: true, error: null, errorAction: null, notice: null });
    try {
      const result = await ports.invoke("get_plugin_window_preferences", { pluginId });
      if (!current(request, pluginId)) return;
      const autoDetach = responseAutoDetach(result);
      retryAutoDetach = null;
      publish({ ...state, autoDetach, loaded: true, loading: false, error: null, errorAction: null, saveIntent: null });
    } catch (error) {
      if (!current(request, pluginId)) return;
      publish({ ...state, loading: false, error: errorMessage(error), errorAction: "load" });
    }
  }

  async function open(pluginId: string): Promise<void> {
    if (disposed || typeof pluginId !== "string" || pluginId.trim() === "" || !isPluginActive(pluginId)) return;
    const stablePluginId = pluginId;
    if (state.open && state.pluginId === stablePluginId) return;
    const request = ++generation;
    retryAutoDetach = null;
    publish({ ...emptyPluginWindowPreferencesState(), open: true, pluginId: stablePluginId, loading: true });
    await load(request, stablePluginId);
  }

  async function persist(enabled: boolean, intent: "toggle" | "reset", allowBeforeLoaded = false): Promise<void> {
    const pluginId = state.pluginId;
    if (typeof enabled !== "boolean" || !pluginId || !state.open || !isPluginActive(pluginId)
      || (!state.loaded && !allowBeforeLoaded)
      || state.loading || state.saving || disposed) return;
    const request = generation;
    retryAutoDetach = enabled;
    publish({ ...state, saving: true, error: null, errorAction: null, saveIntent: intent, notice: null });
    try {
      const result = await ports.invoke("set_plugin_auto_detach", { pluginId, enabled });
      if (!current(request, pluginId)) return;
      const autoDetach = responseAutoDetach(result);
      if (intent === "reset" && autoDetach !== false) throw new Error("宿主未确认恢复默认设置，请重试。");
      retryAutoDetach = null;
      publish({
        ...state,
        autoDetach,
        loaded: state.loaded || intent === "reset",
        saving: false,
        error: null,
        errorAction: null,
        saveIntent: null,
        notice: intent === "reset" ? "已恢复默认设置，下次打开此插件时生效。" : "已保存，下次打开此插件时生效。",
      });
    } catch (error) {
      if (!current(request, pluginId)) return;
      publish({ ...state, saving: false, error: errorMessage(error), errorAction: "save", saveIntent: intent });
    }
  }

  function setAutoDetach(enabled: boolean): Promise<void> {
    return persist(enabled, "toggle");
  }

  function resetToDefault(): Promise<void> {
    if (!state.open || state.loaded) return Promise.resolve();
    return persist(false, "reset", true);
  }

  async function retry(): Promise<void> {
    if (!state.open || !state.pluginId || disposed) return;
    const action = state.errorAction;
    const pluginId = state.pluginId;
    if (action === "load") {
      await load(generation, pluginId);
    } else if (action === "save" && retryAutoDetach !== null) {
      const intent = state.saveIntent ?? "toggle";
      await persist(retryAutoDetach, intent, intent === "reset" && !state.loaded);
    }
  }

  function close(): void {
    if (disposed) return;
    generation++;
    retryAutoDetach = null;
    publish(emptyPluginWindowPreferencesState());
  }

  function pluginChanged(pluginId: string): void {
    if (state.open && state.pluginId !== pluginId) close();
  }

  function dispose(): void {
    generation++;
    retryAutoDetach = null;
    disposed = true;
    state = emptyPluginWindowPreferencesState();
  }

  return { open, close, dispose, pluginChanged, setAutoDetach, resetToDefault, retry, snapshot: () => ({ ...state }) };
}
