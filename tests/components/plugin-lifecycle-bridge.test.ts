// @vitest-environment node
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createPluginLifecycleBridge } from "../../src/lib/pluginLifecycleBridge";

function fixture(readyState: "loading" | "interactive" | "complete" = "complete") {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const domHandlers = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const document = {
    readyState,
    addEventListener(name: string, callback: () => void) { if (name === "DOMContentLoaded") domHandlers.add(callback); },
    removeEventListener(name: string, callback: () => void) { if (name === "DOMContentLoaded") domHandlers.delete(callback); },
    dispatchDomReady() { for (const callback of [...domHandlers]) callback(); },
  };
  const target = { console: { error: vi.fn() }, document,
    addEventListener(name: string, callback: (event: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: (event: unknown) => void) { handlers.get(name)?.delete(callback); },
  };
  const bridge = runInNewContext(`(${createPluginLifecycleBridge.toString()})(window, normalize)`, {
    window: target, Promise,
    setTimeout(callback: () => void, delay: number) { expect(delay).toBe(0); const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    normalize: (detail: Record<string, unknown>) => ({ code: "color", type: "text", payload: null, ...detail }),
  }) as ReturnType<typeof createPluginLifecycleBridge>;
  const dispatch = (name: string, detail?: unknown) => { for (const callback of [...handlers.get(name) ?? []]) callback({ detail }); };
  const runNextTask = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); };
  return { bridge, target, dispatch, handlers, document, domHandlers, timers, runNextTask };
}

