import { untrack } from "svelte";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen as listenTauriEvent } from "@tauri-apps/api/event";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { FeatureAction, PluginItem } from "./types";
import { emptyPluginFeatureList } from "./pluginFeatureExportsState";
import { emptyPluginSubInput } from "./pluginSubInputState";
import type { PluginFeatureList as PluginFeatureListState } from "./pluginFeatureExportsState";
import type { PluginSubInputState } from "./pluginSubInputState";
import { pluginPageDocumentModeEnabled } from "./pluginPageDocument";
import { createPluginPanelDocumentHost } from "./pluginPanelDocumentHost";
import { createPluginRuntimePreload } from "./pluginRuntimePreload";
import { createPluginResourceLease } from "./pluginResourceLease";
import { createHostClipboardController, type HostClipboardStatus } from "./hostClipboardController";
import type { HostClipboardConfig } from "./hostClipboardBridge";
import { createPluginDisplayController } from "./pluginDisplayController";
import type { PluginDisplayConfig } from "./pluginDisplayBridge";
import { createPluginDataController, type PluginDataStatus } from "./pluginDataController";
import type { PluginDataConfig } from "./pluginDataBridge";
import { createPluginPathsController } from "./pluginPathsController";
import type { PluginPathsConfig } from "./pluginPathsBridge";
import { createPluginDialogsController } from "./pluginDialogsController";
import { createPluginFileDragController } from "./pluginFileDragController";
import type { PluginDialogsConfig } from "./pluginNativeDialogBridge";
import { createPluginSecretStorageController } from "./pluginSecretStorageController";
import { preparePluginHtmlResources } from "./pluginResourceHtml";
import { resolvePluginPackageMainUrl } from "./pluginPackageResourcePath";
import { assertPluginEntryReady } from "./pluginEntryReadiness";
import { injectPluginHostScripts } from "./pluginBridgeTransportBinding";
import type { PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import type { DesktopSmokeBridgeProbeResult } from "./pluginPanelDesktopSmokeState";
import { createPluginMainPushPermissionTracker } from "./pluginMainPushPermissions";
import { createPluginMainPushHost } from "./pluginMainPushHost";
import { createPluginPanelFileDropHost } from "./pluginPanelFileDropHost";
import { createPluginAiController } from "./pluginAiController";

type Ports = {
  action: () => FeatureAction;
  persistentSessionId?: string;
  entryMode?: "activate" | "preload";
  closeTracker?: { wrap: (invoke: <R = unknown>(command: string, args?: Record<string, unknown>) => Promise<R>) => <R = unknown>(command: string, args?: Record<string, unknown>) => Promise<R> };
  onLoadError?: (error: unknown) => void | Promise<void>;
  pluginLoadGeneration: number;
  pluginLoadRetry: ReturnType<typeof import("./pluginPanelLoadRetry").createPluginPanelLoadRetryController>;
  loadError: string | null;
  pluginClosingAction: FeatureAction | undefined;
  workerDocument: ReturnType<typeof import("./pluginWorkerDocumentLifecycle").createPluginWorkerDocumentLifecycle>;
  mainPushHost?: ReturnType<typeof createPluginMainPushHost>;
  featureList: PluginFeatureListState;
  hostedIpc: ReturnType<typeof import("./pluginHostedIpcRouter").createPluginHostedIpcRouter>;
  subInputState: PluginSubInputState;
  clearPluginPermissionRequests: () => void;
  activePluginPage?: ReturnType<typeof createPluginPanelDocumentHost> | undefined;
  activePluginRuntime?: ReturnType<typeof createPluginRuntimePreload> | undefined;
  activePluginResources?: ReturnType<typeof createPluginResourceLease> | undefined;
  activeHostClipboard?: ReturnType<typeof createHostClipboardController> | undefined;
  activePluginDisplay?: ReturnType<typeof createPluginDisplayController> | undefined;
  activePluginData?: ReturnType<typeof createPluginDataController> | undefined;
  activePluginPaths?: ReturnType<typeof createPluginPathsController> | undefined;
  activePluginDialogs?: ReturnType<typeof createPluginDialogsController> | undefined;
  activePluginFileDrag?: ReturnType<typeof createPluginFileDragController> | undefined;
  activePluginSecretStorage?: ReturnType<typeof createPluginSecretStorageController> | undefined;
  activeFileDropHost?: ReturnType<typeof createPluginPanelFileDropHost> | undefined;
  activePluginAi?: ReturnType<typeof createPluginAiController> | undefined;
  childFrames: Map<string, HTMLIFrameElement>;
  onFileDropStatus: (message: string | null) => void;
  invalidateBrowserWindows: () => void;
  messageSources: PluginFrameSourceRegistry;
  iframeRef: HTMLIFrameElement | null;
  iframeSrc: string;
  iframeSrcDoc: string;
  hostClipboardStatus: HostClipboardStatus | null;
  pluginDisplayStatus: PluginDataStatus | null;
  pluginDataStatus: PluginDataStatus | null;
  pluginPathsStatus: PluginDataStatus | null;
  pluginDialogsStatus: PluginDataStatus | null;
  webStorageRelay: { start: () => Promise<void> };
  mainPushPermissions?: ReturnType<typeof createPluginMainPushPermissionTracker>;
  webPreviewPluginPath: string;
  desktopSmokeSampleIndex: () => number;
  desktopSmokeExpectedSamples: () => number;
  desktopSmokeExternalPlanSample: () => boolean;
  loadPreviewPluginHtml: () => void;
  injectPluginBridge: (html: string, windowType?: "main" | "browserWindow", browserWindowId?: string, preloadScript?: string, geometrySnapshot?: unknown,
    entryMode?: "activate" | "preload") => string;
  injectDesktopSmokeBridgeProbe: (html: string) => string;
  smokeProbeFailure: (reason: string) => DesktopSmokeBridgeProbeResult;
  waitForSmokeProbe: (pluginId: string, featureCode: string, sampleIndex: number, htmlBytes: number) => Promise<DesktopSmokeBridgeProbeResult>;
  reportRenderSmoke: (options: {mainFile:string; html:string; fsLoad:boolean; loadError?:string; bridgeProbe?:DesktopSmokeBridgeProbeResult}) => Promise<void>;
  waitForHostPaint: () => Promise<void>;
  focusMainFrame: (node: HTMLIFrameElement | null, retryHandoffFrom?: HTMLElement) => boolean;
  reportPluginReady: () => void;
  pluginItems: PluginItem[];
  selectedIndex: number;
  tick: () => Promise<unknown>;
};

export function createPluginPanelLoadController(ports: Ports) {
  function retryPluginLoad(focusHandoffFrom: HTMLButtonElement) {
    // A persistent owner is a tombstoned native session after startup failure.
    // Retrying it in place would reuse the same UUID and cannot be safe.
    if (ports.persistentSessionId) return;
    const token = ports.pluginLoadRetry.requestRetry(ports.pluginLoadGeneration);
    if (token === null) return;
    void loadPluginHtml(undefined, undefined, undefined, undefined, undefined, token, focusHandoffFrom);
  }

  async function loadPluginHtml(initialClipboard?: HostClipboardConfig, initialData?: PluginDataConfig, initialPaths?: PluginPathsConfig, initialDialogs?: PluginDialogsConfig, initialDisplay?: PluginDisplayConfig, retryToken?: number, retryFocusHandoffFrom?: HTMLButtonElement) {
    const loadAction = ports.action();
    const generation = ports.pluginLoadGeneration + 1;
    const accepted = retryToken === undefined
      ? ports.pluginLoadRetry.beginAutomatic(generation)
      : ports.pluginLoadRetry.beginRetry(generation, retryToken);
    if (!accepted) return;
    ports.pluginLoadGeneration = generation;
    if (retryToken === undefined) ports.loadError = null;
    ports.onFileDropStatus(null);
    ports.pluginClosingAction = undefined;
    const workersStopped = untrack(() => ports.workerDocument.shutdown());
    const previousFileDropHost = ports.activeFileDropHost;
    ports.activeFileDropHost = undefined;
    ports.activePluginAi?.close();
    ports.activePluginAi = undefined;
    untrack(() => ports.mainPushHost?.reset(generation));
    ports.featureList = emptyPluginFeatureList(generation);
    ports.hostedIpc.clear();
    ports.subInputState = untrack(() => emptyPluginSubInput(ports.subInputState.sequence + 1, 0, generation));
    const isCurrent = () => generation === ports.pluginLoadGeneration && ports.action() === loadAction;
    ports.clearPluginPermissionRequests();
    void ports.activePluginPage?.close();
    void ports.activePluginRuntime?.close();
    void ports.activePluginResources?.close();
    void ports.activeHostClipboard?.close(); void ports.activePluginDisplay?.close();
    void ports.activePluginData?.close();
    void ports.activePluginPaths?.close();
    void ports.activePluginDialogs?.close();
    void ports.activePluginFileDrag?.close();
    void ports.activePluginSecretStorage?.close();
    await Promise.all([workersStopped, previousFileDropHost?.close()]);
    if (!isCurrent()) return;
    untrack(() => {
      ports.invalidateBrowserWindows();
      ports.messageSources.unregisterMain(ports.iframeRef?.contentWindow);
    });
    ports.iframeSrc = "";
    ports.iframeSrcDoc = "";
    ports.hostClipboardStatus = null;
    ports.pluginDisplayStatus = null;
    ports.pluginDataStatus = null;
    ports.pluginPathsStatus = null;
    ports.pluginDialogsStatus = null;
    const trackedInvoke = ports.closeTracker?.wrap(invoke) ?? invoke;
    const page = pluginPageDocumentModeEnabled() && loadAction.plugin_path !== ports.webPreviewPluginPath
      ? createPluginPanelDocumentHost({ invoke: trackedInvoke, pluginId: loadAction.plugin_id, pluginRoot: loadAction.plugin_path,
        parentOrigin: window.location.origin, isCurrent, sources: ports.messageSources,
        listenNativeRevocation: (event: string, receive: (event: { payload: unknown }) => void) => listenTauriEvent(event, receive),
      onFailure: () => { if (isCurrent()) { ports.featureList = emptyPluginFeatureList(generation); ports.clearPluginPermissionRequests(); ports.activePluginAi?.close(); void ports.activePluginRuntime?.close(); void ports.activeHostClipboard?.close(); void ports.activePluginDisplay?.close(); void ports.activePluginData?.close(); void ports.activePluginPaths?.close(); void ports.activePluginDialogs?.close(); void ports.activePluginFileDrag?.close(); void ports.activePluginSecretStorage?.close(); const message = "插件页面已失效，请退出后重新打开"; ports.loadError = message; ports.pluginLoadRetry.terminal(generation, message); } },
      }) : undefined;
    ports.activePluginPage = page;
    if (page) { ports.pluginItems = []; ports.selectedIndex = 0; }
    const runtimeInvokeBase = page?.invoke ?? trackedInvoke;
    const runtimeInvoke = ports.mainPushPermissions?.wrap(runtimeInvokeBase) ?? runtimeInvokeBase;
    const pluginAi = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined
      : createPluginAiController({ pluginId: loadAction.plugin_id, invoke: runtimeInvoke, isCurrent, sources: ports.messageSources, hostedIpc: ports.hostedIpc });
    ports.activePluginAi = pluginAi;
    const resourceUrl = page?.resourceUrl ?? convertFileSrc;
    const hostClipboard = createHostClipboardController(runtimeInvoke, loadAction.plugin_id, isCurrent,
      (status) => { if (isCurrent()) ports.hostClipboardStatus = status; }, initialClipboard);
    ports.activeHostClipboard = hostClipboard;
    const display = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined : createPluginDisplayController(runtimeInvoke,
      loadAction.plugin_id, isCurrent, status => { if (isCurrent()) ports.pluginDisplayStatus = status; }, initialDisplay);
    ports.activePluginDisplay = display;
    const data = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined : createPluginDataController(runtimeInvoke,
      loadAction.plugin_id, isCurrent, (status) => { if (isCurrent()) ports.pluginDataStatus = status; }, initialData);
    ports.activePluginData = data;
    const paths = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined : createPluginPathsController(ports.mainPushPermissions?.wrap(trackedInvoke) ?? trackedInvoke,
      loadAction.plugin_id, isCurrent, status => { if (isCurrent()) ports.pluginPathsStatus = status; }, initialPaths);
    ports.activePluginPaths = paths;
    const dialogs = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined : createPluginDialogsController(runtimeInvoke,
      loadAction.plugin_id, isCurrent, status => { if (isCurrent()) ports.pluginDialogsStatus = status; }, initialDialogs);
    ports.activePluginDialogs = dialogs;
    const fileDrag = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined
      : createPluginFileDragController({ invoke: trackedInvoke, pluginId: loadAction.plugin_id, isCurrent,
        pageDocumentId: () => page?.configuration().pageDocumentId,
        onStatus: status => { if (status) (status.state === "error" ? console.warn : console.info)(`[PluginPanel] ${status.message}`); },
      });
    ports.activePluginFileDrag = fileDrag;
    const runtime = createPluginRuntimePreload(runtimeInvoke, loadAction.plugin_id, isCurrent, undefined,
      ports.persistentSessionId);
    ports.activePluginRuntime = runtime;
    const secretStorage = loadAction.plugin_path === ports.webPreviewPluginPath ? undefined
      : createPluginSecretStorageController(runtimeInvoke, loadAction.plugin_id, isCurrent, () => {});
    ports.activePluginSecretStorage = secretStorage;
    const resources = createPluginResourceLease({ invoke: trackedInvoke, pluginId: loadAction.plugin_id,
      pluginRoot: loadAction.plugin_path, isCurrent, convertFileSrc });
    ports.activePluginResources = resources;
    const mainFile = loadAction.main_url || "index.html";
    const headlessPlugin = !loadAction.main_url?.trim();
    try {
      if (loadAction.plugin_path === ports.webPreviewPluginPath) {
        ports.loadPreviewPluginHtml();
        return;
      }
      await page?.prepare();
      if (!isCurrent()) return;
      if (data) await ports.webStorageRelay.start();
      if (!isCurrent()) return;
      await data?.prepare();
      if (!isCurrent()) return;
      await paths?.prepare();
      if (!isCurrent()) return;
      await dialogs?.prepare();
      if (!isCurrent()) return;
      await display?.prepare();
      if (!isCurrent()) return;
      await hostClipboard.prepareGranted();
      if (!isCurrent()) return;
      const pluginDir = loadAction.plugin_path;
      let html: string;
      if (headlessPlugin) {
        html = '<!doctype html><html><head><meta charset="UTF-8"></head><body data-atools-headless-plugin="true"></body></html>';
      } else {
        const mainFilePath = resolvePluginPackageMainUrl(pluginDir, mainFile);
        if (!mainFilePath) throw new Error("ERR_ATOOLS_PLUGIN_MAIN_PATH");
        html = await readTextFile(mainFilePath);
        if (!isCurrent()) return;
        assertPluginEntryReady(html);
        html = await preparePluginHtmlResources(html, {
          pluginDir,
          mainFile,
          pluginRoot: pluginDir,
          mainFilePath,
          readTextFile,
          convertFileSrc: resourceUrl,
          resolveModuleSrc: page ? resourceUrl : resources.resolveModuleSrc,
          warn: (message, error) => console.warn(`[PluginPanel] ${message}`, error),
        });
      }
      if (!isCurrent()) return;

      let preloadScript = "";
      // Preload must run after the Host Bridge and before any plugin page bundle,
      // matching Electron/ZTools preload semantics.
      if (loadAction.preload_path) {
        preloadScript = await runtime.prepare({
          pluginDir,
          preloadPath: loadAction.preload_path,
          isCurrent,
          readTextFile: (modulePath) => invoke<string>("read_plugin_preload_module", {
            pluginId: loadAction.plugin_id,
            modulePath,
          }),
          onSafeStorageRequired: async () => { if (!secretStorage) throw new Error("ERR_ATOOLS_SECRET_STORAGE_UNAVAILABLE"); await secretStorage.prepare(); },
        onFileDragRequired: async () => { await fileDrag?.prepare(); },
        });
      } else if (!headlessPlugin) {
        // A trusted bounded page scan can request the ordinary Node permission flow.
        // Unknown and pure Web pages keep their existing zero-Node startup path.
        preloadScript = await runtime.preparePage();
      }
      if (!isCurrent()) return;

      html = ports.injectPluginBridge(html, "main", "", preloadScript, undefined, ports.entryMode ?? "activate");
      if (page) {
        const observer = await invoke<string>("native_panel_document_probe_source");
        if (!isCurrent()) return;
        html = injectPluginHostScripts(html, `<script>${observer.replace(/<\/script/gi, "<\\/script")}<\/script>`);
      }
      if (!page) html = ports.injectDesktopSmokeBridgeProbe(html);

      const bridgeProbePromise = page ? undefined : ports.waitForSmokeProbe(
        loadAction.plugin_id,
        loadAction.feature_code,
        ports.desktopSmokeSampleIndex(),
        html.length
      );
      ports.iframeSrc = page ? page.stage(html) : "";
      ports.iframeSrcDoc = page ? "" : html;
      if (page) { html = ""; preloadScript = ""; }
      await ports.tick();
      if (page) await page.ready;
      await ports.waitForHostPaint();
      if (!isCurrent()) return;
      if (!ports.pluginLoadRetry.succeed(generation)) return;
      ports.loadError = null;
      ports.focusMainFrame(ports.iframeRef, retryToken === undefined ? undefined : retryFocusHandoffFrom);
      ports.reportPluginReady();
      if (loadAction.plugin_path !== ports.webPreviewPluginPath) {
        const fileDrop = createPluginPanelFileDropHost({ pluginId: loadAction.plugin_id, isCurrent,
          listen: (event, receive) => listenTauriEvent<unknown>(event, receive), iframe: () => ports.iframeRef, childFrames: ports.childFrames,
          sources: ports.messageSources, hostedIpc: ports.hostedIpc, onStatus: ports.onFileDropStatus });
        ports.activeFileDropHost = fileDrop;
        void fileDrop.start().catch(() => { if (isCurrent()) ports.onFileDropStatus("文件拖放接收不可用，请重新打开插件后重试"); });
      }
      if (page) return;
      try {
        const bridgeProbe = await bridgeProbePromise!;
        if (!isCurrent()) return;
        await ports.reportRenderSmoke({
          mainFile,
          html,
          fsLoad: true,
          bridgeProbe,
        });
      } catch (error) {
        console.warn("[PluginPanel] Post-ready render diagnostics failed:", error);
      }
    } catch (e) {
      const state = ports.pluginLoadRetry.snapshot();
      if (state.generation === generation && state.phase === "ready") {
        console.warn("[PluginPanel] Post-ready plugin error:", e);
        return;
      }
      pluginAi?.close();
      await Promise.allSettled([page?.close(), resources.close(), runtime.close(), hostClipboard.close(), display?.close(), data?.close(), paths?.close(), dialogs?.close(), fileDrag?.close(), secretStorage?.close()]);
      if (!isCurrent()) return;
      const message = `无法加载插件: ${e}`;
      const publishFailure = ports.persistentSessionId
        ? ports.pluginLoadRetry.terminal(generation, message)
        : ports.pluginLoadRetry.fail(generation, message);
      const terminalFailure = ports.pluginLoadRetry.snapshot().generation === generation && ports.pluginLoadRetry.snapshot().phase === "terminal";
      if (!publishFailure && !terminalFailure) return;
      console.error("[PluginPanel] Load failed:", e);
      ports.featureList = emptyPluginFeatureList(generation);
      if (publishFailure) ports.loadError = message;
      await ports.onLoadError?.(e);
      if (!isCurrent()) return;
      await ports.reportRenderSmoke({
        mainFile,
        html: "",
        fsLoad: false,
        loadError: ports.loadError ?? undefined,
        bridgeProbe: ports.smokeProbeFailure("desktop-bridge-probe-load-failed"),
      });
    }
  }


  return { retryPluginLoad, loadPluginHtml };
}
