// @vitest-environment node
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createPluginSubInputBridge } from "../../src/lib/pluginSubInputBridge";

function setup(epoch = 0) {
  const handlers = new Map<string, Set<(event?: unknown) => void>>();
  const posted: Array<{ message: any; origin: string }> = [];
  const errors = vi.fn();
  const parent = { postMessage: (message: unknown, origin: string) => { posted.push({ message, origin }); } };
  const target = {
    parent, console: { error: errors },
    addEventListener: vi.fn((name: string, callback: (event?: unknown) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(callback);
    }),
    removeEventListener: vi.fn((name: string, callback: (event?: unknown) => void) => { handlers.get(name)?.delete(callback); }),
  };
  // Exercise the exact dependency-free source injected into an opaque plugin iframe.
  const createForEpoch = (bridgeEpoch: number) => runInNewContext(`(${createPluginSubInputBridge.toString()})(window, bridgeEpoch)`, { window: target, bridgeEpoch }) as ReturnType<typeof createPluginSubInputBridge>;
  const bridge = createForEpoch(epoch);
  const dispatch = (name: string, event?: unknown) => { for (const callback of [...handlers.get(name) ?? []]) callback(event); };
  const receive = (text: unknown, source: unknown = parent, generation: unknown = posted.at(-1)?.message.generation ?? 0, responseEpoch: unknown = epoch) => dispatch("message", { source, data: { __ipc_subinput_change__: true, text, epoch: responseEpoch, generation } });
  return { bridge, createForEpoch, target, parent, posted, errors, handlers, dispatch, receive };
}

