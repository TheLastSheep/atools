import { describe, expect, it, vi } from "vitest";
import { createRendererCommandAliasEvents, RENDERER_COMMAND_ALIASES_EVENT } from "../../packages/ztools-renderer/src/commandAliasEvents";
import { RENDERER_DISABLED_COMMANDS_EVENT } from "../../packages/ztools-renderer/src/commandInvalidationEvents";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type { RendererHostListener, RendererHostUnlisten, RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

const ALIASES_KEY = "ztools-renderer:command-aliases";
const DISABLED_COMMANDS_KEY = "ztools-renderer:disable-commands";
const APPS = [{ name: "Example", path: "/Applications/Example.app" }];

function settings(aliasValue: string | null, disabledValue: string | null = null) {
  const namespaced: Record<string, string | null> = Object.fromEntries(
    [...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
  );
  namespaced[ALIASES_KEY] = aliasValue;
  namespaced[DISABLED_COMMANDS_KEY] = disabledValue;
  return { version: 1, settings: { "settings-general": null, ...namespaced } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

describe("renderer command alias events", () => {
  it("keeps the internal invalidator active before any renderer callback is registered", async () => {
    let currentAliases = JSON.stringify({ app: [{ alias: "Before" }] });
    let emit!: RendererHostListener;
    let batchLoads = 0;
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        async invoke(command) {
          if (command !== "get_ztools_renderer_settings") throw new Error(`Unexpected route ${command}`);
          batchLoads += 1;
          return settings(currentAliases);
        },
        async listen(event, handler) {
          if (event === RENDERER_COMMAND_ALIASES_EVENT) emit = handler;
          return vi.fn();
        },
      },
    });
    await vi.waitFor(() => expect(adapter.snapshot().commandAliasEvents.listenerState).toBe("listening"));
    expect(adapter.snapshot().commandAliasEvents.callbacks).toBe(0);
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "Before" }] });

    currentAliases = JSON.stringify({ app: [{ alias: "After" }] });
    emit(null);
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "After" }] });
    expect(batchLoads).toBe(2);
    adapter.dispose();
  });

  it("activates disabled-command notifications with isolated cache invalidation and callbacks", async () => {
    let currentAliases = JSON.stringify({ app: [{ alias: "Before" }] });
    let currentDisabled = JSON.stringify(["old-command"]);
    const listeners = new Map<string, RendererHostListener>();
    let batchLoads = 0;
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        async invoke(command) {
          if (command !== "get_ztools_renderer_settings") throw new Error(`Unexpected route ${command}`);
          batchLoads += 1;
          return settings(currentAliases, currentDisabled);
        },
        async listen(event, handler) {
          listeners.set(event, handler);
          return vi.fn();
        },
      },
    });
    await vi.waitFor(() => expect(adapter.snapshot().disabledCommandsEvents.listenerState).toBe("listening"));
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "Before" }] });
    await expect(adapter.api.dbGet("disable-commands")).resolves.toEqual(["old-command"]);

    const aliasCallback = vi.fn();
    const disabledFailure = vi.fn(() => Promise.reject(new Error("private callback detail")));
    let callbackRead: Promise<unknown> | undefined;
    const disabledSuccess = vi.fn(() => { callbackRead = adapter.api.dbGet("disable-commands"); });
    adapter.api.onCommandAliasesChanged(aliasCallback);
    adapter.api.onDisabledCommandsChanged(disabledFailure);
    adapter.api.onDisabledCommandsChanged(disabledSuccess);
    await vi.waitFor(() => expect(adapter.snapshot().commandAliasEvents.callbacks).toBe(1));

    listeners.get(RENDERER_DISABLED_COMMANDS_EVENT)?.({ changed: true });
    expect(disabledSuccess).not.toHaveBeenCalled();
    expect(adapter.snapshot().disabledCommandsEvents.invalidPayloads).toBe(1);
    await expect(adapter.api.dbGet("disable-commands")).resolves.toEqual(["old-command"]);

    currentAliases = JSON.stringify({ app: [{ alias: "After" }] });
    listeners.get(RENDERER_COMMAND_ALIASES_EVENT)?.(null);
    await vi.waitFor(() => expect(aliasCallback).toHaveBeenCalledOnce());
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "After" }] });
    expect(disabledSuccess).not.toHaveBeenCalled();
    await expect(adapter.api.dbGet("disable-commands")).resolves.toEqual(["old-command"]);
    expect(batchLoads).toBe(2);

    currentDisabled = JSON.stringify(["fresh-command"]);
    listeners.get(RENDERER_DISABLED_COMMANDS_EVENT)?.(null);
    await vi.waitFor(() => expect(disabledSuccess).toHaveBeenCalledOnce());
    await expect(callbackRead).resolves.toEqual(["fresh-command"]);
    await vi.waitFor(() => expect(adapter.snapshot().disabledCommandsEvents.callbackErrors).toBe(1));
    await expect(adapter.api.dbGet("disable-commands")).resolves.toEqual(["fresh-command"]);
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "After" }] });
    expect(batchLoads).toBe(3);
    expect(adapter.capabilities().events).toMatchObject({
      onDisabledCommandsChanged: "limited",
      onCommandAliasesChanged: "limited",
    });
    expect(adapter.snapshot().inactiveEvents).not.toContain("onDisabledCommandsChanged");
    adapter.dispose();
  });

  it("makes old in-flight disabled-command reads adopt the event generation after success", async () => {
    const oldLoad = deferred<unknown>();
    let currentDisabled = JSON.stringify(["fresh-command"]);
    let emit!: RendererHostListener;
    let batchLoads = 0;
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        async invoke(command) {
          if (command !== "get_ztools_renderer_settings") throw new Error(`Unexpected route ${command}`);
          batchLoads += 1;
          if (batchLoads === 1) return oldLoad.promise;
          return settings(null, currentDisabled);
        },
        async listen(event, handler) {
          if (event === RENDERER_DISABLED_COMMANDS_EVENT) emit = handler;
          return vi.fn();
        },
      },
    });
    adapter.api.onDisabledCommandsChanged(vi.fn());
    await vi.waitFor(() => expect(adapter.snapshot().disabledCommandsEvents.listenerState).toBe("listening"));
    const oldRead = adapter.api.dbGet("disable-commands");
    await vi.waitFor(() => expect(batchLoads).toBe(1));
    emit(null);
    const currentRead = adapter.api.dbGet("disable-commands");
    oldLoad.resolve(settings(null, JSON.stringify(["stale-command"])));

    await vi.waitFor(() => expect(batchLoads).toBe(2));
    await expect(oldRead).resolves.toEqual(["fresh-command"]);
    await expect(currentRead).resolves.toEqual(["fresh-command"]);
    expect(batchLoads).toBe(2);
    adapter.dispose();
  });

  it("retries an old-generation disabled-command read when its batch fails after notification", async () => {
    const oldLoad = deferred<unknown>();
    let batchLoads = 0;
    let emit!: RendererHostListener;
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        async invoke(command) {
          if (command !== "get_ztools_renderer_settings") throw new Error(`Unexpected route ${command}`);
          batchLoads += 1;
          if (batchLoads === 1) return oldLoad.promise;
          return settings(null, JSON.stringify(["recovered-command"]));
        },
        async listen(event, handler) {
          if (event === RENDERER_DISABLED_COMMANDS_EVENT) emit = handler;
          return vi.fn();
        },
      },
    });
    const read = adapter.api.dbGet("disable-commands");
    await vi.waitFor(() => expect(batchLoads).toBe(1));
    emit(null);
    oldLoad.reject(new Error("stale transport failure"));

    await vi.waitFor(() => expect(batchLoads).toBe(2));
    await expect(read).resolves.toEqual(["recovered-command"]);
    expect(batchLoads).toBe(2);
    adapter.dispose();
  });

  it("reads a normalized alias projection through the alias-only 512 KiB allowance", async () => {
    const serialized = JSON.stringify("a".repeat(512 * 1024 - 2));
    let calls = 0;
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        async invoke(command) {
          if (command !== "get_ztools_renderer_settings") throw new Error(`Unexpected route ${command}`);
          calls += 1;
          return settings(serialized);
        },
        async listen() { return vi.fn(); },
      },
    });

    await expect(adapter.api.dbGet("command-aliases")).resolves.toBe("a".repeat(512 * 1024 - 2));
    expect(calls).toBe(1);
    adapter.dispose();
  });

  it("accepts only null, shares one listener, and invalidates caches before public callbacks", async () => {
    let currentAliases = JSON.stringify({ app: [{ alias: "Before" }] });
    let emit!: RendererHostListener;
    let aliasEventListenCount = 0;
    const calls: RendererHostCommand[] = [];
    const transport: ZToolsRendererTransport = {
      async invoke(command) {
        calls.push(command);
        if (command === "get_ztools_renderer_settings") return settings(currentAliases);
        if (command === "list_launcher_apps") return APPS;
        throw new Error(`Unexpected route ${command}`);
      },
      async listen(event, handler) {
        if (event === RENDERER_COMMAND_ALIASES_EVENT) {
          aliasEventListenCount += 1;
          emit = handler;
        }
        return vi.fn();
      },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "Before" }] });
    await adapter.api.getApps();

    let callbackRead: Promise<unknown> | undefined;
    const first = vi.fn(() => { callbackRead = adapter.api.dbGet("command-aliases"); });
    const second = vi.fn();
    const stopFirst = adapter.api.onCommandAliasesChanged(first);
    const stopSecond = adapter.api.onCommandAliasesChanged(second);
    await vi.waitFor(() => expect(adapter.snapshot().commandAliasEvents.listenerState).toBe("listening"));
    expect(aliasEventListenCount).toBe(1);

    emit({ changed: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(adapter.snapshot().commandAliasEvents.invalidPayloads).toBe(1);
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "Before" }] });

    currentAliases = JSON.stringify({ app: [{ alias: "After" }] });
    emit(null);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    await expect(callbackRead).resolves.toEqual({ app: [{ alias: "After" }] });
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "After" }] });
    await adapter.api.getApps();

    expect(calls.filter((command) => command === "get_ztools_renderer_settings")).toHaveLength(2);
    expect(calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);
    expect(adapter.snapshot().appCatalog.invalidations).toBe(0);
    expect(adapter.snapshot().commandAliasEvents).toMatchObject({
      subscribers: 1,
      callbacks: 2,
      deliveredEvents: 1,
      registrationErrors: 0,
      callbackErrors: 0,
    });

    stopFirst();
    stopSecond();
    expect(adapter.snapshot().commandAliasEvents.listenerState).toBe("listening");
    expect(adapter.snapshot().commandAliasEvents.callbacks).toBe(0);
    adapter.dispose();
  });

  it("makes old in-flight alias reads adopt the fresh event generation", async () => {
    const oldLoad = deferred<unknown>();
    let emit!: RendererHostListener;
    let batchLoads = 0;
    const transport: ZToolsRendererTransport = {
      async invoke(command) {
        if (command === "get_ztools_renderer_settings") {
          batchLoads += 1;
          if (batchLoads === 1) return oldLoad.promise;
          return settings(JSON.stringify({ app: [{ alias: "Fresh" }] }));
        }
        throw new Error(`Unexpected route ${command}`);
      },
      async listen(event, handler) {
        if (event === RENDERER_COMMAND_ALIASES_EVENT) emit = handler;
        return vi.fn();
      },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });
    adapter.api.onCommandAliasesChanged(vi.fn());
    await vi.waitFor(() => expect(adapter.snapshot().commandAliasEvents.listenerState).toBe("listening"));

    const oldRead = adapter.api.dbGet("command-aliases");
    await vi.waitFor(() => expect(batchLoads).toBe(1));
    emit(null);
    const currentRead = adapter.api.dbGet("command-aliases");
    oldLoad.resolve(settings(JSON.stringify({ app: [{ alias: "Stale" }] })));

    await vi.waitFor(() => expect(batchLoads).toBe(2));
    await expect(oldRead).resolves.toEqual({ app: [{ alias: "Fresh" }] });
    await expect(currentRead).resolves.toEqual({ app: [{ alias: "Fresh" }] });
    await expect(adapter.api.dbGet("command-aliases")).resolves.toEqual({ app: [{ alias: "Fresh" }] });
    expect(batchLoads).toBe(2);
    adapter.dispose();
  });

  it("retries an old-generation alias read when its batch fails after notification", async () => {
    const oldLoad = deferred<unknown>();
    let emit!: RendererHostListener;
    let batchLoads = 0;
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        async invoke(command) {
          if (command !== "get_ztools_renderer_settings") throw new Error(`Unexpected route ${command}`);
          batchLoads += 1;
          if (batchLoads === 1) return oldLoad.promise;
          return settings(JSON.stringify({ app: [{ alias: "Recovered" }] }));
        },
        async listen(event, handler) {
          if (event === RENDERER_COMMAND_ALIASES_EVENT) emit = handler;
          return vi.fn();
        },
      },
    });
    const read = adapter.api.dbGet("command-aliases");
    await vi.waitFor(() => expect(batchLoads).toBe(1));
    emit(null);
    oldLoad.reject(new Error("stale transport failure"));

    await vi.waitFor(() => expect(batchLoads).toBe(2));
    await expect(read).resolves.toEqual({ app: [{ alias: "Recovered" }] });
    expect(batchLoads).toBe(2);
    adapter.dispose();
  });

  it("retries failed registration and releases a listener that resolves after disposal", async () => {
    let emit!: RendererHostListener;
    const late = deferred<RendererHostUnlisten>();
    const stop = vi.fn();
    const listen = vi.fn()
      .mockRejectedValueOnce(new Error("registration rejected"))
      .mockImplementationOnce(async (_event: string, handler: RendererHostListener) => {
        emit = handler;
        return late.promise;
      });
    const invalidated = vi.fn();
    const events = createRendererCommandAliasEvents({ listen }, invalidated);
    const callback = vi.fn();
    await expect(events.ready()).resolves.toBe(false);
    expect(events.snapshot().registrationErrors).toBe(1);
    events.subscribe(callback);
    const retry = events.ready();
    expect(events.snapshot().registrationsPending).toBe(1);

    events.dispose();
    late.resolve(stop);
    await expect(retry).resolves.toBe(false);
    await vi.waitFor(() => expect(events.snapshot().lateListenerUnlistens).toBe(1));
    emit(null);
    expect(stop).toHaveBeenCalledOnce();
    expect(invalidated).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(events.snapshot()).toMatchObject({ listenerState: "disposed", subscribers: 0, cleanupPending: 0 });
  });
});
