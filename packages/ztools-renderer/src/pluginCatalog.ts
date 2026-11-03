import { createRendererCallbackRegistry } from "./callbackRegistry";
import {
  adapterDisposedError,
  assertRendererCallback,
  HOST_ERROR_MESSAGES,
  invalidRendererArgument,
  invalidRendererResponse,
} from "./errors";
import { createRendererNullEventSubscriptions } from "./eventSubscriptions";
import type { RendererEventSubscriptionsSnapshot } from "./eventSubscriptions";
import { mapPluginInventory } from "./mappers";
import type {
  RendererHostUnlisten,
  ZToolsRendererPlugin,
  ZToolsRendererTransport,
} from "./types";

const PLUGINS_CHANGED_EVENT = "atools://renderer-plugins-changed" as const;
const PLUGINS_CHANGED_CALLBACK = "onPluginsChanged" as const;

export interface RendererPluginCatalogSnapshot {
  cachedPlugins: number;
  generation: number;
  readPending: boolean;
  lateChangePending: boolean;
  lateSubscriberRefreshes: number;
  callbackErrors: number;
  invalidPayloads: number;
  eventSource: RendererEventSubscriptionsSnapshot;
}

export interface RendererPluginCatalog {
  getAllPlugins(): Promise<ZToolsRendererPlugin[]>;
  getDisabledPlugins(): Promise<string[]>;
  onPluginsChanged(callback: () => unknown): RendererHostUnlisten;
  snapshot(): RendererPluginCatalogSnapshot;
  dispose(): void;
}

interface PluginCatalogOptions {
  transport: Pick<ZToolsRendererTransport, "listen">;
  loadPlugins: () => Promise<unknown>;
  settleBeforeDispose<T>(operation: () => Promise<T>): Promise<T>;
}

interface PluginSnapshot {
  generation: number;
  plugins: ZToolsRendererPlugin[];
}

interface PendingRead {
  generation: number;
  promise: Promise<PluginSnapshot>;
}

/** Keeps one validated plugin snapshot fresh across inventory and change callbacks. */
export function createRendererPluginCatalog(options: PluginCatalogOptions): RendererPluginCatalog {
  const callbacks = createRendererCallbackRegistry<typeof PLUGINS_CHANGED_CALLBACK>(
    [PLUGINS_CHANGED_CALLBACK],
    64,
    () => { callbackErrors += 1; },
  );
  let disposed = false;
  let generation = 0;
  let cached: PluginSnapshot | undefined;
  let pending: PendingRead | undefined;
  let removeEventObserver: RendererHostUnlisten | undefined;
  let publicSubscriptionEstablished = false;
  let lateChangePending = false;
  let lateSubscriberRefreshes = 0;
  let refreshRunning = false;
  let refreshRequested = false;
  let callbackErrors = 0;
  let invalidPayloads = 0;
  const events = createRendererNullEventSubscriptions(
    options.transport,
    PLUGINS_CHANGED_EVENT,
    () => { invalidPayloads += 1; },
  );

  function ensureActive(): void {
    if (disposed) throw adapterDisposedError();
  }

  function queueRefreshNotification(): void {
    if (disposed) return;
    refreshRequested = true;
    if (refreshRunning) return;
    refreshRunning = true;
    void (async () => {
      try {
        while (!disposed && refreshRequested) {
          refreshRequested = false;
          await options.settleBeforeDispose(() =>
            callbacks.emitAndWait(PLUGINS_CHANGED_CALLBACK, [], () => !disposed),
          );
        }
      } catch {
        if (!disposed) callbackErrors += 1;
      } finally {
        refreshRunning = false;
        if (!disposed && refreshRequested) queueRefreshNotification();
      }
    })();
  }

  function onNativePluginsChanged(): void {
    if (disposed) return;
    generation += 1;
    cached = undefined;
    if (!publicSubscriptionEstablished) {
      lateChangePending = true;
      return;
    }
    queueRefreshNotification();
  }

  function ensureEventObserver(): void {
    ensureActive();
    removeEventObserver ??= events.subscribe(onNativePluginsChanged);
  }

  async function loadSnapshot(readGeneration: number): Promise<PluginSnapshot> {
    const listenerReady = await events.ready();
    ensureActive();
    if (readGeneration !== generation) return readCurrentSnapshot();
    if (!listenerReady) {
      throw invalidRendererResponse("The plugin inventory change listener is unavailable.");
    }

    try {
      const response = await options.loadPlugins();
      ensureActive();
      if (readGeneration !== generation) return readCurrentSnapshot();
      const snapshot = { generation: readGeneration, plugins: mapPluginInventory(response) };
      ensureActive();
      if (readGeneration !== generation) return readCurrentSnapshot();
      cached = snapshot;
      return snapshot;
    } catch (error) {
      ensureActive();
      if (readGeneration !== generation) return readCurrentSnapshot();
      throw error;
    }
  }

  function readCurrentSnapshot(): Promise<PluginSnapshot> {
    ensureActive();
    if (cached?.generation === generation) return Promise.resolve(cached);
    if (pending?.generation === generation) return pending.promise;

    const readGeneration = generation;
    let promise!: Promise<PluginSnapshot>;
    promise = loadSnapshot(readGeneration).finally(() => {
      if (pending?.promise === promise) pending = undefined;
    });
    pending = { generation: readGeneration, promise };
    return promise;
  }

  async function readCurrent(): Promise<ZToolsRendererPlugin[]> {
    ensureEventObserver();
    while (true) {
      const snapshot = await options.settleBeforeDispose(readCurrentSnapshot);
      ensureActive();
      if (snapshot.generation === generation) return snapshot.plugins;
    }
  }

  async function getAllPlugins(): Promise<ZToolsRendererPlugin[]> {
    return JSON.parse(JSON.stringify(await readCurrent())) as ZToolsRendererPlugin[];
  }

  async function getDisabledPlugins(): Promise<string[]> {
    const plugins = await readCurrent();
    return plugins.filter((plugin) => !plugin.enabled).map((plugin) => plugin.path);
  }

  function onPluginsChanged(callback: () => unknown): RendererHostUnlisten {
    ensureEventObserver();
    assertRendererCallback(callback);
    const unsubscribe = callbacks.add(PLUGINS_CHANGED_CALLBACK, callback as (...args: never[]) => unknown);
    if (!unsubscribe) {
      throw invalidRendererArgument(HOST_ERROR_MESSAGES.CALLBACK_LIMIT(PLUGINS_CHANGED_CALLBACK));
    }
    if (!publicSubscriptionEstablished) {
      publicSubscriptionEstablished = true;
      if (lateChangePending) {
        lateChangePending = false;
        lateSubscriberRefreshes += 1;
        queueRefreshNotification();
      }
    }
    return unsubscribe;
  }

  return {
    getAllPlugins,
    getDisabledPlugins,
    onPluginsChanged,
    snapshot() {
      return {
        cachedPlugins: cached?.plugins.length ?? 0,
        generation,
        readPending: pending !== undefined,
        lateChangePending,
        lateSubscriberRefreshes,
        callbackErrors,
        invalidPayloads,
        eventSource: events.snapshot(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      refreshRequested = false;
      cached = undefined;
      pending = undefined;
      callbacks.clear();
      removeEventObserver?.();
      removeEventObserver = undefined;
      events.dispose();
    },
  };
}
