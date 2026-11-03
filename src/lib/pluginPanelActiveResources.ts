import type { createPluginRuntimePreload } from "./pluginRuntimePreload";
import type { createPluginResourceLease } from "./pluginResourceLease";
import type { createPluginPanelDocumentHost } from "./pluginPanelDocumentHost";
import type { createHostClipboardController } from "./hostClipboardController";
import type { createPluginDisplayController } from "./pluginDisplayController";
import type { createPluginDataController } from "./pluginDataController";
import type { createPluginDialogsController } from "./pluginDialogsController";
import type { createPluginFileDragController } from "./pluginFileDragController";
import type { createPluginPathsController } from "./pluginPathsController";
import type { createPluginSecretStorageController } from "./pluginSecretStorageController";
import type { createPluginPanelFileDropHost } from "./pluginPanelFileDropHost";
import type { createPluginAiController } from "./pluginAiController";
import { closePluginPanelResourcesStrict, createPluginPanelCloseTracker } from "./pluginPanelCloseTracker";

/** Owns active capability instances and their shared close order for one plugin panel. */
export function createPluginPanelActiveResources() {
  const closeTracker = createPluginPanelCloseTracker();
  let initialClose: Promise<void> | undefined, retryClose: Promise<void> | undefined;
  const terminalFailures: unknown[] = [];
  let runtime: ReturnType<typeof createPluginRuntimePreload> | undefined;
  let lease: ReturnType<typeof createPluginResourceLease> | undefined;
  let page: ReturnType<typeof createPluginPanelDocumentHost> | undefined;
  let clipboard: ReturnType<typeof createHostClipboardController> | undefined;
  let display: ReturnType<typeof createPluginDisplayController> | undefined;
  let data: ReturnType<typeof createPluginDataController> | undefined;
  let dialogs: ReturnType<typeof createPluginDialogsController> | undefined;
  let fileDrag: ReturnType<typeof createPluginFileDragController> | undefined;
  let paths: ReturnType<typeof createPluginPathsController> | undefined;
  let secretStorage: ReturnType<typeof createPluginSecretStorageController> | undefined;
  let fileDrop: ReturnType<typeof createPluginPanelFileDropHost> | undefined;
  let ai: ReturnType<typeof createPluginAiController> | undefined;

  function closeAllStrict(options?: { retry?: boolean }): Promise<void> {
    if (options?.retry) {
      if (!initialClose) return Promise.reject(new Error("ERR_ATOOLS_PLUGIN_CLEANUP_NOT_STARTED"));
      if (retryClose) return retryClose;
      retryClose = (async () => {
        if (initialClose) await initialClose.catch(() => {});
        await closeTracker.retryFailed();
        if (terminalFailures.length) throw terminalFailures[0];
      })();
      const current = retryClose;
      void current.finally(() => { if (retryClose === current) retryClose = undefined; }).catch(() => {});
      return current;
    }
    if (initialClose) return initialClose;
    closeTracker.begin();
    initialClose = closePluginPanelResourcesStrict([
      () => page?.close(), () => runtime?.closeStrict(), () => lease?.close(), () => clipboard?.close(),
      () => display?.close(), () => data?.close(), () => paths?.close(), () => dialogs?.close(),
      () => fileDrag?.close(), () => secretStorage?.close(), () => fileDrop?.close(), () => ai?.close(),
    ], () => closeTracker.drain(), errors => {
      for (const error of errors) if (!closeTracker.hasFailedError(error)) terminalFailures.push(error);
    });
    return initialClose;
  }

  function closeAll() {
    void closeAllStrict().catch(error => console.warn("[PluginPanel] resource teardown failed", error));
  }

  return {
    get runtime() { return runtime; }, set runtime(value) { runtime = value; },
    get lease() { return lease; }, set lease(value) { lease = value; },
    get page() { return page; }, set page(value) { page = value; },
    get clipboard() { return clipboard; }, set clipboard(value) { clipboard = value; },
    get display() { return display; }, set display(value) { display = value; },
    get data() { return data; }, set data(value) { data = value; },
    get dialogs() { return dialogs; }, set dialogs(value) { dialogs = value; },
    get fileDrag() { return fileDrag; }, set fileDrag(value) { fileDrag = value; },
    get paths() { return paths; }, set paths(value) { paths = value; },
    get secretStorage() { return secretStorage; }, set secretStorage(value) { secretStorage = value; },
    get fileDrop() { return fileDrop; }, set fileDrop(value) { fileDrop = value; },
    get ai() { return ai; }, set ai(value) { ai = value; },
    closeAll, closeAllStrict, closeTracker,
  };
}
