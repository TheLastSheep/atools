import { invoke } from "@tauri-apps/api/core";
import type { FeatureAction, SearchResult } from "./types";
import type { PluginPanelMountProps } from "./pluginPanelMount";
import type { PluginActivationToken } from "./pluginCodeLifecycle";
import { normalizePluginRedirectLabel, selectPluginRedirectResult } from "./pluginRedirect";
import { desktopSmokePluginQueueActionActive } from "./desktopSmokePluginQueue";
import { parseDetachedPluginRequest } from "./launcherPluginDetachContract";

interface PluginLifecyclePort {
  beginActivation(): PluginActivationToken;
  start(): Promise<void>;
  isCurrent(activation: PluginActivationToken, pluginId?: string): boolean;
}

interface Ports {
  isDetachWindow: boolean;
  hasTauriRuntime: () => boolean;
  activePlugin: () => FeatureAction | null;
  setActivePlugin: (action: FeatureAction | null) => void;
  setActivationError: (message: string) => void;
  clearActivationError: () => void;
  lifecycle: PluginLifecyclePort;
  onReturnToSearch: (codeChanged?: boolean) => Promise<void>;
  openPluginDetachAction: (action: FeatureAction, isCurrent?: () => boolean) => Promise<boolean>;
  claimPluginDetachAction: (handoffId: string) => Promise<FeatureAction>;
  activateFeature: (code: string, payload: unknown, options: { expectedPluginId: string; preserveLauncherReturnContext: boolean }) => Promise<unknown>;
  resizePalette: (height: number) => void | Promise<void>;
  onEscape: () => void | Promise<void>;
  onSettingsRedirect: (menu: "shortcuts" | "ai", detail?: Record<string, unknown>) => boolean | Promise<boolean>;
  onReady: (featureCode: string) => void;
  onLoadError: (error: Error) => void;
  desktopSmokeEnabled: () => boolean;
  smokeActions: () => FeatureAction[];
  smokeIndex: () => number;
  smokeExternalPlan: (action: FeatureAction | null) => boolean;
  onSmokeRender: () => void | Promise<void>;
}

