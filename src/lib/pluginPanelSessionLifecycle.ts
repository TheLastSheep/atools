import type { FeatureAction } from "./types";
import type { PluginPanelLoadRetryController } from "./pluginPanelLoadRetry";
import type { PluginWorkerDocumentLifecycle, PluginWorkerDocumentLifecycleResult } from "./pluginWorkerDocumentLifecycle";
import type { PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
type PluginHostedIpcRouter = ReturnType<typeof createPluginHostedIpcRouter>;
type PostPort = (source: unknown, message: unknown) => boolean;

function isConfirmedWorkerShutdown(value: unknown): value is PluginWorkerDocumentLifecycleResult {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => typeof key !== "string"
      || !["requested", "acknowledged", "timedOut"].includes(key))) return false;
    const result = value as Partial<PluginWorkerDocumentLifecycleResult>;
    const requested = result.requested, acknowledged = result.acknowledged;
    return typeof requested === "number" && Number.isSafeInteger(requested) && requested >= 0
      && typeof acknowledged === "number" && Number.isSafeInteger(acknowledged) && acknowledged === requested
      && result.timedOut === false;
  } catch { return false; }
}

export interface PluginPanelSessionLifecyclePorts {
  action(): FeatureAction; documentPluginId?: string; persistentSessionId?: string;
  closingAction(): FeatureAction | undefined; setClosingAction(value: FeatureAction | undefined): void;
  workerDocument: PluginWorkerDocumentLifecycle; nextGeneration(): number; currentGeneration(): number;
  retry: PluginPanelLoadRetryController; clearLoadError(): void; resetFeatures(generation: number): void;
  resetEntry?(action: FeatureAction): void;
  hostedIpc: PluginHostedIpcRouter; invalidateBrowserWindows(): void; clearPermissionRequests(): void;
  closeResources(): void; closeResourcesStrict?: (options?: { retry?: boolean }) => Promise<void>;
  beginStrictClose?: () => void;
  destroyBrowserWindows?: () => void | Promise<void>;
  iframeWindow(): Window | null; post: PostPort; wasOutDispatched(): boolean; setOutDispatched(value: boolean): void;
  wasDetachDispatched(): boolean; setDetachDispatched(value: boolean): void;
  onclose(isKill?: boolean): void | Promise<void>;
  invoke(command: string): Promise<unknown>;
  mainPushHost?: { close(): void }; mainPushPermissions?: { close(): void };
  webStorageRelay: { close(): void }; sources: PluginFrameSourceRegistry;
  persistentGrantsUpdatedEvent: string; currentPluginId(): string; permissionGrants(pluginId: string): string[];
  setPersistentPermissions(value: string[]): void; handlePanelKeydown(event: KeyboardEvent): void;
  onSettings?(): void; resolveDestroyedSmokeProbe(): void; setVisible?: (visible: boolean) => void;
}

