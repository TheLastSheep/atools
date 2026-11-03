import { invoke } from "@tauri-apps/api/core";
import type { FeatureAction } from "./types";
import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import { pluginDialogSmokeGuardEnabled } from "./pluginDialogBridge";
import { desktopBrowserWindowSmokeQueueEnabled } from "./desktopBrowserWindowIsolationProbe";
import { createDesktopSmokeBridgeProbeState, type DesktopSmokeBridgeProbeResult } from "./pluginPanelDesktopSmokeState";

type Ports = {
  action: () => FeatureAction;
  expectedSamples: () => number;
  sampleIndex: () => number;
  externalPlanSample: () => boolean;
  onRender: () => void | Promise<void> | undefined;
  windows: () => PluginBrowserWindowState[];
  iframeSrc: () => string;
  hasSubInput: () => boolean;
  subInputPlaceholder: () => string;
  invoke: typeof invoke;
  tick: () => Promise<unknown>;
};

export function createPluginPanelRenderSmokeController(ports: Ports) {
  function isEnabled() {
    const env = import.meta.env as Record<string, unknown>;
    return env.VITE_ATOOLS_DESKTOP_SMOKE !== undefined
      && pluginDialogSmokeGuardEnabled(env)
      && desktopBrowserWindowSmokeQueueEnabled(ports.expectedSamples(), ports.onRender());
  }

  const probe = createDesktopSmokeBridgeProbeState({isEnabled, getSampleIndex: ports.sampleIndex});
  const { failure: failure, waitFor, receive, resolve } = probe;

  function waitForMacrotask() {
    return new Promise<void>((resolveTask) => window.setTimeout(resolveTask, 0));
  }

  async function waitForHostState() {
    await ports.tick();
    await waitForMacrotask();
    await ports.tick();
  }

  async function report(options: {
    mainFile: string;
    html: string;
    fsLoad: boolean;
    loadError?: string;
    bridgeProbe?: DesktopSmokeBridgeProbeResult;
  }) {
    if (!isEnabled() || ports.action().plugin_path === "__atools_plugin_host_preview__") return;
    const html = options.html || "";
    const bridgeProbe = options.bridgeProbe ?? failure("desktop-bridge-probe-missing");
    await waitForHostState();
    const browserWindowCleanupChecked = bridgeProbe.browserWindowCleanupChecked && ports.windows().length === 0;
    try {
      await ports.invoke("report_plugin_panel_render_smoke", {
        report: {
          pluginId: ports.action().plugin_id,
          featureCode: ports.action().feature_code,
          mainUrl: options.mainFile || ports.action().main_url || "index.html",
          pluginPath: ports.action().plugin_path,
          fsLoad: options.fsLoad,
          iframeSrcdocLoaded: html.length > 0,
          iframeSrcEmpty: ports.iframeSrc() === "",
          loadError: options.loadError || "",
          iframeSrcdocBytes: new TextEncoder().encode(html).length,
          expectedSamples: Math.max(1, ports.expectedSamples()),
          sampleIndex: ports.sampleIndex(),
          externalPlanSample: ports.externalPlanSample(),
          bridgeProbeReported: bridgeProbe.reported,
          bridgeProbePassed: bridgeProbe.passed,
          bridgeProbeChecks: bridgeProbe.checks,
          bridgeProbePassedChecks: bridgeProbe.passedChecks,
          bridgeProbeFailedIds: bridgeProbe.failedIds,
          nativeMethodProbeReported: bridgeProbe.nativeMethodReported,
          nativeMethodProbePassed: bridgeProbe.nativeMethodPassed,
          nativeMethodProbeChecks: bridgeProbe.nativeMethodChecks,
          nativeMethodProbePassedChecks: bridgeProbe.nativeMethodPassedChecks,
          nativeMethodProbeFailedIds: bridgeProbe.nativeMethodFailedIds,
          browserWindowProbeExpected: bridgeProbe.browserWindowProbeExpected,
          browserWindowProbeReported: bridgeProbe.browserWindowProbeReported,
          browserWindowProbePassed: bridgeProbe.browserWindowProbePassed,
          browserWindowProbeChecks: bridgeProbe.browserWindowProbeChecks,
          browserWindowProbePassedChecks: bridgeProbe.browserWindowProbePassedChecks,
          browserWindowProbeFailedIds: bridgeProbe.browserWindowProbeFailedIds,
          browserWindowCreated: bridgeProbe.browserWindowCreated,
          browserWindowChildOriginOpaque: bridgeProbe.browserWindowChildOriginOpaque,
          browserWindowSelfTauriUnavailable: bridgeProbe.browserWindowSelfTauriUnavailable,
          browserWindowParentTauriUnavailable: bridgeProbe.browserWindowParentTauriUnavailable,
          browserWindowParentDocumentBlocked: bridgeProbe.browserWindowParentDocumentBlocked,
          browserWindowSendToParentChecked: bridgeProbe.browserWindowSendToParentChecked,
          browserWindowExecuteJavascriptChecked: bridgeProbe.browserWindowExecuteJavascriptChecked,
          browserWindowIpcRoundtripChecked: bridgeProbe.browserWindowIpcRoundtripChecked,
          browserWindowCleanupChecked,
          subinputVisible: ports.hasSubInput() || bridgeProbe.domInputVisible,
          subinputPlaceholder: ports.subInputPlaceholder() || bridgeProbe.domInputPlaceholder || "",
        },
      });
      await ports.onRender();
    } catch (error) {
      console.warn("[PluginPanel] Failed to report desktop render smoke:", error);
    }
  }

  return { isEnabled, failure, waitFor, receive, resolve, report };
}
