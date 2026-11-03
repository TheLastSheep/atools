import {
  adapterDisposedError,
  assertRendererCallback,
} from "./errors";
import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { mapLauncherApps } from "./mappers";
import type { RendererAppCatalogSnapshot, RendererHostUnlisten, ZToolsRendererApp, ZToolsRendererTransport } from "./types";

interface AppCatalogOptions {
  transport: Pick<ZToolsRendererTransport, "listen">;
  loadApps: () => Promise<unknown>;
}

export interface RendererAppCatalog {
  getApps(): Promise<ZToolsRendererApp[]>;
  resolve(path: string): Promise<ZToolsRendererApp | undefined>;
  onAppsChanged(callback: () => void): RendererHostUnlisten;
  snapshot(): RendererAppCatalogSnapshot;
  dispose(): void;
}

/** Owns one live app snapshot and serializes reads across catalog invalidations. */
export function createRendererAppCatalog(options: AppCatalogOptions): RendererAppCatalog {
  const events = createRendererEventSubscriptions(options.transport, "atools://renderer-apps-changed");
  let disposed = false;
  let invalidations = 0;
  let cached: ReadResult | undefined;
  let pending: Promise<ReadResult> | undefined;

  function ensureActive(): void {
    if (disposed) throw adapterDisposedError();
  }

  const removeInvalidationListener = events.subscribe(() => {
    invalidations += 1;
    cached = undefined;
  });

  async function readSnapshot(): Promise<ReadResult> {
    ensureActive();
    if (cached) return cached;
    if (pending) return pending;

    const generation = invalidations;
    let request: Promise<ReadResult>;
    request = events.ready()
      .then((cacheable) => {
        ensureActive();
        return options.loadApps().then((response) => ({ cacheable, response }));
      })
      .then(({ cacheable, response }) => {
        ensureActive();
        if (generation !== invalidations) {
          if (pending === request) pending = undefined;
          return readSnapshot();
        }
        const result = { generation, apps: mapLauncherApps(response), cacheable };
        if (cacheable) cached = result;
        return result;
      })
      .catch((error: unknown) => {
        ensureActive();
        throw error;
      })
      .finally(() => {
        if (pending === request) pending = undefined;
      });
    pending = request;
    return request;
  }

  async function readCurrent<T>(project: (apps: ZToolsRendererApp[]) => T): Promise<T> {
    const snapshot = await readSnapshot();
    ensureActive();
    return snapshot.generation === invalidations
      ? project(snapshot.apps)
      : readCurrent(project);
  }

  function getApps(): Promise<ZToolsRendererApp[]> {
    return readCurrent(cloneApps);
  }

  function resolve(path: string): Promise<ZToolsRendererApp | undefined> {
    return readCurrent((apps) => {
      const app = apps.find((entry) => entry.path === path);
      return app ? { ...app } : undefined;
    });
  }

  return {
    getApps,
    resolve,
    onAppsChanged(callback) {
      ensureActive();
      assertRendererCallback(callback);
      return events.subscribe(() => callback());
    },
    snapshot() {
      return {
        cachedApps: cached?.apps.length ?? 0,
        readPending: pending !== undefined,
        invalidations,
        eventSource: events.snapshot(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cached = undefined;
      pending = undefined;
      removeInvalidationListener();
      events.dispose();
    },
  };
}

interface ReadResult {
  generation: number;
  apps: ZToolsRendererApp[];
  cacheable: boolean;
}

function cloneApps(apps: ZToolsRendererApp[]): ZToolsRendererApp[] {
  return apps.map((app) => ({ ...app }));
}
