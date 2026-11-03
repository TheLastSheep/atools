import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type {
  RendererHostCommand,
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const PLUGINS_CHANGED_EVENT = "atools://renderer-plugins-changed";
const timestampPlugin = {
  id: "timestamp",
  name: "Timestamp",
  version: "1.0.0",
  path: "/resources/plugins/builtin/timestamp",
  enabled: true,
  source_kind: "builtin",
  manifest: {
    name: "Timestamp",
    title: "时间戳",
    version: "1.0.0",
    main: "index.html",
    features: [{ code: "timestamp", cmds: ["timestamp"] }],
  },
};
const disabledPlugin = {
  ...timestampPlugin,
  id: "disabled",
  name: "Disabled",
  path: "/plugins/disabled",
  enabled: false,
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

function inventoryTransport() {
  let plugins: unknown[] = [];
  let listBehavior: ((call: number) => unknown | Promise<unknown>) | undefined;
  let pluginListenFailures = 0;
  let listCalls = 0;
  const listeners = new Map<string, Set<RendererHostListener>>();
  const commands: RendererHostCommand[] = [];
  const listenCalls: string[] = [];
  const operations: string[] = [];
  const unlistenEvents: string[] = [];
  const transport: ZToolsRendererTransport = {
    async invoke(command) {
      commands.push(command);
      operations.push(`invoke:${command}`);
      if (command !== "list_plugins") throw new Error(`unexpected command: ${command}`);
      listCalls += 1;
      return listBehavior ? listBehavior(listCalls) : structuredClone(plugins);
    },
    listen(event, handler): Promise<RendererHostUnlisten> {
      listenCalls.push(event);
      operations.push(`listen:${event}`);
      if (event === PLUGINS_CHANGED_EVENT && pluginListenFailures > 0) {
        pluginListenFailures -= 1;
        return Promise.reject(new Error("temporary listener failure"));
      }
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
    commands,
    listenCalls,
    operations,
    unlistenEvents,
    get listCalls() { return listCalls; },
    setPlugins(value: unknown[]) { plugins = value; },
    setListBehavior(value: (call: number) => unknown | Promise<unknown>) { listBehavior = value; },
    failNextListen() { pluginListenFailures += 1; },
    emit(event: string, payload: unknown = null) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
  };
}

describe("original renderer plugin inventory", () => {
  it("waits for the targeted main-webview listener and refreshes after built-ins load", async () => {
    const fixture = inventoryTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });

    await expect(adapter.api.getAllPlugins()).resolves.toEqual([]);
    fixture.setPlugins([timestampPlugin]);
    fixture.emit(PLUGINS_CHANGED_EVENT);

    await expect(adapter.api.getAllPlugins()).resolves.toMatchObject([
      { id: "timestamp", name: "Timestamp", sourceKind: "builtin" },
    ]);
    expect(fixture.listenCalls.filter((event) => event === PLUGINS_CHANGED_EVENT))
      .toEqual([PLUGINS_CHANGED_EVENT]);
    expect(fixture.operations.indexOf(`listen:${PLUGINS_CHANGED_EVENT}`))
      .toBeLessThan(fixture.operations.indexOf("invoke:list_plugins"));
    expect(fixture.commands).toEqual(["list_plugins", "list_plugins"]);
    adapter.dispose();
    expect(fixture.unlistenEvents.filter((event) => event === PLUGINS_CHANGED_EVENT)).toHaveLength(1);
  });

  it("shares one in-flight inventory read between all and disabled plugin queries", async () => {
    const fixture = inventoryTransport();
    const pending = deferred<unknown>();
    fixture.setListBehavior(() => pending.promise);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });

    const all = adapter.api.getAllPlugins();
    const disabled = adapter.api.getDisabledPlugins();
    await vi.waitFor(() => expect(fixture.listCalls).toBe(1));
    pending.resolve([timestampPlugin, disabledPlugin]);

    await expect(all).resolves.toMatchObject([{ id: "timestamp" }, { id: "disabled" }]);
    await expect(disabled).resolves.toEqual(["/plugins/disabled"]);
    expect(fixture.listCalls).toBe(1);
    adapter.dispose();
  });

  it.each(["success", "failure"] as const)(
    "does not let a stale %s read replace the inventory after invalidation",
    async (staleOutcome) => {
      const fixture = inventoryTransport();
      const staleRead = deferred<unknown>();
      fixture.setListBehavior((call) => call === 1 ? staleRead.promise : [timestampPlugin]);
      const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });

      const firstRead = adapter.api.getAllPlugins();
      await vi.waitFor(() => expect(fixture.listCalls).toBe(1));
      fixture.setPlugins([timestampPlugin]);
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await expect(adapter.api.getDisabledPlugins()).resolves.toEqual([]);
      if (staleOutcome === "success") staleRead.resolve([]);
      else staleRead.reject(new Error("stale inventory failure"));

      await expect(firstRead).resolves.toMatchObject([{ id: "timestamp" }]);
      await expect(adapter.api.getAllPlugins()).resolves.toMatchObject([{ id: "timestamp" }]);
      expect(fixture.listCalls).toBe(2);
      adapter.dispose();
    },
  );

  it("retries after listener registration failure instead of caching an unobserved inventory", async () => {
    const fixture = inventoryTransport();
    fixture.failNextListen();
    fixture.setPlugins([timestampPlugin]);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });

    await expect(adapter.api.getAllPlugins()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(fixture.listCalls).toBe(0);
    await expect(adapter.api.getAllPlugins()).resolves.toMatchObject([{ id: "timestamp" }]);
    expect(fixture.listenCalls.filter((event) => event === PLUGINS_CHANGED_EVENT))
      .toEqual([PLUGINS_CHANGED_EVENT, PLUGINS_CHANGED_EVENT]);
    expect(fixture.listCalls).toBe(1);
    adapter.dispose();
  });

  it("replays one pre-subscription change once, without an extra read for a current cache", async () => {
    const fixture = inventoryTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await expect(adapter.api.getAllPlugins()).resolves.toEqual([]);
    fixture.setPlugins([timestampPlugin]);
    fixture.emit(PLUGINS_CHANGED_EVENT);

    let refresh: Promise<unknown> | undefined;
    const firstCallback = vi.fn(() => { refresh = adapter.api.getAllPlugins(); });
    const removeFirst = adapter.api.onPluginsChanged(firstCallback);
    const secondCallback = vi.fn();
    const removeSecond = adapter.api.onPluginsChanged(secondCallback);
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(secondCallback).not.toHaveBeenCalled();
    await expect(refresh).resolves.toMatchObject([{ id: "timestamp" }]);
    await expect(adapter.api.getAllPlugins()).resolves.toMatchObject([{ id: "timestamp" }]);
    expect(fixture.listCalls).toBe(2);
    expect(adapter.snapshot().pluginCatalog.lateSubscriberRefreshes).toBe(1);
    removeFirst();
    removeSecond();
    adapter.dispose();
  });

  it("isolates callback errors and rejects non-null native event payloads", async () => {
    const fixture = inventoryTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await expect(adapter.api.getAllPlugins()).resolves.toEqual([]);
    fixture.setPlugins([timestampPlugin]);
    fixture.emit(PLUGINS_CHANGED_EVENT, { unexpected: true });
    await expect(adapter.api.getAllPlugins()).resolves.toEqual([]);
    expect(fixture.listCalls).toBe(1);
    expect(adapter.snapshot().pluginCatalog.invalidPayloads).toBe(1);

    const throwingCallback = vi.fn(() => { throw new Error("callback failure"); });
    const healthyCallback = vi.fn();
    adapter.api.onPluginsChanged(throwingCallback);
    adapter.api.onPluginsChanged(healthyCallback);
    fixture.emit(PLUGINS_CHANGED_EVENT);
    expect(throwingCallback).toHaveBeenCalledOnce();
    expect(healthyCallback).toHaveBeenCalledOnce();
    expect(adapter.snapshot().pluginCatalog.callbackErrors).toBe(1);
    adapter.dispose();
  });

  it("rejects pending reads on dispose and releases the native listener", async () => {
    const fixture = inventoryTransport();
    const pending = deferred<unknown>();
    fixture.setListBehavior(() => pending.promise);
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const read = adapter.api.getAllPlugins();
    await vi.waitFor(() => expect(fixture.listCalls).toBe(1));

    adapter.dispose();
    await expect(read).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    expect(fixture.unlistenEvents.filter((event) => event === PLUGINS_CHANGED_EVENT)).toHaveLength(1);
    pending.resolve([timestampPlugin]);
  });
});
