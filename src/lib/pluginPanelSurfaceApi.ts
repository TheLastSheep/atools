import { destroyPluginPanelSession } from "./pluginPanelSessionLifecycle";
import type { createPluginMainPushHost } from "./pluginMainPushHost";
import type { createPluginPanelSessionLifecycle } from "./pluginPanelSessionLifecycle";
import type { MainPushEntry } from "./pluginMainPushProtocol";
import type { FeatureAction } from "./types";

type MainPushHost = ReturnType<typeof createPluginMainPushHost>;
type PanelLifecycle = ReturnType<typeof createPluginPanelSessionLifecycle>;

/** Exposes the mounted panel's imperative host API and owns terminal disposal. */
export function createPluginPanelSurfaceApi(options: {
  mainPushHost?: MainPushHost;
  resolveIcon(value: string): Promise<string>;
  lifecycle: PanelLifecycle;
  messageHost: { close(): void };
  persistentSessionId?: string;
  documentPluginId: string;
  afterRender(): Promise<unknown>;
  focusFrame(): void;
  destroyBrowserWindows(): void | Promise<void> | undefined;
}) {
  let messageHostCloseAttempted = false, messageHostCloseFailed = false, messageHostCloseError: unknown;
  let initialStrictClose: Promise<void> | undefined, retryClosePromise: Promise<void> | undefined;
  function closeMessageHostOnce() {
    if (!messageHostCloseAttempted) {
      messageHostCloseAttempted = true;
      try { options.messageHost.close(); }
      catch (error) { messageHostCloseFailed = true; messageHostCloseError = error; }
    }
    if (messageHostCloseFailed) throw messageHostCloseError;
  }
  const run = (action: () => unknown | Promise<unknown>) => {
    try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
  };
  function closeStrictOnce() {
    if (initialStrictClose) return initialStrictClose;
    const messageClose = run(() => closeMessageHostOnce());
    const lifecycleClose = run(() => options.lifecycle.destroyStrict());
    initialStrictClose = Promise.allSettled([
      lifecycleClose, messageClose,
    ]).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    return initialStrictClose;
  }
  function retryCloseExplicitly() {
    if (retryClosePromise) return retryClosePromise;
    retryClosePromise = (async () => {
      await closeStrictOnce().catch(() => {});
      await options.lifecycle.retryDestroyStrict();
      if (messageHostCloseFailed) throw messageHostCloseError;
    })();
    const current = retryClosePromise;
    void current.finally(() => { if (retryClosePromise === current) retryClosePromise = undefined; }).catch(() => {});
    return current;
  }
  return {
    async mainPushQuery(requestId: string, generation: number, payload: string, type: string) {
      return options.mainPushHost?.query(requestId, generation, payload, type) ?? Promise.reject(Error("ERR_MAIN_PUSH_NOT_READY"));
    },
    async mainPushSelect(requestId: string, queryId: string, generation: number, handle: string) {
      return options.mainPushHost?.select(requestId, queryId, generation, handle) ?? Promise.reject(Error("ERR_MAIN_PUSH_NOT_READY"));
    },
    mainPushPromote(entry: MainPushEntry) { options.mainPushHost?.promote(entry); },
    mainPushCancel() { options.mainPushHost?.cancel(); },
    mainPushReady() { return options.mainPushHost?.ready() ?? Promise.reject(Error("ERR_MAIN_PUSH_NOT_READY")); },
    mainPushResolveIcon(value: string) { return options.resolveIcon(value); },
    async activatePersistentEntry(next: FeatureAction) {
      if (!options.persistentSessionId || next.plugin_id !== options.documentPluginId) return false;
      if (!await options.lifecycle.activatePersistentEntry(next)) return false;
      await options.afterRender();
      options.focusFrame();
      return true;
    },
    setPersistentVisible(visible: boolean) { return options.lifecycle.setPersistentVisible(visible); },
    closePersistentStrict(closeOptions?: { retry?: boolean }) {
      return closeOptions?.retry ? retryCloseExplicitly() : closeStrictOnce();
    },
    destroyOnUnmount() {
      return destroyPluginPanelSession({ close: closeMessageHostOnce }, options.lifecycle, {
        destroyPluginBrowserWindows: options.destroyBrowserWindows,
      }).catch(() => { console.warn("[PluginPanel] unmount teardown incomplete"); });
    },
  };
}
