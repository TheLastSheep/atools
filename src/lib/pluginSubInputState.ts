/** Host-side state for the plugin navigation input. Visibility is explicit:
 * setting a value or focusing cannot recreate an input removed by the plugin. */
export type SubInputFocusAction = "focus" | "blur" | "select";
export type PluginSubInputState = {
  visible: boolean;
  value: string;
  placeholder: string;
  sequence: number;
  generation: number;
  epoch: number;
  focusRequest: { sequence: number; action: SubInputFocusAction } | null;
};

export function emptyPluginSubInput(sequence = 0, generation = 0, epoch = 0): PluginSubInputState {
  return { visible: false, value: "", placeholder: "", sequence, generation, epoch, focusRequest: null };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function focus(state: PluginSubInputState, action: SubInputFocusAction): PluginSubInputState {
  const sequence = state.sequence + 1;
  return { ...state, sequence, focusRequest: state.visible || action === "blur" ? { sequence, action } : null };
}

export type PluginSubInputUpdate = { state: PluginSubInputState; notifyValue?: string };

export function applyPluginSubInputMessage(
  state: PluginSubInputState,
  message: unknown,
): PluginSubInputUpdate | null {
  const data = record(message);
  if (!data) return null;
  if (data.__ipc_subinput__ !== true && data.__ipc_subinput_remove__ !== true
    && data.__ipc_subinput_focus__ !== true) return null;
  if (data.epoch !== state.epoch) return { state };
  if (data.generation !== undefined) {
    if (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0) return null;
    if (Number(data.generation) < state.generation) return { state };
    state = { ...state, generation: Number(data.generation) };
  }
  if (data.__ipc_subinput_remove__ === true) {
    const removed = emptyPluginSubInput(state.sequence, state.generation, state.epoch);
    return { state: focus(removed, "blur") };
  }
  if (data.__ipc_subinput_focus__ === true) {
    if (!["focus", "blur", "select"].includes(String(data.action))) return null;
    return { state: focus(state, data.action as SubInputFocusAction) };
  }
  if (data.__ipc_subinput__ !== true) return null;
  const opts = record(data.opts);
  if (!opts) return null;
  let next = { ...state };
  if (typeof opts.visible === "boolean") next.visible = opts.visible;
  if (typeof opts.placeholder === "string") next.placeholder = opts.placeholder;
  const hasValue = Object.prototype.hasOwnProperty.call(opts, "value");
  if (hasValue) next.value = String(opts.value ?? "");
  if (!next.visible) next.focusRequest = null;
  if (opts.focus === true) next = focus(next, "focus");
  return { state: next, ...(hasValue ? { notifyValue: next.value } : {}) };
}

/** Apply only the most recent focus request after Svelte has rendered the input.
 * The caller uses the returned cancellation function as its effect cleanup. */
export function createPluginSubInputFocus() {
  let appliedSequence = -1;
  return (options: {
    state: PluginSubInputState;
    input: HTMLInputElement | null | undefined;
    afterRender: () => Promise<unknown>;
    isCurrent: () => boolean;
    focusFrame: () => void;
  }) => {
    const { state, input } = options;
    const request = state.focusRequest;
    if (!request || request.sequence === appliedSequence) return;
    if (state.visible ? !input : request.action !== "blur") return;
    let cancelled = false;
    void options.afterRender().then(() => {
      if (cancelled || !options.isCurrent()) return;
      appliedSequence = request.sequence;
      if (request.action === "blur") { input?.blur(); options.focusFrame(); }
      else { input?.focus({ preventScroll: true }); if (request.action === "select") input?.select(); }
    });
    return () => { cancelled = true; };
  };
}