describe("serialized plugin lifecycle bridge", () => {
  it("delivers a normal initial entry once with exact action values", async () => {
    const f = fixture(), callback = vi.fn(); f.bridge.onPluginEnter(callback);
    f.dispatch("atools-plugin-enter", { code: "color", payload: " a=b%2F ", option: { exact: true } });
    await Promise.resolve();
    expect(callback.mock.calls).toEqual([[{ code: "color", type: "text", payload: " a=b%2F ", option: { exact: true } }]]);
  });
  it("replays the current activation to a callback registered after document readiness", async () => {
    const f = fixture(), callback = vi.fn(); f.dispatch("atools-plugin-enter");
    f.bridge.onPluginEnter(callback); expect(callback).not.toHaveBeenCalled();
    await Promise.resolve(); expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].code).toBe("color");
  });
  it("does not replay a stale entry when a new activation arrives before the microtask", async () => {
    const f = fixture(), callback = vi.fn(); f.dispatch("atools-plugin-enter", { code: "old" });
    f.bridge.onPluginEnter(callback); f.dispatch("atools-plugin-enter", { code: "new" });
    await Promise.resolve(); expect(callback.mock.calls.map(([action]) => action.code)).toEqual(["new"]);
    f.dispatch("atools-plugin-enter", { code: "third" });
    expect(callback.mock.calls.map(([action]) => action.code)).toEqual(["new", "third"]);
  });
  it("replaces callbacks without replaying an already consumed activation", async () => {
    const f = fixture(), first = vi.fn(), replacement = vi.fn();
    f.dispatch("atools-plugin-enter", { code: "pending" });
    f.bridge.onPluginEnter(first); f.bridge.onPluginEnter(replacement); await Promise.resolve();
    expect(first).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledTimes(1);
    const third = vi.fn(); f.bridge.onPluginEnter(third); await Promise.resolve();
    expect(third).not.toHaveBeenCalled();
    f.dispatch("atools-plugin-enter", { code: "future" }); expect(third).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
  it("buffers only the latest undelivered activation", async () => {
    const f = fixture(), callback = vi.fn();
    f.dispatch("atools-plugin-enter", { code: "old" }); f.dispatch("atools-plugin-enter", { code: "latest" });
    f.bridge.onPluginEnter(callback); await Promise.resolve();
    expect(callback.mock.calls.map(([action]) => action.code)).toEqual(["latest"]);
  });
  it("clears pending replay and subscriptions on out/pagehide/dispose", async () => {
    for (const end of ["atools-plugin-out", "pagehide", "dispose"]) {
      const f = fixture(), enter = vi.fn(); f.dispatch("atools-plugin-enter"); f.bridge.onPluginEnter(enter);
      if (end === "dispose") f.bridge.dispose(); else f.dispatch(end);
      await Promise.resolve(); f.dispatch("atools-plugin-enter");
      expect(enter).not.toHaveBeenCalled();
      expect([...f.handlers.values()].every(callbacks => callbacks.size === 0)).toBe(true);
    }
  });
  it("reports throwing and rejected callbacks and still accepts a replacement", async () => {
    const f = fixture(), good = vi.fn();
    f.bridge.onPluginEnter(() => { throw Error("sync fixture error"); }); f.dispatch("atools-plugin-enter");
    f.bridge.onPluginEnter(() => Promise.reject(Error("async fixture error"))); f.dispatch("atools-plugin-enter");
    for (let step = 0; step < 5; step++) await Promise.resolve();
    f.bridge.onPluginEnter(good); f.dispatch("atools-plugin-enter");
    expect(good).toHaveBeenCalledTimes(1); expect(f.target.console.error).toHaveBeenCalledTimes(2);
  });
  it("starts once on a next task after all synchronous DOMContentLoaded handlers", () => {
    const f = fixture("loading"), order: string[] = [], start = vi.fn(() => order.push("start"));
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start);
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start);
    f.document.addEventListener("DOMContentLoaded", () => order.push("plugin-editor-init"));
    f.document.dispatchDomReady();
    expect(order).toEqual(["plugin-editor-init"]);
    expect(start).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(1);
    f.runNextTask(); f.runNextTask();
    expect(order).toEqual(["plugin-editor-init", "start"]);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("uses one next-task for interactive documents without waiting for a second DOMContentLoaded", async () => {
    const f = fixture("interactive"), start = vi.fn();
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start);
    expect(f.timers.size).toBe(1); expect(start).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    f.runNextTask(); expect(start).toHaveBeenCalledTimes(1);
    f.document.dispatchDomReady(); f.runNextTask();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("does not start in a microtask after DOMContentLoaded", async () => {
    const f = fixture("loading"), start = vi.fn();
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start);
    f.document.dispatchDomReady();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled(); expect(f.timers.size).toBe(1);
    f.runNextTask(); expect(start).toHaveBeenCalledTimes(1);
  });
  it("uses one next-task for already-ready documents after pending microtasks", async () => {
    const f = fixture("complete"), start = vi.fn();
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start);
    expect(start).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled(); expect(f.timers.size).toBe(1);
    f.runNextTask(); expect(start).toHaveBeenCalledTimes(1);
  });
  it("cancels the queued start when disposed before DOM readiness", () => {
    const f = fixture("loading"), start = vi.fn();
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start); f.bridge.dispose(); f.document.dispatchDomReady(); f.runNextTask();
    expect(start).not.toHaveBeenCalled(); expect(f.domHandlers.size).toBe(0); expect(f.timers.size).toBe(0);
  });
  it("cancels the queued next-task when an interactive document is disposed", () => {
    const f = fixture("interactive"), start = vi.fn();
    f.bridge.startWhenDocumentReady(f.document as unknown as Document, start);
    expect(f.timers.size).toBe(1);
    f.bridge.dispose(); f.runNextTask();
    expect(start).not.toHaveBeenCalled(); expect(f.timers.size).toBe(0);
  });
  it("cancels the single queued task when disposed after DOM readiness", () => {
    for (const end of ["atools-plugin-out", "pagehide"]) {
      const f = fixture("loading"), start = vi.fn();
      f.bridge.startWhenDocumentReady(f.document as unknown as Document, start); f.document.dispatchDomReady();
      expect(f.timers.size).toBe(1); f.dispatch(end); f.runNextTask();
      expect(start).not.toHaveBeenCalled(); expect(f.timers.size).toBe(0);
    }
  });

});
