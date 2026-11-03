import { expect, it, vi } from "vitest";
import { applyPluginSubInputMessage as reduce, createPluginSubInputFocus, emptyPluginSubInput, type PluginSubInputState } from "../../src/lib/pluginSubInputState";

const update = (state: PluginSubInputState, data: unknown) => reduce(state,
  data && typeof data === "object" && !Array.isArray(data) ? { epoch: state.epoch, ...data } : data);

it("shows a callback-only input with an empty placeholder and keeps visibility independent of value", () => {
  const shown = update(emptyPluginSubInput(), { __ipc_subinput__: true, opts: { visible: true, placeholder: "", focus: true } })!.state;
  expect(shown.visible).toBe(true);
  expect(shown.focusRequest?.action).toBe("focus");
  const changed = update(shown, { __ipc_subinput__: true, opts: { value: "" } })!;
  expect(changed.state.visible).toBe(true);
  expect(changed.notifyValue).toBe("");
});

it("preserves programmatic values exactly and reports even an explicit identical value", () => {
  let state = emptyPluginSubInput();
  for (const value of ["  中文\u0000 ", "  中文\u0000 ", "", 0, false]) {
    const changed = update(state, { __ipc_subinput__: true, opts: { value, focus: true } })!;
    expect(changed.state.value).toBe(String(value));
    expect(changed.notifyValue).toBe(String(value));
    expect(changed.state.visible).toBe(false);
    expect(changed.state.focusRequest).toBeNull();
    state = changed.state;
  }
});

it("remove clears state and cancels earlier focus without allowing a later focus call to show it", () => {
  const shown = update(emptyPluginSubInput(), { __ipc_subinput__: true, opts: { visible: true, focus: true, value: "old" } })!.state;
  const selected = update(shown, { __ipc_subinput_focus__: true, action: "select" })!.state;
  expect(selected.focusRequest?.sequence).toBeGreaterThan(shown.focusRequest!.sequence);
  const removed = update(selected, { __ipc_subinput_remove__: true })!.state;
  expect(removed).toEqual({ ...emptyPluginSubInput(selected.sequence + 1), focusRequest: { sequence: selected.sequence + 1, action: "blur" } });
  const hiddenFocus = update(removed, { __ipc_subinput_focus__: true, action: "focus" })!.state;
  expect(hiddenFocus.visible).toBe(false);
  expect(hiddenFocus.focusRequest).toBeNull();
});

it("does not treat malformed or unrelated frame messages as navigation configuration", () => {
  const state = emptyPluginSubInput();
  for (const message of [null, [], { __ipc_subinput__: 1, opts: {} }, { __ipc_subinput__: true, opts: [] }, { __ipc_subinput_focus__: true, action: "unknown" }, { __ipc_out__: true }]) {
    expect(update(state, message)).toBeNull();
  }
});

it("rejects old document epochs even when the new input has the same generation", () => {
  const state = emptyPluginSubInput(10, 1, 2);
  for (const data of [
    { __ipc_subinput__: true, opts: { visible: true, value: "old" }, generation: 1, epoch: 1 },
    { __ipc_subinput_remove__: true, generation: 2, epoch: 1 },
    { __ipc_subinput__: true, opts: { visible: true }, generation: 1 },
  ]) {
    expect(reduce(state, data)).toEqual({ state });
  }
  const next = update(state, { __ipc_subinput__: true, generation: 2, opts: { visible: true, value: "new" } })!.state;
  expect(next.value).toBe("new");
  expect(update(next, { __ipc_subinput__: true, generation: 1, opts: { value: "late" } })).toEqual({ state: next });
});

it("cancels delayed focus when the input is removed or a newer request takes over", async () => {
  let release!: () => void;
  const afterRender = () => new Promise<void>(resolve => { release = resolve; });
  const input = { focus: vi.fn(), blur: vi.fn(), select: vi.fn() } as unknown as HTMLInputElement;
  const focusFrame = vi.fn();
  const schedule = createPluginSubInputFocus();
  const state = update(emptyPluginSubInput(), { __ipc_subinput__: true, opts: { visible: true, focus: true } })!.state;
  const cancel = schedule({ state, input, afterRender, isCurrent: () => true, focusFrame });
  cancel?.(); release(); await Promise.resolve();
  expect(input.focus).not.toHaveBeenCalled();
  schedule({ state, input, afterRender, isCurrent: () => false, focusFrame });
  release(); await Promise.resolve();
  expect(input.focus).not.toHaveBeenCalled();
  schedule({ state, input, afterRender, isCurrent: () => true, focusFrame });
  release(); await Promise.resolve();
  expect(input.focus).toHaveBeenCalledTimes(1);
  expect(schedule({ state, input, afterRender, isCurrent: () => true, focusFrame })).toBeUndefined();
  const removed = update(state, { __ipc_subinput_remove__: true })!.state;
  schedule({ state: removed, input: null, afterRender, isCurrent: () => true, focusFrame });
  release(); await Promise.resolve();
  expect(focusFrame).toHaveBeenCalledTimes(1);
});
