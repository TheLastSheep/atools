import type { FeatureAction, PluginItem, PluginOutput } from "./types";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import type { RuntimeResourceResolveCall } from "./pluginPanelMessageHandlers";
import type { NativeBridgeCall } from "./pluginPanelNativeBridgeRouter";
import type { PluginSubInputState } from "./pluginSubInputState";
import type { PluginFeatureIntent, PluginFeatureList as PluginFeatureListState } from "./pluginFeatureExportsState";
import type { PluginDocumentIdentity } from "./pluginFrameDocumentIdentity";
import type { DynamicPluginFeature } from "./pluginPanelContracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type Ports = {
  action: () => FeatureAction;
  sources: PluginFrameSourceRegistry;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  handlePermissionRequest: (event: MessageEvent, data: Record<string, unknown>, identity: PluginFrameIdentity) => void;
  handleResourceResolve: (event: MessageEvent, data: RuntimeResourceResolveCall, identity: PluginFrameIdentity) => void;
  handleNativeCall: (event: MessageEvent, data: NativeBridgeCall, identity: PluginFrameIdentity) => void;
  dispatchInvoke: typeof import("./pluginInvokePolicy").dispatchPluginInvokeMessage;
  postIfCurrent: typeof import("./pluginInvokePolicy").postPluginFrameMessageIfCurrent;
  isBridgeRequestId: (value: unknown) => boolean;
  ensurePermission: (permission: string, source: Window | null) => Promise<void>;
  pathsActive: () => boolean;
  dataActive: () => boolean;
  handleDesktopSmokeProbe: (data: Record<string, unknown>) => void;
  handleUiProbeResult: (data: Record<string, unknown>) => void;
  handleRealEntryProbeResult: (data: Record<string, unknown>) => void;
  handleContextMenu: (data: Record<string, unknown>) => void;
  requestEscape: () => Promise<void>;
  handleMainWindowLifecycle: (data: Record<string, unknown>) => Promise<unknown>;
  runFind: (text: unknown, options?: Record<string, unknown>) => void;
  stopFind: (action: unknown) => void;
  closePanel: (isKill?: boolean) => void | Promise<void>;
  featureList: PluginFeatureListState;
  setFeatureList: (state: PluginFeatureListState) => void;
  featureListMessage: typeof import("./pluginFeatureExportsState").featureListMessage;
  featureListIntent: (intent: PluginFeatureIntent) => unknown;
  subInputState: PluginSubInputState;
  setSubInputState: (state: PluginSubInputState) => void;
  applySubInputMessage: typeof import("./pluginSubInputState").applyPluginSubInputMessage;
  notifySubInputChange: (value: unknown) => void;
  dynamicFeatures: Array<{code: string; label: string; explain: string}>;
  setDynamicFeatures: (value: Array<{code: string; label: string; explain: string}>) => void;
  registeredTools: string[];
  setRegisteredTools: (value: string[]) => void;
  dispatchDetach: () => void;
  requestedHeight: number;
  setRequestedHeight: (value: number) => void;
  pluginItems: PluginItem[];
  setPluginItems: (value: PluginItem[]) => void;
  normalizeOutputItems: (value: unknown) => PluginItem[];
  selectedIndex: number;
  setSelectedIndex: (value: number) => void;
  activePage: () => { completeWithOutput: (identity: PluginDocumentIdentity, source: unknown) => boolean } | undefined;
  isDocumentIdentity: (identity: PluginFrameIdentity) => identity is PluginDocumentIdentity;
  clearPermissionRequests: () => void;
  invalidateBrowserWindows: () => void;
  hostedIpc: { invalidate: (role: {kind: "main"}) => void };
  onOutput?: (output: PluginOutput) => void;
  emptyFeatureList: (epoch?: number) => PluginFeatureListState;
};

