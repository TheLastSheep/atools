import { describe, expect, it, vi } from "vitest";
import { bootstrapZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type {
  RendererHostCommand,
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererHostAdapter,
  ZToolsRendererTransport,
  ZToolsRendererWindow,
} from "../../packages/ztools-renderer/src/types";

function hostFor(transport: ZToolsRendererTransport) {
  const pageHide = new Set<() => void>();
  const host: ZToolsRendererWindow = {
    __ATOOLS_ZTOOLS_RENDERER_TRANSPORT__: transport,
    addEventListener(_event, listener) { pageHide.add(listener); },
    removeEventListener(_event, listener) { pageHide.delete(listener); },
  };
  return { host, pageHide, unload() { for (const listener of [...pageHide]) listener(); } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("original renderer document lifecycle", () => {
  it("installs the injected transport on the target before Vue startup", async () => {
    const calls: RendererHostCommand[] = [];
    const namespacedSettings = Object.fromEntries(
      [...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
    );
    const target = hostFor({
      async invoke(command) {
        calls.push(command);
        if (command === "get_ztools_renderer_settings") {
          return { version: 1, settings: { "settings-general": null, ...namespacedSettings } };
        }
        if (command === "list_launcher_apps") {
          return [{ name: "Example", path: "/Applications/Example.app", icon: null }];
        }
        throw new Error(`unexpected route: ${command}`);
      },
      async listen() { return () => undefined; },
    });
    const adapter = bootstrapZtoolsRendererHostAdapter(target.host);

    expect(target.host.__ATOOLS_ZTOOLS_HOST_ADAPTER__).toBe(adapter);
    await expect((target.host.ztools as ZToolsRendererHostAdapter["api"]).getApps()).resolves.toEqual([
      { name: "Example", path: "/Applications/Example.app" },
    ]);
    expect(calls).toEqual(["get_ztools_renderer_settings", "list_launcher_apps"]);
    adapter.dispose();
  });

  it("installs one adapter and releases its native listeners on document exit", async () => {
    const listeners = new Map<string, RendererHostListener>();
    const stopFocus = vi.fn();
    const stopApps = vi.fn();
    const stopAliases = vi.fn();
    const stopDisabledCommands = vi.fn();
    const transport: ZToolsRendererTransport = {
      invoke: vi.fn(),
      listen: vi.fn(async (event, handler) => {
        listeners.set(event, handler);
        if (event === "tauri://focus") return stopFocus;
        if (event === "atools://renderer-apps-changed") return stopApps;
        if (event === "atools://renderer-command-aliases") return stopAliases;
        if (event === "atools://renderer-disabled-commands") return stopDisabledCommands;
        return vi.fn();
      }),
    };
    const window = hostFor(transport);
    const adapter = bootstrapZtoolsRendererHostAdapter(window.host);
    expect(bootstrapZtoolsRendererHostAdapter(window.host)).toBe(adapter);
    expect(window.pageHide.size).toBe(1);
    const callback = vi.fn();
    adapter.api.onFocusSearch(callback);
    await flush();
    listeners.get("tauri://focus")?.({ ignored: true });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith();
    window.unload();
    await flush();
    expect(window.pageHide.size).toBe(0);
    expect(stopFocus).toHaveBeenCalledOnce();
    expect(stopApps).toHaveBeenCalledOnce();
    expect(stopAliases).toHaveBeenCalledOnce();
    expect(stopDisabledCommands).toHaveBeenCalledOnce();
    expect(adapter.snapshot().focusEvents).toMatchObject({
      subscribers: 0, listenerState: "disposed", cleanupPending: 0, cleanupErrors: 0,
    });
    listeners.get("tauri://focus")?.(undefined);
    expect(callback).toHaveBeenCalledOnce();
    expect(adapter.snapshot().disposed).toBe(true);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("cleans a listener that finishes registering after the document has left", async () => {
    const finishRegistration = new Map<string, (stop: RendererHostUnlisten) => void>();
    const stopFocus = vi.fn();
    const stopApps = vi.fn();
    const stopAliases = vi.fn();
    const stopDisabledCommands = vi.fn();
    const window = hostFor({
      invoke: vi.fn(),
      listen: (event) => new Promise((resolve) => { finishRegistration.set(event, resolve); }),
    });
    const adapter = bootstrapZtoolsRendererHostAdapter(window.host);
    adapter.api.onFocusSearch(vi.fn());
    window.unload();
    finishRegistration.get("atools://renderer-apps-changed")?.(stopApps);
    finishRegistration.get("atools://renderer-command-aliases")?.(stopAliases);
    finishRegistration.get("atools://renderer-disabled-commands")?.(stopDisabledCommands);
    finishRegistration.get("tauri://focus")?.(stopFocus);
    await flush();
    expect(stopApps).toHaveBeenCalledOnce();
    expect(stopAliases).toHaveBeenCalledOnce();
    expect(stopDisabledCommands).toHaveBeenCalledOnce();
    expect(stopFocus).toHaveBeenCalledOnce();
    expect(adapter.snapshot().focusEvents.cleanupPending).toBe(0);
    expect(adapter.snapshot().appCatalog.eventSource.lateListenerUnlistens).toBe(1);
    expect(adapter.snapshot().commandAliasEvents).toMatchObject({
      listenerState: "disposed", cleanupPending: 0, lateListenerUnlistens: 1,
    });
    expect(adapter.snapshot().disabledCommandsEvents).toMatchObject({
      listenerState: "disposed", cleanupPending: 0, lateListenerUnlistens: 1,
    });
    expect(adapter.snapshot().focusEvents.lateListenerUnlistens).toBe(1);
    expect(window.pageHide.size).toBe(0);
  });
});
