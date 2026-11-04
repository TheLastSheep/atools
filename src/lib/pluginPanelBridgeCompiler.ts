import type { FeatureAction } from "./types";
import { UTOOLS_BRIDGE } from "./pluginUtoolsBridgeSource";
import { bindOwnPluginBridgeTransport, injectPluginHostScripts } from "./pluginBridgeTransportBinding";
import { pluginFrameTransportScript } from "./pluginFrameTransport";
import { pluginFragmentHistoryScript } from "./pluginFragmentHistory";
import { createPluginLifecycleBridge } from "./pluginLifecycleBridge";
import { createPluginMainPushBridge } from "./pluginMainPushBridge";
import { createPluginMainPushBudget } from "./pluginMainPushBudget";
import { createPluginMainPushPresentation } from "./pluginMainPushPresentation";
import { createPluginFeatureExportsBridge } from "./pluginFeatureExportsBridge";
import { createPluginSubInputBridge } from "./pluginSubInputBridge";
import { browserBufferFactoryScript } from "./browserBuffer";
import { createPluginBrowserWorkerBridge } from "./pluginBrowserWorkerBridge";
import { createPluginBrowserWindowBridge } from "./pluginBrowserWindowBridge";
import { createPluginBrowserWindowGeometry } from "./pluginBrowserWindowGeometry";
import { createPluginHostedIpcBridge } from "./pluginHostedIpcBridge";
import { hostClipboardBridgeScript, type HostClipboardConfig } from "./hostClipboardBridge";
import { pluginDisplayBridgeScript, type PluginDisplayConfig } from "./pluginDisplayBridge";
import { pluginDataBridgeScript, type PluginDataConfig } from "./pluginDataBridge";
import { pluginPathsBridgeScript, type PluginPathsConfig } from "./pluginPathsBridge";
import { pluginNativeDialogBridgeScript, type PluginDialogsConfig } from "./pluginNativeDialogBridge";
import { pluginSecretStorageBridgeScript, type PluginSecretStorageConfig } from "./pluginSecretStorageBridge";
import { pluginElectronAdapterScript } from "./pluginElectronAdapter";
import type { PluginNativeThemeSource } from "./pluginNativeTheme";
import { pluginBridgeJson } from "./pluginDesktopSmokeBridgeSource";
import { createPluginClipboardApi } from "./pluginUtoolsBridgeSource/clipboard-api";
import { createPluginClipboardCopyApi } from "./pluginClipboardCopyApi";
import { createClipboardHistoryCodec } from "./pluginUtoolsBridgeSource/clipboard-history";
import { pluginPanelFileDropReceiverFactorySource } from "./pluginPanelFileDropReceiver";
import { pluginAiBridgeScript } from "./pluginAiBridge";
import { pluginApiStandinProbeScript } from "./pluginApiStandinProbe";
import { pluginFileDragBridgeScript, type PluginFileDragConfig } from "./pluginFileDragBridge";
import { createPluginNativeWindowDomControls } from "./pluginNativeWindowDomControls";
import { createPluginNativeWindowDragRegions } from "./pluginNativeWindowDragRegions";
import { createPluginNativeAppRegionCssRuntime } from "./pluginNativeAppRegionCssRuntime";
import { createPluginNativeAppRegionCss } from "./pluginNativeAppRegionCss";
import { createPluginBroadcastChannelBridge } from "./pluginBroadcastChannelBridge";
import { measurePluginBroadcastPayload } from "./pluginBroadcastPayload";

export type PluginBrowserWindowHostKind = "native" | "hosted";

export type PluginBridgeDocumentOptions = {
  action: FeatureAction;
  entryMode?: "activate" | "preload";
  windowType: "main" | "browserWindow";
  windowHostKind?: PluginBrowserWindowHostKind;
  nativeBackgroundThrottling?: boolean;
  browserWindowId: string;
  geometrySnapshot: unknown;
  workerScope: string;
  mainPushConfig: unknown;
  webContentsId: number;
  subInputEpoch: number;
  appName: string;
  appVersion: string;
  clipboard?: HostClipboardConfig;
  data?: PluginDataConfig;
  paths?: PluginPathsConfig;
  dialogs?: PluginDialogsConfig;
  dialogSmokeGuardEnabled?: boolean;
  display?: PluginDisplayConfig;
  secretStorage?: PluginSecretStorageConfig;
  fileDrag?: PluginFileDragConfig;
  nativeThemeSource?: PluginNativeThemeSource;
  baseBridgeScript?: string;
};