export function createPluginPanelSessionLifecycle(ports: PluginPanelSessionLifecyclePorts) {
  let visible = ports.persistentSessionId ? false : true;
  let terminal: Promise<void> | undefined, retrying: Promise<void> | undefined, activationId = 0;
  let resourceCleanupFailed = false, strictCleanupComplete = false;
  const terminalFailures: unknown[] = [];
  const persistent = Boolean(ports.persistentSessionId);
  const postLifecycle = (event: "plugin-out" | "plugin-detach" | "plugin-enter" | "plugin-hide", detail: Record<string, unknown> = {}) =>
    ports.post(ports.iframeWindow(), { __atools_lifecycle__: true, event, ...detail });
  const dispatchPluginOutEvent = (isKill: boolean) => {
    if (ports.wasOutDispatched()) return;
    ports.setOutDispatched(true); postLifecycle("plugin-out", { isKill });
  };
  const dispatchPluginDetachEvent = () => {
    if (ports.wasDetachDispatched()) return;
    ports.setDetachDispatched(true); postLifecycle("plugin-detach");
  };
  async function setPersistentVisible(next: boolean) {
    if (!persistent || terminal || visible === next) return;
    visible = next; ports.setVisible?.(next);
    if (!next) postLifecycle("plugin-hide");
  }
  async function activatePersistentEntry(action: FeatureAction) {
    if (!persistent || terminal || action.plugin_id !== (ports.documentPluginId ?? ports.action().plugin_id)
      || !Number.isSafeInteger(activationId + 1)) return false;
    const nextId = ++activationId;
    ports.resetEntry?.(action);
    const entry = { code: action.feature_code, type: action.entry_type ?? "text", payload: action.payload, from: "main" };
    if (!ports.post(ports.iframeWindow(), { __atools_lifecycle__: true, event: "plugin-enter", action: entry, activationId: nextId })) return false;
    visible = true; ports.setVisible?.(true);
    return true;
  }
  const handlePluginChromeAction = (actionId: "detach" | "settings" | "back") => {
    switch (actionId) {
      case "detach": dispatchPluginDetachEvent(); break;
      case "settings": ports.onSettings?.(); break;
      case "back": void closePluginPanel(); break;
    }
  };
  const mount = () => {
    const onOutputContextMenuKeydown = (event: KeyboardEvent) => { if (visible) ports.handlePanelKeydown(event); };
    const onPluginRuntimePermissionGrantsUpdated = () => ports.setPersistentPermissions(ports.permissionGrants(ports.action().plugin_id));
    window.addEventListener("keydown", onOutputContextMenuKeydown, { capture: true });
    window.addEventListener(ports.persistentGrantsUpdatedEvent, onPluginRuntimePermissionGrantsUpdated);
    return () => {
      window.removeEventListener("keydown", onOutputContextMenuKeydown, { capture: true });
      window.removeEventListener(ports.persistentGrantsUpdatedEvent, onPluginRuntimePermissionGrantsUpdated);
    };
  };
  function destroyStrict(destroyBrowserWindows?: () => void | Promise<void>) {
    if (terminal) return terminal;
    terminal = (async () => {
      const initialFailures: unknown[] = [];
      const attempt = (action: () => unknown) => {
        try { return action(); } catch (error) { initialFailures.push(error); return undefined; }
      };
      const run = (action: () => unknown | Promise<unknown>) => {
        try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
      };
      visible = false; attempt(() => ports.setVisible?.(false));
      attempt(() => ports.beginStrictClose?.());
      attempt(() => ports.mainPushHost?.close()); attempt(() => ports.mainPushPermissions?.close());
      attempt(() => ports.workerDocument.cancel());
      const destroyWindows = destroyBrowserWindows ?? ports.destroyBrowserWindows;
      const windowsClosed = destroyWindows ? run(() => destroyWindows()) : undefined;
      attempt(() => ports.webStorageRelay.close());
      const generation = attempt(() => ports.nextGeneration());
      if (typeof generation === "number") attempt(() => ports.retry.invalidate(generation));
      attempt(() => ports.clearPermissionRequests());
      attempt(() => ports.resolveDestroyedSmokeProbe()); attempt(() => dispatchPluginOutEvent(true));
      attempt(() => ports.hostedIpc.clear()); attempt(() => ports.sources.clear());
      if (!destroyWindows) attempt(() => ports.invalidateBrowserWindows());
      const resourceIndex = destroyWindows ? 2 : 1;
      const closes = [
        run(() => ports.workerDocument.shutdown()),
        ...(windowsClosed ? [windowsClosed] : []),
        ...(ports.closeResourcesStrict
          ? [run(() => ports.closeResourcesStrict?.())]
          : [run(() => ports.closeResources())]),
      ];
      const results = await Promise.allSettled(closes);
      terminalFailures.push(...initialFailures);
      let workerShutdownFailed = false, workerShutdownFailure: unknown;
      if (results[0]?.status === "rejected") {
        workerShutdownFailed = true; workerShutdownFailure = results[0].reason;
      } else if (!isConfirmedWorkerShutdown(results[0]?.value)) {
        workerShutdownFailed = true; workerShutdownFailure = new Error("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
      }
      if (workerShutdownFailed) terminalFailures.push(workerShutdownFailure);
      if (destroyWindows && results[1]?.status === "rejected") terminalFailures.push(results[1].reason);
      const resourceResult = results[resourceIndex];
      resourceCleanupFailed = resourceResult?.status === "rejected";
      if (!ports.closeResourcesStrict && resourceCleanupFailed) terminalFailures.push((resourceResult as PromiseRejectedResult).reason);
      const failure = results.find(result => result.status === "rejected");
      if (workerShutdownFailed) throw workerShutdownFailure;
      if (initialFailures.length) throw initialFailures[0];
      if (failure?.status === "rejected") throw failure.reason;
      strictCleanupComplete = true;
    })();
    return terminal;
  }
  function retryDestroyStrict(destroyBrowserWindows?: () => void | Promise<void>) {
    if (strictCleanupComplete) return Promise.resolve();
    if (retrying) return retrying;
    const initial = destroyStrict(destroyBrowserWindows);
    retrying = (async () => {
      await initial.catch(() => {});
      if (resourceCleanupFailed && ports.closeResourcesStrict) {
        await ports.closeResourcesStrict({ retry: true });
        resourceCleanupFailed = false;
      }
      if (terminalFailures.length) throw terminalFailures[0];
      strictCleanupComplete = true;
    })();
    const current = retrying;
    void current.finally(() => { if (retrying === current) retrying = undefined; }).catch(() => {});
    return current;
  }
  const destroy = (destroyBrowserWindows?: () => void | Promise<void>) => {
    const completion = destroyStrict(destroyBrowserWindows);
    void completion.catch(error => console.warn("[PluginPanel] strict teardown failed:", error));
    return completion;
  };
  const closePluginPanel = async () => {
    if (persistent) {
      await setPersistentVisible(false);
      await ports.onclose(false);
      ports.invoke("reset_window").catch(() => {});
      return;
    }
    const closingAction = ports.action();
    if (ports.closingAction() === closingAction) return;
    ports.setClosingAction(closingAction);
    const workersStopped = ports.workerDocument.shutdown();
    const generation = ports.nextGeneration(); ports.retry.invalidate(generation); ports.clearLoadError();
    ports.resetFeatures(generation); ports.hostedIpc.clear(); ports.invalidateBrowserWindows(); ports.clearPermissionRequests(); ports.closeResources();
    dispatchPluginOutEvent(false); await workersStopped;
    if (generation !== ports.currentGeneration() || ports.action() !== closingAction) return;
    await ports.onclose(false); ports.invoke("reset_window").catch(() => {});
  };
  async function handlePluginClose(isKill: boolean) {
    if (persistent && isKill) { await ports.onclose(true); return; }
    await closePluginPanel();
  }
  return { dispatchPluginOutEvent, dispatchPluginDetachEvent, handlePluginChromeAction, closePluginPanel,
    handlePluginClose, mount, destroy, destroyStrict, retryDestroyStrict, setPersistentVisible, activatePersistentEntry };
}

export function destroyPluginPanelSession(
  messageHost: { close(): void },
  lifecycle: { destroy(destroyBrowserWindows?: () => void | Promise<void>): void | Promise<void> },
  browserWindows?: { destroyPluginBrowserWindows(): void | Promise<void> },
) {
  const run = (action: () => unknown | Promise<unknown>) => {
    try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
  };
  return Promise.allSettled([
    run(() => messageHost.close()),
    run(() => lifecycle.destroy(browserWindows ? () => browserWindows.destroyPluginBrowserWindows() : undefined)),
  ]).then(results => {
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
}
