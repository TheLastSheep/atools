import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type {
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const PLUGINS_CHANGED_EVENT = "atools://renderer-plugins-changed";

const oldPlugin = {
  id: "old-plugin",
  name: "Old plugin",
  version: "1.0.0",
  path: "/plugins/old-plugin",
  enabled: true,
  source_kind: "builtin",
  manifest: { features: [{ code: "old-feature", cmds: ["old"] }] },
};

const newPlugin = {
  id: "new-plugin",
  name: "New plugin",
  version: "1.0.0",
  path: "/plugins/new-plugin",
  enabled: true,
  source_kind: "builtin",
  manifest: { features: [{ code: "new-feature", cmds: ["new"] }] },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function pluginTransport() {
  let plugins: unknown[] = [];
  let listBehavior: ((call: number) => unknown | Promise<unknown>) | undefined;
  let listCalls = 0;
  let activeListCalls = 0;
  let maxListCallsInFlight = 0;
  const listeners = new Map<string, Set<RendererHostListener>>();
  const unlistenEvents: string[] = [];
  const transport: ZToolsRendererTransport = {
    async invoke(command) {
      if (command !== "list_plugins") throw new Error(`unexpected command: ${command}`);
      const call = ++listCalls;
      activeListCalls += 1;
      maxListCallsInFlight = Math.max(maxListCallsInFlight, activeListCalls);
      try {
        const response = listBehavior ? await listBehavior(call) : structuredClone(plugins);
        return structuredClone(response);
      } finally {
        activeListCalls -= 1;
      }
    },
    listen(event, handler): Promise<RendererHostUnlisten> {
      const handlers = listeners.get(event) ?? new Set<RendererHostListener>();
      handlers.add(handler);
      listeners.set(event, handlers);
      return Promise.resolve(() => {
        handlers.delete(handler);
        unlistenEvents.push(event);
      });
    },
  };

  return {
    transport,
    get listCalls() { return listCalls; },
    get activeListCalls() { return activeListCalls; },
    get maxListCallsInFlight() { return maxListCallsInFlight; },
    get unlistenEvents() { return [...unlistenEvents]; },
    setPlugins(value: unknown[]) { plugins = value; },
    setListBehavior(value: (call: number) => unknown | Promise<unknown>) {
      listBehavior = value;
    },
    emit(event: string, payload: unknown = null) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
  };
}

describe("original Main plugin refresh consumer", () => {
  it("returns isolated plugin clones with optional mapped metadata intact", async () => {
    const fixture = pluginTransport();
    fixture.setPlugins([{
      ...oldPlugin,
      manifest: {
        ...oldPlugin.manifest,
        title: "Plugin title",
        logo: "plugin.svg",
        description: "Plugin description",
        main: "index.html",
        features: [{ code: "old-feature", cmds: ["old"], metadata: { source: "fixture" } }],
      },
    }]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });

    try {
      const first = await adapter.api.getAllPlugins();
      expect(first[0]).toMatchObject({
        title: "Plugin title",
        logo: "plugin.svg",
        description: "Plugin description",
        main: "index.html",
      });
      (first[0].features[0].cmds as unknown[])[0] = "changed";
      (first[0].features[0].metadata as Record<string, unknown>).source = "changed";
      first[0].title = "changed";

      const second = await adapter.api.getAllPlugins();
      expect(second[0]).toMatchObject({
        title: "Plugin title",
        logo: "plugin.svg",
        description: "Plugin description",
        main: "index.html",
        features: [{ code: "old-feature", cmds: ["old"], metadata: { source: "fixture" } }],
      });
      expect(second[0]).not.toBe(first[0]);
      expect(second[0].features[0]).not.toBe(first[0].features[0]);
    } finally {
      adapter.dispose();
    }
  });

  it("starts every consumer in a batch immediately and waits before the trailing batch", async () => {
    const fixture = pluginTransport();
    fixture.setPlugins([oldPlugin]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await adapter.api.getAllPlugins();

    const firstCallbackGate = deferred<void>();
    const invocationOrder: string[] = [];
    let firstCallbackCalls = 0;
    let secondCallbackCalls = 0;
    const removeFirst = adapter.api.onPluginsChanged(async () => {
      firstCallbackCalls += 1;
      invocationOrder.push(`first:${firstCallbackCalls}`);
      if (firstCallbackCalls === 1) await firstCallbackGate.promise;
    });
    const removeSecond = adapter.api.onPluginsChanged(() => {
      secondCallbackCalls += 1;
      invocationOrder.push(`second:${secondCallbackCalls}`);
    });

    try {
      fixture.emit(PLUGINS_CHANGED_EVENT);
      expect(invocationOrder).toEqual(["first:1", "second:1"]);

      fixture.emit(PLUGINS_CHANGED_EVENT);
      await flushMicrotasks();
      expect(invocationOrder).toEqual(["first:1", "second:1"]);

      firstCallbackGate.resolve();
      await vi.waitFor(() => {
        expect(invocationOrder).toEqual(["first:1", "second:1", "first:2", "second:2"]);
      });
      expect(adapter.snapshot().pluginCatalog.callbackErrors).toBe(0);
    } finally {
      firstCallbackGate.resolve();
      removeFirst();
      removeSecond();
      adapter.dispose();
      await flushMicrotasks();
    }
  });

  it("does not let an older async consumer apply its snapshot after a newer refresh", async () => {
    const fixture = pluginTransport();
    fixture.setPlugins([oldPlugin]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await adapter.api.getAllPlugins();

    const firstConsumerGate = deferred<void>();
    const firstReadCompleted = deferred<void>();
    let firstReadIds: string[] = [];
    let callbackCalls = 0;
    let activeCallbacks = 0;
    let maxCallbacksInFlight = 0;
    const appliedIds: string[][] = [];
    let publishedIds: string[] = [];
    fixture.setListBehavior((call) => call === 2 ? [oldPlugin] : [newPlugin]);

    const remove = adapter.api.onPluginsChanged(async () => {
      const call = ++callbackCalls;
      activeCallbacks += 1;
      maxCallbacksInFlight = Math.max(maxCallbacksInFlight, activeCallbacks);
      try {
        const plugins = await adapter.api.getAllPlugins();
        if (call === 1) {
          firstReadIds = plugins.map((plugin) => plugin.id);
          firstReadCompleted.resolve();
          await firstConsumerGate.promise;
        }
        publishedIds = plugins.map((plugin) => plugin.id);
        appliedIds.push(publishedIds);
      } finally {
        activeCallbacks -= 1;
      }
    });

    try {
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await firstReadCompleted.promise;
      expect(firstReadIds).toEqual(["old-plugin"]);

      fixture.setPlugins([newPlugin]);
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await flushMicrotasks();

      firstConsumerGate.resolve();
      await vi.waitFor(() => {
        expect(callbackCalls).toBe(2);
        expect(activeCallbacks).toBe(0);
      });
      expect(maxCallbacksInFlight).toBe(1);
      expect(appliedIds).toEqual([["old-plugin"], ["new-plugin"]]);
      expect(publishedIds).toEqual(["new-plugin"]);
    } finally {
      firstConsumerGate.resolve();
      remove();
      adapter.dispose();
      await flushMicrotasks();
    }
  });

  it("serializes async callbacks and coalesces a 20-event burst to one trailing read", async () => {
    const fixture = pluginTransport();
    fixture.setPlugins([oldPlugin]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await adapter.api.getAllPlugins();
    const baselineListCalls = fixture.listCalls;

    const firstListResponse = deferred<unknown>();
    const releaseCallbacks = deferred<void>();
    const firstCallbackReadCompleted = deferred<void>();
    fixture.setPlugins([newPlugin]);
    fixture.setListBehavior((call) =>
      call === baselineListCalls + 1 ? firstListResponse.promise : [newPlugin],
    );

    let callbackCalls = 0;
    let activeCallbacks = 0;
    let maxCallbacksInFlight = 0;
    let publishedIds: string[] = [];
    const remove = adapter.api.onPluginsChanged(async () => {
      const callbackId = ++callbackCalls;
      activeCallbacks += 1;
      maxCallbacksInFlight = Math.max(maxCallbacksInFlight, activeCallbacks);
      try {
        const plugins = await adapter.api.getAllPlugins();
        if (callbackId === 1) firstCallbackReadCompleted.resolve();
        await releaseCallbacks.promise;
        publishedIds = plugins.map((plugin) => plugin.id);
      } finally {
        activeCallbacks -= 1;
      }
    });

    try {
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await vi.waitFor(() => expect(fixture.listCalls).toBe(baselineListCalls + 1));
      for (let event = 1; event < 20; event += 1) {
        fixture.setPlugins([newPlugin]);
        fixture.emit(PLUGINS_CHANGED_EVENT);
        await flushMicrotasks(2);
      }

      firstListResponse.resolve([oldPlugin]);
      await firstCallbackReadCompleted.promise;
      releaseCallbacks.resolve();
      await vi.waitFor(() => {
        expect(callbackCalls).toBe(2);
        expect(activeCallbacks).toBe(0);
      });
      await flushMicrotasks();

      expect(callbackCalls).toBe(2);
      expect(maxCallbacksInFlight).toBe(1);
      expect(fixture.listCalls - baselineListCalls).toBe(2);
      expect(fixture.maxListCallsInFlight).toBe(1);
      expect(publishedIds).toEqual(["new-plugin"]);
    } finally {
      adapter.dispose();
      firstListResponse.resolve([oldPlugin]);
      releaseCallbacks.resolve();
      await flushMicrotasks();
      remove();
    }
  });

  it("does not refresh on invalid native payloads", async () => {
    const fixture = pluginTransport();
    fixture.setPlugins([oldPlugin]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await adapter.api.getAllPlugins();
    const baselineListCalls = fixture.listCalls;
    const callback = vi.fn(async () => adapter.api.getAllPlugins());
    const remove = adapter.api.onPluginsChanged(callback);

    try {
      fixture.emit(PLUGINS_CHANGED_EVENT, { unexpected: true });
      await flushMicrotasks();
      expect(callback).not.toHaveBeenCalled();
      expect(fixture.listCalls).toBe(baselineListCalls);
    } finally {
      remove();
      adapter.dispose();
    }
  });

  it("contains async callback rejection and continues delivering later changes", async () => {
    const fixture = pluginTransport();
    fixture.setPlugins([oldPlugin]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await adapter.api.getAllPlugins();
    let shouldReject = true;
    const rejectingCallback = vi.fn(async () => {
      if (shouldReject) {
        shouldReject = false;
        throw new Error("controlled async callback failure");
      }
    });
    const healthyCallback = vi.fn();
    const removeRejecting = adapter.api.onPluginsChanged(rejectingCallback);
    const removeHealthy = adapter.api.onPluginsChanged(healthyCallback);

    try {
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await vi.waitFor(() => expect(adapter.snapshot().pluginCatalog.callbackErrors).toBe(1));
      expect(healthyCallback).toHaveBeenCalledTimes(1);
      const readsAfterFailure = fixture.listCalls;
      await flushMicrotasks();
      expect(fixture.listCalls).toBe(readsAfterFailure);

      fixture.emit(PLUGINS_CHANGED_EVENT);
      await vi.waitFor(() => expect(healthyCallback).toHaveBeenCalledTimes(2));
      expect(rejectingCallback).toHaveBeenCalledTimes(2);
      expect(adapter.snapshot().pluginCatalog.callbackErrors).toBe(1);
    } finally {
      removeRejecting();
      removeHealthy();
      adapter.dispose();
      await flushMicrotasks();
    }
  });

  it.each(["unsubscribe", "dispose"] as const)(
    "does not deliver a queued refresh after %s",
    async (cleanupMode) => {
      const fixture = pluginTransport();
      fixture.setPlugins([oldPlugin]);
      const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
      await adapter.api.getAllPlugins();
      const callbackGate = deferred<void>();
      const firstReadCompleted = deferred<void>();
      let callbackCalls = 0;
      const remove = adapter.api.onPluginsChanged(async () => {
        callbackCalls += 1;
        await adapter.api.getAllPlugins();
        if (callbackCalls === 1) firstReadCompleted.resolve();
        await callbackGate.promise;
      });

      try {
        fixture.emit(PLUGINS_CHANGED_EVENT);
        await firstReadCompleted.promise;
        fixture.setPlugins([newPlugin]);
        fixture.emit(PLUGINS_CHANGED_EVENT);
        await flushMicrotasks();
        const callsBeforeCleanup = callbackCalls;

        if (cleanupMode === "unsubscribe") {
          remove();
          callbackGate.resolve();
        } else {
          adapter.dispose();
        }
        await flushMicrotasks();

        expect(callsBeforeCleanup).toBe(1);
        expect(callbackCalls).toBe(1);
        expect(fixture.listCalls).toBe(2);
        if (cleanupMode === "dispose") {
          expect(adapter.snapshot().disposed).toBe(true);
          expect(adapter.snapshot().pluginCatalog.callbackErrors).toBe(0);
        }
      } finally {
        callbackGate.resolve();
        remove();
        adapter.dispose();
        await flushMicrotasks();
      }
    },
  );
});