describe("serialized plugin subinput bridge", () => {
  it("resolves configuration and value requests when queued, supporting direct Promise chaining", async () => {
    const f = setup();
    const configured = vi.fn(), changed = vi.fn();
    await f.bridge.setSubInput(() => {}).then(configured);
    await f.bridge.setSubInputValue("").then(changed);
    expect(configured).toHaveBeenCalledWith(true);
    expect(changed).toHaveBeenCalledWith(true);
    expect(f.posted).toHaveLength(2);
    f.bridge.dispose();
    await expect(f.bridge.setSubInput(() => {})).resolves.toBe(false);
    await expect(f.bridge.setSubInputValue("ignored")).resolves.toBe(false);
    expect(f.posted).toHaveLength(2);
  });

  it("delivers the standard callback independently of onSubInput, with visible and default focus", () => {
    const f = setup(), callback = vi.fn();
    f.bridge.setSubInput(callback);
    expect(f.posted).toEqual([{ message: { __ipc_subinput__: true, opts: { visible: true, placeholder: "", focus: true }, epoch: 0, generation: 1 }, origin: "*" }]);
    expect(callback).not.toHaveBeenCalled();
    f.receive("中文 精确文本 ");
    f.receive("");
    expect(callback.mock.calls).toEqual([[{ text: "中文 精确文本 " }], [{ text: "" }]]);
    expect(f.handlers.get("message")?.size).toBe(1);
  });

  it("accepts positional placeholder/focus and preserves the supported options extension, including exact empty values", () => {
    const f = setup(), callback = vi.fn();
    f.bridge.setSubInput(callback, "查找", false);
    f.bridge.setSubInput({ placeholder: "", focus: false, value: "" });
    f.bridge.setSubInput({ value: 0 });
    f.bridge.setSubInput(null, "无回调也显示", false);
    expect(f.posted.map(item => item.message.opts)).toEqual([
      { visible: true, placeholder: "查找", focus: false },
      { visible: true, placeholder: "", focus: false, value: "" },
      { visible: true, placeholder: "", focus: true, value: "0" },
      { visible: true, placeholder: "无回调也显示", focus: false },
    ]);
    f.receive("retained");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("deduplicates callbacks and maintains only one message listener across repeated registration", () => {
    const f = setup(), callback = vi.fn(), extra = vi.fn(), replacement = vi.fn();
    f.bridge.setSubInput(callback);
    f.bridge.onSubInput(callback);
    f.bridge.onSubInput(callback);
    const stopExtra = f.bridge.onSubInput(extra);
    f.bridge.onSubInput(extra);
    expect(f.target.addEventListener.mock.calls.filter(([name]) => name === "message")).toHaveLength(1);
    f.receive("first");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(extra).toHaveBeenCalledTimes(1);
    stopExtra(); stopExtra();
    f.bridge.setSubInput(replacement);
    f.receive("second");
    expect(callback).toHaveBeenCalledTimes(2); // It remains an explicitly registered onSubInput listener.
    expect(extra).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("rejects sibling/child messages and malformed envelopes while accepting only the actual parent", () => {
    const f = setup(), callback = vi.fn();
    f.bridge.setSubInput(callback);
    f.receive("spoof", {});
    f.receive("spoof", null);
    for (const data of [null, [], { __ipc_subinput_change__: false }, { __ipc_subinput_change__: "true", text: "spoof" }]) f.dispatch("message", { source: f.parent, data });
    for (const generation of [undefined, null, "1", 1.5, NaN, Infinity, -1, 0, 2]) f.dispatch("message", { source: f.parent, data: { __ipc_subinput_change__: true, text: "wrong generation", epoch: 0, generation } });
    for (const epoch of [undefined, null, "0", 0.5, NaN, Infinity, -1, 1]) f.dispatch("message", { source: f.parent, data: { __ipc_subinput_change__: true, text: "wrong epoch", epoch, generation: 1 } });
    expect(callback).not.toHaveBeenCalled();
    f.receive("trusted");
    expect(callback).toHaveBeenCalledWith({ text: "trusted" });
  });

  it("posts value changes without local callback delivery, then delivers one callback per host response including repeated empty values", () => {
    const f = setup(), callback = vi.fn();
    f.bridge.setSubInput(callback);
    f.bridge.onSubInput(callback);
    f.bridge.setSubInputValue("");
    expect(callback).not.toHaveBeenCalled();
    f.receive("", f.parent, f.posted.at(-1)?.message.generation);
    f.bridge.setSubInputValue("");
    expect(callback).toHaveBeenCalledTimes(1);
    f.receive("", f.parent, f.posted.at(-1)?.message.generation);
    f.bridge.setSubInput({ value: "configured" });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(f.posted.slice(1).map(item => item.message.opts)).toEqual([
      { focus: true, value: "" }, { focus: true, value: "" },
      { visible: true, placeholder: "", focus: true, value: "configured" },
    ]);
    f.receive("configured", f.parent, f.posted.at(-1)?.message.generation);
    expect(callback.mock.calls).toEqual([[{ text: "" }], [{ text: "" }], [{ text: "configured" }]]);
  });

  it("clears the primary and extra subscriptions on removal, and reattaches a single fresh listener after reopening", async () => {
    const f = setup(), old = vi.fn(), extra = vi.fn(), fresh = vi.fn();
    f.bridge.setSubInput(old); f.bridge.onSubInput(extra);
    await expect(f.bridge.removeSubInput()).resolves.toBe(true);
    f.receive("old");
    expect(old).not.toHaveBeenCalled(); expect(extra).not.toHaveBeenCalled();
    expect(f.handlers.get("message")?.size).toBe(0);
    f.bridge.setSubInput(fresh);
    f.receive("new");
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(f.handlers.get("message")?.size).toBe(1);
    expect(f.posted.some(item => item.message.__ipc_subinput_remove__ === true)).toBe(true);
  });

  it("ignores queued changes from an old input generation after removal and immediate reopening", async () => {
    const f = setup(), old = vi.fn(), fresh = vi.fn(), extra = vi.fn();
    f.bridge.setSubInput(old);
    const oldGeneration = f.posted.at(-1)!.message.generation;
    const removed = f.bridge.removeSubInput();
    const removedGeneration = f.posted.at(-1)!.message.generation;
    f.bridge.setSubInput(fresh);
    await removed;
    const freshGeneration = f.posted.at(-1)!.message.generation;
    f.bridge.onSubInput(fresh); f.bridge.onSubInput(extra);
    f.receive("old queued text", f.parent, oldGeneration);
    f.receive("removed queued text", f.parent, removedGeneration);
    expect(old).not.toHaveBeenCalled(); expect(fresh).not.toHaveBeenCalled(); expect(extra).not.toHaveBeenCalled();
    f.receive("current text", f.parent, freshGeneration);
    expect(fresh).toHaveBeenCalledTimes(1); expect(extra).toHaveBeenCalledTimes(1);
    f.bridge.setSubInputValue("");
    await f.bridge.subInputFocus(); await f.bridge.subInputBlur(); await f.bridge.subInputSelect();
    expect(f.posted.map(item => item.message.generation)).toEqual([1, 2, 3, 3, 3, 3, 3]);
  });

  it("isolates a reloaded document epoch even when the parent, iframe proxy and input generation match", () => {
    const f = setup(1), oldCallback = vi.fn(), freshCallback = vi.fn();
    f.bridge.setSubInput(oldCallback);
    const oldRequest = f.posted.at(-1)!.message;
    f.bridge.dispose();
    // A reload retains this window facade and parent identity, but creates a fresh JS context.
    const freshBridge = f.createForEpoch(2);
    freshBridge.setSubInput(freshCallback);
    const freshRequest = f.posted.at(-1)!.message;
    expect(oldRequest.generation).toBe(1); expect(freshRequest.generation).toBe(1);
    expect(oldRequest.epoch).toBe(1); expect(freshRequest.epoch).toBe(2);
    f.receive("old document reply", f.parent, oldRequest.generation, oldRequest.epoch);
    expect(oldCallback).not.toHaveBeenCalled(); expect(freshCallback).not.toHaveBeenCalled();
    f.receive("new document reply", f.parent, freshRequest.generation, freshRequest.epoch);
    expect(freshCallback).toHaveBeenCalledTimes(1);
    expect(freshCallback).toHaveBeenCalledWith({ text: "new document reply" });
    expect(f.handlers.get("message")?.size).toBe(1);
    freshBridge.dispose();
  });

  it("uses the existing focus/blur/select protocol and removes a lone onSubInput subscription", async () => {
    const f = setup(), callback = vi.fn();
    const stop = f.bridge.onSubInput(callback);
    await expect(f.bridge.subInputFocus()).resolves.toBe(true);
    await expect(f.bridge.subInputBlur()).resolves.toBe(true);
    await expect(f.bridge.subInputSelect()).resolves.toBe(true);
    expect(f.posted.map(item => item.message)).toEqual(["focus", "blur", "select"].map(action => ({ __ipc_subinput_focus__: true, action, epoch: 0, generation: 0 })));
    stop(); f.receive("ignored");
    expect(callback).not.toHaveBeenCalled();
    expect(f.handlers.get("message")?.size).toBe(0);
  });

  it("does not show a removed input again when only its cached value changes", async () => {
    const f = setup(), callback = vi.fn();
    let visible = false;
    let value = "";
    f.parent.postMessage = (message: any, origin: string) => {
      f.posted.push({ message, origin });
      if (message.__ipc_subinput_remove__) { visible = false; value = ""; }
      if (message.__ipc_subinput__) {
        if (message.opts.visible !== undefined) visible = message.opts.visible;
        if (Object.prototype.hasOwnProperty.call(message.opts, "value")) { value = message.opts.value; f.receive(value, f.parent, message.generation, message.epoch); }
      }
    };
    f.bridge.setSubInput(callback);
    expect(visible).toBe(true);
    await f.bridge.removeSubInput();
    expect(visible).toBe(false);
    f.bridge.setSubInputValue("cached");
    expect(value).toBe("cached"); expect(visible).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect(f.posted.at(-1)?.message.opts).toEqual({ value: "cached", focus: true });
    f.bridge.setSubInput(callback, "", false);
    expect(visible).toBe(true);
    expect(value).toBe("cached");
  });

  it.each(["dispose", "pagehide"])("releases all resources on %s and makes old references inert", async mode => {
    const f = setup(), callback = vi.fn();
    f.bridge.setSubInput(callback); f.bridge.onSubInput(callback);
    if (mode === "dispose") f.bridge.dispose(); else f.dispatch("pagehide");
    f.bridge.dispose();
    const before = f.posted.length;
    f.receive("late"); f.bridge.onSubInput(callback);
    await expect(f.bridge.setSubInput(callback)).resolves.toBe(false);
    await expect(f.bridge.setSubInputValue("late")).resolves.toBe(false);
    await expect(f.bridge.removeSubInput()).resolves.toBe(false);
    await expect(f.bridge.subInputFocus()).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled(); expect(f.posted).toHaveLength(before);
    expect(f.handlers.get("message")?.size).toBe(0);
    expect(f.handlers.get("pagehide")?.size).toBe(0);
  });

  it("isolates failing callbacks and does not dispatch listeners removed during the same event", async () => {
    const f = setup(), extra = vi.fn();
    f.bridge.setSubInput(() => { throw new Error("fixture callback"); });
    f.bridge.onSubInput(extra);
    f.receive("first");
    expect(f.errors).toHaveBeenCalledTimes(1); expect(extra).toHaveBeenCalledTimes(1);
    f.bridge.setSubInput(() => { void f.bridge.removeSubInput(); });
    f.receive("second");
    expect(extra).toHaveBeenCalledTimes(1);
    f.bridge.setSubInput(async () => { throw new Error("async fixture callback"); });
    f.receive("third");
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalledTimes(2));
  });
});
