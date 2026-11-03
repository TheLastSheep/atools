import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeControl } from "../../src/lib/pluginRuntimeControl";
import { createPluginRuntimeInventoryLoader } from "../../src/lib/pluginRuntimeInventoryLoader";
import { runtimeKinds, runtimeSessionId, type RuntimeKind, type RuntimeSession, type RuntimeSnapshot } from "../../src/lib/pluginRuntimeInventory";

function row(pluginId: string, instanceId: string, kind: RuntimeKind = "background", revision = "a".repeat(64)): RuntimeSession {
  const windowLabel = "main";
  return Object.freeze({ id: runtimeSessionId(kind, windowLabel, instanceId), kind, instanceId, pluginId, windowLabel,
    codeRevision: revision, phase: "ready", evidence: kind === "legacy_node" ? "node_owner" : "admission" });
}
function nativeSnapshot(sessions: readonly RuntimeSession[], unavailable: RuntimeKind[] = [], truncated = false): RuntimeSnapshot {
  return { schemaVersion: 1, sessions, coverage: runtimeKinds.map(kind => ({ kind, available: !unavailable.includes(kind) })), truncated };
}
function controlWith(rows: RuntimeSession[] = []) {
  const control = createPluginRuntimeControl();
  let current = [...rows];
  const stop = vi.fn(async (target: RuntimeSession) => {
    current = current.filter(item => item.id !== target.id || item.codeRevision !== target.codeRevision);
    control.changed();
  });
  const unregister = control.registerSource("loader-test", { snapshot: () => current, stop });
  return { control, stop, update(next: RuntimeSession[]) { current = [...next]; control.changed(); }, unregister };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("plugin runtime inventory loader", () => {
  it("reads one native snapshot and exposes parsed coverage without polling", async () => {
    const invoke = vi.fn(async () => nativeSnapshot([row("native-tool", "native-1")]));
    const loader = createPluginRuntimeInventoryLoader({ invoke, control: undefined });
    expect(invoke).not.toHaveBeenCalled();
    await loader.refresh();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("list_plugin_runtime_sessions");
    expect(loader.snapshot()).toMatchObject({ phase: "ready", truncated: false, sessions: [{ pluginId: "native-tool" }] });
    loader.dispose();
  });

  it("keeps the latest generation when an older native reply arrives late", async () => {
    const replies = [deferred<unknown>(), deferred<unknown>()];
    let replyIndex = 0;
    const invoke = vi.fn(() => replies[replyIndex++].promise);
    const loader = createPluginRuntimeInventoryLoader({ invoke, control: undefined });
    const oldRead = loader.refresh();
    const newRead = loader.refresh();
    replies[1].resolve(nativeSnapshot([row("new", "new-instance")]));
    await newRead;
    replies[0].resolve(nativeSnapshot([row("old", "old-instance")]));
    await oldRead;
    expect(loader.snapshot().sessions.map(item => item.pluginId)).toEqual(["new"]);
    loader.dispose();
  });

  it("keeps current local rows on native error and never renders an old native snapshot as current", async () => {
    const local = row("local-tool", "local-1");
    const ownership = controlWith([local]);
    const invoke = vi.fn().mockResolvedValueOnce(nativeSnapshot([row("native-tool", "native-1")]))
      .mockRejectedValueOnce(new Error("raw native cause"));
    const loader = createPluginRuntimeInventoryLoader({ invoke, control: ownership.control });
    await loader.refresh();
    expect(loader.snapshot().sessions.map(item => item.pluginId)).toEqual(["local-tool", "native-tool"]);
    await loader.refresh();
    expect(loader.snapshot()).toMatchObject({ phase: "error", staleNative: true, sessions: [local] });
    expect(JSON.stringify(loader.snapshot())).not.toContain("raw native cause");
    loader.dispose(); ownership.unregister(); ownership.control.dispose();
  });

  it("preserves local precedence for exact identity but does not overwrite a different revision", async () => {
    const native = row("same-plugin", "same-instance", "background", "b".repeat(64));
    const local = { ...native, codeRevision: "a".repeat(64), evidence: "admission" as const };
    const ownership = controlWith([local]);
    const loader = createPluginRuntimeInventoryLoader({ invoke: async () => nativeSnapshot([native]), control: ownership.control });
    await loader.refresh();
    expect(loader.snapshot().sessions).toEqual([native]);
    loader.dispose(); ownership.unregister(); ownership.control.dispose();
  });

  it("stops only a current local row and performs one native read after confirmed success", async () => {
    const local = Object.freeze({ ...row("background-tool", "owner-1"), evidence: "renderer_view" as const });
    const ownership = controlWith([local]);
    const invoke = vi.fn(async () => nativeSnapshot([]));
    const loader = createPluginRuntimeInventoryLoader({ invoke, control: ownership.control });
    expect(loader.canStop(local)).toBe(true);
    expect(await loader.stop(local)).toBe("stopped");
    expect(ownership.stop).toHaveBeenCalledOnce();
    expect(ownership.stop).toHaveBeenCalledWith(local);
    expect(invoke).toHaveBeenCalledOnce();
    expect(loader.snapshot().sessions).toEqual([]);
    loader.dispose(); ownership.unregister(); ownership.control.dispose();
  });

  it("treats an owner replaced before stop confirmation as stale and refreshes current rows", async () => {
    const oldRow = Object.freeze({ ...row("background-tool", "same-owner", "background", "a".repeat(64)), evidence: "renderer_view" as const });
    const currentRow = Object.freeze({ ...row("background-tool", "same-owner", "background", "b".repeat(64)), evidence: "renderer_view" as const });
    const control = createPluginRuntimeControl();
    const oldStop = vi.fn(async () => {});
    let oldRows = [oldRow];
    const releaseOld = control.registerSource("owner", { snapshot: () => oldRows, stop: oldStop });
    expect(control.snapshot()).toEqual([oldRow]);
    const invoke = vi.fn(async () => nativeSnapshot([]));
    const loader = createPluginRuntimeInventoryLoader({ invoke, control });

    expect(loader.canStop(oldRow)).toBe(true);
    const stopping = loader.stop(oldRow);
    releaseOld();
    const newStop = vi.fn(async () => {});
    let currentRows = [currentRow];
    const releaseCurrent = control.registerSource("owner", { snapshot: () => currentRows, stop: newStop });

    await expect(stopping).resolves.toBe("stale");
    expect(oldStop).not.toHaveBeenCalled();
    expect(newStop).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(loader.snapshot().sessions).toEqual([currentRow]);

    loader.dispose();
    releaseCurrent();
    control.dispose();
  });

  it("disposal invalidates pending reads and consumes their late rejection", async () => {
    const reply = deferred<unknown>();
    const invoke = vi.fn(() => reply.promise);
    const loader = createPluginRuntimeInventoryLoader({ invoke, control: undefined });
    const subscriber = vi.fn();
    loader.subscribe(subscriber);
    const read = loader.refresh();
    loader.dispose();
    subscriber.mockClear();
    reply.reject(new Error("late native failure"));
    await expect(read).resolves.toBeUndefined();
    expect(subscriber).not.toHaveBeenCalled();
  });
});
