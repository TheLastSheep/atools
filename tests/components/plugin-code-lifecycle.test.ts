import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginCodeLifecycle, parsePluginCodeChange, pluginCodeChangeMessage, type PluginLifecycleCleanup } from "../../src/lib/pluginCodeLifecycle";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

async function setup() {
  let receive!: (payload: unknown) => void;
  let active: string | null = "alpha";
  const stop = vi.fn();
  const invalidateActivePlugin = vi.fn(() => { active = null; });
  const refreshCatalog = vi.fn(async () => {});
  const lifecycle = createPluginCodeLifecycle({
    subscribe: async handler => { receive = handler; return stop; },
    activePluginId: () => active,
    invalidateActivePlugin,
    refreshCatalog,
  });
  await lifecycle.start();
  return { lifecycle, receive, stop, invalidateActivePlugin, refreshCatalog, setActive: (id: string) => { active = id; } };
}

describe("plugin code lifecycle", () => {
  it("accepts only bounded identity and known reasons, dropping unrelated payload fields", () => {
    for (const reason of ["reset", "installed", "updated", "removed", "disabled", "enabled"]) {
      expect(parsePluginCodeChange({ pluginId: "插件-alpha", reason, path: "/private/unused" })).toEqual({ pluginId: "插件-alpha", reason });
    }
    for (const payload of [null, [], "alpha", {}, { plugin_id: "alpha", reason: "updated" },
      { pluginId: "", reason: "updated" }, { pluginId: " alpha", reason: "updated" },
      { pluginId: "a\n", reason: "updated" }, { pluginId: "a".repeat(513), reason: "updated" },
      { pluginId: "alpha", reason: "reloaded" }, { pluginId: "alpha", reason: null }]) {
      expect(parsePluginCodeChange(payload)).toBeNull();
    }
    expect(pluginCodeChangeMessage({ pluginId: "alpha", reason: "reset" })).toContain("运行环境已重置");
    expect(pluginCodeChangeMessage({ pluginId: "alpha", reason: "removed" })).toContain("已卸载");
    expect(pluginCodeChangeMessage({ pluginId: "alpha", reason: "disabled" })).toContain("已停用");
  });

  it("has no startup refresh or idle timer, and a reset invalidates only its own active plugin", async () => {
    vi.useFakeTimers();
    const state = await setup();
    expect(state.refreshCatalog).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    state.receive({ pluginId: "beta", reason: "reset" });
    state.receive({ pluginId: "alpha", reason: "unknown" });
    expect(state.invalidateActivePlugin).not.toHaveBeenCalled();
    state.receive({ pluginId: "alpha", reason: "reset" });
    expect(state.invalidateActivePlugin).toHaveBeenCalledTimes(1);
    expect(state.invalidateActivePlugin).toHaveBeenCalledWith({ pluginId: "alpha", reason: "reset" });
    expect(vi.getTimerCount()).toBe(0);
    state.lifecycle.dispose();
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps an unrelated active frame and coalesces catalog changes in one burst", async () => {
    vi.useFakeTimers();
    const state = await setup();
    for (const reason of ["installed", "updated", "removed", "enabled", "disabled"]) state.receive({ pluginId: "beta", reason });
    expect(state.invalidateActivePlugin).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    expect(state.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    state.lifecycle.dispose();
  });

  it("merges changes during an in-flight catalog read into one follow-up and cancels queued refresh on destroy", async () => {
    vi.useFakeTimers();
    const state = await setup();
    const held = deferred<void>();
    state.refreshCatalog.mockImplementationOnce(() => held.promise);
    state.receive({ pluginId: "alpha", reason: "updated" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.refreshCatalog).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) state.receive({ pluginId: "beta", reason: "installed" });
    expect(vi.getTimerCount()).toBe(0);
    held.resolve();
    await vi.runAllTimersAsync();
    expect(state.refreshCatalog).toHaveBeenCalledTimes(2);
    state.receive({ pluginId: "beta", reason: "removed" });
    state.lifecycle.dispose();
    await vi.runAllTimersAsync();
    expect(state.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it("rejects delayed activations of mutated plugins while allowing an unrelated pending plugin", async () => {
    const state = await setup();
    const before = state.lifecycle.beginActivation();
    state.receive({ pluginId: "beta", reason: "reset" });
    expect(state.lifecycle.isCurrent(before, "alpha")).toBe(true);
    expect(state.lifecycle.isCurrent(before, "beta")).toBe(false);
    const after = state.lifecycle.beginActivation();
    expect(state.lifecycle.isCurrent(before, "alpha")).toBe(false);
    expect(state.lifecycle.isCurrent(after, "beta")).toBe(true);
    state.lifecycle.cancelActivation();
    expect(state.lifecycle.isCurrent(after, "alpha")).toBe(false);
    state.lifecycle.dispose();
    expect(state.lifecycle.isCurrent(state.lifecycle.beginActivation(), "alpha")).toBe(false);
  });

  it("bounds mutation tracking and conservatively rejects activations older than evicted records", async () => {
    const state = await setup();
    const old = state.lifecycle.beginActivation();
    for (let i = 0; i < 300; i++) state.receive({ pluginId: `plugin-${i}`, reason: "reset" });
    expect(state.lifecycle.isCurrent(old, "untouched")).toBe(false);
    const recent = state.lifecycle.beginActivation();
    expect(state.lifecycle.isCurrent(recent, "untouched")).toBe(true);
    state.lifecycle.dispose();
  });

  it("removes a late asynchronous subscription after unmount and ignores its late events", async () => {
    vi.useFakeTimers();
    const late = deferred<() => void>();
    let receive!: (payload: unknown) => void;
    const stop = vi.fn();
    const invalidateActivePlugin = vi.fn();
    const refreshCatalog = vi.fn(async () => {});
    const subscribe = vi.fn(handler => { receive = handler; return late.promise; });
    const lifecycle = createPluginCodeLifecycle({ subscribe, activePluginId: () => "alpha", invalidateActivePlugin, refreshCatalog });
    const started = lifecycle.start();
    expect(lifecycle.start()).toBe(started);
    await Promise.resolve();
    lifecycle.dispose();
    receive({ pluginId: "alpha", reason: "updated" });
    late.resolve(stop);
    await started;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(invalidateActivePlugin).not.toHaveBeenCalled();
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a listener failure without preventing local activation or creating retries", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const lifecycle = createPluginCodeLifecycle({ subscribe: async () => { throw new Error("not available"); }, activePluginId: () => null, invalidateActivePlugin: vi.fn(), refreshCatalog: vi.fn(), onError });
    await lifecycle.start();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(lifecycle.isCurrent(lifecycle.beginActivation(), "alpha")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.dispose();
  });

  it("waits for asynchronous late unsubscription in both start and dispose", async () => {
    const late = deferred<PluginLifecycleCleanup>();
    const cleanup = deferred<void>();
    const stop = vi.fn(() => cleanup.promise);
    const lifecycle = createPluginCodeLifecycle({ subscribe: () => late.promise, activePluginId: () => null, invalidateActivePlugin: vi.fn(), refreshCatalog: vi.fn() });
    let started = false;
    let disposed = false;
    const start = lifecycle.start().then(() => { started = true; });
    await Promise.resolve();
    const disposal = lifecycle.dispose();
    expect(lifecycle.dispose()).toBe(disposal);
    const stopWaiting = disposal.then(() => { disposed = true; });
    late.resolve(stop);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(started).toBe(false);
    expect(disposed).toBe(false);
    cleanup.resolve();
    await Promise.all([start, stopWaiting]);
    expect(started).toBe(true);
    expect(disposed).toBe(true);
  });

  it.each([false, true])("catches rejected asynchronous unsubscription, including late cleanup: %s", async lateSubscription => {
    const late = deferred<PluginLifecycleCleanup>();
    const failure = new Error("unsubscribe failed");
    const stop = vi.fn(async () => { throw failure; });
    const onError = vi.fn();
    const lifecycle = createPluginCodeLifecycle({ subscribe: () => lateSubscription ? late.promise : Promise.resolve(stop), activePluginId: () => null, invalidateActivePlugin: vi.fn(), refreshCatalog: vi.fn(), onError });
    const start = lifecycle.start();
    if (!lateSubscription) await start;
    else await Promise.resolve();
    const disposal = lifecycle.dispose();
    if (lateSubscription) late.resolve(stop);
    await Promise.all([start, disposal]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
