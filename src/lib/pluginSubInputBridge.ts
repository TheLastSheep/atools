export type PluginSubInputCallback = (details: { text: string }) => unknown;
export type PluginSubInputOptions = { placeholder?: string; focus?: boolean; value?: unknown };

/** Keep this factory self-contained: PluginPanel injects its serialized source. */
export function createPluginSubInputBridge(target: Window & { console?: Pick<Console, "error">;
  __ATOOLS_FRAME_TRANSPORT__?: { post: (message: Record<string, unknown>) => unknown; accept: (event: MessageEvent) => boolean } }, epoch = 0) {
  let primaryCallback: PluginSubInputCallback | null = null;
  const subscribers = new Set<PluginSubInputCallback>();
  let listening = false;
  let disposed = false;
  let generation = 0;

  function reportError(error: unknown) {
    target.console?.error("[ATools subinput] callback failed", error);
  }
  function receive(event: MessageEvent) {
    if (disposed || event.source !== target.parent) return;
    if (target.__ATOOLS_FRAME_TRANSPORT__ && !target.__ATOOLS_FRAME_TRANSPORT__.accept(event)) return;
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || data.__ipc_subinput_change__ !== true) return;
    if (!Number.isInteger(data.epoch) || data.epoch !== epoch) return;
    const eventGeneration = data.generation;
    if (!Number.isInteger(eventGeneration) || eventGeneration !== generation) return;
    const text = String(data.text ?? "");
    const callbacks = new Set<PluginSubInputCallback>();
    if (primaryCallback) callbacks.add(primaryCallback);
    for (const callback of subscribers) callbacks.add(callback);
    for (const callback of callbacks) {
      if (disposed || eventGeneration !== generation) break;
      if (primaryCallback !== callback && !subscribers.has(callback)) continue;
      try {
        const result = callback({ text });
        if (result && typeof (result as PromiseLike<unknown>).then === "function") Promise.resolve(result).catch(reportError);
      } catch (error) { reportError(error); }
    }
  }
  function attach() {
    if (disposed || listening) return;
    target.addEventListener("message", receive);
    listening = true;
  }
  function detach() {
    if (!listening) return;
    target.removeEventListener("message", receive);
    listening = false;
  }
  function clearCallbacks() {
    primaryCallback = null;
    subscribers.clear();
    detach();
  }
  function post(message: Record<string, unknown>) {
    if (disposed) return;
    const payload = { ...message, epoch, generation };
    if (target.__ATOOLS_FRAME_TRANSPORT__) target.__ATOOLS_FRAME_TRANSPORT__.post(payload);
    else target.parent.postMessage(payload, "*");
  }
  function focus(action: "focus" | "blur" | "select") {
    if (disposed) return Promise.resolve(false);
    post({ __ipc_subinput_focus__: true, action });
    return Promise.resolve(true);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearCallbacks();
    target.removeEventListener("pagehide", dispose);
  }
  target.addEventListener("pagehide", dispose, { once: true });

  return {
    setSubInput(callbackOrOptions?: PluginSubInputCallback | PluginSubInputOptions | null, placeholder?: string, shouldFocus = true) {
      if (disposed) return Promise.resolve(false);
      generation += 1;
      const record = callbackOrOptions && typeof callbackOrOptions === "object" ? callbackOrOptions : null;
      if (typeof callbackOrOptions === "function") primaryCallback = callbackOrOptions;
      if (primaryCallback || subscribers.size) attach();
      const options: PluginSubInputOptions & { visible: true } = {
        visible: true,
        placeholder: String((record ? record.placeholder : placeholder) ?? ""),
        focus: record ? record.focus === undefined || record.focus === true : shouldFocus === true,
      };
      if (record && Object.prototype.hasOwnProperty.call(record, "value")) options.value = String(record.value ?? "");
      post({ __ipc_subinput__: true, opts: options });
      return Promise.resolve(true);
    },
    setSubInputValue(value: unknown) {
      if (disposed) return Promise.resolve(false);
      post({ __ipc_subinput__: true, opts: { focus: true, value: String(value ?? "") } });
      return Promise.resolve(true);
    },
    removeSubInput() {
      if (disposed) return Promise.resolve(false);
      generation += 1;
      clearCallbacks();
      post({ __ipc_subinput_remove__: true });
      return Promise.resolve(true);
    },
    subInputFocus: () => focus("focus"),
    subInputBlur: () => focus("blur"),
    subInputSelect: () => focus("select"),
    onSubInput(callback: PluginSubInputCallback) {
      if (disposed || typeof callback !== "function") return () => {};
      subscribers.add(callback);
      attach();
      return () => {
        subscribers.delete(callback);
        if (!primaryCallback && subscribers.size === 0) detach();
      };
    },
    dispose,
  };
}