export function createPluginBridgeDocument(options: PluginBridgeDocumentOptions): string {
  const safeEntryMode = options.entryMode === "preload" ? "preload" : "activate";
  const safeWindowType = options.windowType === "browserWindow" ? "browserWindow" : "main";
  const safeWindowHostKind = options.windowHostKind === "native" ? "native" : "hosted";
  const nativeBackgroundThrottling = safeWindowType === "browserWindow" && safeWindowHostKind === "native"
    ? options.nativeBackgroundThrottling : undefined;
  const action = options.action;
  const parameters = {
    __PLUGIN_ID__: action.plugin_id, __FEATURE_CODE__: action.feature_code, __ACTION_PAYLOAD__: action.payload ?? null,
    __ACTION_ENTRY_TYPE__: ["regex", "over", "files", "img"].includes(action.entry_type ?? "") ? action.entry_type : "text",
    __PLUGIN_PATH__: action.plugin_path || "", __APP_NAME__: options.appName, __APP_VERSION__: options.appVersion,
  };
  const bridge = bindOwnPluginBridgeTransport(UTOOLS_BRIDGE)
    .replace("__ATOOLS_FILE_DROP_RECEIVER_FACTORY__", () => pluginPanelFileDropReceiverFactorySource())
    .replace("__ATOOLS_CLIPBOARD_FACTORY__", () =>
      createPluginClipboardApi.toString())
    .replace("__ATOOLS_CLIPBOARD_COPY_FACTORY__", () => createPluginClipboardCopyApi.toString())
    .replace("__ATOOLS_CLIPBOARD_HISTORY_CODEC_FACTORY__", () => createClipboardHistoryCodec.toString())
    .replace("__ATOOLS_LIFECYCLE_FACTORY__", () => createPluginLifecycleBridge.toString())
    .replace("__ATOOLS_MAIN_PUSH_FACTORY__", () => options.mainPushConfig ? createPluginMainPushBridge.toString() : "undefined")
    .replace("__ATOOLS_MAIN_PUSH_BUDGET_FACTORY__", () => options.mainPushConfig ? createPluginMainPushBudget.toString() : "undefined")
    .replace("__ATOOLS_MAIN_PUSH_PRESENTATION_FACTORY__", () => options.mainPushConfig ? createPluginMainPushPresentation.toString() : "undefined")
    .replace("__ATOOLS_MAIN_PUSH_CONFIG__", () => pluginBridgeJson(options.mainPushConfig))
    .replace("__ATOOLS_FEATURE_EXPORTS_FACTORY__", () => createPluginFeatureExportsBridge.toString())
    .replace("__ATOOLS_SUBINPUT_FACTORY__", () => createPluginSubInputBridge.toString())
    .replace("__ATOOLS_BUFFER_FACTORY__", () => browserBufferFactoryScript())
    .replace("__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__", () => createPluginBrowserWorkerBridge.toString())
    .replace("__ATOOLS_WORKER_SCOPE__", () => pluginBridgeJson(options.workerScope))
    .replace("__ATOOLS_BROWSER_WINDOW_BRIDGE_FACTORY__", () => createPluginBrowserWindowBridge.toString())
    .replace("__ATOOLS_BROWSER_WINDOW_GEOMETRY_FACTORY__", () => createPluginBrowserWindowGeometry.toString())
    .replace("__ATOOLS_NATIVE_WINDOW_DOM_CONTROLS_FACTORY__", () =>
      safeWindowType === "browserWindow" && safeWindowHostKind === "native"
        ? createPluginNativeWindowDomControls.toString() : "undefined")
    .replace("__ATOOLS_NATIVE_WINDOW_DRAG_REGIONS_FACTORY__", () =>
      safeWindowType === "browserWindow" && safeWindowHostKind === "native"
        ? createPluginNativeWindowDragRegions.toString() : "undefined")
    .replace("__ATOOLS_NATIVE_APP_REGION_CSS_RUNTIME_FACTORY__", () =>
      safeWindowType === "browserWindow" && safeWindowHostKind === "native"
        ? createPluginNativeAppRegionCssRuntime.toString() : "undefined")
    .replace("__ATOOLS_NATIVE_APP_REGION_CSS_FACTORY__", () =>
      safeWindowType === "browserWindow" && safeWindowHostKind === "native"
        ? createPluginNativeAppRegionCss.toString() : "undefined")
    .replace("__ATOOLS_HOSTED_IPC_FACTORY__", () => createPluginHostedIpcBridge.toString())
    .replace("__ATOOLS_BROADCAST_CHANNEL_FACTORY__", () => createPluginBroadcastChannelBridge.toString())
    .replace("__ATOOLS_BROADCAST_PAYLOAD_MEASURE__", () => measurePluginBroadcastPayload.toString())
    .replace("__ATOOLS_WEB_CONTENTS_ID__", () => String(options.webContentsId))
    .replace("__ATOOLS_ENTRY_MODE__", () => JSON.stringify(safeEntryMode))
    .replaceAll("__ATOOLS_SUBINPUT_EPOCH__", () => String(options.subInputEpoch))
    .replace(/__(?:PLUGIN_ID|FEATURE_CODE|ACTION_PAYLOAD|ACTION_ENTRY_TYPE|PLUGIN_PATH|APP_NAME|APP_VERSION)__/g,
      token => pluginBridgeJson(parameters[token as keyof typeof parameters]))
    .replace("var _atoolsPluginPermissions = null;", `var _atoolsPluginPermissions = ${pluginBridgeJson(action.plugin_permissions ?? [])};`)
    .replace("var _atoolsDeclaredProviders = null;", `var _atoolsDeclaredProviders = ${pluginBridgeJson(action.plugin_providers ?? {})};`)
    .replace("var _atoolsWindowType = 'main';", `var _atoolsWindowType = ${JSON.stringify(safeWindowType)};`)
    .replace("var _atoolsWindowHostKind = 'hosted';", `var _atoolsWindowHostKind = ${JSON.stringify(safeWindowHostKind)};`)
    .replace("var _atoolsBrowserWindowId = '';", `var _atoolsBrowserWindowId = ${JSON.stringify(options.browserWindowId)};`)
    .replace("var _atoolsBrowserWindowGeometry = null;", `var _atoolsBrowserWindowGeometry = ${pluginBridgeJson(options.geometrySnapshot)};`)
    .replace("var _atoolsNativeBrowserWindowBackgroundThrottling = true;",
      `var _atoolsNativeBrowserWindowBackgroundThrottling = ${JSON.stringify(nativeBackgroundThrottling ?? true)};`);
  return (options.baseBridgeScript ?? pluginFrameTransportScript()) + pluginFileDragBridgeScript(options.fileDrag) + pluginFragmentHistoryScript() + bridge
    + (options.clipboard ? hostClipboardBridgeScript(options.clipboard) : "")
    + (options.data ? pluginDataBridgeScript(options.data) : "")
    + (options.paths ? pluginPathsBridgeScript(options.paths) : "")
    + (options.dialogs ? pluginNativeDialogBridgeScript(options.dialogs, options.dialogSmokeGuardEnabled ?? false) : "")
    + (options.display ? pluginDisplayBridgeScript(options.display) : "")
    + (options.secretStorage ? pluginSecretStorageBridgeScript(options.secretStorage) : "")
    + pluginElectronAdapterScript(options.nativeThemeSource === "light" || options.nativeThemeSource === "dark" ? options.nativeThemeSource : "system")
    + pluginAiBridgeScript(action.plugin_id)
    + pluginApiStandinProbeScript();
}

export function injectPluginBridgeHtml(html: string, injection: string): string {
  return injectPluginHostScripts(html, injection);
}
