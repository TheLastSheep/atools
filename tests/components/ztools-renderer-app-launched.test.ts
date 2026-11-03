import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type { RendererHostCommand, RendererHostListener, RendererHostUnlisten, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function appLaunchTransport(onListen: (handler: RendererHostListener) => void, stop: () => void): ZToolsRendererTransport {
  return {
    invoke: vi.fn(async () => null),
    async listen(event, handler) {
      expect(event).toBe("atools://renderer-app-launched");
      onListen(handler);
      return stop;
    },
  };
}

const launchApp = { type: "app", path: "/Applications/Example.app" };
const launchApps = [{ name: "Example", path: launchApp.path }];
const launchReceipt = {
  version: 1,
  revision: 1,
  values: { "command-history": null, "pinned-commands": null },
  changed: [],
};

function rendererSettingsSnapshot() {
  const settings = Object.fromEntries(
    [...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
  );
  return {
    version: 1,
    settings: { "settings-general": JSON.stringify({ localAppSearch: true }), ...settings },
  };
}

function launcherTransport(
  listenForLaunch: (handler: RendererHostListener) => Promise<RendererHostUnlisten>,
  invoke: (command: RendererHostCommand) => unknown | Promise<unknown>,
): ZToolsRendererTransport {
  return {
    async invoke(command) { return invoke(command); },
    listen(event, handler) {
      if (event === "atools://renderer-apps-changed") return Promise.resolve(() => undefined);
      if (event === "atools://renderer-general-settings") return Promise.resolve(() => undefined);
      if (event === "atools://renderer-local-shortcuts") return Promise.resolve(() => undefined);
      if (event === "atools://renderer-app-launched") return listenForLaunch(handler);
      throw new Error(`unexpected event ${event}`);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("ZTools renderer app-launched event", () => {
  it("shares one listener, accepts only null, and never exposes rejected payloads", async () => {
    let emit!: RendererHostListener;
    const stop = vi.fn();
    const adapter = createZtoolsRendererHostAdapter({
      transport: appLaunchTransport((handler) => { emit = handler; }, stop),
    });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = adapter.api.onAppLaunched(first);
    const unsubscribeSecond = adapter.api.onAppLaunched(second);
    await settlePromises();

    expect(adapter.capabilities().events.onAppLaunched).toBe("limited");
    expect(adapter.capabilities().events).toHaveProperty("onAppsChanged", "limited");
    emit({ secret: "private launch path", extra: true });
    emit(undefined);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    emit(null);
    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith();
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith();
    expect(adapter.snapshot().appLaunched).toEqual({
      invalidPayloads: 2,
      eventSource: {
        subscribers: 2,
        listenerState: "listening",
        deliveredEvents: 1,
        registrationErrors: 0,
        callbackErrors: 0,
        registrationsPending: 0,
        lateListenerUnlistens: 0,
        cleanupPending: 0,
        cleanupErrors: 0,
      },
    });
    expect(JSON.stringify(adapter.snapshot())).not.toContain("private launch path");

    unsubscribeFirst();
    emit(null);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    expect(stop).toHaveBeenCalledOnce();
    expect(adapter.snapshot().appLaunched.eventSource.listenerState).toBe("idle");
    adapter.dispose();
  });

  it("isolates callback errors and disposes the listener without forwarding payload data", async () => {
    let emit!: RendererHostListener;
    const stop = vi.fn();
    const adapter = createZtoolsRendererHostAdapter({
      transport: appLaunchTransport((handler) => { emit = handler; }, stop),
    });
    expect(() => adapter.api.onAppLaunched(null as never)).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
    );
    adapter.api.onAppLaunched(() => { throw new Error("callback detail"); });
    adapter.api.onAppLaunched(() => Promise.reject(new Error("async callback detail")));
    await settlePromises();
    expect(() => emit(null)).not.toThrow();
    await settlePromises();
    expect(adapter.snapshot().appLaunched.eventSource.callbackErrors).toBe(2);
    expect(JSON.stringify(adapter.snapshot())).not.toContain("callback detail");
    expect(JSON.stringify(adapter.snapshot())).not.toContain("async callback detail");

    adapter.dispose();
    emit({ secret: "late invalid app launch payload" });
    expect(adapter.snapshot().appLaunched.invalidPayloads).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(adapter.snapshot().appLaunched.eventSource).toMatchObject({
      subscribers: 0,
      listenerState: "disposed",
      cleanupPending: 0,
      cleanupErrors: 0,
    });
  });

  it("unlistens a late native registration after disposal", async () => {
    let resolveListen!: (unlisten: () => void) => void;
    let emit!: RendererHostListener;
    const stop = vi.fn();
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        invoke: vi.fn(async () => null),
        listen(event, handler) {
          expect(event).toBe("atools://renderer-app-launched");
          emit = handler;
          return new Promise((resolve) => { resolveListen = resolve; });
        },
      },
    });
    const callback = vi.fn();
    adapter.api.onAppLaunched(callback);
    adapter.dispose();
    resolveListen(stop);
    await settlePromises();
    emit(null);

    expect(stop).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    expect(adapter.snapshot().appLaunched.eventSource).toMatchObject({
      listenerState: "disposed",
      registrationsPending: 0,
      lateListenerUnlistens: 1,
      cleanupPending: 0,
      cleanupErrors: 0,
    });
  });

  it("ignores invalid payloads from a retired registration while counting the current one", async () => {
    const registrations: Array<{
      handler: RendererHostListener;
      resolve(unlisten: RendererHostUnlisten): void;
    }> = [];
    const oldStop = vi.fn();
    const currentStop = vi.fn();
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        invoke: vi.fn(async () => null),
        listen(event, handler) {
          if (event === "atools://renderer-apps-changed") return Promise.resolve(() => undefined);
          expect(event).toBe("atools://renderer-app-launched");
          return new Promise<RendererHostUnlisten>((resolve) => {
            registrations.push({ handler, resolve });
          });
        },
      },
    });
    const oldCallback = vi.fn();
    const currentCallback = vi.fn();
    const unsubscribeOld = adapter.api.onAppLaunched(oldCallback);
    unsubscribeOld();
    const unsubscribeCurrent = adapter.api.onAppLaunched(currentCallback);
    expect(registrations).toHaveLength(2);
    registrations[1].resolve(currentStop);
    await settlePromises();

    registrations[0].handler({ secret: "retired listener payload" });
    expect(adapter.snapshot().appLaunched.invalidPayloads).toBe(0);
    expect(oldCallback).not.toHaveBeenCalled();
    registrations[1].handler({ secret: "current listener payload" });
    expect(adapter.snapshot().appLaunched.invalidPayloads).toBe(1);
    expect(currentCallback).not.toHaveBeenCalled();
    registrations[1].handler(null);
    expect(currentCallback).toHaveBeenCalledOnce();
    expect(currentCallback).toHaveBeenCalledWith();

    registrations[0].resolve(oldStop);
    await settlePromises();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(JSON.stringify(adapter.snapshot())).not.toContain("retired listener payload");
    expect(JSON.stringify(adapter.snapshot())).not.toContain("current listener payload");
    unsubscribeCurrent();
    expect(currentStop).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("waits for app-launched listener readiness before a fast successful launch", async () => {
    let resolveLaunchListener!: (unlisten: RendererHostUnlisten) => void;
    let emitLaunch!: RendererHostListener;
    const stopLaunch = vi.fn();
    const launchCalls: RendererHostCommand[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: launcherTransport((handler) => {
        emitLaunch = handler;
        return new Promise((resolve) => { resolveLaunchListener = resolve; });
      }, (command) => {
        if (command === "get_ztools_renderer_settings") return rendererSettingsSnapshot();
        if (command === "list_launcher_apps") return launchApps;
        if (command === "launch_renderer_app") {
          launchCalls.push(command);
          emitLaunch(null);
          return launchReceipt;
        }
        throw new Error(`unexpected route ${command}`);
      }),
    });
    const onLaunched = vi.fn();
    adapter.api.onAppLaunched(onLaunched);
    await adapter.api.getApps();

    const pendingLaunch = adapter.api.launch(launchApp);
    await flushMicrotasks();
    expect(launchCalls).toEqual([]);
    expect(adapter.snapshot().nativeCalls.launch_renderer_app).toBeUndefined();
    expect(adapter.snapshot().appLaunched.eventSource.listenerState).toBe("registering");

    resolveLaunchListener(stopLaunch);
    await expect(pendingLaunch).resolves.toEqual(launchReceipt);
    expect(launchCalls).toEqual(["launch_renderer_app"]);
    expect(onLaunched).toHaveBeenCalledOnce();
    expect(onLaunched).toHaveBeenCalledWith();
    expect(adapter.snapshot().nativeCalls.launch_renderer_app).toBe(1);
    expect(adapter.snapshot().outstandingNativeCalls).toBe(0);
    adapter.dispose();
    expect(stopLaunch).toHaveBeenCalledOnce();
  });

  it("rejects launch when app-launched registration fails", async () => {
    let rejectLaunchListener!: (error: Error) => void;
    const launchCalls: RendererHostCommand[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: launcherTransport(() => new Promise((_resolve, reject) => {
        rejectLaunchListener = reject;
      }), (command) => {
        if (command === "get_ztools_renderer_settings") return rendererSettingsSnapshot();
        if (command === "list_launcher_apps") return launchApps;
        launchCalls.push(command);
        return launchReceipt;
      }),
    });
    adapter.api.onAppLaunched(vi.fn());
    await adapter.api.getApps();

    const pendingLaunch = adapter.api.launch(launchApp);
    await flushMicrotasks();
    rejectLaunchListener(new Error("private registration error"));
    await expect(pendingLaunch).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(launchCalls).toEqual([]);
    expect(adapter.snapshot().nativeCalls.launch_renderer_app).toBeUndefined();
    expect(adapter.snapshot().appLaunched.eventSource.registrationErrors).toBe(1);
    expect(JSON.stringify(adapter.snapshot())).not.toContain("private registration error");
    adapter.dispose();
  });

  it("cancels launch while awaiting registration and unlistens a late listener", async () => {
    let resolveLaunchListener!: (unlisten: RendererHostUnlisten) => void;
    let emitLaunch!: RendererHostListener;
    const stopLaunch = vi.fn();
    const launchCalls: RendererHostCommand[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: launcherTransport((handler) => {
        emitLaunch = handler;
        return new Promise((resolve) => { resolveLaunchListener = resolve; });
      }, (command) => {
        if (command === "get_ztools_renderer_settings") return rendererSettingsSnapshot();
        if (command === "list_launcher_apps") return launchApps;
        launchCalls.push(command);
        return launchReceipt;
      }),
    });
    const onLaunched = vi.fn();
    adapter.api.onAppLaunched(onLaunched);
    await adapter.api.getApps();
    const pendingLaunch = adapter.api.launch(launchApp);
    await flushMicrotasks();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pendingLaunch.then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : "rejected",
      ),
      new Promise<string>((resolve) => { timeout = setTimeout(() => resolve("timeout"), 100); }),
    ]);
    clearTimeout(timeout);
    expect(outcome).toBe("timeout");

    adapter.dispose();
    await expect(pendingLaunch).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    expect(launchCalls).toEqual([]);
    expect(adapter.snapshot().nativeCalls.launch_renderer_app).toBeUndefined();
    resolveLaunchListener(stopLaunch);
    await flushMicrotasks();
    emitLaunch(null);
    expect(stopLaunch).toHaveBeenCalledOnce();
    expect(onLaunched).not.toHaveBeenCalled();
    expect(adapter.snapshot().appLaunched.eventSource).toMatchObject({
      listenerState: "disposed",
      registrationsPending: 0,
      lateListenerUnlistens: 1,
      cleanupPending: 0,
      cleanupErrors: 0,
    });
  });
});