export function createLauncherPluginWindowController(ports: Ports) {
  let detachedInitialization: Promise<void> | null = null;

  function detachedPluginRequestFromHash() {
    if (!ports.isDetachWindow || typeof window === "undefined") return null;
    return parseDetachedPluginRequest(window.location.hash, true);
  }

  async function initializeDetachedPluginWindow() {
    if (!ports.isDetachWindow || ports.activePlugin() !== null || !ports.hasTauriRuntime()) return;
    if (detachedInitialization) return detachedInitialization;
    detachedInitialization = initializeDetachedPluginWindowOnce();
    return detachedInitialization;
  }

  async function initializeDetachedPluginWindowOnce() {
    const request = detachedPluginRequestFromHash();
    if (!request) return;
    const activation = ports.lifecycle.beginActivation();
    try {
      await ports.lifecycle.start();
      if (!ports.lifecycle.isCurrent(activation)) return;
      // A present handoff always wins over legacy route parameters. If claiming
      // it fails, never guess a feature code and activate different content.
      const action = request.kind === "handoff"
        ? await ports.claimPluginDetachAction(request.handoffId)
        : await invoke<FeatureAction>("activate_feature", {
          code: request.featureCode,
          payload: null,
          ...(request.pluginId ? { expectedPluginId: request.pluginId } : {}),
        });
      if (request.kind === "legacy" && request.pluginId && action.plugin_id !== request.pluginId) {
        throw new Error("FEATURE_OWNER_CHANGED: activate_feature returned a different owner");
      }
      if (!ports.lifecycle.isCurrent(activation, action.plugin_id)) return;
      ports.clearActivationError();
      ports.setActivePlugin(action);
      void ports.resizePalette(action.expand_height);
    } catch (error) {
      if (!ports.lifecycle.isCurrent(activation)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("FEATURE_OWNER_CHANGED:")) {
        ports.setActivationError("此功能的来源已变化，请刷新后重新打开。");
      } else if (request.kind === "handoff") {
        ports.setActivationError("分离窗口无法认领该插件动作，请回到搜索后重试。");
      } else {
        ports.setActivationError("分离窗口无法打开该插件，请检查插件状态后重试。");
      }
      console.warn("Failed to open detached plugin:", error);
    }
  }

  async function openDetachedPluginWindow(action: FeatureAction): Promise<boolean> {
    if (ports.isDetachWindow) return false;
    if (!ports.hasTauriRuntime()) {
      if (ports.activePlugin() === action) ports.setActivationError("仅在桌面运行时可打开分离插件窗口，请回到桌面应用重试。");
      return false;
    }
    try {
      return await ports.openPluginDetachAction(action, () => ports.activePlugin() === action);
    } catch (error) {
      if (ports.activePlugin() === action) {
        ports.setActivationError("无法打开分离窗口，插件仍保持在当前面板，请重试。");
      }
      console.warn("Failed to open detached plugin window:", action.feature_code, error);
      return false;
    }
  }

  async function onPluginDetachAction() {
    const action = ports.activePlugin();
    if (!action?.feature_code || ports.isDetachWindow) return;
    ports.clearActivationError();
    const opened = await openDetachedPluginWindow(action);
    if (!opened || ports.activePlugin() !== action) return;
    try {
      await ports.onReturnToSearch();
    } catch (error) {
      if (ports.activePlugin() === action) {
        ports.setActivationError("分离窗口已打开，但当前面板未能返回搜索；请手动返回后重试。");
      }
      console.warn("Failed to return from detached plugin action:", error);
    }
  }

  async function handlePluginRedirect(label: unknown, payload: unknown) {
    const target = normalizePluginRedirectLabel(label);
    if (!target) throw new Error("redirect unsupported: label must be a non-empty string or [plugin, command]");
    if (!ports.hasTauriRuntime()) throw new Error("redirect unsupported: plugin feature search requires desktop runtime");

    const redirectResults = await invoke<SearchResult[]>("search_features", { query: target.query });
    const selection = selectPluginRedirectResult(target, redirectResults);
    if (selection.status === "ready") {
      const plugin = selection.result;
      await ports.activateFeature(plugin.code, payload ?? null, {
        expectedPluginId: plugin.plugin_id,
        preserveLauncherReturnContext: true,
      });
      return true;
    }

    const scope = target.pluginName ? `${target.pluginName} / ${target.query}` : target.query;
    if (selection.status === "ambiguous") {
      throw new Error(`redirect ambiguous: ${scope} matched ${selection.candidates.length} plugin features`);
    }
    throw new Error(`redirect failed: no plugin feature found for ${scope}`);
  }

  function pluginPanelProps(action: FeatureAction): PluginPanelMountProps {
    const actions = ports.smokeActions();
    const index = ports.smokeIndex();
    const queueActive = desktopSmokePluginQueueActionActive(ports.desktopSmokeEnabled(), action, actions, index);
    return {
      action,
      onclose: ports.onReturnToSearch,
      onescape: ports.onEscape,
      onredirect: handlePluginRedirect,
      onsettingsredirect: ports.onSettingsRedirect,
      desktopSmokeExpectedSamples: queueActive ? actions.length : 0,
      desktopSmokeSampleIndex: queueActive ? index : 0,
      desktopSmokeExternalPlanSample: queueActive ? ports.smokeExternalPlan(action) : false,
      onready: () => ports.onReady(action.feature_code),
      onloaderror: error => ports.onLoadError(error instanceof Error ? error : new Error(String(error))),
      ondesktopsmokerender: queueActive ? ports.onSmokeRender : undefined,
    };
  }

  return {
    detachedPluginRequestFromHash,
    initializeDetachedPluginWindow,
    openDetachedPluginWindow,
    onPluginDetachAction,
    handlePluginRedirect,
    pluginPanelProps,
  };
}
