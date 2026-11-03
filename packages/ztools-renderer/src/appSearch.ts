import {
  adapterDisposedError,
  assertRendererCallback,
  HOST_ERROR_MESSAGES,
  invalidRendererArgument,
  invalidRendererResponse,
} from "./errors";
import { createRendererCallbackRegistry } from "./callbackRegistry";
import type { RendererAppCatalog } from "./appCatalog";
import type { RendererGeneralPreferenceEvents } from "./generalPreferenceEvents";
import type { RendererAppCatalogSnapshot, RendererHostUnlisten, ZToolsRendererApp } from "./types";

interface AppSearchOptions {
  catalog: RendererAppCatalog;
  readSettings: () => Promise<unknown>;
  preferences: Pick<RendererGeneralPreferenceEvents, "observeLocalAppSearch" | "ready">;
}

export interface RendererAppSearchCatalog {
  getApps(): Promise<ZToolsRendererApp[]>;
  resolve(path: string): Promise<ZToolsRendererApp | undefined>;
  onAppsChanged(callback: () => unknown): RendererHostUnlisten;
  snapshot(): RendererAppCatalogSnapshot;
  dispose(): void;
}

/** Keeps search visibility separate from the raw catalog used to validate app launches. */
export function createRendererAppSearchCatalog(options: AppSearchOptions): RendererAppSearchCatalog {
  let disposed = false;
  let enabled = true;
  let initialized = false;
  let settingRevision = 0;
  let visibilityRevision = 0;
  let initialization: Promise<void> | undefined;
  const callbacks = createRendererCallbackRegistry<"onAppsChanged">(["onAppsChanged"], 64);

  function ensureActive(): void {
    if (disposed) throw adapterDisposedError();
  }

  function notifyAppsChanged(): void {
    if (!disposed) callbacks.emit("onAppsChanged", []);
  }

  function applyEventValue(value: boolean): void {
    if (disposed) return;
    settingRevision += 1;
    const changed = enabled !== value;
    enabled = value;
    initialized = true;
    if (changed) {
      visibilityRevision += 1;
      notifyAppsChanged();
    }
  }

  const removeCatalogListener = options.catalog.onAppsChanged(notifyAppsChanged);
  const removePreferenceObserver = options.preferences.observeLocalAppSearch(applyEventValue);

  async function ensureGeneralSettingsListener(): Promise<void> {
    const listenerReady = await options.preferences.ready();
    ensureActive();
    if (!listenerReady) {
      initialized = false;
      throw invalidRendererResponse("The General settings listener is unavailable for app search.");
    }
  }

  async function initializeFromSnapshot(): Promise<void> {
    const revision = settingRevision;
    try {
      const settings = await options.readSettings();
      ensureActive();
      if (settingRevision !== revision) return;
      enabled = readLocalAppSearch(settings);
      initialized = true;
    } catch (error) {
      ensureActive();
      if (settingRevision !== revision) return;
      throw error;
    }
  }

  function ensureInitialized(): Promise<void> {
    ensureActive();
    if (initialized) return Promise.resolve();
    if (initialization) return initialization;

    let pending!: Promise<void>;
    pending = initializeFromSnapshot().finally(() => {
      if (initialization === pending) initialization = undefined;
    });
    initialization = pending;
    return pending;
  }

  async function getApps(): Promise<ZToolsRendererApp[]> {
    await ensureGeneralSettingsListener();
    await ensureInitialized();
    while (true) {
      ensureActive();
      if (!enabled) return [];
      const revision = visibilityRevision;
      const apps = await options.catalog.getApps();
      ensureActive();
      if (revision === visibilityRevision) return apps;
    }
  }

  function resolve(path: string): Promise<ZToolsRendererApp | undefined> {
    ensureActive();
    return options.catalog.resolve(path);
  }

  function onAppsChanged(callback: () => unknown): RendererHostUnlisten {
    ensureActive();
    assertRendererCallback(callback);
    const unsubscribe = callbacks.add("onAppsChanged", callback as (...args: never[]) => unknown);
    if (!unsubscribe) {
      throw invalidRendererArgument(HOST_ERROR_MESSAGES.CALLBACK_LIMIT("onAppsChanged"));
    }
    return unsubscribe;
  }

  return {
    getApps,
    resolve,
    onAppsChanged,
    snapshot: () => options.catalog.snapshot(),
    dispose() {
      if (disposed) return;
      disposed = true;
      callbacks.clear();
      removePreferenceObserver();
      removeCatalogListener();
      options.catalog.dispose();
    },
  };
}

function readLocalAppSearch(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRendererResponse("General settings are invalid for app search.");
  }
  const settings = value as Record<string, unknown>;
  if (!Object.hasOwn(settings, "localAppSearch")) return true;
  if (typeof settings.localAppSearch !== "boolean") {
    throw invalidRendererResponse("The stored localAppSearch setting is not boolean.");
  }
  return settings.localAppSearch;
}
