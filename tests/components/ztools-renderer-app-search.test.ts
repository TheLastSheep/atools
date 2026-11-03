import { describe, expect, it, vi } from "vitest";
import { createRendererAppSearchCatalog } from "../../packages/ztools-renderer/src/appSearch";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type {
  RendererHostCommand,
  RendererHostListener,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const APP_EVENT = "atools://renderer-apps-changed";
const GENERAL_EVENT = "atools://renderer-general-settings";
const appRows = [
  { name: "Fixture Application", path: "/Applications/Fixture.app", icon: "fixture-icon" },
];
const emptyAppState = {
  version: 1,
  revision: 1,
  values: { "command-history": null, "pinned-commands": null },
  changed: [],
};

type Settings = Record<string, unknown> | null;

function nativeSettings(
  settingsGeneral: Settings,
  localShortcuts: Array<{ name: string; path: string; alias?: string }> = [],
): unknown {
  const settings: Record<string, string | null> = Object.fromEntries(
    [...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
  );
  settings["settings-general"] = settingsGeneral === null ? null : JSON.stringify(settingsGeneral);
  if (localShortcuts.length > 0) {
    settings["ztools-renderer:local-shortcuts"] = JSON.stringify(localShortcuts.map((shortcut, index) => ({
      id: `local-${index}`,
      ...shortcut,
      type: "file",
      addedAt: index,
    })));
  }
  return { version: 1, settings };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFixture(options: {
  settings?: Settings;
  readSettings?: () => Promise<unknown>;
  failGeneralListener?: () => boolean;
  deferGeneralListener?: boolean;
  readApps?: () => Promise<typeof appRows>;
  plugins?: unknown[];
  localShortcuts?: Array<{ name: string; path: string; alias?: string }>;
} = {}) {
  const listeners = new Map<string, Set<RendererHostListener>>();
  const registrations = new Map<string, number>();
  const removals = new Map<string, number>();
  const calls: RendererHostCommand[] = [];
  let listenAttempts = 0;
  let deferredGeneralHandler: RendererHostListener | undefined;
  let releaseGeneralRegistration: (() => void) | undefined;
  let apps = [...appRows];

  const transport: ZToolsRendererTransport = {
    async invoke(command) {
      calls.push(command);
      if (command === "get_ztools_renderer_settings") {
        return options.readSettings
          ? options.readSettings()
          : nativeSettings(
            options.settings === undefined ? { localAppSearch: true } : options.settings,
            options.localShortcuts,
          );
      }
      if (command === "list_launcher_apps") return options.readApps ? options.readApps() : apps;
      if (command === "list_plugins") return options.plugins ?? [];
      if (command === "launch_renderer_app") return emptyAppState;
      throw new Error(`Unexpected native command: ${command}`);
    },
    async listen(event, handler) {
      if (event === GENERAL_EVENT) listenAttempts += 1;
      if (event === GENERAL_EVENT && options.failGeneralListener?.()) {
        throw new Error("fixture General listener registration failed");
      }
      if (event === GENERAL_EVENT && options.deferGeneralListener) {
        deferredGeneralHandler = handler;
        return new Promise((resolve) => {
          releaseGeneralRegistration = () => {
            const handlers = listeners.get(event) ?? new Set<RendererHostListener>();
            handlers.add(handler);
            listeners.set(event, handlers);
            registrations.set(event, (registrations.get(event) ?? 0) + 1);
            resolve(() => {
              handlers.delete(handler);
              removals.set(event, (removals.get(event) ?? 0) + 1);
            });
          };
        });
      }
      const handlers = listeners.get(event) ?? new Set<RendererHostListener>();
      handlers.add(handler);
      listeners.set(event, handlers);
      registrations.set(event, (registrations.get(event) ?? 0) + 1);
      return () => {
        handlers.delete(handler);
        removals.set(event, (removals.get(event) ?? 0) + 1);
      };
    },
  };

  return {
    adapter: createZtoolsRendererHostAdapter({ transport }),
    calls,
    listenAttempts: () => listenAttempts,
    listeners,
    registrations,
    removals,
    setApps(next: typeof appRows) { apps = [...next]; },
    emit(event: string, payload: unknown) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    emitGeneral(settings: Record<string, unknown>) {
      this.emit(GENERAL_EVENT, { version: 1, raw: JSON.stringify(settings) });
    },
    releaseGeneralListenerWith(settings: Record<string, unknown>) {
      deferredGeneralHandler?.({ version: 1, raw: JSON.stringify(settings) });
      releaseGeneralRegistration?.();
    },
    listenerCount(event: string) { return listeners.get(event)?.size ?? 0; },
  };
}

function createAppSearchModuleFixture(ready: () => Promise<boolean>) {
  let observe!: (enabled: boolean) => unknown;
  const app = { name: "Fixture Application", path: appRows[0].path, icon: "fixture-icon" };
  const catalog = {
    getApps: vi.fn(async () => [app]),
    resolve: vi.fn(async (path: string) => path === app.path ? app : undefined),
    onAppsChanged: vi.fn((_callback: () => unknown) => () => undefined),
    snapshot: () => ({
      cachedApps: 1,
      readPending: false,
      invalidations: 0,
      eventSource: {
        subscribers: 0,
        listenerState: "idle" as const,
        deliveredEvents: 0,
        registrationErrors: 0,
        callbackErrors: 0,
        registrationsPending: 0,
        lateListenerUnlistens: 0,
        cleanupPending: 0,
        cleanupErrors: 0,
      },
    }),
    dispose: vi.fn(),
  };
  const readSettings = vi.fn(async () => ({ localAppSearch: true }));
  const preferences = {
    observeLocalAppSearch(callback: (enabled: boolean) => unknown) {
      observe = callback;
      return () => undefined;
    },
    ready,
  };
  return {
    search: createRendererAppSearchCatalog({ catalog, readSettings, preferences }),
    catalog,
    readSettings,
    emit(enabled: boolean) { observe(enabled); },
    app,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for renderer event fixture");
}

describe("pinned Main local app search", () => {
  it("rejects when a preference event arrives before listener registration fails", async () => {
    const ready = vi.fn(async () => false);
    const fixture = createAppSearchModuleFixture(ready);
    fixture.emit(false);

    await expect(fixture.search.getApps()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(fixture.readSettings).not.toHaveBeenCalled();
    expect(fixture.catalog.getApps).not.toHaveBeenCalled();
    await expect(fixture.search.resolve(fixture.app.path)).resolves.toEqual(fixture.app);
    expect(fixture.catalog.resolve).toHaveBeenCalledOnce();
    fixture.search.dispose();
  });

  it("rejects an event received during initialization if listener readiness then fails", async () => {
    const listener = deferred<boolean>();
    const ready = vi.fn(() => listener.promise);
    const fixture = createAppSearchModuleFixture(ready);
    const pendingApps = fixture.search.getApps();
    fixture.emit(false);
    listener.resolve(false);

    await expect(pendingApps).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(fixture.readSettings).not.toHaveBeenCalled();
    expect(fixture.catalog.getApps).not.toHaveBeenCalled();
    await expect(fixture.search.resolve(fixture.app.path)).resolves.toEqual(fixture.app);
    fixture.search.dispose();
  });

  it("re-reads the setting after listener recovery instead of trusting an event from failed registration", async () => {
    let attempts = 0;
    const ready = vi.fn(async () => ++attempts > 1);
    const fixture = createAppSearchModuleFixture(ready);
    fixture.emit(false);
    await expect(fixture.search.getApps()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });

    await expect(fixture.search.getApps()).resolves.toEqual([fixture.app]);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(fixture.readSettings).toHaveBeenCalledOnce();
    expect(fixture.catalog.getApps).toHaveBeenCalledOnce();
    fixture.search.dispose();
  });

  it("defaults to enabled and strictly rejects a stored non-boolean value", async () => {
    const defaultFixture = createFixture({ settings: null });
    await expect(defaultFixture.adapter.api.getApps()).resolves.toEqual([
      { name: "Fixture Application", path: "/Applications/Fixture.app", icon: "fixture-icon" },
    ]);
    expect(defaultFixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);
    defaultFixture.adapter.dispose();

    const missingFixture = createFixture({ settings: {} });
    await expect(missingFixture.adapter.api.getApps()).resolves.toHaveLength(1);
    missingFixture.adapter.dispose();

    const invalidFixture = createFixture({ settings: { localAppSearch: "false" } });
    await expect(invalidFixture.adapter.api.getApps()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(invalidFixture.calls).not.toContain("list_launcher_apps");
    invalidFixture.adapter.dispose();
  });

  it("hides search apps while retaining raw app resolution for launch", async () => {
    const fixture = createFixture({
      settings: { localAppSearch: false },
      plugins: [{
        id: "builtin-fixture",
        name: "Builtin Fixture",
        version: "1",
        path: "/plugins/builtin-fixture",
        enabled: true,
        source_kind: "builtin",
        manifest: { features: [{ code: "keep", cmds: ["Keep plugin result"] }] },
      }],
      localShortcuts: [{ name: "Fixture Shortcut", alias: "Fixture Alias", path: "/tmp/fixture" }],
    });

    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);
    expect(fixture.calls).not.toContain("list_launcher_apps");
    await expect(fixture.adapter.api.getAllPlugins()).resolves.toMatchObject([
      { id: "builtin-fixture", sourceKind: "builtin" },
    ]);
    await expect(fixture.adapter.api.localShortcuts.getAll()).resolves.toEqual([
      {
        id: "local-0", name: "Fixture Shortcut", alias: "Fixture Alias", path: "/tmp/fixture",
        type: "file", addedAt: 0,
      },
    ]);

    await fixture.adapter.api.launch({ path: appRows[0].path, type: "app" });
    expect(fixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);
    expect(fixture.calls.filter((command) => command === "launch_renderer_app")).toHaveLength(1);
    fixture.adapter.dispose();
  });

  it("uses General events to refresh Main immediately and skips same-value rescans", async () => {
    const fixture = createFixture({ settings: { localAppSearch: true } });
    const changed = vi.fn();
    let appsObservedFromPublicCallback: unknown = null;
    const localAppSearchChanged = vi.fn(async (enabled: boolean) => {
      if (!enabled) appsObservedFromPublicCallback = await fixture.adapter.api.getApps();
    });
    fixture.adapter.api.onAppsChanged(changed);
    fixture.adapter.api.onUpdateLocalAppSearch(localAppSearchChanged);
    await expect(fixture.adapter.api.getApps()).resolves.toHaveLength(1);
    await waitFor(() => fixture.listenerCount(GENERAL_EVENT) === 1);

    fixture.emitGeneral({ localAppSearch: "false" });
    expect(fixture.adapter.snapshot().generalPreferenceEvents.invalidPayloads).toBe(1);
    expect(changed).not.toHaveBeenCalled();

    fixture.emitGeneral({ localAppSearch: false });
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);
    await waitFor(() => appsObservedFromPublicCallback !== null);
    expect(appsObservedFromPublicCallback).toEqual([]);
    fixture.emitGeneral({ localAppSearch: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(localAppSearchChanged).toHaveBeenLastCalledWith(false);

    fixture.emitGeneral({ localAppSearch: true });
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(fixture.adapter.api.getApps()).resolves.toHaveLength(1);
    expect(fixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);
    fixture.adapter.dispose();
  });

  it("restores the default search visibility when a valid full General event omits the field", async () => {
    const fixture = createFixture({ settings: { localAppSearch: true } });
    const changed = vi.fn();
    const publicPreference = vi.fn();
    fixture.adapter.api.onAppsChanged(changed);
    fixture.adapter.api.onUpdateLocalAppSearch(publicPreference);
    await expect(fixture.adapter.api.getApps()).resolves.toEqual(appRows);
    expect(fixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);

    fixture.emitGeneral({ localAppSearch: false });
    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);
    fixture.emitGeneral({ recentRows: 3 });
    await expect(fixture.adapter.api.getApps()).resolves.toEqual(appRows);

    expect(changed).toHaveBeenCalledTimes(2);
    expect(publicPreference).toHaveBeenCalledOnce();
    expect(publicPreference).toHaveBeenCalledWith(false);
    expect(fixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);
    fixture.adapter.dispose();
  });

  it("does not restart an in-flight catalog scan for a same-value setting event", async () => {
    const catalogRead = deferred<typeof appRows>();
    const fixture = createFixture({
      settings: { localAppSearch: true },
      readApps: () => catalogRead.promise,
    });
    const pendingApps = fixture.adapter.api.getApps();
    await waitFor(() => fixture.calls.filter((command) => command === "list_launcher_apps").length === 1);

    fixture.emitGeneral({ localAppSearch: true });
    catalogRead.resolve([...appRows]);

    await expect(pendingApps).resolves.toEqual(appRows);
    expect(fixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);
    fixture.adapter.dispose();
  });

  it("lets a newer setting event win over an in-flight startup read", async () => {
    const read = deferred<unknown>();
    const fixture = createFixture({ readSettings: () => read.promise });
    const pendingRead = fixture.adapter.api.getApps();
    await waitFor(() => fixture.calls.includes("get_ztools_renderer_settings"));

    fixture.emitGeneral({ localAppSearch: false });
    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);
    read.resolve(nativeSettings({ localAppSearch: true }));
    await expect(pendingRead).resolves.toEqual([]);
    expect(fixture.calls).not.toContain("list_launcher_apps");
    fixture.adapter.dispose();
  });

  it("waits for General listener readiness before another namespace starts the shared snapshot", async () => {
    const fixture = createFixture({
      settings: { localAppSearch: true },
      deferGeneralListener: true,
    });
    const history = fixture.adapter.api.dbGet("command-history");
    const apps = fixture.adapter.api.getApps();
    await waitFor(() => fixture.listenAttempts() === 1);

    expect(fixture.calls).not.toContain("get_ztools_renderer_settings");
    fixture.releaseGeneralListenerWith({ localAppSearch: false });

    await expect(history).resolves.toBeNull();
    await expect(apps).resolves.toEqual([]);
    expect(fixture.calls.filter((command) => command === "get_ztools_renderer_settings")).toHaveLength(1);
    expect(fixture.calls).not.toContain("list_launcher_apps");
    fixture.adapter.dispose();
  });

  it("uses a General event received before the first settings read", async () => {
    const fixture = createFixture({ settings: { localAppSearch: true } });
    await waitFor(() => fixture.listenerCount(GENERAL_EVENT) === 1);
    fixture.emitGeneral({ localAppSearch: false });

    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);
    expect(fixture.calls).not.toContain("get_ztools_renderer_settings");
    expect(fixture.calls).not.toContain("list_launcher_apps");
    fixture.adapter.dispose();
  });

  it("keeps the event value authoritative when an older startup read fails", async () => {
    const read = deferred<unknown>();
    const fixture = createFixture({ readSettings: () => read.promise });
    const pendingRead = fixture.adapter.api.getApps();
    await waitFor(() => fixture.calls.includes("get_ztools_renderer_settings"));

    fixture.emitGeneral({ localAppSearch: false });
    read.reject(new Error("stale settings snapshot failed"));
    await expect(pendingRead).resolves.toEqual([]);
    expect(fixture.calls).not.toContain("list_launcher_apps");
    fixture.adapter.dispose();
  });

  it("keeps directory invalidation and callback lifecycle independent of the search toggle", async () => {
    const fixture = createFixture({ settings: { localAppSearch: false } });
    const changed = vi.fn();
    fixture.adapter.api.onAppsChanged(changed);
    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);

    fixture.setApps([{ name: "Updated Fixture", path: "/Applications/Updated.app", icon: "updated-icon" }]);
    fixture.emit(APP_EVENT, null);
    expect(changed).toHaveBeenCalledOnce();
    await expect(fixture.adapter.api.getApps()).resolves.toEqual([]);
    await fixture.adapter.api.launch({ path: "/Applications/Updated.app", type: "app" });
    expect(fixture.calls.filter((command) => command === "list_launcher_apps")).toHaveLength(1);

    fixture.adapter.dispose();
    expect(fixture.listenerCount(GENERAL_EVENT)).toBe(0);
    expect(fixture.removals.get(GENERAL_EVENT)).toBe(1);
    expect(fixture.removals.get(APP_EVENT)).toBe(1);
  });

  it("fails search when the shared General listener is unavailable while raw resolve still works", async () => {
    let fail = true;
    const fixture = createFixture({
      settings: { localAppSearch: true },
      failGeneralListener: () => fail,
    });
    await expect(fixture.adapter.api.getApps()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    await fixture.adapter.api.launch({ path: appRows[0].path, type: "app" });
    expect(fixture.calls.filter((command) => command === "launch_renderer_app")).toHaveLength(1);

    fail = false;
    await expect(fixture.adapter.api.getApps()).resolves.toHaveLength(1);
    expect(fixture.listenAttempts()).toBe(2);
    expect(fixture.registrations.get(GENERAL_EVENT)).toBe(1);
    fixture.adapter.dispose();
  });

  it("preserves callback limits and isolates callback failures", async () => {
    const fixture = createFixture();
    const failedCallback = vi.fn(() => { throw new Error("consumer failure"); });
    const nextCallback = vi.fn();
    fixture.adapter.api.onAppsChanged(failedCallback);
    fixture.adapter.api.onAppsChanged(nextCallback);
    for (let index = 2; index < 64; index += 1) {
      fixture.adapter.api.onAppsChanged(() => undefined);
    }
    expect(() => fixture.adapter.api.onAppsChanged(() => undefined)).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
    );
    fixture.emit(APP_EVENT, null);
    expect(failedCallback).toHaveBeenCalledOnce();
    expect(nextCallback).toHaveBeenCalledOnce();
    fixture.adapter.dispose();
  });
});
