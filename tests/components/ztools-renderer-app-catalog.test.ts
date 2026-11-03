import { describe, expect, it, vi } from "vitest";
import { createRendererAppCatalog } from "../../packages/ztools-renderer/src/appCatalog";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type {
  RendererHostCommand,
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const appEvent = "atools://renderer-apps-changed";
const generalEvent = "atools://renderer-general-settings";
const oldApps = [{ name: "Old", path: "/Applications/Old.app" }];
const newApps = [{ name: "New", path: "/Applications/New.app" }];
const emptyAppState = {
  version: 1,
  revision: 1,
  values: { "command-history": null, "pinned-commands": null },
  changed: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventHarness() {
  const handlers = new Set<RendererHostListener>();
  const unlisten = vi.fn();
  const listen = vi.fn(async (event: string, handler: RendererHostListener) => {
    if (event !== appEvent) throw new Error(`unexpected event: ${event}`);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      unlisten();
    };
  });
  return {
    transport: { listen } as Pick<ZToolsRendererTransport, "listen">,
    listen,
    unlisten,
    emit(payload: unknown) {
      for (const handler of [...handlers]) handler(payload);
    },
    listenerCount: () => handlers.size,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for app catalog fixture state");
}

describe("renderer app catalog", () => {
  it("waits for its shared listener and exposes no event payload to callbacks", async () => {
    let finishRegistration!: (unlisten: RendererHostUnlisten) => void;
    let nativeListener!: RendererHostListener;
    const unlisten = vi.fn();
    const listen = vi.fn((_event: string, handler: RendererHostListener) => {
      nativeListener = handler;
      return new Promise<RendererHostUnlisten>((resolve) => { finishRegistration = resolve; });
    });
    const loadApps = vi.fn(async () => [{ name: "Example", path: "/Applications/Example.app", icon: "icon-url" }]);
    const catalog = createRendererAppCatalog({ transport: { listen }, loadApps });
    const changed = vi.fn();
    expect(() => catalog.onAppsChanged(null as unknown as () => void))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }));
    const remove = catalog.onAppsChanged(changed);
    const first = catalog.getApps();
    const second = catalog.getApps();

    expect(listen).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledWith(appEvent, expect.any(Function));
    expect(loadApps).not.toHaveBeenCalled();
    finishRegistration(unlisten);
    const [visible, joined] = await Promise.all([first, second]);
    expect(visible).toEqual([{ name: "Example", path: "/Applications/Example.app", icon: "icon-url" }]);
    expect(joined).toEqual(visible);
    expect(loadApps).toHaveBeenCalledOnce();

    visible[0].path = "/tmp/changed.app";
    await expect(catalog.getApps()).resolves.toEqual([
      { name: "Example", path: "/Applications/Example.app", icon: "icon-url" },
    ]);
    nativeListener({ path: "/private/app/path" });
    expect(changed.mock.calls).toEqual([[]]);
    expect(catalog.snapshot()).toMatchObject({ cachedApps: 0, invalidations: 1 });
    await catalog.getApps();
    expect(loadApps).toHaveBeenCalledTimes(2);

    remove();
    expect(unlisten).not.toHaveBeenCalled();
    catalog.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("discards a read invalidated in flight and coalesces the fresh read", async () => {
    const events = eventHarness();
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    let activeReads = 0;
    let maximumReads = 0;
    let readNumber = 0;
    const loadApps = vi.fn(() => {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      const read = ++readNumber === 1 ? firstRead : secondRead;
      return read.promise.finally(() => { activeReads -= 1; });
    });
    const catalog = createRendererAppCatalog({ transport: events.transport, loadApps });
    const first = catalog.getApps();
    await waitFor(() => loadApps.mock.calls.length === 1);
    const joined = catalog.getApps();
    events.emit({ path: "/private/stale-path" });
    expect(loadApps).toHaveBeenCalledOnce();

    firstRead.resolve(oldApps);
    await waitFor(() => loadApps.mock.calls.length === 2);
    expect(maximumReads).toBe(1);
    secondRead.resolve(newApps);
    await expect(Promise.all([first, joined])).resolves.toEqual([newApps, newApps]);
    expect(catalog.snapshot()).toMatchObject({ cachedApps: 1, invalidations: 1, readPending: false });
    expect(maximumReads).toBe(1);
    expect(events.listen).toHaveBeenCalledOnce();
    catalog.dispose();
  });

  it("rechecks freshness before resolving a member to launch or reveal", async () => {
    const events = eventHarness();
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    let readNumber = 0;
    const loadApps = vi.fn(() => (++readNumber === 1 ? firstRead : secondRead).promise);
    const catalog = createRendererAppCatalog({ transport: events.transport, loadApps });
    const resolved = catalog.resolve(oldApps[0].path);
    await waitFor(() => loadApps.mock.calls.length === 1);
    firstRead.resolve(oldApps);
    queueMicrotask(() => events.emit(null));
    await waitFor(() => loadApps.mock.calls.length === 2);
    secondRead.resolve(newApps);

    await expect(resolved).resolves.toBeUndefined();
    expect(catalog.snapshot()).toMatchObject({ cachedApps: 1, invalidations: 1 });
    expect(loadApps).toHaveBeenCalledTimes(2);
    catalog.dispose();
  });

  it("retries a failed listener registration and does not cache its read", async () => {
    let attempts = 0;
    const handlers = new Set<RendererHostListener>();
    const transport = {
      listen: vi.fn(async (_event: string, handler: RendererHostListener) => {
        attempts += 1;
        if (attempts === 1) throw new Error("registration failed");
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      }),
    };
    const loadApps = vi.fn()
      .mockResolvedValueOnce(oldApps)
      .mockResolvedValueOnce(newApps);
    const catalog = createRendererAppCatalog({ transport, loadApps });

    await expect(catalog.getApps()).resolves.toEqual(oldApps);
    expect(catalog.snapshot().cachedApps).toBe(0);
    await expect(catalog.getApps()).resolves.toEqual(newApps);
    expect(loadApps).toHaveBeenCalledTimes(2);
    expect(transport.listen).toHaveBeenCalledTimes(2);
    expect(catalog.snapshot().cachedApps).toBe(1);
    catalog.dispose();
  });

  it("rejects a warm-cache getApps continuation after disposal", async () => {
    const events = eventHarness();
    const catalog = createRendererAppCatalog({
      transport: events.transport,
      loadApps: async () => oldApps,
    });
    await catalog.getApps();
    const pending = catalog.getApps();
    catalog.dispose();
    expect(catalog.snapshot().invalidations).toBe(0);

    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    expect(catalog.snapshot().cachedApps).toBe(0);
  });

  it("rejects a warm-cache resolve continuation after disposal", async () => {
    const events = eventHarness();
    const catalog = createRendererAppCatalog({
      transport: events.transport,
      loadApps: async () => oldApps,
    });
    await catalog.getApps();
    const pending = catalog.resolve(oldApps[0].path);
    catalog.dispose();
    expect(catalog.snapshot().invalidations).toBe(0);

    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    expect(catalog.snapshot().cachedApps).toBe(0);
  });

  it("cleans its listener on dispose and rejects a late catalogue value", async () => {
    const events = eventHarness();
    const read = deferred<unknown>();
    const loadApps = vi.fn(() => read.promise);
    const catalog = createRendererAppCatalog({ transport: events.transport, loadApps });
    const pending = catalog.getApps();
    await waitFor(() => loadApps.mock.calls.length === 1);
    catalog.dispose();
    expect(events.listenerCount()).toBe(0);
    expect(events.unlisten).toHaveBeenCalledOnce();
    read.resolve(oldApps);
    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    expect(catalog.snapshot()).toMatchObject({ cachedApps: 0, readPending: false });
    expect(catalog.snapshot().eventSource.listenerState).toBe("disposed");
  });

  it("refreshes launch and reveal membership from one current snapshot", async () => {
    let apps = oldApps;
    const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
    let emit!: RendererHostListener;
    const stopped = vi.fn();
    const transport: ZToolsRendererTransport = {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === "get_ztools_renderer_settings") {
          return {
            version: 1,
            settings: Object.fromEntries([
              ["settings-general", JSON.stringify({ localAppSearch: true })],
              ...[...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
            ]),
          };
        }
        if (command === "list_launcher_apps") return apps;
        if (command === "launch_renderer_app") return emptyAppState;
        if (command === "call_agent_tool") return null;
        throw new Error(`unexpected route: ${command}`);
      },
      async listen(event, handler) {
        if (event === generalEvent) return () => undefined;
        if (event === "atools://renderer-local-shortcuts") return () => undefined;
        if (event !== appEvent) throw new Error(`unexpected event: ${event}`);
        emit = handler;
        return stopped;
      },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });
    const changed = vi.fn();
    const api = adapter.api;
    const inactive = api.onAiStatusChanged as unknown as (callback: unknown) => RendererHostUnlisten;
    expect(Object.hasOwn(api, "onAppsChanged")).toBe(true);
    expect(Object.keys(api)).toContain("onAiStatusChanged");
    expect("onAiStatusChanged" in api).toBe(true);
    expect(() => inactive(null)).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
    );
    inactive(vi.fn());
    const remove = adapter.api.onAppsChanged(changed);

    await expect(adapter.api.getApps()).resolves.toEqual(oldApps);
    apps = newApps;
    emit(null);
    expect(changed.mock.calls).toEqual([[]]);
    await expect(adapter.api.getApps()).resolves.toEqual(newApps);
    await expect(adapter.api.launch({ path: oldApps[0].path, type: "app" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });
    await adapter.api.launch({ path: newApps[0].path, type: "app" });
    await expect(adapter.api.revealInFinder(oldApps[0].path))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });
    await adapter.api.revealInFinder(newApps[0].path);

    expect(calls.filter(({ command }) => command === "list_launcher_apps")).toHaveLength(2);
    expect(adapter.capabilities().events.onAppsChanged).toBe("limited");
    expect(adapter.snapshot().inactiveEvents).toEqual(["onAiStatusChanged"]);
    expect(adapter.snapshot().appCatalog).toMatchObject({ cachedApps: 1, invalidations: 1 });
    remove();
    adapter.dispose();
    expect(stopped).toHaveBeenCalledOnce();
  });
});
