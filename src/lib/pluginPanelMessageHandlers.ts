import type { FeatureAction } from "./types";
import type { PluginFrameIdentity } from "./pluginInvokePolicy";
import { convertPluginRuntimeResourceUrl } from "./pluginRuntimeResourcePath";

type UiHostProbeResult = { pluginId: string; featureCode: string; passed: number; total: number; failedIds: string[] };
export type RuntimeResourceResolveCall = { __atools_resource_resolve__: true; reqId: number; url: string; baseDir?: string };
type FindableWindow = Window & { find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean, wholeWord?: boolean, searchInFrames?: boolean, showDialog?: boolean) => boolean };
type MessageResponseHandlerContext = {
  action: () => FeatureAction; iframeSrc: () => string; previewPayload: () => Record<string, unknown>; webPreviewPluginPath: string;
  iframeWindow: () => Window | null; pluginResourceUrl: () => (path: string) => string;
  post: (source: unknown, message: unknown, identity: PluginFrameIdentity) => boolean;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>; closePanel: () => void;
  setUiHostProbeResult: (result: UiHostProbeResult) => void;
};

export function createPluginPanelMessageHandlers(context: MessageResponseHandlerContext) {
function handleRuntimeResourceResolveCall(e: MessageEvent, data: RuntimeResourceResolveCall, identity: PluginFrameIdentity) {
  try {
    const url = typeof data.url === "string" ? data.url : String(data.url ?? "");
    const resolved = context.action().plugin_path && context.action().plugin_path !== context.webPreviewPluginPath
      ? convertPluginRuntimeResourceUrl({
          pluginRoot: context.action().plugin_path,
          mainUrl: context.action().main_url || "index.html",
          documentKind: identity.kind === "main" ? "main" : "browserWindow",
          resourceUrl: url,
          baseUrl: data.baseDir,
          convertFileSrc: context.pluginResourceUrl(),
        })
      : url;
    if (resolved === null) throw new Error("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
    context.post(e.source, {
      __atools_resource_response__: true,
      reqId: data.reqId,
      url: resolved,
    }, identity);
  } catch (err) {
    context.post(e.source, {
      __atools_resource_response__: true,
      reqId: data.reqId,
      error: err instanceof Error ? err.message : String(err),
    }, identity);
  }
}

function handleUiHostProbeResult(data: Record<string, unknown>) {
  const pluginId = typeof data.pluginId === "string" ? data.pluginId : "";
  const featureCode = typeof data.featureCode === "string" ? data.featureCode : "";
  if (pluginId && pluginId !== context.action().plugin_id) return;
  if (featureCode && featureCode !== context.action().feature_code) return;
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const normalized = probes
    .map((probe) => {
      if (!probe || typeof probe !== "object") return null;
      const record = probe as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "unknown";
      return { id, passed: record.passed === true };
    })
    .filter((probe): probe is { id: string; passed: boolean } => probe !== null);
  const failedIds = normalized.filter((probe) => !probe.passed).map((probe) => probe.id);
  context.setUiHostProbeResult({
    pluginId: pluginId || context.action().plugin_id,
    featureCode: featureCode || context.action().feature_code,
    passed: normalized.length - failedIds.length,
    total: normalized.length,
    failedIds,
  });
}

function handleRealEntryFixtureProbeResult(data: Record<string, unknown>) {
  const pluginId = typeof data.pluginId === "string" ? data.pluginId : "";
  const featureCode = typeof data.featureCode === "string" ? data.featureCode : "";
  if (pluginId && pluginId !== context.action().plugin_id) return;
  if (featureCode && featureCode !== context.action().feature_code) return;
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const fixtureProbes = probes
    .map((probe) => {
      if (!probe || typeof probe !== "object") return null;
      const record = probe as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "unknown";
      return { id, passed: record.passed === true };
    })
    .filter((probe): probe is { id: string; passed: boolean } => probe !== null);
  if (fixtureProbes.length === 0) {
    const errors = Array.isArray(data.errors) ? data.errors.length : Number(data.errors || 0) || 0;
    fixtureProbes.push(
      { id: "real-entry-fixture-ready", passed: true },
      { id: "real-entry-fixture-errors", passed: errors === 0 },
    );
  }
  const errorMessages = Array.isArray(data.errors)
    ? data.errors.map((error) => String(error)).filter(Boolean)
    : [];
  const panelProbes = [
    { id: "plugin-panel-iframe-src", passed: Boolean(context.iframeSrc()) },
    ...fixtureProbes,
  ];
  const failedIds = panelProbes.filter((probe) => !probe.passed).map((probe) => probe.id);
  handleUiHostProbeResult({
    pluginId: pluginId || context.action().plugin_id,
    featureCode: featureCode || context.action().feature_code,
    probes: panelProbes,
  });
  const payload = context.previewPayload();
  if (payload.realEntryFixture === true && window.parent !== window) {
    window.parent.postMessage({
      __atools_plugin_panel_real_entry_probe__: true,
      pluginId: pluginId || context.action().plugin_id,
      featureCode: featureCode || context.action().feature_code,
      fixtureSrc: context.iframeSrc(),
      probes: panelProbes,
      passed: panelProbes.length - failedIds.length,
      total: panelProbes.length,
      failedIds,
      errors: errorMessages,
    }, "*");
  }
}

async function handleMainWindowLifecycle(data: Record<string, unknown>) {
  if (data.action === "hide") {
    if ("__TAURI_INTERNALS__" in window) {
      await context.invoke("hide_main_window");
    } else {
      context.closePanel();
    }
    return;
  }
  if (data.action === "show" && "__TAURI_INTERNALS__" in window) {
    await context.invoke("show_main_window");
  }
}

function runPluginFindInPage(text: unknown, options: Record<string, unknown> = {}) {
  const query = typeof text === "string" ? text : String(text ?? "");
  if (!query) return;
  try {
    const pluginWindow = context.iframeWindow() as FindableWindow | null;
    if (typeof pluginWindow?.find !== "function") return;
    const matchCase = options.matchCase === true;
    const forward = options.forward !== false;
    pluginWindow.find(query, matchCase, !forward, true, false, true, false);
  } catch (err) {
    console.info("[PluginPanel] findInPage unavailable for sandboxed plugin iframe:", err);
  }
}

function clearMainPluginSelection() {
  try {
    context.iframeWindow()?.getSelection?.()?.removeAllRanges();
  } catch (err) {
    console.info("[PluginPanel] selection clear unavailable for sandboxed plugin iframe:", err);
  }
}

function stopPluginFindInPage(action: unknown) {
  const mode = typeof action === "string" ? action : "clearSelection";
  if (mode === "keepSelection" || mode === "activateSelection") return;
  clearMainPluginSelection();
}


  return { handleRuntimeResourceResolveCall, handleUiHostProbeResult, handleRealEntryFixtureProbeResult,
    handleMainWindowLifecycle, runPluginFindInPage, clearMainPluginSelection, stopPluginFindInPage };
}
