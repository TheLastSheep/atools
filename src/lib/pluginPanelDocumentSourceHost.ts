import { untrack } from "svelte";
import type { FeatureAction, PluginItem } from "./types";
import type { PluginSubInputState } from "./pluginSubInputState";
import type { PluginBrowserWindowType } from "./pluginBrowserWindowTypes";
import type { createPluginWorkerDocumentLifecycle } from "./pluginWorkerDocumentLifecycle";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import type { createPluginMainPushHost } from "./pluginMainPushHost";
import type { createHostClipboardController } from "./hostClipboardController";
import type { createPluginDataController } from "./pluginDataController";
import type { createPluginPathsController } from "./pluginPathsController";
import type { createPluginDialogsController } from "./pluginDialogsController";
import type { createPluginDisplayController } from "./pluginDisplayController";
import type { createPluginSecretStorageController } from "./pluginSecretStorageController";
import type { createPluginFileDragController } from "./pluginFileDragController";
import { createPluginBridgeDocument, injectPluginBridgeHtml, type PluginBrowserWindowHostKind } from "./pluginPanelBridgeCompiler";
import { createDesktopSmokeBridgeProbeHtml } from "./pluginDesktopSmokeBridgeSource";
import { pluginDialogSmokeGuardEnabled } from "./pluginDialogBridge";
import { normalizePluginOutputItems } from "./pluginHostView";
import { applyPluginSubInputMessage, emptyPluginSubInput } from "./pluginSubInputState";
import { previewIframeSrc, previewPayload, previewSubInputOptions } from "./pluginPanelPreview";

type Ports = {
  action: () => FeatureAction;
  workerDocument: ReturnType<typeof createPluginWorkerDocumentLifecycle>;
  hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>;
  mainPushHost: ReturnType<typeof createPluginMainPushHost> | undefined;
  generation: () => number;
  pluginPathForPreview: string;
  productName: string;
  productVersion: string;
  clipboard: () => ReturnType<typeof createHostClipboardController> | undefined;
  data: () => ReturnType<typeof createPluginDataController> | undefined;
  paths: () => ReturnType<typeof createPluginPathsController> | undefined;
  dialogs: () => ReturnType<typeof createPluginDialogsController> | undefined;
  display: () => ReturnType<typeof createPluginDisplayController> | undefined;
  secretStorage?: () => ReturnType<typeof createPluginSecretStorageController> | undefined;
  fileDrag?: () => ReturnType<typeof createPluginFileDragController> | undefined;
  bridgeScript: () => string | undefined;
  smokeEnabled: () => boolean;
  smokeSampleIndex: () => number;
  subInputState: () => PluginSubInputState;
  setSubInputState: (value: PluginSubInputState) => void;
  iframeSrc: (value: string) => void;
  iframeSrcDoc: (value: string) => void;
  setPluginItems: (value: PluginItem[]) => void;
  setSelectedIndex: (value: number) => void;
  setLoadError: (value: string | null) => void;
};

/** Owns main/preview bridge document assembly and its host-side preview state projection. */
export function createPluginPanelDocumentSourceHost(ports: Ports) {
  function bridgeHtml(windowType: PluginBrowserWindowType = "main", browserWindowId = "", geometrySnapshot: unknown = null,
    windowHostKind: PluginBrowserWindowHostKind = "hosted", entryMode: "activate" | "preload" = "activate",
    nativeBackgroundThrottling?: boolean) {
    const safeWindowType = windowType === "browserWindow" ? "browserWindow" : "main";
    const workerScope = safeWindowType === "main" ? ports.workerDocument.freshScope() : crypto.randomUUID();
    const mainPushConfig = safeWindowType === "main" ? ports.mainPushHost?.configuration() ?? null : null;
    const themeSource = typeof document !== "undefined" ? document.documentElement.dataset.atoolsTheme : "system";
    const webContentsId = ports.hostedIpc.reserve(safeWindowType === "main" ? { kind: "main" } : { kind: "child", windowId: browserWindowId });
    return createPluginBridgeDocument({
      action: ports.action(), windowType: safeWindowType, windowHostKind, entryMode, browserWindowId, geometrySnapshot, workerScope, mainPushConfig, webContentsId,
      subInputEpoch: ports.generation(), appName: ports.productName, appVersion: ports.productVersion,
      nativeThemeSource: themeSource === "light" || themeSource === "dark" ? themeSource : "system",
      clipboard: ports.clipboard()?.configuration(), data: ports.data()?.configuration(), paths: ports.paths()?.configuration(),
      dialogs: ports.dialogs()?.configuration(), dialogSmokeGuardEnabled: pluginDialogSmokeGuardEnabled(),
      display: ports.display()?.configuration(), baseBridgeScript: ports.bridgeScript(),
      nativeBackgroundThrottling,
      secretStorage: safeWindowType === "main" ? ports.secretStorage?.()?.configuration() : undefined,
      fileDrag: safeWindowType === "main" ? ports.fileDrag?.()?.configuration() : undefined,
    });
  }

  function injectBridge(html: string, windowType: PluginBrowserWindowType = "main", browserWindowId = "", preloadScript = "",
    geometrySnapshot: unknown = null, windowHostKind: PluginBrowserWindowHostKind = "hosted", entryMode: "activate" | "preload" = "activate",
    nativeBackgroundThrottling?: boolean) {
    return injectPluginBridgeHtml(html, `${bridgeHtml(windowType, browserWindowId, geometrySnapshot, windowHostKind, entryMode,
      nativeBackgroundThrottling)}${preloadScript}`);
  }

  function smokeProbeHtml() {
    const action = ports.action();
    return createDesktopSmokeBridgeProbeHtml({
      enabled: ports.smokeEnabled(), pluginId: action.plugin_id, featureCode: action.feature_code,
      sampleIndex: ports.smokeSampleIndex(), mainUrl: action.main_url || "index.html",
    });
  }

  function injectSmokeProbe(html: string) {
    const probe = smokeProbeHtml();
    if (!probe) return html;
    if (html.includes("</body>")) return html.replace("</body>", `${probe}</body>`);
    return `${html}${probe}`;
  }

  function loadPreview() {
    const payload = previewPayload(ports.action());
    const src = previewIframeSrc(payload.iframeSrc);
    if (src) {
      ports.workerDocument.clearScope();
      ports.iframeSrc(src);
      ports.iframeSrcDoc("");
    } else {
      const html = typeof payload.srcdoc === "string" ? payload.srcdoc
        : "<!doctype html><html><body><main>Plugin host preview</main></body></html>";
      ports.iframeSrc("");
      ports.iframeSrcDoc(injectBridge(html));
    }
    ports.setPluginItems(normalizePluginOutputItems(payload.outputItems));
    const state = untrack(ports.subInputState);
    const update = applyPluginSubInputMessage(emptyPluginSubInput(state.sequence + 1, 0, state.epoch), {
      __ipc_subinput__: true, epoch: ports.generation(),
      opts: { ...previewSubInputOptions(payload.subInput), visible: Boolean(payload.subInput),
        value: typeof payload.subInputValue === "string" ? payload.subInputValue : "" },
    });
    ports.setSubInputState(update!.state);
    ports.setSelectedIndex(0);
    ports.setLoadError(null);
  }

  return { bridgeHtml, injectBridge, smokeProbeHtml, injectSmokeProbe, loadPreview };
}