export function createAuthenticatedPluginMessageHandler(ports: Ports) {
  function handleAuthenticatedPluginMessage(e: MessageEvent, data: Record<string, unknown>, sourceIdentity: PluginFrameIdentity) {
    if (data.__atools_permission_request__) {
      ports.handlePermissionRequest(e, data as Record<string, unknown>, sourceIdentity);
      return;
    }

    if (data.__atools_resource_resolve__) {
      ports.handleResourceResolve(e, data as RuntimeResourceResolveCall, sourceIdentity);
      return;
    }

    if (data.__atools_native_call__) {
      ports.handleNativeCall(e, data as NativeBridgeCall, sourceIdentity);
      return;
    }

    if (data.__ipc_call__) {
      void ports.dispatchInvoke({
        source: e.source,
        identity: sourceIdentity,
        message: data,
        sources: ports.sources,
        pluginId: ports.action().plugin_id,
        authorize: (permission) => ports.pathsActive() && permission === "system.path"
          ? Promise.reject(new Error("请使用本插件已授权的同步目录路径快照"))
          : ports.dataActive() && permission === "data"
          ? Promise.reject(new Error("请使用本插件已授权的数据会话"))
          : ports.ensurePermission(permission, e.source as Window | null),
        invoke: (command, args) => ports.invoke(command, args),
      })
        .then((dispatch) => {
          if (!dispatch.handled) return;
          ports.postIfCurrent({
            source: e.source,
            identity: dispatch.identity,
            sources: ports.sources,
            message: {
              __ipc_response__: true,
              reqId: dispatch.request.reqId,
              result: dispatch.result,
            },
          });
        })
        .catch((error) => {
          if (!ports.isBridgeRequestId(data.reqId)) return;
          ports.postIfCurrent({
            source: e.source,
            identity: sourceIdentity,
            sources: ports.sources,
            message: {
              __ipc_response__: true,
              reqId: data.reqId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return;
    }

    if (sourceIdentity.kind !== "main") return;

    if (data.__atools_desktop_smoke_bridge_probe__) {
      ports.handleDesktopSmokeProbe(data as Record<string, unknown>);
      return;
    }

    if (data.__atools_ui_host_probe_result__) {
      ports.handleUiProbeResult(data as Record<string, unknown>);
      return;
    }

    if (data.__atools_real_entry_fixture_probe__) {
      ports.handleRealEntryProbeResult(data as Record<string, unknown>);
      return;
    }

    if (data.__ipc_plugin_contextmenu__) {
      ports.handleContextMenu(data as Record<string, unknown>);
      return;
    }

    if (data.__ipc_plugin_escape__) {
      void ports.requestEscape().catch((err) => {
        console.warn("[PluginPanel] plugin ESC handling failed:", err);
      });
      return;
    }

    if (data.__ipc_main_window__) {
      void ports.handleMainWindowLifecycle(data as Record<string, unknown>)
        .catch((err) => console.warn("[PluginPanel] main window lifecycle failed:", err));
      return;
    }

    if (data.__ipc_find_in_page__) {
      ports.runFind(data.text, isRecord(data.options) ? data.options : {});
      return;
    }

    if (data.__ipc_stop_find_in_page__) {
      ports.stopFind(data.action);
      return;
    }

    // Handle close requests from iframe
    if (data.__ipc_close__) {
      void Promise.resolve(ports.closePanel(data.isKill === true)).catch(error => {
        console.warn("[PluginPanel] plugin close request failed:", error);
      });
      return;
    }

    if (sourceIdentity.kind === "main") {
      const nextList = ports.featureListMessage(ports.featureList, data);
      if (nextList) {
        ports.setFeatureList(nextList);
        if (data.mode === nextList.mode && data.epoch === nextList.epoch && data.entry === nextList.entry && data.revision === nextList.revision
          && typeof data.intent === "string" && ["previous", "next", "first", "last", "activate"].includes(data.intent)) ports.featureListIntent(data.intent as PluginFeatureIntent);
        return;
      }
    }

    const subInputUpdate = ports.applySubInputMessage(ports.subInputState, data);
    if (subInputUpdate) {
      ports.setSubInputState(subInputUpdate.state);
      if (subInputUpdate.notifyValue !== undefined) ports.notifySubInputChange(subInputUpdate.notifyValue);
      return;
    }

    if (data.__ipc_dynamic_feature__) {
      const allFeatures = Array.isArray(data.allFeatures) ? data.allFeatures : [];
      const nextFeatures: Array<DynamicPluginFeature | null> = allFeatures
        .map((feature: unknown) => {
          if (!feature || typeof feature !== "object") return null;
          const record = feature as Record<string, unknown>;
          const code = typeof record.code === "string" ? record.code : "";
          if (!code) return null;
          return {
            code,
            label: typeof record.label === "string" ? record.label : code,
            explain: typeof record.explain === "string" ? record.explain : "",
          };
        });
      ports.setDynamicFeatures(nextFeatures
        .filter((feature): feature is DynamicPluginFeature => feature !== null));
      return;
    }

    if (data.__ipc_register_tool__) {
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (name && !ports.registeredTools.includes(name)) {
        ports.setRegisteredTools([...ports.registeredTools, name]);
      }
      return;
    }

    if (data.__ipc_detach_plugin__) {
      ports.dispatchDetach();
      return;
    }

    if (data.__ipc_plugin_height__) {
      const height = Number(data.height);
      if (Number.isFinite(height) && height > 0) {
        ports.setRequestedHeight(Math.max(120, Math.min(900, Math.round(height))));
        ports.invoke("expand_window", { height: ports.requestedHeight }).catch(() => {});
      }
      return;
    }

    // Handle plugin output from iframe
    if (data.__ipc_out__) {
      ports.setFeatureList(ports.emptyFeatureList(ports.subInputState.epoch));
      ports.setPluginItems(ports.normalizeOutputItems(data.data));
      ports.setSelectedIndex(0);
      if (ports.pluginItems.length && ports.activePage() && ports.isDocumentIdentity(sourceIdentity)) {
        ports.clearPermissionRequests();
        ports.activePage()?.completeWithOutput(sourceIdentity, e.source);
      }
      if (sourceIdentity.kind === "main" && ports.pluginItems.length > 0) {
        ports.invalidateBrowserWindows();
        ports.hostedIpc.invalidate({ kind: "main" });
        ports.sources.unregisterMain(e.source);
      }
      // Fire output event
      if (ports.onOutput) {
        ports.onOutput({
          items: ports.pluginItems,
          plugin_id: ports.action().plugin_id,
          feature_code: ports.action().feature_code
        });
      }
      return;
    }
  }


  return handleAuthenticatedPluginMessage;
}
