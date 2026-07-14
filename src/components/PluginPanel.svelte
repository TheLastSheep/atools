<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import type { FeatureAction, PluginOutput, PluginItem } from "../lib/types";
  import { readTextFile } from "@tauri-apps/plugin-fs";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { writeImage, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { Command, open as shellOpen } from "@tauri-apps/plugin-shell";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import packageInfo from "../../package.json";
  import {
    dialogSmokeGuardError,
    normalizeDialogBridgeOptions,
    pluginDialogSmokeGuardEnabled,
  } from "../lib/pluginDialogBridge";
  import { normalizePluginOutputItems, pluginHostView, type PluginHostAction } from "../lib/pluginHostView";
  import {
    convertPluginResourceUrl,
    pluginResourceFilePath,
    preparePluginHtmlResources,
  } from "../lib/pluginResourceHtml";
  import { desktopCaptureSourcesForDisplay } from "../lib/pluginScreenBridge";
  import { normalizeShellTrashPath, shellTrashAppleScript } from "../lib/pluginSystemShellBridge";
  import {
    PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT,
    grantPluginRuntimePermission,
    pluginRuntimePermissionGrantList,
  } from "../lib/pluginRuntimePermissions";
  import {
    PluginFrameSourceRegistry,
    bindNativeBridgeArgsToSource,
    dispatchPluginInvokeMessage,
    identifyPluginMessageEvent,
    isPluginBridgeRequestId,
    nativePluginPermissionForMethod,
    pluginPermissionListAllows,
    postPluginFrameMessageIfCurrent,
    resolvePluginPermissionRequest,
    runPluginFrameOperation,
    type PluginFrameIdentity,
  } from "../lib/pluginInvokePolicy";
  import {
    HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS,
    HostedBrowserWindowNavigationTokens,
    HostedBrowserWindowRpcHost,
    hostedBrowserWindowUnsupported,
  } from "../lib/hostedBrowserWindowRpc";
  import {
    desktopBrowserWindowIsolationProbeSource,
    desktopBrowserWindowSmokeQueueEnabled,
    normalizeDesktopBrowserWindowProbeContract,
  } from "../lib/desktopBrowserWindowIsolationProbe";

  type Props = {
    action: FeatureAction;
    onclose: () => void;
    onoutput?: (output: PluginOutput) => void;
    onredirect?: (label: unknown, payload: unknown) => boolean | Promise<boolean>;
    onsettingsredirect?: (
      menu: "shortcuts" | "ai",
      detail?: Record<string, unknown>
    ) => boolean | Promise<boolean>;
    desktopSmokeExpectedSamples?: number;
    desktopSmokeSampleIndex?: number;
    desktopSmokeExternalPlanSample?: boolean;
    onready?: () => void | Promise<void>;
    ondesktopsmokerender?: () => void | Promise<void>;
  };

  type DynamicPluginFeature = {
    code: string;
    label: string;
    explain: string;
  };

  type EyeDropperConstructor = new () => {
    open: () => Promise<{ sRGBHex?: string }>;
  };

  type EyeDropperWindow = Window & {
    EyeDropper?: EyeDropperConstructor;
  };

  type OutputContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    itemIndex: number;
  };

  type PluginContextMenuInfo = {
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    tagName: string;
    editable: boolean;
    selectedText: string;
    defaultPrevented: boolean;
  };

  type PluginBrowserWindowType = "main" | "browserWindow";

  type PluginBrowserWindowInspectedElement = {
    x: number;
    y: number;
    tagName: string;
    id: string;
    className: string;
    text: string;
  };

  type PluginBrowserWindowState = {
    id: string;
    url: string;
    title: string;
    srcdoc: string;
    documentGeneration: number;
    history: PluginBrowserWindowHistoryEntry[];
    historyIndex: number;
    loading: boolean;
    visible: boolean;
    focused: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    positioned: boolean;
    alwaysOnTop: boolean;
    backgroundColor: string;
    menuBarAutoHide: boolean;
    menuBarVisible: boolean;
    menuRemoved: boolean;
    windowButtonVisible: boolean;
    windowButtonPosition: PluginBrowserWindowPoint | null;
    vibrancy: string;
    vibrancyOptions: Record<string, unknown>;
    backgroundMaterial: string;
    sheetOffsetY: number;
    sheetOffsetX: number;
    documentEdited: boolean;
    representedFilename: string;
    modal: boolean;
    parentWindowId: string | null;
    minimized: boolean;
    maximized: boolean;
    resizable: boolean;
    movable: boolean;
    closable: boolean;
    minimizable: boolean;
    maximizable: boolean;
    fullScreen: boolean;
    fullScreenable: boolean;
    minimumWidth: number;
    minimumHeight: number;
    maximumWidth: number;
    maximumHeight: number;
    aspectRatio: number;
    aspectRatioExtraSize: PluginBrowserWindowSize;
    opacity: number;
    hasShadow: boolean;
    skipTaskbar: boolean;
    kiosk: boolean;
    visibleOnAllWorkspaces: boolean;
    contentProtected: boolean;
    focusable: boolean;
    flashing: boolean;
    progressBar: number | null;
    progressBarMode: string;
    mediaSourceId: string;
    webContentsMediaSourceId: string;
    webContentsFocused: boolean;
    webContentsBeingCaptured: boolean;
    ignoreMenuShortcuts: boolean;
    zOrder: number;
    devToolsOpened: boolean;
    devToolsFocused: boolean;
    devToolsMode: string;
    devToolsTitle: string;
    inspectedElement: PluginBrowserWindowInspectedElement | null;
    zoomFactor: number;
    zoomLevel: number;
    visualZoomMinimumLevel: number;
    visualZoomMaximumLevel: number;
    audioMuted: boolean;
    currentlyAudible: boolean;
    userAgent: string;
    frameRate: number;
    backgroundThrottling: boolean;
    processId: number;
    osProcessId: number;
    crashed: boolean;
  };

  type PluginBrowserWindowBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  type PluginBrowserWindowSize = {
    width: number;
    height: number;
  };

  type PluginBrowserWindowPoint = {
    x: number;
    y: number;
  };

  type PluginBrowserWindowHistoryEntry = {
    url: string;
    title: string;
    srcdoc: string;
  };

  type PluginBrowserWindowParentMessage = {
    windowId: string;
    channel: string;
    args: unknown[];
  };

  type PluginBrowserWindowInsertedCss = {
    windowId: string;
    key: string;
    css: string;
    cssOrigin: "author" | "user";
  };

  type PluginRuntimePermissionRequest = {
    id: string;
    permission: string;
    source: Window | null;
    bridgeReqId: number | null;
  };

  type UiHostProbeResult = {
    pluginId: string;
    featureCode: string;
    passed: number;
    total: number;
    failedIds: string[];
  };

  type DesktopSmokeBridgeProbeResult = {
    reported: boolean;
    passed: boolean;
    checks: number;
    passedChecks: number;
    failedIds: string[];
    domInputVisible: boolean;
    domInputPlaceholder: string;
    nativeMethodReported: boolean;
    nativeMethodPassed: boolean;
    nativeMethodChecks: number;
    nativeMethodPassedChecks: number;
    nativeMethodFailedIds: string[];
    browserWindowProbeExpected: boolean;
    browserWindowProbeReported: boolean;
    browserWindowProbePassed: boolean;
    browserWindowProbeChecks: number;
    browserWindowProbePassedChecks: number;
    browserWindowProbeFailedIds: string[];
    browserWindowCreated: boolean;
    browserWindowChildOriginOpaque: boolean;
    browserWindowSelfTauriUnavailable: boolean;
    browserWindowParentTauriUnavailable: boolean;
    browserWindowParentDocumentBlocked: boolean;
    browserWindowSendToParentChecked: boolean;
    browserWindowExecuteJavascriptChecked: boolean;
    browserWindowIpcRoundtripChecked: boolean;
    browserWindowCleanupChecked: boolean;
  };

  type DesktopSmokeBridgeProbeWaiter = {
    pluginId: string;
    featureCode: string;
    sampleIndex: number;
    resolve: (result: DesktopSmokeBridgeProbeResult) => void;
    timeoutId: number;
  };

  let {
    action,
    onclose,
    onoutput,
    onredirect,
    onsettingsredirect,
    desktopSmokeExpectedSamples = 0,
    desktopSmokeSampleIndex = 0,
    desktopSmokeExternalPlanSample = false,
    onready,
    ondesktopsmokerender,
  }: Props = $props();
  const WEB_PREVIEW_PLUGIN_PATH = "__atools_plugin_host_preview__";
  const PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-popups";
  const PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX = "allow-scripts allow-popups";
  const PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS: PluginBrowserWindowBounds = { x: 0, y: 0, width: 560, height: 220 };
  const PLUGIN_BROWSER_WINDOW_MIN_WIDTH = 260;
  const PLUGIN_BROWSER_WINDOW_MIN_HEIGHT = 160;
  const PLUGIN_BROWSER_WINDOW_MAX_WIDTH = 1200;
  const PLUGIN_BROWSER_WINDOW_MAX_HEIGHT = 900;
  const PLUGIN_BROWSER_WINDOW_MAX_POSITION = 2000;
  let iframeSrcDoc = $state("");
  let iframeSrc = $state("");
  let pluginReadyReported = false;
  let loadError = $state<string | null>(null);
  let subInputOpts = $state<{ placeholder?: string; focus?: boolean }>({});
  let pluginItems = $state<PluginItem[]>([]);
  let selectedIndex = $state(0);
  let iframeRef = $state<HTMLIFrameElement | null>(null);
  let subInputRef = $state<HTMLInputElement | null>(null);
  let subInputValue = $state("");
  let dynamicFeatures = $state<DynamicPluginFeature[]>([]);
  let registeredTools = $state<string[]>([]);
  let requestedPluginHeight = $state(0);
  let dynamicFeatureOwner = $state("");
  let pluginOutDispatched = false;
  let pluginDetachDispatched = false;
  let outputContextMenu = $state<OutputContextMenuState>({ visible: false, x: 0, y: 0, itemIndex: -1 });
  let lastPluginContextMenu = $state<PluginContextMenuInfo | null>(null);
  let pluginBrowserWindows = $state<PluginBrowserWindowState[]>([]);
  let lastBrowserWindowMessage = $state<PluginBrowserWindowParentMessage | null>(null);
  let pluginBrowserWindowSeq = 0;
  let pluginBrowserWindowCssSeq = 0;
  let pluginBrowserWindowFindSeq = 0;
  let pluginBrowserWindowFrames = new Map<string, HTMLIFrameElement>();
  let pluginBrowserWindowInsertedCss = new Map<string, PluginBrowserWindowInsertedCss>();
  const pluginBrowserWindowNavigation = new HostedBrowserWindowNavigationTokens();
  const pluginBrowserWindowRpc = new HostedBrowserWindowRpcHost();
  const pluginMessageSources = new PluginFrameSourceRegistry();
  let runtimeApprovedPluginPermissions = $state<string[]>([]);
  let runtimePersistentPluginPermissions = $state<string[]>([]);
  let pluginPermissionRequests = $state<PluginRuntimePermissionRequest[]>([]);
  let uiHostProbeResult = $state<UiHostProbeResult | null>(null);
  let desktopSmokeBridgeProbeWaiter: DesktopSmokeBridgeProbeWaiter | null = null;
  let pluginPermissionRequestSeq = 0;
  let activePluginPermissionRequest = $derived(pluginPermissionRequests[0] ?? null);
  const pluginPermissionResolvers = new Map<string, (allowed: boolean) => void>();
  let hasSubInput = $derived(Boolean(subInputOpts.placeholder) || subInputOpts.focus === true || subInputValue.length > 0);
  let hostView = $derived(pluginHostView(action, {
    subInputVisible: hasSubInput,
    iframeReady: Boolean(iframeSrcDoc || iframeSrc),
    outputItems: pluginItems,
    selectedIndex,
    loadError,
    dynamicFeatureCount: dynamicFeatures.length,
    registeredToolCount: registeredTools.length,
    requestedHeight: requestedPluginHeight,
    contextMenuTarget: pluginContextMenuTarget(lastPluginContextMenu),
    browserWindowCount: pluginBrowserWindows.length,
    browserWindowMessage: pluginBrowserWindowMessageLabel(lastBrowserWindowMessage),
    uiHostProbePassed: uiHostProbeResult?.passed ?? 0,
    uiHostProbeTotal: uiHostProbeResult?.total ?? 0,
    uiHostProbeFailedIds: uiHostProbeResult?.failedIds ?? [],
  }));

  $effect(() => {
    const owner = `${action.plugin_id}:${action.feature_code}`;
    if (dynamicFeatureOwner !== owner) {
      dynamicFeatureOwner = owner;
      dynamicFeatures = [];
      registeredTools = [];
      requestedPluginHeight = 0;
      pluginOutDispatched = false;
      pluginDetachDispatched = false;
      lastPluginContextMenu = null;
      pluginBrowserWindows = [];
      lastBrowserWindowMessage = null;
      pluginBrowserWindowSeq = 0;
      pluginBrowserWindowCssSeq = 0;
      pluginBrowserWindowFindSeq = 0;
      pluginBrowserWindowNavigation.closeAll();
      pluginBrowserWindowRpc.closeAll();
      pluginBrowserWindowFrames.clear();
      pluginBrowserWindowInsertedCss.clear();
      pluginMessageSources.clear();
      uiHostProbeResult = null;
      clearPluginPermissionRequests();
      runtimeApprovedPluginPermissions = [];
      runtimePersistentPluginPermissions = pluginRuntimePermissionGrantList(action.plugin_id);
    }
  });

  $effect(() => {
    if (subInputOpts.focus && subInputRef) {
      setTimeout(() => subInputRef?.focus(), 0);
    }
  });

  function handleSubInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    subInputValue = target.value;
    // Forward to iframe
    iframeRef?.contentWindow?.postMessage({
      __ipc_subinput_change__: true,
      text: subInputValue
    }, "*");
  }

  function handleSubInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      closeOutputContextMenu();
      selectedIndex = Math.min(selectedIndex + 1, pluginItems.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      closeOutputContextMenu();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === "Enter" && pluginItems.length > 0) {
      e.preventDefault();
      handleItemClick(selectedIndex);
    }
  }

  function handleItemClick(idx: number) {
    closeOutputContextMenu();
    void copyPluginOutputItem(idx);
  }

  function copyPluginOutputItem(idx: number) {
    const item = pluginItems[idx];
    if (!item?.data) return Promise.resolve(false);
    return writePluginOutputText(item.data)
      .then(() => {
        const copiedItem = { title: "已复制", description: item.data, data: item.data };
        pluginItems = [copiedItem];
        selectedIndex = 0;
        onoutput?.({
          items: [copiedItem],
          plugin_id: action.plugin_id,
          feature_code: action.feature_code
        });
        return true;
      })
      .catch((err) => {
        console.warn("[PluginPanel] plugin output copy failed:", err);
        return false;
      });
  }

  function writePluginOutputText(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return writeText(text);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function openOutputContextMenu(e: MouseEvent, idx: number) {
    const item = pluginItems[idx];
    if (!item?.data) return;
    e.preventDefault();
    selectedIndex = idx;
    outputContextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      itemIndex: idx,
    };
  }

  function closeOutputContextMenu() {
    if (!outputContextMenu.visible) return;
    outputContextMenu = { visible: false, x: 0, y: 0, itemIndex: -1 };
  }

  function copyOutputContextMenuItem() {
    const idx = outputContextMenu.itemIndex;
    closeOutputContextMenu();
    void copyPluginOutputItem(idx);
  }

  function handlePluginPanelKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && outputContextMenu.visible) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeOutputContextMenu();
    }
  }

  function pluginContextMenuTarget(info: PluginContextMenuInfo | null) {
    if (!info) return "";
    if (info.editable) return "可编辑区域";
    return info.tagName ? `iframe ${info.tagName.toLowerCase()}` : "iframe";
  }

  function pluginBrowserWindowMessageLabel(message: PluginBrowserWindowParentMessage | null) {
    if (!message) return "";
    return message.args.length > 0
      ? `${message.channel} +${message.args.length}`
      : message.channel;
  }

  function escapePluginPreviewHtml(value: unknown) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const PLUGIN_SCRIPT_CLOSE_RE = new RegExp("</" + "script", "gi");

  function pluginBridgeJson(value: unknown) {
    return JSON.stringify(value).replace(PLUGIN_SCRIPT_CLOSE_RE, "<\\/script");
  }

  function contextMenuNumber(value: unknown) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : 0;
  }

  function handlePluginContextMenu(data: Record<string, unknown>) {
    closeOutputContextMenu();
    lastPluginContextMenu = {
      x: contextMenuNumber(data.x),
      y: contextMenuNumber(data.y),
      screenX: contextMenuNumber(data.screenX),
      screenY: contextMenuNumber(data.screenY),
      tagName: typeof data.tagName === "string" ? data.tagName.slice(0, 32).toUpperCase() : "",
      editable: data.editable === true,
      selectedText: typeof data.selectedText === "string" ? data.selectedText.slice(0, 200) : "",
      defaultPrevented: data.defaultPrevented === true,
    };
  }

  function previewPayload() {
    return action.payload && typeof action.payload === "object"
      ? action.payload as Record<string, unknown>
      : {};
  }

  function previewSubInputOptions(value: unknown) {
    if (!value || typeof value !== "object") return {};
    const record = value as Record<string, unknown>;
    return {
      placeholder: typeof record.placeholder === "string" ? record.placeholder : "",
      focus: record.focus === true,
    };
  }

  function previewIframeSrc(value: unknown) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const url = new URL(trimmed);
      const isLocalHttp = (url.protocol === "http:" || url.protocol === "https:")
        && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
      return isLocalHttp || url.protocol === "file:" ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function pluginBridgeHtml(windowType: PluginBrowserWindowType = "main", browserWindowId = "") {
    const safeWindowType: PluginBrowserWindowType = windowType === "browserWindow" ? "browserWindow" : "main";
    return UTOOLS_BRIDGE
      .replace(/__PLUGIN_ID__/g, pluginBridgeJson(action.plugin_id))
      .replace(/__FEATURE_CODE__/g, pluginBridgeJson(action.feature_code))
      .replace(/__ACTION_PAYLOAD__/g, pluginBridgeJson(action.payload ?? null))
      .replace(/__APP_NAME__/g, pluginBridgeJson(packageInfo.productName || packageInfo.name || "ATools"))
      .replace(/__APP_VERSION__/g, pluginBridgeJson(packageInfo.version || "0.0.0"))
      .replace("var _atoolsPluginPermissions = null;", `var _atoolsPluginPermissions = ${pluginBridgeJson(action.plugin_permissions ?? [])};`)
      .replace("var _atoolsWindowType = 'main';", `var _atoolsWindowType = ${JSON.stringify(safeWindowType)};`)
      .replace("var _atoolsBrowserWindowId = '';", `var _atoolsBrowserWindowId = ${JSON.stringify(browserWindowId)};`);
  }

  function injectPluginBridge(
    html: string,
    windowType: PluginBrowserWindowType = "main",
    browserWindowId = ""
  ) {
    const bridge = pluginBridgeHtml(windowType, browserWindowId);
    if (html.includes("</head>")) return html.replace("</head>", `${bridge}</head>`);
    const bodyOpenMatch = html.match(/<body\b[^>]*>/i);
    if (bodyOpenMatch?.index != null) {
      const insertAt = bodyOpenMatch.index + bodyOpenMatch[0].length;
      return `${html.slice(0, insertAt)}${bridge}${html.slice(insertAt)}`;
    }
    return bridge + html;
  }

  function desktopSmokeBridgeProbeHtml() {
    if (!desktopPluginPanelRenderSmokeEnabled()) return "";
    const pluginId = pluginBridgeJson(action.plugin_id);
    const featureCode = pluginBridgeJson(action.feature_code);
    const sampleIndex = Number.isFinite(desktopSmokeSampleIndex) ? desktopSmokeSampleIndex : 0;
    const browserWindowProbeSource = desktopBrowserWindowIsolationProbeSource({
      mainUrl: action.main_url || "index.html",
      sampleIndex,
    });
    return `
<script>
(function() {
  var pluginId = ${pluginId};
  var featureCode = ${featureCode};
  var sampleIndex = ${sampleIndex};
  function probeResult(id, passed, detail) {
    return {
      id: String(id || 'unknown'),
      passed: passed === true,
      detail: detail == null ? '' : String(detail)
    };
  }
  function runProbe(id, callback) {
    try {
      return probeResult(id, callback() === true);
    } catch (error) {
      return probeResult(id, false, error && error.message || String(error));
    }
  }
  function runAsyncProbe(id, callback) {
    return Promise.resolve()
      .then(callback)
      .then(function(passed) {
        return probeResult(id, passed === true);
      })
      .catch(function(error) {
        return probeResult(id, false, error && error.message || String(error));
      });
  }
  function contextBridgeErrorAccepted(error) {
    return /readCurrentBrowserUrl|readCurrentFolderPath|browser|finder|osascript|automation|permission|unavailable|not available|denied/i.test(String(error && error.message || error || ''));
  }
  function visibleInputState() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea'));
    for (var i = 0; i < inputs.length; i += 1) {
      var element = inputs[i];
      if (!element || element.disabled === true || element.type === 'hidden') continue;
      var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      var rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
      var visible = !rect || (rect.width > 0 && rect.height > 0);
      if (!visible) continue;
      return {
        visible: true,
        placeholder: String(element.getAttribute('placeholder') || '')
      };
    }
    return { visible: false, placeholder: '' };
  }
  function run() {
    var key = 'atools-desktop-smoke-bridge-probe-' + sampleIndex;
    var inputState = visibleInputState();
    var probes = [
      runProbe('desktop-bridge-utools-object', function() {
        return !!window.utools && window.ztools === window.utools;
      }),
      runProbe('desktop-bridge-window-type', function() {
        return !!window.utools && typeof window.utools.getWindowType === 'function' && window.utools.getWindowType() === 'main';
      }),
      runProbe('desktop-bridge-app-identity', function() {
        return !!window.utools
          && typeof window.utools.getAppName === 'function'
          && typeof window.utools.getAppVersion === 'function'
          && String(window.utools.getAppName() || '').length > 0
          && String(window.utools.getAppVersion() || '').length > 0;
      }),
      runProbe('desktop-bridge-db-storage', function() {
        if (!window.utools || !window.utools.dbStorage) return false;
        window.utools.dbStorage.setItem(key, { ok: true, sampleIndex: sampleIndex });
        var value = window.utools.dbStorage.getItem(key);
        window.utools.dbStorage.removeItem(key);
        return !!value && value.ok === true && value.sampleIndex === sampleIndex;
      }),
      runProbe('desktop-bridge-platform-flags', function() {
        return !!window.utools
          && typeof window.utools.isDev === 'function'
          && typeof window.utools.isMacOS === 'function'
          && typeof window.utools.isWindows === 'function'
          && typeof window.utools.isLinux === 'function'
          && typeof window.utools.isDev() === 'boolean'
          && typeof window.utools.isMacOS() === 'boolean'
          && typeof window.utools.isWindows() === 'boolean'
          && typeof window.utools.isLinux() === 'boolean';
      })
    ];
    var browserWindowProbePromise = ${browserWindowProbeSource};
    Promise.all([
      Promise.all([
      runAsyncProbe('desktop-bridge-native-get-path', function() {
        return window.utools && typeof window.utools.getPath === 'function'
          ? Promise.resolve(window.utools.getPath('home')).then(function(value) {
              return typeof value === 'string' && value.length > 0;
            })
          : false;
      }),
      runAsyncProbe('desktop-bridge-native-capture-sources', function() {
        return window.utools && typeof window.utools.desktopCaptureSources === 'function'
          ? Promise.resolve(window.utools.desktopCaptureSources({ types: ['screen'] })).then(function(sources) {
              return Array.isArray(sources) && sources.length > 0;
            })
          : false;
      }),
      runAsyncProbe('desktop-bridge-native-browser-context', function() {
        if (!window.utools || typeof window.utools.readCurrentBrowserUrl !== 'function') return false;
        return Promise.resolve(window.utools.readCurrentBrowserUrl())
          .then(function(value) {
            return typeof value === 'string' || value === null || value === undefined;
          })
          .catch(function(error) {
            return contextBridgeErrorAccepted(error);
          });
      }),
      runAsyncProbe('desktop-bridge-native-folder-context', function() {
        if (!window.utools || typeof window.utools.readCurrentFolderPath !== 'function') return false;
        return Promise.resolve(window.utools.readCurrentFolderPath())
          .then(function(value) {
            return typeof value === 'string' || value === null || value === undefined;
          })
          .catch(function(error) {
            return contextBridgeErrorAccepted(error);
          });
      })
      ]),
      browserWindowProbePromise
    ]).then(function(results) {
      var nativeMethodProbes = results[0];
      var browserWindowProbe = results[1] && typeof results[1] === 'object' ? results[1] : {};
      var browserWindowProbes = Array.isArray(browserWindowProbe.probes) ? browserWindowProbe.probes : [];
      var browserWindowProbePassed = browserWindowProbe.expected === true
        && browserWindowProbe.reported === true
        && browserWindowProbes.length === 9
        && browserWindowProbes.every(function(probe) { return probe && probe.passed === true; });
      window.parent.postMessage({
        __atools_desktop_smoke_bridge_probe__: true,
        pluginId: pluginId,
        featureCode: featureCode,
        sampleIndex: sampleIndex,
        probes: probes,
        nativeMethodProbes: nativeMethodProbes,
        browserWindowProbeExpected: browserWindowProbe.expected === true,
        browserWindowProbeReported: browserWindowProbe.reported === true,
        browserWindowProbePassed: browserWindowProbePassed,
        browserWindowProbes: browserWindowProbes,
        browserWindowCreated: browserWindowProbe.created === true,
        browserWindowChildOriginOpaque: browserWindowProbe.childOriginOpaque === true,
        browserWindowSelfTauriUnavailable: browserWindowProbe.selfTauriUnavailable === true,
        browserWindowParentTauriUnavailable: browserWindowProbe.parentTauriUnavailable === true,
        browserWindowParentDocumentBlocked: browserWindowProbe.parentDocumentBlocked === true,
        browserWindowSendToParentChecked: browserWindowProbe.sendToParentChecked === true,
        browserWindowExecuteJavascriptChecked: browserWindowProbe.executeJavascriptChecked === true,
        browserWindowIpcRoundtripChecked: browserWindowProbe.ipcRoundtripChecked === true,
        browserWindowCleanupChecked: browserWindowProbe.cleanupChecked === true,
        domInputVisible: inputState.visible,
        domInputPlaceholder: inputState.placeholder
      }, '*');
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(run, 0); }, { once: true });
  } else {
    setTimeout(run, 0);
  }
})();
<\/script>`;
  }

  function injectDesktopSmokeBridgeProbe(html: string) {
    const probe = desktopSmokeBridgeProbeHtml();
    if (!probe) return html;
    if (html.includes("</body>")) return html.replace("</body>", `${probe}</body>`);
    return `${html}${probe}`;
  }

  function normalizedHostPluginPermission(permission: string | null | undefined) {
    return String(permission || "").trim();
  }

  function desktopSmokeNativeProbePermissionAllowed(permission: string | null | undefined) {
    const value = normalizedHostPluginPermission(permission);
    if (!value || !desktopPluginPanelRenderSmokeEnabled()) return false;
    return [
      "system.path",
      "screen.desktopCaptureSources",
      "context.browser",
      "context.finder",
      "browserWindow",
    ].includes(value);
  }

  function hostPluginPermissionAllowed(permission: string | null | undefined) {
    const value = normalizedHostPluginPermission(permission);
    if (!value) return false;
    if (pluginPermissionListAllows(runtimeApprovedPluginPermissions, value)) return true;
    if (pluginPermissionListAllows(runtimePersistentPluginPermissions, value)) return true;
    return pluginPermissionListAllows(action.plugin_permissions, value);
  }

  function postPluginPermissionResponse(request: PluginRuntimePermissionRequest, allowed: boolean) {
    if (request.bridgeReqId !== null) {
      try {
        request.source?.postMessage({
          __atools_permission_response__: true,
          reqId: request.bridgeReqId,
          permission: request.permission,
          allowed,
        }, "*");
      } catch (error) {
        console.warn("[PluginPanel] failed to post plugin permission response:", error);
      }
    }
    const resolver = pluginPermissionResolvers.get(request.id);
    if (resolver) resolver(allowed);
    pluginPermissionResolvers.delete(request.id);
  }

  function addRuntimeApprovedPluginPermission(permission: string) {
    const value = normalizedHostPluginPermission(permission);
    if (!value || runtimeApprovedPluginPermissions.includes(value)) return;
    runtimeApprovedPluginPermissions = [...runtimeApprovedPluginPermissions, value];
  }

  function clearPluginPermissionRequests() {
    for (const request of pluginPermissionRequests) {
      postPluginPermissionResponse(request, false);
    }
    pluginPermissionRequests = [];
    pluginPermissionResolvers.clear();
  }

  function enqueuePluginPermissionRequest(
    permission: string,
    source: Window | null,
    bridgeReqId: number | null = null
  ) {
    const value = normalizedHostPluginPermission(permission);
    if (!value) return Promise.resolve(false);
    if (hostPluginPermissionAllowed(value) || desktopSmokeNativeProbePermissionAllowed(value)) {
      if (bridgeReqId !== null) {
        source?.postMessage({
          __atools_permission_response__: true,
          reqId: bridgeReqId,
          permission: value,
          allowed: true,
        }, "*");
      }
      return Promise.resolve(true);
    }

    const id = `permission:${++pluginPermissionRequestSeq}`;
    const request: PluginRuntimePermissionRequest = { id, permission: value, source, bridgeReqId };
    pluginPermissionRequests = [...pluginPermissionRequests, request];
    if (bridgeReqId !== null) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      pluginPermissionResolvers.set(id, resolve);
    });
  }

  async function ensureHostPluginPermission(permission: string | null | undefined, source: Window | null) {
    const value = normalizedHostPluginPermission(permission);
    if (!value) throw new Error("Unsupported plugin permission");
    if (hostPluginPermissionAllowed(value) || desktopSmokeNativeProbePermissionAllowed(value)) return;
    const allowed = await enqueuePluginPermissionRequest(value, source);
    if (!allowed) throw new Error(`Plugin permission denied: ${value}`);
  }

  function handlePluginPermissionRequest(e: MessageEvent, data: Record<string, unknown>) {
    if (!isPluginBridgeRequestId(data.reqId)) return;
    try {
      const request = resolvePluginPermissionRequest(data);
      void enqueuePluginPermissionRequest(request.permission, e.source as Window | null, request.reqId);
    } catch (error) {
      (e.source as Window)?.postMessage({
        __atools_permission_response__: true,
        reqId: data.reqId,
        permission: normalizedHostPluginPermission(data.permission as string | undefined),
        allowed: false,
        error: error instanceof Error ? error.message : String(error),
      }, "*");
    }
  }

  function respondPluginPermissionRequest(
    request: PluginRuntimePermissionRequest,
    allowed: boolean,
    persistent = false,
  ) {
    if (allowed) {
      if (persistent) {
        grantPluginRuntimePermission(action.plugin_id, request.permission);
        runtimePersistentPluginPermissions = pluginRuntimePermissionGrantList(action.plugin_id);
      }
      addRuntimeApprovedPluginPermission(request.permission);
    }
    pluginPermissionRequests = pluginPermissionRequests.filter((item) => item.id !== request.id);
    postPluginPermissionResponse(request, allowed);
  }

  function nativePermissionForMethod(method: unknown) {
    return nativePluginPermissionForMethod(method);
  }

  function loadPreviewPluginHtml() {
    const payload = previewPayload();
    const src = previewIframeSrc(payload.iframeSrc);
    if (src) {
      iframeSrc = src;
      iframeSrcDoc = "";
    } else {
      const html = typeof payload.srcdoc === "string"
        ? payload.srcdoc
        : "<!doctype html><html><body><main>Plugin host preview</main></body></html>";
      iframeSrc = "";
      iframeSrcDoc = injectPluginBridge(html);
    }
    pluginItems = normalizePluginOutputItems(payload.outputItems);
    subInputOpts = previewSubInputOptions(payload.subInput);
    subInputValue = typeof payload.subInputValue === "string" ? payload.subInputValue : "";
    selectedIndex = 0;
    loadError = null;
  }

  function postPluginLifecycleEvent(event: "plugin-out" | "plugin-detach", detail: Record<string, unknown> = {}) {
    iframeRef?.contentWindow?.postMessage({
      __atools_lifecycle__: true,
      event,
      ...detail,
    }, "*");
  }

  function dispatchPluginOutEvent(isKill: boolean) {
    if (pluginOutDispatched) return;
    pluginOutDispatched = true;
    postPluginLifecycleEvent("plugin-out", { isKill });
  }

  function dispatchPluginDetachEvent() {
    if (pluginDetachDispatched) return;
    pluginDetachDispatched = true;
    postPluginLifecycleEvent("plugin-detach");
  }

  function handlePluginChromeAction(actionId: PluginHostAction["id"]) {
    switch (actionId) {
      case "detach":
        dispatchPluginDetachEvent();
        break;
      case "settings":
        console.info("[PluginPanel] plugin settings action is not available yet");
        break;
      case "back":
        closePluginPanel();
        break;
    }
  }

  function closePluginPanel() {
    dispatchPluginOutEvent(false);
    onclose();
  }

  onDestroy(() => {
    resolveDesktopSmokeBridgeProbe(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-destroyed"));
    pluginBrowserWindowNavigation.closeAll();
    pluginBrowserWindowRpc.closeAll();
    pluginMessageSources.clear();
    dispatchPluginOutEvent(true);
  });

  onMount(() => {
    const onOutputContextMenuKeydown = (event: KeyboardEvent) => handlePluginPanelKeydown(event);
    const onPluginRuntimePermissionGrantsUpdated = () => {
      runtimePersistentPluginPermissions = pluginRuntimePermissionGrantList(action.plugin_id);
    };
    window.addEventListener("keydown", onOutputContextMenuKeydown, { capture: true });
    window.addEventListener(PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, onPluginRuntimePermissionGrantsUpdated);
    return () => {
      window.removeEventListener("keydown", onOutputContextMenuKeydown, { capture: true });
      window.removeEventListener(PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, onPluginRuntimePermissionGrantsUpdated);
    };
  });

  const UTOOLS_BRIDGE = `
<script>
(function() {
  // The sandbox never receives or discovers Tauri internals. Every command is
  // mediated by the host-side source registry and deny-by-default policy.
  var _reqId = 0;
  var _pending = {};
  window.addEventListener('message', function(e) {
    if (e.data && e.data.__ipc_response__) {
      var p = _pending[e.data.reqId];
      if (p) {
        if (e.data.error) p.reject(new Error(String(e.data.error)));
        else p.resolve(e.data.result);
        delete _pending[e.data.reqId];
      }
    }
  });
  var _invoke = function(cmd, args) {
    return new Promise(function(resolve, reject) {
      var id = ++_reqId;
      _pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ __ipc_call__: true, reqId: id, cmd: cmd, args: args || {} }, '*');
    });
  };

  var _atoolsPluginPermissions = null;
  var _atoolsRuntimeGrantedPermissions = {};
  var _permissionReqId = 0;
  var _permissionPending = {};
  function _pluginPermissionGroup(permission) {
    var value = String(permission || '').trim();
    if (!value) return '';
    var dot = value.indexOf('.');
    return dot > 0 ? value.slice(0, dot) : value;
  }
  function _pluginPermissionAllowed(permission) {
    var value = String(permission || '').trim();
    if (!value) return true;
    if (_atoolsRuntimeGrantedPermissions[value] === true) return true;
    if (!Array.isArray(_atoolsPluginPermissions)) return true;
    var group = _pluginPermissionGroup(value);
    return _atoolsPluginPermissions.some(function(item) {
      var allowed = String(item || '').trim();
      if (!allowed) return false;
      if (allowed === '*' || allowed === value || allowed === group) return true;
      if (allowed.endsWith('.*') && value.indexOf(allowed.slice(0, -1)) === 0) return true;
      return false;
    });
  }
  function _requirePluginPermission(permission) {
    var value = String(permission || '').trim();
    if (!value || _pluginPermissionAllowed(value)) return true;
    throw new Error('Plugin permission denied: ' + value);
  }
  function _requestPluginPermission(permission) {
    var value = String(permission || '').trim();
    if (!value || _pluginPermissionAllowed(value)) return Promise.resolve(true);
    return new Promise(function(resolve, reject) {
      var id = ++_permissionReqId;
      _permissionPending[id] = { permission: value, resolve: resolve, reject: reject };
      window.parent.postMessage({
        __atools_permission_request__: true,
        reqId: id,
        permission: value,
        pluginId: __PLUGIN_ID__,
        featureCode: __FEATURE_CODE__
      }, '*');
    });
  }
  function _permissionPromise(permission, executor) {
    try {
      var value = String(permission || '').trim();
      if (!value || _pluginPermissionAllowed(value)) {
        return executor();
      }
      return _requestPluginPermission(value).then(function() {
        return executor();
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }
  function _rejectPluginPermission(permission) {
    var value = String(permission || '').trim();
    if (!value) value = 'unknown';
    return new Error('Plugin permission denied: ' + value);
  }
  function _resolvePluginPermissionResponse(data) {
    var reqId = data && data.reqId;
    var pending = _permissionPending[reqId];
    if (!pending) return;
    delete _permissionPending[reqId];
    if (data.allowed === true) {
      _atoolsRuntimeGrantedPermissions[pending.permission] = true;
      pending.resolve(true);
    } else {
      pending.reject(_rejectPluginPermission(pending.permission));
    }
  }
  function _invokePermissionForCommand(cmd, args) {
    switch (String(cmd || '')) {
      case 'put_plugin_data':
      case 'put_plugin_data_bulk':
      case 'get_plugin_data':
      case 'get_plugin_data_item':
      case 'remove_plugin_data':
        return 'data';
      case 'copy_text':
        return 'clipboard.write';
      case 'shell_open': {
        var target = String(args && args.url || '').trim();
        if (/^file:/i.test(target) || !/^[a-z][a-z\\d+.-]*:/i.test(target)) return 'shell.openPath';
        return 'shell.openExternal';
      }
      case 'system_get_path':
        return 'system.path';
      case 'show_notification':
        return 'notification';
      default:
        return null;
    }
  }
  function _nativePermissionForMethod(method) {
    switch (String(method || '')) {
      case 'showOpenDialog':
        return 'dialog.open';
      case 'showSaveDialog':
        return 'dialog.save';
      case 'copyImage':
      case 'copyFile':
      case 'hideMainWindowPasteText':
      case 'hideMainWindowPasteImage':
      case 'hideMainWindowPasteFile':
        return 'clipboard.write';
      case 'getCopyedFiles':
        return 'clipboard.read';
      case 'shellOpenPath':
        return 'shell.openPath';
      case 'shellOpenExternal':
        return 'shell.openExternal';
      case 'shellShowItemInFolder':
        return 'shell.showItemInFolder';
      case 'shellTrashItem':
        return 'shell.trashItem';
      case 'shellBeep':
        return 'shell.beep';
      case 'screenCapture':
        return 'screen.capture';
      case 'screenColorPick':
        return 'screen.colorPick';
      case 'desktopCaptureSources':
        return 'screen.desktopCaptureSources';
      case 'readCurrentBrowserUrl':
        return 'context.browser';
      case 'readCurrentFolderPath':
        return 'context.finder';
      case 'simulateKeyboardTap':
      case 'hideMainWindowTypeString':
        return 'input.keyboard';
      case 'startDrag':
        return 'file.drag';
      case 'createBrowserWindow':
      case 'sendToParent':
      case 'browserWindowAction':
        return 'browserWindow';
      case 'redirect':
      case 'redirectHotKeySetting':
      case 'redirectAiModelsSetting':
        return 'settings.redirect';
      default:
        return null;
    }
  }
  var _rawInvokeFn = _invoke;
  var _invokeFn = function(cmd, args) {
    var permission = _invokePermissionForCommand(cmd, args);
    if (!permission) return Promise.reject(new Error('Unsupported plugin invoke command: ' + String(cmd || '(empty)')));
    return _permissionPromise(permission, function() {
      return _rawInvokeFn(cmd, args);
    });
  };
  var _nativeReqId = 0;
  var _nativePending = {};
  var _resourceReqId = 0;
  var _resourcePending = {};
  var _atoolsWindowType = 'main';
  var _atoolsBrowserWindowId = '';
  var _browserWindowCallbacks = {};
  var _browserWindowEventDispatchers = {};
  var _browserWindowHandles = {};
  var _childIpcListeners = {};
  var _hostedBrowserWindowRpcPort = null;
  var _hostedBrowserWindowRpcGeneration = 0;
  var _hostedBrowserWindowRpcMethods = {
    describe: true,
    executeJavaScript: true,
    sendInputEvent: true,
    insertCSS: true,
    removeInsertedCSS: true,
    findInPage: true,
    stopFindInPage: true
  };

  function _hostedBrowserWindowRpcError(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function _hostedBrowserWindowRpcNumber(value, fallback) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : (fallback || 0);
  }
  function _hostedBrowserWindowRpcModifiers(inputEvent) {
    var modifiers = Array.isArray(inputEvent.modifiers)
      ? inputEvent.modifiers.map(function(value) { return String(value).toLowerCase(); })
      : [];
    return {
      altKey: inputEvent.altKey === true || modifiers.indexOf('alt') >= 0,
      ctrlKey: inputEvent.ctrlKey === true || modifiers.indexOf('control') >= 0 || modifiers.indexOf('ctrl') >= 0,
      metaKey: inputEvent.metaKey === true || modifiers.indexOf('meta') >= 0 || modifiers.indexOf('command') >= 0 || modifiers.indexOf('cmd') >= 0,
      shiftKey: inputEvent.shiftKey === true || modifiers.indexOf('shift') >= 0
    };
  }
  function _hostedBrowserWindowRpcSendInputEvent(args) {
    var inputEvent = args && args.inputEvent;
    if (!inputEvent || typeof inputEvent !== 'object' || Array.isArray(inputEvent)) {
      throw new Error('webContents.sendInputEvent requires an input event object');
    }
    var rawType = String(inputEvent.type || '').trim().toLowerCase();
    if (!rawType) throw new Error('webContents.sendInputEvent requires an input event type');
    var target = document.activeElement || document.body || document;
    var modifiers = _hostedBrowserWindowRpcModifiers(inputEvent);
    var keyboardType = rawType === 'rawkeydown' || rawType === 'keydown'
      ? 'keydown'
      : (rawType === 'keyup' ? 'keyup' : (rawType === 'char' ? 'keypress' : ''));
    if (keyboardType) {
      var key = String(inputEvent.key || inputEvent.keyCode || inputEvent.code || '');
      var code = String(inputEvent.code || inputEvent.keyCode || inputEvent.key || '');
      target.dispatchEvent(new window.KeyboardEvent(keyboardType, {
        bubbles: true,
        cancelable: true,
        key: key,
        code: code,
        repeat: inputEvent.repeat === true || inputEvent.isAutoRepeat === true,
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
        shiftKey: modifiers.shiftKey
      }));
      return undefined;
    }
    var mouseTypes = {
      mousedown: 'mousedown',
      mouseup: 'mouseup',
      mousemove: 'mousemove',
      mouseenter: 'mouseenter',
      mouseleave: 'mouseleave',
      contextmenu: 'contextmenu'
    };
    var mouseType = mouseTypes[rawType];
    var x = _hostedBrowserWindowRpcNumber(inputEvent.x != null ? inputEvent.x : inputEvent.clientX, 0);
    var y = _hostedBrowserWindowRpcNumber(inputEvent.y != null ? inputEvent.y : inputEvent.clientY, 0);
    var pointTarget = document.elementFromPoint && document.elementFromPoint(x, y) || target;
    if (mouseType) {
      var buttonName = String(inputEvent.button == null ? 'left' : inputEvent.button).toLowerCase();
      var button = buttonName === 'middle' ? 1 : (buttonName === 'right' ? 2 : (buttonName === 'left' ? 0 : _hostedBrowserWindowRpcNumber(inputEvent.button, 0)));
      pointTarget.dispatchEvent(new window.MouseEvent(mouseType, {
        bubbles: mouseType !== 'mouseenter' && mouseType !== 'mouseleave',
        cancelable: true,
        clientX: x,
        clientY: y,
        screenX: _hostedBrowserWindowRpcNumber(inputEvent.globalX != null ? inputEvent.globalX : inputEvent.screenX, x),
        screenY: _hostedBrowserWindowRpcNumber(inputEvent.globalY != null ? inputEvent.globalY : inputEvent.screenY, y),
        button: button,
        buttons: _hostedBrowserWindowRpcNumber(inputEvent.buttons, mouseType === 'mouseup' || mouseType === 'mouseleave' ? 0 : (button === 1 ? 4 : (button === 2 ? 2 : 1))),
        detail: _hostedBrowserWindowRpcNumber(inputEvent.clickCount, 0),
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
        shiftKey: modifiers.shiftKey
      }));
      return undefined;
    }
    if (rawType === 'mousewheel') {
      pointTarget.dispatchEvent(new window.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        deltaX: _hostedBrowserWindowRpcNumber(inputEvent.deltaX != null ? inputEvent.deltaX : inputEvent.wheelDeltaX, 0),
        deltaY: _hostedBrowserWindowRpcNumber(inputEvent.deltaY != null ? inputEvent.deltaY : inputEvent.wheelDeltaY, 0),
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
        shiftKey: modifiers.shiftKey
      }));
      return undefined;
    }
    throw new Error('Unsupported webContents.sendInputEvent type: ' + String(inputEvent.type || ''));
  }
  function _hostedBrowserWindowRpcFind(args) {
    var text = String(args && args.text || '');
    if (!text) throw new Error('webContents.findInPage requires non-empty text');
    var matchCase = args && args.matchCase === true;
    var needle = matchCase ? text : text.toLowerCase();
    var rawHaystack = document.body && document.body.innerText || document.documentElement && document.documentElement.textContent || '';
    var haystack = matchCase ? rawHaystack : rawHaystack.toLowerCase();
    var index = 0;
    var matches = 0;
    while (needle && index <= haystack.length) {
      var foundIndex = haystack.indexOf(needle, index);
      if (foundIndex < 0) break;
      matches += 1;
      index = foundIndex + needle.length;
    }
    var rect = matches > 0 && document.body && document.body.getBoundingClientRect
      ? document.body.getBoundingClientRect()
      : null;
    var forward = !args || args.forward !== false;
    return {
      requestId: Number(args && args.requestId || 0),
      activeMatchOrdinal: matches <= 0 ? 0 : (forward ? 1 : matches),
      matches: matches,
      selectionArea: {
        x: Math.max(0, Math.round(rect && rect.left || 0)),
        y: Math.max(0, Math.round(rect && rect.top || 0)),
        width: Math.max(0, Math.round(rect && rect.width || 0)),
        height: Math.max(0, Math.round(rect && rect.height || 0))
      },
      finalUpdate: true
    };
  }
  function _hostedBrowserWindowRpcDispatch(method, args) {
    if (!_hostedBrowserWindowRpcMethods[method]) {
      throw new Error('Unsupported hosted BrowserWindow RPC method: ' + String(method || '(empty)'));
    }
    if (method === 'describe') {
      return {
        title: String(document.title || ''),
        readyState: String(document.readyState || ''),
        text: String(document.body && document.body.innerText || document.documentElement && document.documentElement.textContent || '')
      };
    }
    if (method === 'executeJavaScript') {
      return (0, eval)(String(args && args.code || ''));
    }
    if (method === 'sendInputEvent') return _hostedBrowserWindowRpcSendInputEvent(args || {});
    if (method === 'insertCSS') {
      var cssKey = String(args && args.key || '');
      var css = String(args && args.css || '');
      if (!cssKey || !css) throw new Error('webContents.insertCSS requires key and CSS text');
      var style = document.createElement('style');
      style.setAttribute('data-atools-browser-window-css-key', cssKey);
      style.setAttribute('data-atools-browser-window-css-origin', args && args.cssOrigin === 'user' ? 'user' : 'author');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      return cssKey;
    }
    if (method === 'removeInsertedCSS') {
      var removeKey = String(args && args.key || '');
      var styles = document.querySelectorAll('style[data-atools-browser-window-css-key]');
      Array.prototype.some.call(styles, function(styleNode) {
        if (styleNode.getAttribute('data-atools-browser-window-css-key') !== removeKey) return false;
        styleNode.remove();
        return true;
      });
      return undefined;
    }
    if (method === 'findInPage') return _hostedBrowserWindowRpcFind(args || {});
    if (method === 'stopFindInPage') {
      var stopAction = String(args && args.action || 'clearSelection');
      if (stopAction !== 'keepSelection' && stopAction !== 'activateSelection') {
        var selection = window.getSelection && window.getSelection();
        if (selection) selection.removeAllRanges();
      }
      return undefined;
    }
    throw new Error('Unsupported hosted BrowserWindow RPC method: ' + String(method || '(empty)'));
  }
  function _acceptHostedBrowserWindowRpc(event) {
    var data = event && event.data;
    if (!data || data.__atools_hosted_browser_window_rpc_init__ !== true) return false;
    if ((_atoolsWindowType || 'main') !== 'browserWindow') return true;
    if (event.source !== window.parent) return true;
    var generation = Number(data.generation);
    var port = event.ports && event.ports[0];
    if (!Number.isSafeInteger(generation) || generation <= _hostedBrowserWindowRpcGeneration || !port) return true;
    if (_hostedBrowserWindowRpcPort && typeof _hostedBrowserWindowRpcPort.close === 'function') {
      _hostedBrowserWindowRpcPort.close();
    }
    _hostedBrowserWindowRpcGeneration = generation;
    _hostedBrowserWindowRpcPort = port;
    port.onmessage = function(portEvent) {
      var request = portEvent && portEvent.data;
      if (!request || request.__atools_hosted_browser_window_rpc_request__ !== true) return;
      if (request.generation !== _hostedBrowserWindowRpcGeneration) return;
      var reqId = Number(request.reqId);
      if (!Number.isSafeInteger(reqId) || reqId <= 0) return;
      Promise.resolve().then(function() {
        return _hostedBrowserWindowRpcDispatch(String(request.method || ''), request.args || {});
      }).then(function(result) {
        try {
          port.postMessage({
            __atools_hosted_browser_window_rpc_response__: true,
            generation: _hostedBrowserWindowRpcGeneration,
            reqId: reqId,
            result: result
          });
        } catch (cloneError) {
          port.postMessage({
            __atools_hosted_browser_window_rpc_response__: true,
            generation: _hostedBrowserWindowRpcGeneration,
            reqId: reqId,
            error: _hostedBrowserWindowRpcError(cloneError)
          });
        }
      }, function(error) {
        port.postMessage({
          __atools_hosted_browser_window_rpc_response__: true,
          generation: _hostedBrowserWindowRpcGeneration,
          reqId: reqId,
          error: _hostedBrowserWindowRpcError(error)
        });
      });
    };
    if (typeof port.start === 'function') port.start();
    port.postMessage({
      __atools_hosted_browser_window_rpc_ready__: true,
      generation: generation
    });
    return true;
  }

  window.addEventListener('message', function(e) {
    if (_acceptHostedBrowserWindowRpc(e)) return;
    if (e.data && e.data.__atools_permission_response__) {
      _resolvePluginPermissionResponse(e.data);
    }
    if (e.data && e.data.__atools_lifecycle__) {
      var lifecycleEvent = String(e.data.event || '');
      if (lifecycleEvent === 'plugin-out') {
        window.dispatchEvent(new CustomEvent('atools-plugin-out', { detail: { isKill: e.data.isKill === true } }));
      } else if (lifecycleEvent === 'plugin-detach') {
        window.dispatchEvent(new CustomEvent('atools-plugin-detach'));
      }
    }
    if (e.data && e.data.__atools_native_response__) {
      var p = _nativePending[e.data.reqId];
      if (p) {
        if (e.data.error) p.reject(new Error(String(e.data.error)));
        else p.resolve(e.data.result);
        delete _nativePending[e.data.reqId];
      }
    }
    if (e.data && e.data.__atools_resource_response__) {
      var resource = _resourcePending[e.data.reqId];
      if (resource) {
        if (e.data.error) resource.reject(new Error(String(e.data.error)));
        else resource.resolve(e.data.url);
        delete _resourcePending[e.data.reqId];
      }
    }
    if (e.data && e.data.__atools_browser_window_parent_message__) {
      var callback = _browserWindowCallbacks[e.data.windowId];
      if (typeof callback === 'function') {
        var channel = String(e.data.channel || '');
        var args = Array.isArray(e.data.args) ? e.data.args : [];
        try {
          callback.apply(null, [channel].concat(args));
        } catch (err) {
          console.error('[createBrowserWindow callback]', err);
        }
      }
    }
    if (e.data && e.data.__atools_browser_window_event__) {
      var dispatcher = _browserWindowEventDispatchers[e.data.windowId];
      if (typeof dispatcher === 'function') {
        var eventName = String(e.data.event || '');
        var eventArgs = Array.isArray(e.data.args) ? e.data.args : [];
        var eventTarget = String(e.data.target || '');
        dispatcher(eventName, eventArgs, eventTarget);
      }
    }
    if (e.data && e.data.__atools_browser_window_ipc__) {
      var targetWindowId = String(e.data.windowId || '');
      if ((_atoolsWindowType || 'main') === 'browserWindow' && targetWindowId === (_atoolsBrowserWindowId || '')) {
        var ipcChannel = String(e.data.channel || '');
        var ipcArgs = Array.isArray(e.data.args) ? e.data.args : [];
        _emitChildIpc(ipcChannel, ipcArgs);
      }
    }
  });

  function _nativeCall(method, args) {
    var permission = _nativePermissionForMethod(method);
    if (!permission) return Promise.reject(new Error('Unsupported native bridge method: ' + String(method || '(empty)')));
    return _permissionPromise(permission, function() {
      return new Promise(function(resolve, reject) {
      var id = ++_nativeReqId;
      _nativePending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        __atools_native_call__: true,
        reqId: id,
        method: method,
        args: args || {}
      }, '*');
      });
    });
  }
  function _nativeCallbackCall(method, args, callback) {
    return _nativeCall(method, args).then(function(result) {
      if (typeof callback === 'function') callback(result);
      return result;
    });
  }
  function _browserWindowAction(id, action) {
    var args = Array.prototype.slice.call(arguments, 2);
    return _nativeCall('browserWindowAction', {
      id: String(id || ''),
      action: String(action || ''),
      args: args
    });
  }
  function _hostedBrowserWindowUnsupported(action) {
    return new Error(
      'ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED: '
      + String(action || 'hosted BrowserWindow operation')
      + ' is unavailable for an isolated hosted BrowserWindow'
    );
  }
  function _childIpcList(channel, create) {
    var key = String(channel || '');
    if (!key) return [];
    if (!_childIpcListeners[key] && create) _childIpcListeners[key] = [];
    return _childIpcListeners[key] || [];
  }
  function _emitChildIpc(channel, args) {
    var key = String(channel || '');
    if (!key) return;
    var listeners = _childIpcList(key, false).slice();
    var event = {
      channel: key,
      sender: null,
      senderFrame: null,
      returnValue: undefined
    };
    listeners.forEach(function(entry) {
      try {
        entry.listener.apply(null, [event].concat(args || []));
      } catch (err) {
        console.error('[browserWindow ipcRenderer]', err);
      }
      if (entry.once) _removeChildIpcListener(key, entry.listener);
    });
  }
  function _addChildIpcListener(channel, listener, once) {
    if (typeof listener !== 'function') return _ipcRenderer;
    _childIpcList(channel, true).push({ listener: listener, once: once === true });
    return _ipcRenderer;
  }
  function _removeChildIpcListener(channel, listener) {
    var key = String(channel || '');
    if (!_childIpcListeners[key]) return _ipcRenderer;
    _childIpcListeners[key] = _childIpcListeners[key].filter(function(entry) {
      return entry.listener !== listener;
    });
    if (_childIpcListeners[key].length === 0) delete _childIpcListeners[key];
    return _ipcRenderer;
  }
  function _removeAllChildIpcListeners(channel) {
    if (typeof channel === 'string' && channel) delete _childIpcListeners[channel];
    else _childIpcListeners = {};
    return _ipcRenderer;
  }
  var _ipcRenderer = {
    on: function(channel, listener) { return _addChildIpcListener(channel, listener, false); },
    addListener: function(channel, listener) { return _addChildIpcListener(channel, listener, false); },
    once: function(channel, listener) { return _addChildIpcListener(channel, listener, true); },
    off: function(channel, listener) { return _removeChildIpcListener(channel, listener); },
    removeListener: function(channel, listener) { return _removeChildIpcListener(channel, listener); },
    removeAllListeners: function(channel) { return _removeAllChildIpcListeners(channel); }
  };
  if (typeof window.require !== 'function') {
    window.require = function(name) {
      var moduleName = String(name || '');
      if (moduleName === 'electron') return { ipcRenderer: _ipcRenderer };
      throw new Error('Cannot find module ' + moduleName);
    };
  }
  function _createBrowserWindowHandle(result, callback) {
    var record = result && typeof result === 'object' ? result : {};
    var id = String(record.id || '');
    var destroyed = false;
    var eventListeners = {};
    var webContentsEventListeners = {};
    var webContentsFindReqId = 0;
    var webContentsUrl = String(record.url || '');
    var webContentsTitle = String(record.title || '');
    var webContentsLoading = false;
    var webContentsHistory = webContentsUrl ? [webContentsUrl] : [];
    var webContentsHistoryIndex = webContentsHistory.length > 0 ? 0 : -1;
    var webContentsDevToolsOpened = false;
    var webContentsDevToolsFocused = false;
    var webContentsDevToolsMode = '';
    var webContentsDevToolsTitle = '';
    var webContentsZoomFactor = 1;
    var webContentsZoomLevel = 0;
    var webContentsVisualZoomMinimumLevel = 0;
    var webContentsVisualZoomMaximumLevel = 0;
    var webContentsAudioMuted = false;
    var webContentsCurrentlyAudible = false;
    var webContentsUserAgent = typeof record.userAgent === 'string' ? record.userAgent : String(navigator.userAgent || '');
    var webContentsFrameRate = normalizeFrameRate(record.frameRate || 60);
    var webContentsBackgroundThrottling = record.backgroundThrottling !== false;
    var webContentsProcessId = hostedPositiveInteger(record.processId, hostedNumericId(id, 1));
    var webContentsOSProcessId = hostedPositiveInteger(record.osProcessId, 100000 + webContentsProcessId);
    var webContentsCrashed = record.crashed === true;
    var webContentsMediaSourceId = typeof record.webContentsMediaSourceId === 'string' && record.webContentsMediaSourceId
      ? record.webContentsMediaSourceId
      : 'web-contents:' + hostedNumericId(id, 1) + ':0';
    var webContentsFocused = record.webContentsFocused === true || record.focused === true;
    var webContentsBeingCaptured = record.webContentsBeingCaptured === true;
    var webContentsIgnoreMenuShortcuts = record.ignoreMenuShortcuts === true;
    function hostedBrowserWindowHexPair(value) {
      var number = Math.min(255, Math.max(0, Math.round(Number(value) || 0)));
      return number.toString(16).padStart(2, '0');
    }
    function normalizeHostedBrowserWindowBackgroundColor(value, fallback) {
      var raw = String(value == null ? '' : value).trim();
      var fallbackColor = typeof fallback === 'string' && /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : '#ffffff';
      var hex = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
      if (hex) {
        var body = hex[1];
        if (body.length === 3) return ('#' + body.split('').map(function(ch) { return ch + ch; }).join('')).toLowerCase();
        if (body.length === 4) return ('#' + body.slice(1).split('').map(function(ch) { return ch + ch; }).join('')).toLowerCase();
        if (body.length === 8) return ('#' + body.slice(2)).toLowerCase();
        return ('#' + body).toLowerCase();
      }
      var lower = raw.toLowerCase();
      if (lower.indexOf('rgb(') === 0 || lower.indexOf('rgba(') === 0) {
        var openIndex = raw.indexOf('(');
        var closeIndex = raw.indexOf(')', openIndex + 1);
        var rgbParts = raw.slice(openIndex + 1, closeIndex >= 0 ? closeIndex : raw.length).split(',');
        if (rgbParts.length >= 3) return '#' + hostedBrowserWindowHexPair(rgbParts[0]) + hostedBrowserWindowHexPair(rgbParts[1]) + hostedBrowserWindowHexPair(rgbParts[2]);
      }
      var namedColors = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', blueviolet: '#8a2be2' };
      return namedColors[raw] || fallbackColor;
    }
    function hostedFiniteNumber(value, fallback) {
      var numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    }
    function hostedPlainOptions(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function hostedWindowButtonPosition(value) {
      if (value == null) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      return {
        x: hostedFiniteNumber(value.x, 0),
        y: hostedFiniteNumber(value.y, 0)
      };
    }
    function hostedWindowButtonPositionCopy(value) {
      return value ? { x: value.x, y: value.y } : null;
    }
    var browserWindowBackgroundColor = normalizeHostedBrowserWindowBackgroundColor(record.backgroundColor || record.backgroundcolor || '#ffffff');
    var browserWindowMenuBarAutoHide = record.menuBarAutoHide === true || record.menubarautohide === true || record.autoHideMenuBar === true || record.autohidemenubar === true;
    var browserWindowMenuRemoved = record.menuRemoved === true || record.menuremoved === true;
    var browserWindowMenuBarVisible = !browserWindowMenuRemoved && record.menuBarVisible !== false && record.menubarvisible !== false;
    var browserWindowButtonVisible = record.windowButtonVisible !== false && record.windowbuttonvisible !== false;
    var browserWindowButtonPosition = hostedWindowButtonPosition(record.windowButtonPosition || record.windowbuttonposition || null);
    var browserWindowVibrancy = typeof record.vibrancy === 'string' ? record.vibrancy : '';
    var browserWindowVibrancyOptions = hostedPlainOptions(record.vibrancyOptions || record.vibrancyoptions);
    var browserWindowBackgroundMaterial = typeof record.backgroundMaterial === 'string' ? record.backgroundMaterial : typeof record.backgroundmaterial === 'string' ? record.backgroundmaterial : 'none';
    var browserWindowSheetOffsetY = hostedFiniteNumber(record.sheetOffsetY || record.sheetoffsety, 0);
    var browserWindowSheetOffsetX = hostedFiniteNumber(record.sheetOffsetX || record.sheetoffsetx, 0);
    var browserWindowDocumentEdited = record.documentEdited === true || record.documentedited === true;
    var browserWindowRepresentedFilename = typeof record.representedFilename === 'string'
      ? record.representedFilename
      : typeof record.representedfilename === 'string'
        ? record.representedfilename
        : '';
    var browserWindowModal = record.modal === true;
    var browserWindowParentId = typeof record.parentWindowId === 'string' && record.parentWindowId
      ? record.parentWindowId
      : typeof record.parentwindowid === 'string' && record.parentwindowid
        ? record.parentwindowid
        : null;
    var browserWindowMinimized = record.minimized === true;
    var browserWindowMaximized = record.maximized === true;
    var browserWindowFullScreen = record.fullScreen === true || record.fullscreen === true;
    var browserWindowKiosk = record.kiosk === true;
    if (typeof callback === 'function' && id) {
      _browserWindowCallbacks[id] = callback;
    }
    function hostedNumericId(value, fallback) {
      var match = String(value || '').match(/(\\d+)$/);
      var numeric = match ? Number(match[1]) : Number(fallback);
      return Number.isInteger(numeric) && numeric > 0 ? numeric : 1;
    }
    function hostedPositiveInteger(value, fallback) {
      var numeric = Number(value);
      if (Number.isInteger(numeric) && numeric > 0) return numeric;
      var fallbackNumeric = Number(fallback);
      return Number.isInteger(fallbackNumeric) && fallbackNumeric > 0 ? fallbackNumeric : 1;
    }
    function eventList(name, create) {
      var key = String(name || '');
      if (!key) return [];
      if (!eventListeners[key] && create) eventListeners[key] = [];
      return eventListeners[key] || [];
    }
    function emitEvent(name, args) {
      var listeners = eventList(name, false).slice();
      listeners.forEach(function(entry) {
        try {
          entry.listener.apply(null, args || []);
        } catch (err) {
          console.error('[browserWindow event]', err);
        }
        if (entry.once) removeListener(name, entry.listener);
      });
    }
    function addEventListener(name, listener, once) {
      if (typeof listener !== 'function') return handle;
      eventList(name, true).push({ listener: listener, once: once === true });
      return handle;
    }
    function removeListener(name, listener) {
      var key = String(name || '');
      if (!eventListeners[key]) return handle;
      eventListeners[key] = eventListeners[key].filter(function(entry) {
        return entry.listener !== listener;
      });
      if (eventListeners[key].length === 0) delete eventListeners[key];
      return handle;
    }
    function removeAllListeners(name) {
      if (typeof name === 'string' && name) delete eventListeners[name];
      else eventListeners = {};
      return handle;
    }
    function webContentsEventList(name, create) {
      var key = String(name || '');
      if (!key) return [];
      if (!webContentsEventListeners[key] && create) webContentsEventListeners[key] = [];
      return webContentsEventListeners[key] || [];
    }
    function emitWebContentsEvent(name, args) {
      var listeners = webContentsEventList(name, false).slice();
      var event = {
        type: String(name || ''),
        sender: webContents,
        preventDefault: function() {},
        defaultPrevented: false
      };
      if (event.type === 'audio-state-changed') {
        var audioArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
        var audible = typeof audioArg === 'boolean'
          ? audioArg
          : audioArg && typeof audioArg === 'object' && typeof audioArg.audible === 'boolean'
            ? audioArg.audible
            : webContentsCurrentlyAudible;
        event.audible = audible;
      }
      listeners.forEach(function(entry) {
        try {
          entry.listener.apply(null, [event].concat(args || []));
        } catch (err) {
          console.error('[browserWindow webContents event]', err);
        }
        if (entry.once) removeWebContentsListener(name, entry.listener);
      });
    }
    function addWebContentsListener(name, listener, once) {
      if (typeof listener !== 'function') return webContents;
      webContentsEventList(name, true).push({ listener: listener, once: once === true });
      return webContents;
    }
    function removeWebContentsListener(name, listener) {
      var key = String(name || '');
      if (!webContentsEventListeners[key]) return webContents;
      webContentsEventListeners[key] = webContentsEventListeners[key].filter(function(entry) {
        return entry.listener !== listener;
      });
      if (webContentsEventListeners[key].length === 0) delete webContentsEventListeners[key];
      return webContents;
    }
    function removeAllWebContentsListeners(name) {
      if (typeof name === 'string' && name) delete webContentsEventListeners[name];
      else webContentsEventListeners = {};
      return webContents;
    }
    function syncWebContentsNavigationState(result, options) {
      var record = result && typeof result === 'object' ? result : {};
      var nextUrl = typeof record.url === 'string' ? record.url : webContentsUrl;
      var nextTitle = typeof record.title === 'string' ? record.title : webContentsTitle;
      var push = options && options.push === true;
      if (push && nextUrl) {
        webContentsHistory = webContentsHistory.slice(0, webContentsHistoryIndex + 1);
        webContentsHistory.push(nextUrl);
        webContentsHistoryIndex = webContentsHistory.length - 1;
      }
      if (Number.isInteger(record.historyIndex)) webContentsHistoryIndex = record.historyIndex;
      if (Number.isInteger(record.historyLength)) {
        var historyLength = Math.max(0, record.historyLength);
        if (historyLength > 0 && webContentsHistory.length !== historyLength) {
          var rebuilt = webContentsHistory.slice(0, historyLength);
          while (rebuilt.length < historyLength) rebuilt.push(rebuilt[rebuilt.length - 1] || nextUrl);
          webContentsHistory = rebuilt;
        }
      }
      if (nextUrl && webContentsHistory.length === 0) {
        webContentsHistory = [nextUrl];
        webContentsHistoryIndex = 0;
      }
      if (webContentsHistoryIndex < 0 && webContentsHistory.length > 0) webContentsHistoryIndex = 0;
      if (webContentsHistoryIndex >= webContentsHistory.length) webContentsHistoryIndex = webContentsHistory.length - 1;
      webContentsUrl = nextUrl;
      webContentsTitle = nextTitle;
      webContentsLoading = record.loading === true;
      if (typeof record.crashed === 'boolean') webContentsCrashed = record.crashed;
      return result;
    }
    function syncBrowserWindowBackgroundColor(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof result === 'string') browserWindowBackgroundColor = normalizeHostedBrowserWindowBackgroundColor(result, browserWindowBackgroundColor);
      if (typeof record.backgroundColor === 'string') browserWindowBackgroundColor = normalizeHostedBrowserWindowBackgroundColor(record.backgroundColor, browserWindowBackgroundColor);
      return result;
    }
    function browserWindowSetBackgroundColor(value) {
      var backgroundColor = normalizeHostedBrowserWindowBackgroundColor(value, browserWindowBackgroundColor);
      browserWindowBackgroundColor = backgroundColor;
      _browserWindowAction(id, 'setBackgroundColor', backgroundColor).then(syncBrowserWindowBackgroundColor).catch(function(err) {
        console.error('[browserWindow setBackgroundColor]', err);
      });
      return undefined;
    }
    function syncBrowserWindowMenuBarState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.menuBarAutoHide === 'boolean') browserWindowMenuBarAutoHide = record.menuBarAutoHide;
      if (typeof record.menuRemoved === 'boolean') browserWindowMenuRemoved = record.menuRemoved;
      if (typeof record.menuBarVisible === 'boolean') browserWindowMenuBarVisible = record.menuBarVisible && !browserWindowMenuRemoved;
      if (browserWindowMenuRemoved) browserWindowMenuBarVisible = false;
      return result;
    }
    function browserWindowSetAutoHideMenuBar(hide) {
      browserWindowMenuBarAutoHide = hide === true;
      _browserWindowAction(id, 'setAutoHideMenuBar', browserWindowMenuBarAutoHide).then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow setAutoHideMenuBar]', err);
      });
      return undefined;
    }
    function browserWindowSetMenuBarVisibility(visible) {
      browserWindowMenuBarVisible = visible === true && !browserWindowMenuRemoved;
      _browserWindowAction(id, 'setMenuBarVisibility', browserWindowMenuBarVisible).then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow setMenuBarVisibility]', err);
      });
      return undefined;
    }
    function browserWindowRemoveMenu() {
      browserWindowMenuRemoved = true;
      browserWindowMenuBarVisible = false;
      _browserWindowAction(id, 'removeMenu').then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow removeMenu]', err);
      });
      return undefined;
    }
    function browserWindowSetMenu(menu) {
      browserWindowMenuRemoved = menu == null;
      browserWindowMenuBarVisible = !browserWindowMenuRemoved;
      _browserWindowAction(id, 'setMenu', menu == null ? null : menu).then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow setMenu]', err);
      });
      return undefined;
    }
    function syncBrowserWindowTitlebarMaterialState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.windowButtonVisible === 'boolean') browserWindowButtonVisible = record.windowButtonVisible;
      if (Object.prototype.hasOwnProperty.call(record, 'windowButtonPosition')) browserWindowButtonPosition = hostedWindowButtonPosition(record.windowButtonPosition);
      if (typeof record.vibrancy === 'string') browserWindowVibrancy = record.vibrancy;
      if (record.vibrancyOptions && typeof record.vibrancyOptions === 'object' && !Array.isArray(record.vibrancyOptions)) browserWindowVibrancyOptions = record.vibrancyOptions;
      if (typeof record.backgroundMaterial === 'string') browserWindowBackgroundMaterial = record.backgroundMaterial;
      if (typeof record.sheetOffsetY === 'number') browserWindowSheetOffsetY = record.sheetOffsetY;
      if (typeof record.sheetOffsetX === 'number') browserWindowSheetOffsetX = record.sheetOffsetX;
      return result;
    }
    function browserWindowSetWindowButtonVisibility(visible) {
      browserWindowButtonVisible = visible === true;
      _browserWindowAction(id, 'setWindowButtonVisibility', browserWindowButtonVisible).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setWindowButtonVisibility]', err);
      });
      return undefined;
    }
    function browserWindowSetWindowButtonPosition(position) {
      browserWindowButtonPosition = hostedWindowButtonPosition(position);
      _browserWindowAction(id, 'setWindowButtonPosition', hostedWindowButtonPositionCopy(browserWindowButtonPosition)).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setWindowButtonPosition]', err);
      });
      return undefined;
    }
    function browserWindowSetVibrancy(type, options) {
      var vibrancy = type == null || String(type) === '' ? null : String(type);
      var vibrancyOptions = hostedPlainOptions(options);
      browserWindowVibrancy = vibrancy || '';
      browserWindowVibrancyOptions = vibrancyOptions;
      _browserWindowAction(id, 'setVibrancy', vibrancy, vibrancyOptions).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setVibrancy]', err);
      });
      return undefined;
    }
    function browserWindowSetBackgroundMaterial(material) {
      var backgroundMaterial = material == null || String(material) === '' ? 'none' : String(material);
      browserWindowBackgroundMaterial = backgroundMaterial;
      _browserWindowAction(id, 'setBackgroundMaterial', backgroundMaterial).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setBackgroundMaterial]', err);
      });
      return undefined;
    }
    function browserWindowSetSheetOffset(offsetY, offsetX) {
      browserWindowSheetOffsetY = hostedFiniteNumber(offsetY, 0);
      browserWindowSheetOffsetX = hostedFiniteNumber(offsetX, 0);
      var payload = [browserWindowSheetOffsetY];
      if (arguments.length > 1) payload.push(browserWindowSheetOffsetX);
      _browserWindowAction.apply(null, [id, 'setSheetOffset'].concat(payload)).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setSheetOffset]', err);
      });
      return undefined;
    }
    function syncBrowserWindowShapeState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.minimized === 'boolean') browserWindowMinimized = record.minimized;
      if (typeof record.maximized === 'boolean') browserWindowMaximized = record.maximized;
      if (typeof record.fullScreen === 'boolean') browserWindowFullScreen = record.fullScreen;
      if (typeof record.fullscreen === 'boolean') browserWindowFullScreen = record.fullscreen;
      if (typeof record.kiosk === 'boolean') browserWindowKiosk = record.kiosk;
      return result;
    }
    function browserWindowShapeAction(action) {
      var payload = Array.prototype.slice.call(arguments, 1);
      return _browserWindowAction.apply(null, [id, action].concat(payload)).then(syncBrowserWindowShapeState);
    }
    function browserWindowIsNormal() {
      return !browserWindowMinimized && !browserWindowMaximized && !browserWindowFullScreen && !browserWindowKiosk;
    }
    function syncBrowserWindowDocumentParentState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.documentEdited === 'boolean') browserWindowDocumentEdited = record.documentEdited;
      if (typeof record.representedFilename === 'string') browserWindowRepresentedFilename = record.representedFilename;
      if (typeof record.modal === 'boolean') browserWindowModal = record.modal;
      if (Object.prototype.hasOwnProperty.call(record, 'parentWindowId')) {
        browserWindowParentId = typeof record.parentWindowId === 'string' && record.parentWindowId ? record.parentWindowId : null;
      }
      return result;
    }
    function browserWindowSetDocumentEdited(edited) {
      browserWindowDocumentEdited = edited === true;
      _browserWindowAction(id, 'setDocumentEdited', browserWindowDocumentEdited).then(syncBrowserWindowDocumentParentState).catch(function(err) {
        console.error('[browserWindow setDocumentEdited]', err);
      });
      return undefined;
    }
    function browserWindowSetRepresentedFilename(filename) {
      browserWindowRepresentedFilename = String(filename == null ? '' : filename);
      _browserWindowAction(id, 'setRepresentedFilename', browserWindowRepresentedFilename).then(syncBrowserWindowDocumentParentState).catch(function(err) {
        console.error('[browserWindow setRepresentedFilename]', err);
      });
      return undefined;
    }
    function hostedBrowserWindowParentId(parentWindow) {
      if (parentWindow == null) return null;
      if (parentWindow && typeof parentWindow === 'object' && typeof parentWindow.id === 'string' && parentWindow.id) return parentWindow.id;
      return null;
    }
    function browserWindowSetParentWindow(parentWindow) {
      browserWindowParentId = hostedBrowserWindowParentId(parentWindow);
      _browserWindowAction(id, 'setParentWindow', browserWindowParentId).then(syncBrowserWindowDocumentParentState).catch(function(err) {
        console.error('[browserWindow setParentWindow]', err);
      });
      return undefined;
    }
    function browserWindowGetParentWindow() {
      if (!browserWindowParentId) return null;
      return _browserWindowHandles[browserWindowParentId] || null;
    }
    function browserWindowGetChildWindows() {
      var children = [];
      Object.keys(_browserWindowHandles).forEach(function(key) {
        var childHandle = _browserWindowHandles[key];
        if (childHandle && typeof childHandle.__atoolsParentWindowId === 'function' && childHandle.__atoolsParentWindowId() === id) {
          children.push(childHandle);
        }
      });
      return children;
    }
    function webContentsNavigationAction(action) {
      webContentsLoading = true;
      var payload = Array.prototype.slice.call(arguments, 1);
      return _browserWindowAction.apply(null, [id, action].concat(payload)).then(function(result) {
        webContentsLoading = false;
        return syncWebContentsNavigationState(result, { push: action === 'loadURL' || action === 'webContents.loadURL' });
      }).catch(function(err) {
        webContentsLoading = false;
        throw err;
      });
    }
    function navigationHistoryOffset(value) {
      var offset = Number(value);
      return Number.isFinite(offset) ? Math.trunc(offset) : 0;
    }
    function navigationHistoryIndex(value) {
      var index = Number(value);
      return Number.isFinite(index) ? Math.trunc(index) : -1;
    }
    function navigationHistoryCanGoToOffset(value) {
      var targetIndex = webContentsHistoryIndex + navigationHistoryOffset(value);
      return targetIndex >= 0 && targetIndex < webContentsHistory.length && targetIndex !== webContentsHistoryIndex;
    }
    function navigationHistoryAction(action) {
      var payload = Array.prototype.slice.call(arguments, 1);
      _browserWindowAction.apply(null, [id, action].concat(payload)).then(syncWebContentsNavigationState).catch(function(err) {
        console.error('[browserWindow ' + action + ']', err);
      });
      return undefined;
    }
    function navigationHistoryClear() {
      if (webContentsUrl) {
        webContentsHistory = [webContentsUrl];
        webContentsHistoryIndex = 0;
      } else {
        webContentsHistory = [];
        webContentsHistoryIndex = -1;
      }
      _browserWindowAction(id, 'webContents.navigationHistory.clear').then(syncWebContentsNavigationState).catch(function(err) {
        console.error('[browserWindow webContents.navigationHistory.clear]', err);
      });
      return undefined;
    }
    function webContentsStop() {
      webContentsLoading = false;
      _browserWindowAction(id, 'webContents.stop').then(syncWebContentsNavigationState).catch(function(err) {
        console.error('[browserWindow webContents.stop]', err);
      });
      return undefined;
    }
    function syncWebContentsCrashState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.crashed === 'boolean') webContentsCrashed = record.crashed;
      return result;
    }
    function webContentsForcefullyCrashRenderer() {
      webContentsCrashed = true;
      _browserWindowAction(id, 'webContents.forcefullyCrashRenderer').then(syncWebContentsCrashState).catch(function(err) {
        console.error('[browserWindow webContents.forcefullyCrashRenderer]', err);
      });
      return undefined;
    }
    function syncWebContentsDevToolsState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.devToolsOpened === 'boolean') webContentsDevToolsOpened = record.devToolsOpened;
      if (typeof record.devToolsFocused === 'boolean') webContentsDevToolsFocused = record.devToolsFocused;
      if (typeof record.devToolsMode === 'string') webContentsDevToolsMode = record.devToolsMode;
      if (typeof record.devToolsTitle === 'string') webContentsDevToolsTitle = record.devToolsTitle;
      if (!webContentsDevToolsOpened) webContentsDevToolsFocused = false;
      return result;
    }
    function syncWebContentsDevToolsEvent(name, args) {
      var eventName = String(name || '');
      var firstArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
      if (firstArg && typeof firstArg === 'object') {
        syncWebContentsDevToolsState(firstArg);
        return;
      }
      if (eventName === 'devtools-opened') {
        webContentsDevToolsOpened = true;
        webContentsDevToolsFocused = true;
      }
      if (eventName === 'devtools-closed') {
        webContentsDevToolsOpened = false;
        webContentsDevToolsFocused = false;
      }
    }
    function webContentsDevToolsAction(action) {
      var payload = Array.prototype.slice.call(arguments, 1);
      return _browserWindowAction.apply(null, [id, action].concat(payload)).then(syncWebContentsDevToolsState);
    }
    function normalizeInspectCoordinate(value) {
      var numeric = Number(value);
      return Number.isFinite(numeric) ? Math.round(numeric) : 0;
    }
    function webContentsInspectElement(xValue, yValue) {
      normalizeInspectCoordinate(xValue);
      normalizeInspectCoordinate(yValue);
      throw _hostedBrowserWindowUnsupported('webContents.inspectElement');
    }
    function zoomLevelFromFactor(factor) {
      return Math.log(factor) / Math.log(1.2);
    }
    function zoomFactorFromLevel(level) {
      return Math.pow(1.2, level);
    }
    function normalizeZoomFactor(value) {
      var factor = Number(value);
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error('webContents.setZoomFactor requires a factor greater than 0');
      }
      return factor;
    }
    function normalizeZoomLevel(value) {
      var level = Number(value);
      if (!Number.isFinite(level)) {
        throw new Error('webContents.setZoomLevel requires a finite level');
      }
      return level;
    }
    function normalizeFrameRate(value) {
      var rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('webContents.setFrameRate requires a positive frame rate');
      }
      return Math.min(240, Math.max(1, Math.round(rate)));
    }
    function syncWebContentsRuntimeState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.userAgent === 'string') webContentsUserAgent = record.userAgent;
      if (typeof record.frameRate === 'number' && Number.isFinite(record.frameRate) && record.frameRate > 0) {
        webContentsFrameRate = normalizeFrameRate(record.frameRate);
      }
      if (typeof record.backgroundThrottling === 'boolean') {
        webContentsBackgroundThrottling = record.backgroundThrottling;
      }
      if (Number.isInteger(record.processId) && record.processId > 0) webContentsProcessId = record.processId;
      if (Number.isInteger(record.osProcessId) && record.osProcessId > 0) webContentsOSProcessId = record.osProcessId;
      return result;
    }
    function webContentsSetUserAgent(value) {
      var userAgent = String(value == null ? '' : value);
      webContentsUserAgent = userAgent;
      _browserWindowAction(id, 'webContents.setUserAgent', userAgent).then(syncWebContentsRuntimeState).catch(function(err) {
        console.error('[browserWindow webContents.setUserAgent]', err);
      });
      return undefined;
    }
    function webContentsSetFrameRate(value) {
      var frameRate = normalizeFrameRate(value);
      webContentsFrameRate = frameRate;
      _browserWindowAction(id, 'webContents.setFrameRate', frameRate).then(syncWebContentsRuntimeState).catch(function(err) {
        console.error('[browserWindow webContents.setFrameRate]', err);
      });
      return undefined;
    }
    function webContentsSetBackgroundThrottling(value) {
      var backgroundThrottling = value !== false;
      webContentsBackgroundThrottling = backgroundThrottling;
      _browserWindowAction(id, 'webContents.setBackgroundThrottling', backgroundThrottling).then(syncWebContentsRuntimeState).catch(function(err) {
        console.error('[browserWindow webContents.setBackgroundThrottling]', err);
      });
      return undefined;
    }
    function syncWebContentsZoomState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.zoomFactor === 'number' && Number.isFinite(record.zoomFactor) && record.zoomFactor > 0) {
        webContentsZoomFactor = record.zoomFactor;
      }
      if (typeof record.zoomLevel === 'number' && Number.isFinite(record.zoomLevel)) {
        webContentsZoomLevel = record.zoomLevel;
      }
      if (typeof record.minimumLevel === 'number' && Number.isFinite(record.minimumLevel)) {
        webContentsVisualZoomMinimumLevel = record.minimumLevel;
      }
      if (typeof record.maximumLevel === 'number' && Number.isFinite(record.maximumLevel)) {
        webContentsVisualZoomMaximumLevel = record.maximumLevel;
      }
      return result;
    }
    function syncWebContentsAudioState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.audioMuted === 'boolean') webContentsAudioMuted = record.audioMuted;
      if (typeof record.currentlyAudible === 'boolean') webContentsCurrentlyAudible = record.currentlyAudible;
      if (typeof record.audible === 'boolean') webContentsCurrentlyAudible = record.audible;
      if (webContentsAudioMuted) webContentsCurrentlyAudible = false;
      return result;
    }
    function syncWebContentsAudioEvent(name, args) {
      if (String(name || '') !== 'audio-state-changed') return;
      var firstArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
      var audible = typeof firstArg === 'boolean'
        ? firstArg
        : firstArg && typeof firstArg === 'object' && typeof firstArg.audible === 'boolean'
          ? firstArg.audible
          : null;
      if (typeof audible === 'boolean') webContentsCurrentlyAudible = audible && !webContentsAudioMuted;
    }
    function syncWebContentsCrashEvent(name) {
      if (String(name || '') === 'render-process-gone') webContentsCrashed = true;
    }
    function syncWebContentsFocusState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.webContentsFocused === 'boolean') webContentsFocused = record.webContentsFocused;
      else if (typeof record.focused === 'boolean') webContentsFocused = record.focused;
      return result;
    }
    function syncWebContentsShortcutState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.ignoreMenuShortcuts === 'boolean') webContentsIgnoreMenuShortcuts = record.ignoreMenuShortcuts;
      return result;
    }
    function syncWebContentsWindowEvent(name, args) {
      var eventName = String(name || '');
      var firstArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
      if (firstArg && typeof firstArg === 'object' && typeof firstArg.focused === 'boolean') {
        webContentsFocused = firstArg.focused;
      } else if (eventName === 'focus') {
        webContentsFocused = true;
      } else if (eventName === 'blur' || eventName === 'hide' || eventName === 'closed') {
        webContentsFocused = false;
      }
    }
    function browserWindowFocusAction(action) {
      return _browserWindowAction(id, action).then(syncWebContentsFocusState);
    }
    function webContentsFocus() {
      webContentsFocused = true;
      _browserWindowAction(id, 'webContents.focus').then(syncWebContentsFocusState).catch(function(err) {
        console.error('[browserWindow webContents.focus]', err);
      });
      return undefined;
    }
    function webContentsSetIgnoreMenuShortcuts(ignore) {
      var nextIgnore = ignore === true;
      webContentsIgnoreMenuShortcuts = nextIgnore;
      _browserWindowAction(id, 'webContents.setIgnoreMenuShortcuts', nextIgnore).then(syncWebContentsShortcutState).catch(function(err) {
        console.error('[browserWindow webContents.setIgnoreMenuShortcuts]', err);
      });
      return undefined;
    }
    function webContentsSetAudioMuted(mutedValue) {
      var muted = mutedValue === true;
      webContentsAudioMuted = muted;
      if (muted) webContentsCurrentlyAudible = false;
      _browserWindowAction(id, 'webContents.setAudioMuted', muted).then(syncWebContentsAudioState).catch(function(err) {
        console.error('[browserWindow webContents.setAudioMuted]', err);
      });
      return undefined;
    }
    function webContentsSetZoomFactor(factorValue) {
      var factor = normalizeZoomFactor(factorValue);
      webContentsZoomFactor = factor;
      webContentsZoomLevel = zoomLevelFromFactor(factor);
      _browserWindowAction(id, 'webContents.setZoomFactor', factor).then(syncWebContentsZoomState).catch(function(err) {
        console.error('[browserWindow webContents.setZoomFactor]', err);
      });
      return undefined;
    }
    function webContentsSetZoomLevel(levelValue) {
      var level = normalizeZoomLevel(levelValue);
      webContentsZoomLevel = level;
      webContentsZoomFactor = zoomFactorFromLevel(level);
      _browserWindowAction(id, 'webContents.setZoomLevel', level).then(syncWebContentsZoomState).catch(function(err) {
        console.error('[browserWindow webContents.setZoomLevel]', err);
      });
      return undefined;
    }
    function webContentsInsertText(text) {
      return _browserWindowAction(id, 'webContents.insertText', String(text == null ? '' : text)).then(function() {
        return undefined;
      });
    }
    function webContentsEditAction(action) {
      throw _hostedBrowserWindowUnsupported(action);
    }
    function hostedWebContentsBytes(result) {
      if (result instanceof ArrayBuffer) return new Uint8Array(result);
      if (typeof Uint8Array === 'function' && result instanceof Uint8Array) return result;
      var record = result && typeof result === 'object' ? result : {};
      var data = Array.isArray(record.data) ? record.data : Array.isArray(record.bytes) ? record.bytes : null;
      if (data) return typeof Uint8Array === 'function' ? new Uint8Array(data) : data.slice();
      var base64 = typeof record.base64 === 'string'
        ? record.base64
        : typeof record.dataUrl === 'string'
          ? (record.dataUrl.match(/^data:[^;]+;base64,(.*)$/) || [])[1]
          : '';
      if (base64 && typeof atob === 'function') {
        var binary = atob(base64);
        if (typeof Uint8Array !== 'function') return binary;
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }
      return result;
    }
    function hostedNativeImageFromResult(result) {
      var record = result && typeof result === 'object' ? result : {};
      var dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
      var width = Number(record.width || (record.size && record.size.width) || 0);
      var height = Number(record.height || (record.size && record.size.height) || 0);
      var size = {
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
      };
      return {
        toDataURL: function() { return dataUrl; },
        toPNG: function() { return hostedWebContentsBytes(record); },
        getSize: function() { return { width: size.width, height: size.height }; },
        getAspectRatio: function() { return size.height > 0 ? size.width / size.height : 0; },
        isEmpty: function() { return !dataUrl && !record.base64 && !record.data && !record.bytes; },
      };
    }
    function webContentsCapturePage(rect, opts) {
      var payload = [];
      if (arguments.length > 0) payload.push(rect || {});
      if (arguments.length > 1) payload.push(opts || {});
      return _browserWindowAction.apply(null, [id, 'webContents.capturePage'].concat(payload)).then(hostedNativeImageFromResult);
    }
    function webContentsPrint(options, callback) {
      var printOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      var done = typeof options === 'function' ? options : typeof callback === 'function' ? callback : null;
      _browserWindowAction(id, 'webContents.print', printOptions).then(function(result) {
        if (!done) return;
        var record = result && typeof result === 'object' ? result : {};
        var success = record.success === true;
        var failureReason = typeof record.failureReason === 'string' ? record.failureReason : '';
        done(success, failureReason);
      }).catch(function(err) {
        var message = err && err.message ? err.message : String(err);
        if (done) done(false, message);
        else console.error('[browserWindow webContents.print]', err);
      });
      return undefined;
    }
    function webContentsPrintToPDF(options) {
      var printOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return _browserWindowAction(id, 'webContents.printToPDF', printOptions).then(hostedWebContentsBytes);
    }
    function webContentsSavePage(fullPath, saveType) {
      return _browserWindowAction(
        id,
        'webContents.savePage',
        String(fullPath == null ? '' : fullPath),
        String(saveType == null ? '' : saveType)
      ).then(function() {
        return undefined;
      });
    }
    var navigationHistory = {
      canGoBack: function() { return webContentsHistoryIndex > 0; },
      canGoForward: function() { return webContentsHistoryIndex >= 0 && webContentsHistoryIndex < webContentsHistory.length - 1; },
      goBack: function() { return navigationHistoryAction('webContents.navigationHistory.goBack'); },
      goForward: function() { return navigationHistoryAction('webContents.navigationHistory.goForward'); },
      goToIndex: function(index) { return navigationHistoryAction('webContents.navigationHistory.goToIndex', navigationHistoryIndex(index)); },
      canGoToOffset: function(offset) { return navigationHistoryCanGoToOffset(offset); },
      goToOffset: function(offset) { return navigationHistoryAction('webContents.navigationHistory.goToOffset', navigationHistoryOffset(offset)); },
      clear: function() { return navigationHistoryClear(); },
    };
    var webContents = {
      navigationHistory: navigationHistory,
      getURL: function() { return webContentsUrl; },
      getTitle: function() { return webContentsTitle; },
      isLoading: function() { return webContentsLoading; },
      isLoadingMainFrame: function() { return webContentsLoading; },
      isWaitingForResponse: function() { return webContentsLoading; },
      canGoBack: function() { return webContentsHistoryIndex > 0; },
      canGoForward: function() { return webContentsHistoryIndex >= 0 && webContentsHistoryIndex < webContentsHistory.length - 1; },
      loadURL: function(url, options) { return webContentsNavigationAction('webContents.loadURL', String(url || ''), options || {}); },
      reload: function() { return webContentsNavigationAction('webContents.reload'); },
      goBack: function() { return webContentsNavigationAction('webContents.goBack'); },
      goForward: function() { return webContentsNavigationAction('webContents.goForward'); },
      reloadIgnoringCache: function() { return webContentsNavigationAction('webContents.reloadIgnoringCache'); },
      stop: function() { return webContentsStop(); },
      isDestroyed: function() { return destroyed; },
      getType: function() { return 'window'; },
      isCrashed: function() { return webContentsCrashed; },
      forcefullyCrashRenderer: function() { return webContentsForcefullyCrashRenderer(); },
      focus: function() { return webContentsFocus(); },
      isFocused: function() { return webContentsFocused; },
      getOwnerBrowserWindow: function() { return handle; },
      getMediaSourceId: function() { return webContentsMediaSourceId; },
      isBeingCaptured: function() { return webContentsBeingCaptured; },
      setIgnoreMenuShortcuts: function(ignore) { return webContentsSetIgnoreMenuShortcuts(ignore); },
      openDevTools: function(options) { return webContentsDevToolsAction('webContents.openDevTools', options || {}); },
      closeDevTools: function() { return webContentsDevToolsAction('webContents.closeDevTools'); },
      toggleDevTools: function() { return webContentsDevToolsAction('webContents.toggleDevTools'); },
      isDevToolsOpened: function() { return webContentsDevToolsOpened; },
      isDevToolsFocused: function() { return webContentsDevToolsOpened && webContentsDevToolsFocused; },
      inspectElement: function(x, y) { return webContentsInspectElement(x, y); },
      capturePage: function(rect, opts) { return webContentsCapturePage.apply(null, arguments); },
      print: function(options, callback) { return webContentsPrint(options, callback); },
      printToPDF: function(options) { return webContentsPrintToPDF(options); },
      savePage: function(fullPath, saveType) { return webContentsSavePage(fullPath, saveType); },
      getUserAgent: function() { return webContentsUserAgent; },
      setUserAgent: function(userAgent) { return webContentsSetUserAgent(userAgent); },
      getFrameRate: function() { return webContentsFrameRate; },
      setFrameRate: function(frameRate) { return webContentsSetFrameRate(frameRate); },
      getBackgroundThrottling: function() { return webContentsBackgroundThrottling; },
      setBackgroundThrottling: function(allowed) { return webContentsSetBackgroundThrottling(allowed); },
      getProcessId: function() { return webContentsProcessId; },
      getOSProcessId: function() { return webContentsOSProcessId; },
      centerSelection: function() { return webContentsEditAction('webContents.centerSelection'); },
      scrollToTop: function() { return webContentsEditAction('webContents.scrollToTop'); },
      scrollToBottom: function() { return webContentsEditAction('webContents.scrollToBottom'); },
      adjustSelection: function(options) {
        var selectionOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        return webContentsEditAction('webContents.adjustSelection', {
          start: Number(selectionOptions.start || 0),
          end: Number(selectionOptions.end || 0),
        });
      },
      insertText: function(text) { return webContentsInsertText(text); },
      undo: function() { return webContentsEditAction('webContents.undo'); },
      redo: function() { return webContentsEditAction('webContents.redo'); },
      cut: function() { return webContentsEditAction('webContents.cut'); },
      copy: function() { return webContentsEditAction('webContents.copy'); },
      paste: function() { return webContentsEditAction('webContents.paste'); },
      pasteAndMatchStyle: function() { return webContentsEditAction('webContents.pasteAndMatchStyle'); },
      delete: function() { return webContentsEditAction('webContents.delete'); },
      selectAll: function() { return webContentsEditAction('webContents.selectAll'); },
      unselect: function() { return webContentsEditAction('webContents.unselect'); },
      replace: function(text) { return webContentsEditAction('webContents.replace', String(text == null ? '' : text)); },
      replaceMisspelling: function(text) { return webContentsEditAction('webContents.replaceMisspelling', String(text == null ? '' : text)); },
      setZoomFactor: function(factor) { return webContentsSetZoomFactor(factor); },
      getZoomFactor: function() { return webContentsZoomFactor; },
      setZoomLevel: function(level) { return webContentsSetZoomLevel(level); },
      getZoomLevel: function() { return webContentsZoomLevel; },
      setVisualZoomLevelLimits: function(minimumLevel, maximumLevel) {
        return _browserWindowAction(id, 'webContents.setVisualZoomLevelLimits', Number(minimumLevel), Number(maximumLevel)).then(function(result) {
          syncWebContentsZoomState(result);
          return undefined;
        });
      },
      setAudioMuted: function(muted) { return webContentsSetAudioMuted(muted); },
      isAudioMuted: function() { return webContentsAudioMuted; },
      isCurrentlyAudible: function() { return webContentsCurrentlyAudible; },
      send: function(channel) {
        var payload = Array.prototype.slice.call(arguments);
        payload[0] = String(channel || '');
        return _browserWindowAction.apply(null, [id, 'webContents.send'].concat(payload));
      },
      executeJavaScript: function(code, userGesture) {
        return _browserWindowAction(id, 'webContents.executeJavaScript', String(code == null ? '' : code), userGesture === true);
      },
      sendInputEvent: function(inputEvent) {
        return _browserWindowAction(id, 'webContents.sendInputEvent', inputEvent || {});
      },
      insertCSS: function(css, options) {
        return _browserWindowAction(id, 'webContents.insertCSS', String(css == null ? '' : css), options || {});
      },
      removeInsertedCSS: function(key) {
        return _browserWindowAction(id, 'webContents.removeInsertedCSS', String(key || ''));
      },
      findInPage: function(text, options) {
        var requestId = ++webContentsFindReqId;
        _browserWindowAction(id, 'webContents.findInPage', String(text == null ? '' : text), options || {}, requestId).catch(function(err) {
          console.error('[browserWindow webContents.findInPage]', err);
        });
        return requestId;
      },
      stopFindInPage: function(action) {
        _browserWindowAction(id, 'webContents.stopFindInPage', String(action || 'clearSelection')).catch(function(err) {
          console.error('[browserWindow webContents.stopFindInPage]', err);
        });
        return undefined;
      },
      on: function(name, listener) { return addWebContentsListener(name, listener, false); },
      addListener: function(name, listener) { return addWebContentsListener(name, listener, false); },
      once: function(name, listener) { return addWebContentsListener(name, listener, true); },
      off: function(name, listener) { return removeWebContentsListener(name, listener); },
      removeListener: function(name, listener) { return removeWebContentsListener(name, listener); },
      removeAllListeners: function(name) { return removeAllWebContentsListeners(name); }
    };
    if (id) {
      _browserWindowEventDispatchers[id] = function(name, args, target) {
        if (target === 'webContents') {
          syncWebContentsDevToolsEvent(name, args);
          syncWebContentsAudioEvent(name, args);
          syncWebContentsCrashEvent(name);
          emitWebContentsEvent(name, args);
          return;
        }
        if (name === 'closed') {
          destroyed = true;
          delete _browserWindowCallbacks[id];
          delete _browserWindowHandles[id];
        }
        syncWebContentsWindowEvent(name, args);
        emitEvent(name, args);
        if (name === 'closed') {
          delete _browserWindowEventDispatchers[id];
        }
      };
    }
    var handle = {
      id: id,
      type: 'browserWindow',
      windowType: 'browserWindow',
      url: String(record.url || ''),
      title: String(record.title || ''),
      show: function() { return _browserWindowAction(id, 'show'); },
      hide: function() { return _browserWindowAction(id, 'hide'); },
      focus: function() { return browserWindowFocusAction('focus'); },
      isVisible: function() { return _browserWindowAction(id, 'isVisible'); },
      isFocused: function() { return _browserWindowAction(id, 'isFocused'); },
      showInactive: function() { return browserWindowFocusAction('showInactive'); },
      blur: function() { return browserWindowFocusAction('blur'); },
      getTitle: function() { return _browserWindowAction(id, 'getTitle'); },
      setTitle: function(title) { return _browserWindowAction(id, 'setTitle', String(title || '')); },
      getURL: function() { return _browserWindowAction(id, 'getURL'); },
      loadURL: function(url) { return webContentsNavigationAction('loadURL', String(url || '')); },
      reload: function() { return webContentsNavigationAction('reload'); },
      minimize: function() { return browserWindowShapeAction('minimize'); },
      isMinimized: function() { return _browserWindowAction(id, 'isMinimized'); },
      restore: function() { return browserWindowShapeAction('restore'); },
      maximize: function() { return browserWindowShapeAction('maximize'); },
      unmaximize: function() { return browserWindowShapeAction('unmaximize'); },
      isMaximized: function() { return _browserWindowAction(id, 'isMaximized'); },
      isAlwaysOnTop: function() { return _browserWindowAction(id, 'isAlwaysOnTop'); },
      setAlwaysOnTop: function(flag) { return _browserWindowAction(id, 'setAlwaysOnTop', flag === true); },
      getBackgroundColor: function() { return browserWindowBackgroundColor; },
      setBackgroundColor: function(backgroundColor) { return browserWindowSetBackgroundColor(backgroundColor); },
      setAutoHideMenuBar: function(hide) { return browserWindowSetAutoHideMenuBar(hide); },
      isMenuBarAutoHide: function() { return browserWindowMenuBarAutoHide; },
      setMenuBarVisibility: function(visible) { return browserWindowSetMenuBarVisibility(visible); },
      isMenuBarVisible: function() { return browserWindowMenuBarVisible; },
      removeMenu: function() { return browserWindowRemoveMenu(); },
      setMenu: function(menu) { return browserWindowSetMenu(menu); },
      setWindowButtonVisibility: function(visible) { return browserWindowSetWindowButtonVisibility(visible); },
      setWindowButtonPosition: function(position) { return browserWindowSetWindowButtonPosition(position); },
      getWindowButtonPosition: function() { return hostedWindowButtonPositionCopy(browserWindowButtonPosition); },
      setVibrancy: function(type, options) { return browserWindowSetVibrancy(type, options); },
      setBackgroundMaterial: function(material) { return browserWindowSetBackgroundMaterial(material); },
      setSheetOffset: function(offsetY, offsetX) { return browserWindowSetSheetOffset.apply(null, arguments); },
      isNormal: function() { return browserWindowIsNormal(); },
      isModal: function() { return browserWindowModal; },
      setDocumentEdited: function(edited) { return browserWindowSetDocumentEdited(edited); },
      isDocumentEdited: function() { return browserWindowDocumentEdited; },
      setRepresentedFilename: function(filename) { return browserWindowSetRepresentedFilename(filename); },
      getRepresentedFilename: function() { return browserWindowRepresentedFilename; },
      setParentWindow: function(parentWindow) { return browserWindowSetParentWindow(parentWindow); },
      getParentWindow: function() { return browserWindowGetParentWindow(); },
      getChildWindows: function() { return browserWindowGetChildWindows(); },
      getBounds: function() { return _browserWindowAction(id, 'getBounds'); },
      setBounds: function(bounds) { return _browserWindowAction(id, 'setBounds', bounds || {}); },
      getSize: function() { return _browserWindowAction(id, 'getSize'); },
      setSize: function(width, height) { return _browserWindowAction(id, 'setSize', width, height); },
      getContentSize: function() { return _browserWindowAction(id, 'getContentSize'); },
      setContentSize: function(width, height, animate) { return _browserWindowAction(id, 'setContentSize', width, height, animate === true); },
      getMinimumSize: function() { return _browserWindowAction(id, 'getMinimumSize'); },
      setMinimumSize: function(width, height) { return _browserWindowAction(id, 'setMinimumSize', width, height); },
      getMaximumSize: function() { return _browserWindowAction(id, 'getMaximumSize'); },
      setMaximumSize: function(width, height) { return _browserWindowAction(id, 'setMaximumSize', width, height); },
      setAspectRatio: function(aspectRatio, extraSize) { return _browserWindowAction(id, 'setAspectRatio', Number(aspectRatio), extraSize || {}); },
      getPosition: function() { return _browserWindowAction(id, 'getPosition'); },
      setPosition: function(x, y) { return _browserWindowAction(id, 'setPosition', x, y); },
      center: function() { return _browserWindowAction(id, 'center'); },
      isResizable: function() { return _browserWindowAction(id, 'isResizable'); },
      setResizable: function(flag) { return _browserWindowAction(id, 'setResizable', flag === true); },
      isMovable: function() { return _browserWindowAction(id, 'isMovable'); },
      setMovable: function(flag) { return _browserWindowAction(id, 'setMovable', flag === true); },
      isClosable: function() { return _browserWindowAction(id, 'isClosable'); },
      setClosable: function(flag) { return _browserWindowAction(id, 'setClosable', flag === true); },
      isMinimizable: function() { return _browserWindowAction(id, 'isMinimizable'); },
      setMinimizable: function(flag) { return _browserWindowAction(id, 'setMinimizable', flag === true); },
      isMaximizable: function() { return _browserWindowAction(id, 'isMaximizable'); },
      setMaximizable: function(flag) { return _browserWindowAction(id, 'setMaximizable', flag === true); },
      isFullScreen: function() { return _browserWindowAction(id, 'isFullScreen'); },
      setFullScreen: function(flag) { return browserWindowShapeAction('setFullScreen', flag === true); },
      isFullScreenable: function() { return _browserWindowAction(id, 'isFullScreenable'); },
      setFullScreenable: function(flag) { return _browserWindowAction(id, 'setFullScreenable', flag === true); },
      getOpacity: function() { return _browserWindowAction(id, 'getOpacity'); },
      setOpacity: function(opacity) { return _browserWindowAction(id, 'setOpacity', Number(opacity)); },
      hasShadow: function() { return _browserWindowAction(id, 'hasShadow'); },
      setHasShadow: function(flag) { return _browserWindowAction(id, 'setHasShadow', flag === true); },
      invalidateShadow: function() { return _browserWindowAction(id, 'invalidateShadow'); },
      setSkipTaskbar: function(flag) { return _browserWindowAction(id, 'setSkipTaskbar', flag === true); },
      setKiosk: function(flag) { return browserWindowShapeAction('setKiosk', flag === true); },
      isKiosk: function() { return _browserWindowAction(id, 'isKiosk'); },
      setVisibleOnAllWorkspaces: function(flag, options) { return _browserWindowAction(id, 'setVisibleOnAllWorkspaces', flag === true, options || {}); },
      isVisibleOnAllWorkspaces: function() { return _browserWindowAction(id, 'isVisibleOnAllWorkspaces'); },
      setContentProtection: function(flag) { return _browserWindowAction(id, 'setContentProtection', flag === true); },
      isContentProtected: function() { return _browserWindowAction(id, 'isContentProtected'); },
      setFocusable: function(flag) { return _browserWindowAction(id, 'setFocusable', flag === true); },
      isFocusable: function() { return _browserWindowAction(id, 'isFocusable'); },
      flashFrame: function(flag) { return _browserWindowAction(id, 'flashFrame', flag === true); },
      setProgressBar: function(progress, options) { return _browserWindowAction(id, 'setProgressBar', Number(progress), options || {}); },
      getMediaSourceId: function() { return _browserWindowAction(id, 'getMediaSourceId'); },
      moveTop: function() { return _browserWindowAction(id, 'moveTop'); },
      moveAbove: function(mediaSourceId) { return _browserWindowAction(id, 'moveAbove', String(mediaSourceId || '')); },
      on: function(name, listener) { return addEventListener(name, listener, false); },
      addListener: function(name, listener) { return addEventListener(name, listener, false); },
      once: function(name, listener) { return addEventListener(name, listener, true); },
      off: function(name, listener) { return removeListener(name, listener); },
      removeListener: function(name, listener) { return removeListener(name, listener); },
      removeAllListeners: function(name) { return removeAllListeners(name); },
      close: function() {
        return _browserWindowAction(id, 'close').then(function(actionResult) {
          destroyed = true;
          delete _browserWindowCallbacks[id];
          delete _browserWindowEventDispatchers[id];
          delete _browserWindowHandles[id];
          return actionResult;
        });
      },
      isDestroyed: function() { return destroyed; }
    };
    Object.defineProperty(handle, '__atoolsParentWindowId', {
      enumerable: false,
      configurable: true,
      value: function() { return browserWindowParentId; }
    });
    Object.defineProperty(handle, 'webContents', {
      enumerable: false,
      configurable: true,
      value: webContents
    });
    if (id) _browserWindowHandles[id] = handle;
    return handle;
  }
  function _hasRuntimeUrlProtocol(value) {
    if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.indexOf('//') === 0;
  }
  function _isRuntimeLocalResourceUrl(value) {
    var trimmed = String(value || '').trim();
    if (!trimmed || trimmed.charAt(0) === '#') return false;
    if (trimmed.indexOf('asset(') === 0) return false;
    if (_hasRuntimeUrlProtocol(trimmed)) return false;
    return true;
  }
  function _runtimeResourceBaseDir() {
    try {
      if (!document || typeof document.querySelector !== 'function') return '';
      var base = document.querySelector('base[href]');
      if (!base || typeof base.getAttribute !== 'function') return '';
      var href = base.getAttribute('href') || '';
      if (_isRuntimeLocalResourceUrl(href)) return href;
      var marker = base.getAttribute('data-atools-plugin-base-href') || '';
      return _isRuntimeLocalResourceUrl(marker) ? marker : '';
    } catch (err) {
      return '';
    }
  }
  function _resolvePluginResource(url, baseDir) {
    var raw = String(url || '').trim();
    if (!_isRuntimeLocalResourceUrl(raw)) return Promise.resolve(url);
    var resolvedBaseDir = baseDir || _runtimeResourceBaseDir();
    return new Promise(function(resolve, reject) {
      var id = ++_resourceReqId;
      _resourcePending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        __atools_resource_resolve__: true,
        reqId: id,
        url: raw,
        baseDir: resolvedBaseDir || ''
      }, '*');
    });
  }
  window.__atools_resolve_plugin_resource__ = _resolvePluginResource;
  function _runtimeResourceMarker(attr) {
    return 'data-atools-resource-resolved-' + String(attr || '').toLowerCase();
  }
  function _isRuntimeElement(node) {
    return node
      && node.nodeType === 1
      && typeof node.getAttribute === 'function'
      && typeof node.setAttribute === 'function';
  }
  function _runtimeResourceAttrsForElement(element) {
    var tagName = String(element.tagName || '').toLowerCase();
    var attrs = [];
    if (tagName === 'link') attrs.push('href');
    if (tagName === 'object') attrs.push('data');
    if (typeof element.getAttribute === 'function' && element.getAttribute('style') != null) attrs.push('style');
    if (tagName === 'img' || tagName === 'source') attrs.push('srcset');
    if (tagName === 'img' || tagName === 'source' || tagName === 'video' || tagName === 'audio' || tagName === 'track' || tagName === 'iframe' || tagName === 'embed' || tagName === 'script') attrs.push('src');
    if (tagName === 'img' || tagName === 'video') attrs.push('poster');
    return attrs;
  }
  function _splitRuntimeSrcset(value) {
    var candidates = [];
    var current = '';
    for (var index = 0; index < value.length; index += 1) {
      var char = value.charAt(index);
      if (char === ',' && _isRuntimeSrcsetSeparator(current)) {
        candidates.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    if (current || candidates.length === 0) candidates.push(current);
    return candidates;
  }
  function _isRuntimeSrcsetSeparator(current) {
    var trimmed = current.trim();
    if (!trimmed) return true;
    return trimmed.toLowerCase().indexOf('data:') !== 0 || _firstRuntimeWhitespaceIndex(trimmed) >= 0;
  }
  function _firstRuntimeWhitespaceIndex(value) {
    for (var index = 0; index < value.length; index += 1) {
      if (_isRuntimeWhitespaceCode(value.charCodeAt(index))) return index;
    }
    return -1;
  }
  function _isRuntimeWhitespaceCode(code) {
    return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
  }
  function _skipRuntimeWhitespace(value, index) {
    var cursor = index;
    while (cursor < value.length && _isRuntimeWhitespaceCode(value.charCodeAt(cursor))) {
      cursor += 1;
    }
    return cursor;
  }
  function _findRuntimeCssQuoteEnd(value, index, quote) {
    for (var cursor = index; cursor < value.length; cursor += 1) {
      if (value.charAt(cursor) === quote) return cursor;
    }
    return -1;
  }
  function _findRuntimeCssClosingParen(value, index) {
    var quote = '';
    for (var cursor = index; cursor < value.length; cursor += 1) {
      var char = value.charAt(cursor);
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ')') return cursor;
    }
    return -1;
  }
  function _runtimeCssUrlToken(value, index) {
    if (value.slice(index, index + 4).toLowerCase() !== 'url(') return null;
    var contentStart = _skipRuntimeWhitespace(value, index + 4);
    if (contentStart >= value.length) return null;
    var first = value.charAt(contentStart);
    var contentEnd;
    var closeParen;
    if (first === '"' || first === "'") {
      contentEnd = _findRuntimeCssQuoteEnd(value, contentStart + 1, first);
      if (contentEnd < 0) return null;
      closeParen = _skipRuntimeWhitespace(value, contentEnd + 1);
      if (value.charAt(closeParen) !== ')') return null;
      return {
        start: index,
        end: closeParen + 1,
        url: value.slice(contentStart + 1, contentEnd),
        kind: 'url'
      };
    }
    closeParen = _findRuntimeCssClosingParen(value, contentStart);
    if (closeParen < 0) return null;
    return {
      start: index,
      end: closeParen + 1,
      url: value.slice(contentStart, closeParen).trim(),
      kind: 'url'
    };
  }
  function _collectRuntimeCssUrlTokens(value) {
    var tokens = [];
    var index = 0;
    while (index < value.length) {
      var token = _runtimeCssUrlToken(value, index);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
      index += 1;
    }
    return tokens;
  }
  function _runtimeCssImportToken(value, index) {
    if (value.slice(index, index + 7).toLowerCase() !== '@import') return null;
    var cursor = _skipRuntimeWhitespace(value, index + 7);
    var quote = value.charAt(cursor);
    if (quote !== '"' && quote !== "'") return null;
    var endQuote = _findRuntimeCssQuoteEnd(value, cursor + 1, quote);
    if (endQuote < 0) return null;
    return {
      start: cursor,
      end: endQuote + 1,
      url: value.slice(cursor + 1, endQuote),
      kind: 'import'
    };
  }
  function _collectRuntimeCssImportTokens(value) {
    var tokens = [];
    var index = 0;
    while (index < value.length) {
      var token = _runtimeCssImportToken(value, index);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
      index += 1;
    }
    return tokens;
  }
  function _runtimeCssTokens(value) {
    var tokens = _collectRuntimeCssImportTokens(value).concat(_collectRuntimeCssUrlTokens(value));
    tokens.sort(function(a, b) {
      return a.start - b.start;
    });
    var filtered = [];
    var lastEnd = -1;
    tokens.forEach(function(token) {
      if (token.start < lastEnd) return;
      filtered.push(token);
      lastEnd = token.end;
    });
    return filtered;
  }
  function _escapeRuntimeCssUrl(value) {
    return String(value || '').replace(/"/g, '%22');
  }
  function _runtimeCssReplacement(token, converted) {
    var safe = _escapeRuntimeCssUrl(converted);
    if (token.kind === 'import') return '"' + safe + '"';
    return 'url("' + safe + '")';
  }
  function _rewriteRuntimeCss(value) {
    var css = String(value || '');
    var tokens = _runtimeCssTokens(css);
    if (!tokens.length) return Promise.resolve(css);
    return Promise.all(tokens.map(function(token) {
      return _resolvePluginResource(token.url);
    })).then(function(convertedValues) {
      var output = '';
      var lastIndex = 0;
      tokens.forEach(function(token, index) {
        var converted = convertedValues[index];
        output += css.slice(lastIndex, token.start);
        output += converted === token.url
          ? css.slice(token.start, token.end)
          : _runtimeCssReplacement(token, converted);
        lastIndex = token.end;
      });
      return output + css.slice(lastIndex);
    });
  }
  function _rewriteRuntimeResourceAttrValue(attr, raw) {
    return attr === 'srcset'
      ? _rewriteRuntimeSrcset(raw)
      : attr === 'style'
        ? _rewriteRuntimeCss(raw)
        : _resolvePluginResource(raw);
  }
  function _rewriteRuntimeSrcsetCandidate(candidate) {
    var trimmed = String(candidate || '').trim();
    if (!trimmed) return Promise.resolve(trimmed);
    var descriptorIndex = _firstRuntimeWhitespaceIndex(trimmed);
    var url = descriptorIndex >= 0 ? trimmed.slice(0, descriptorIndex) : trimmed;
    var descriptor = descriptorIndex >= 0 ? trimmed.slice(descriptorIndex) : '';
    return _resolvePluginResource(url).then(function(converted) {
      return String(converted) + descriptor;
    });
  }
  function _rewriteRuntimeSrcset(value) {
    return Promise.all(_splitRuntimeSrcset(String(value || '')).map(_rewriteRuntimeSrcsetCandidate))
      .then(function(candidates) {
        return candidates.join(', ');
      });
  }
  function _resolveRuntimeResourceAttr(element, attr) {
    var raw = element.getAttribute(attr);
    if (!raw) return;
    var marker = _runtimeResourceMarker(attr);
    if (element.getAttribute(marker) === raw) return;
    element.setAttribute(marker, raw);
    var task = _rewriteRuntimeResourceAttrValue(attr, raw);
    task.then(function(converted) {
      if (!converted || converted === raw) return;
      if (element.getAttribute(attr) === raw) {
        element.setAttribute(attr, converted);
        element.setAttribute(marker, converted);
      }
    }).catch(function(err) {
      console.warn('[atools runtime resource]', err);
    });
  }
  function _resolveRuntimeStyleElement(element) {
    if (!_isRuntimeElement(element)) return;
    if (String(element.tagName || '').toLowerCase() !== 'style') return;
    var raw = typeof element.textContent === 'string' ? element.textContent : '';
    if (!raw) return;
    var marker = 'data-atools-resource-resolved-css';
    if (element.getAttribute(marker) === raw) return;
    element.setAttribute(marker, raw);
    _rewriteRuntimeCss(raw).then(function(converted) {
      if (!converted || converted === raw) return;
      if (element.textContent === raw) {
        element.textContent = converted;
        element.setAttribute(marker, converted);
      }
    }).catch(function(err) {
      console.warn('[atools runtime css resource]', err);
    });
  }
  function _replaceRuntimeInsertedCssRule(sheet, index, convertedRule, originalInsertRule, originalDeleteRule) {
    var targetIndex = Number(index);
    if (!Number.isFinite(targetIndex)) targetIndex = 0;
    try {
      if (typeof originalDeleteRule === 'function') {
        originalDeleteRule.call(sheet, targetIndex);
        originalInsertRule.call(sheet, convertedRule, targetIndex);
        return;
      }
    } catch (err) {}
    try {
      originalInsertRule.call(sheet, convertedRule, targetIndex);
    } catch (err) {}
  }
  function _installRuntimeCssStyleSheetPatch() {
    var CssStyleSheetCtor = null;
    try {
      CssStyleSheetCtor = window.CSSStyleSheet || (typeof CSSStyleSheet === 'function' ? CSSStyleSheet : null);
    } catch (err) {}
    if (!CssStyleSheetCtor || !CssStyleSheetCtor.prototype) return;
    var proto = CssStyleSheetCtor.prototype;
    if (proto.__atoolsResourceInsertRulePatched || typeof proto.insertRule !== 'function') return;
    var originalInsertRule = proto.insertRule;
    var originalDeleteRule = proto.deleteRule;
    proto.insertRule = function(rule, index) {
      var sheet = this;
      var rawRule = String(rule || '');
      var insertedIndex = originalInsertRule.apply(sheet, arguments);
      var targetIndex = typeof insertedIndex === 'number'
        ? insertedIndex
        : typeof index === 'number'
          ? index
          : 0;
      _rewriteRuntimeCss(rawRule).then(function(convertedRule) {
        if (!convertedRule || convertedRule === rawRule) return;
        _replaceRuntimeInsertedCssRule(sheet, targetIndex, convertedRule, originalInsertRule, originalDeleteRule);
      }).catch(function(err) {
        console.warn('[atools runtime css insertRule]', err);
      });
      return insertedIndex;
    };
    try {
      Object.defineProperty(proto, '__atoolsResourceInsertRulePatched', { value: true });
    } catch (err) {
      proto.__atoolsResourceInsertRulePatched = true;
    }
  }
  function _preinsertResourceAttrsForElement(element) {
    if (!_isRuntimeElement(element)) return [];
    var tagName = String(element.tagName || '').toLowerCase();
    if (tagName === 'script' && _isRuntimeLocalResourceUrl(element.getAttribute('src') || '')) return ['src'];
    if (tagName === 'link' && _isRuntimeLocalResourceUrl(element.getAttribute('href') || '')) return ['href'];
    return [];
  }
  function _preflightRuntimeElementResources(element) {
    var attrs = _preinsertResourceAttrsForElement(element);
    if (!attrs.length) return Promise.resolve(false);
    return Promise.all(attrs.map(function(attr) {
      var raw = element.getAttribute(attr);
      if (!raw) return Promise.resolve(false);
      return _rewriteRuntimeResourceAttrValue(attr, raw).then(function(converted) {
        if (!converted || converted === raw) return false;
        if (element.getAttribute(attr) === raw) {
          element.setAttribute(attr, converted);
          element.setAttribute(_runtimeResourceMarker(attr), converted);
          return true;
        }
        return false;
      });
    })).then(function(results) {
      return results.some(Boolean);
    });
  }
  function _runtimeInsertionItemsHavePreinsertResources(items) {
    return items.some(function(item) {
      return _preinsertResourceAttrsForElement(item).length > 0;
    });
  }
  function _preflightRuntimeInsertionItems(items) {
    var elements = items.filter(function(item) {
      return _preinsertResourceAttrsForElement(item).length > 0;
    });
    if (!elements.length) return Promise.resolve(false);
    return Promise.all(elements.map(_preflightRuntimeElementResources)).then(function(results) {
      return results.some(Boolean);
    });
  }
  function _installRuntimeVariadicPreinsertResourcePatch(proto, methodName) {
    if (!proto) return;
    var originalMethod = proto[methodName];
    if (typeof originalMethod !== 'function') return;
    var marker = '__atoolsResourcePreinsertPatched_' + methodName;
    if (proto[marker]) return;
    proto[methodName] = function() {
      var target = this;
      var args = Array.prototype.slice.call(arguments);
      if (!_runtimeInsertionItemsHavePreinsertResources(args)) {
        return originalMethod.apply(target, arguments);
      }
      _preflightRuntimeInsertionItems(args).then(function() {
        originalMethod.apply(target, args);
      }).catch(function(err) {
        console.warn('[atools runtime preinsert ' + methodName + ']', err);
        originalMethod.apply(target, args);
      });
      return undefined;
    };
    try {
      Object.defineProperty(proto, marker, { value: true });
    } catch (err) {
      proto[marker] = true;
    }
  }
  function _installRuntimePreinsertResourcePatch() {
    var NodeCtor = null;
    try {
      NodeCtor = window.Node || (typeof Node === 'function' ? Node : null);
    } catch (err) {}
    if (!NodeCtor || !NodeCtor.prototype) return;
    var proto = NodeCtor.prototype;
    if (proto.__atoolsResourcePreinsertPatched) return;
    var originalAppendChild = proto.appendChild;
    var originalInsertBefore = proto.insertBefore;
    if (typeof originalAppendChild === 'function') {
      proto.appendChild = function(child) {
        var parent = this;
        if (!_preinsertResourceAttrsForElement(child).length) {
          return originalAppendChild.call(parent, child);
        }
        _preflightRuntimeElementResources(child).then(function() {
          originalAppendChild.call(parent, child);
        }).catch(function(err) {
          console.warn('[atools runtime preinsert appendChild]', err);
          originalAppendChild.call(parent, child);
        });
        return child;
      };
    }
    if (typeof originalInsertBefore === 'function') {
      proto.insertBefore = function(child, before) {
        var parent = this;
        if (!_preinsertResourceAttrsForElement(child).length) {
          return originalInsertBefore.call(parent, child, before);
        }
        _preflightRuntimeElementResources(child).then(function() {
          originalInsertBefore.call(parent, child, before);
        }).catch(function(err) {
          console.warn('[atools runtime preinsert insertBefore]', err);
          originalInsertBefore.call(parent, child, before);
        });
        return child;
      };
    }
    try {
      Object.defineProperty(proto, '__atoolsResourcePreinsertPatched', { value: true });
    } catch (err) {
      proto.__atoolsResourcePreinsertPatched = true;
    }
    var ElementCtor = null;
    var DocumentCtor = null;
    var FragmentCtor = null;
    try {
      ElementCtor = window.Element || (typeof Element === 'function' ? Element : null);
    } catch (err) {}
    try {
      DocumentCtor = window.Document || (typeof Document === 'function' ? Document : null);
    } catch (err) {}
    try {
      FragmentCtor = window.DocumentFragment || (typeof DocumentFragment === 'function' ? DocumentFragment : null);
    } catch (err) {}
    [ElementCtor, DocumentCtor, FragmentCtor].forEach(function(Ctor) {
      if (!Ctor || !Ctor.prototype) return;
      ['append', 'prepend', 'before', 'after', 'replaceWith'].forEach(function(methodName) {
        _installRuntimeVariadicPreinsertResourcePatch(Ctor.prototype, methodName);
      });
    });
  }
  function _rewriteRuntimeElementResources(element) {
    if (!_isRuntimeElement(element)) return;
    _runtimeResourceAttrsForElement(element).forEach(function(attr) {
      _resolveRuntimeResourceAttr(element, attr);
    });
    _resolveRuntimeStyleElement(element);
  }
  function _scanRuntimeResources(root) {
    var selector = 'img[src],img[srcset],source[src],source[srcset],video[src],video[poster],audio[src],track[src],iframe[src],embed[src],object[data],script[src],link[href],style,[style]';
    if (_isRuntimeElement(root)) _rewriteRuntimeElementResources(root);
    if (!root || typeof root.querySelectorAll !== 'function') return;
    Array.prototype.slice.call(root.querySelectorAll(selector)).forEach(_rewriteRuntimeElementResources);
  }
  function _installRuntimeResourceObserver() {
    _scanRuntimeResources(document);
    if (typeof MutationObserver !== 'function') return;
    var observerRoot = document.documentElement || document.body || document;
    if (!observerRoot) return;
    var observer = new MutationObserver(function(mutations) {
      Array.prototype.slice.call(mutations || []).forEach(function(mutation) {
        if (mutation.type === 'attributes') {
          _rewriteRuntimeElementResources(mutation.target);
          return;
        }
        if (mutation.type === 'characterData') {
          _resolveRuntimeStyleElement(mutation.target && mutation.target.parentNode);
          return;
        }
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(_scanRuntimeResources);
      });
    });
    var observerOptions = {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['src', 'poster', 'srcset', 'href', 'data', 'style']
    };
    try {
      observer.observe(observerRoot, observerOptions);
    } catch (err) {
      var fallbackRoot = document.body && document.body !== observerRoot ? document.body : null;
      if (!fallbackRoot) return;
      try {
        observer.observe(fallbackRoot, observerOptions);
      } catch (fallbackErr) {}
    }
  }
  function _copiedFileName(path) {
    var raw = String(path || '');
    var trimmed = raw.replace(/[\\/]+$/, '');
    var parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
  }
  function _normalizeCopiedFileEntry(entry) {
    var record = entry && typeof entry === 'object' ? entry : {};
    var path = typeof entry === 'string'
      ? entry
      : (typeof record.path === 'string' ? record.path : (typeof record.name === 'string' ? record.name : ''));
    var isDiractory = typeof record.isDiractory === 'boolean' ? record.isDiractory : /[\\/]$/.test(path);
    var isFile = typeof record.isFile === 'boolean' ? record.isFile : !isDiractory;
    return Object.assign({}, record, {
      path: path,
      name: typeof record.name === 'string' && record.name ? record.name : _copiedFileName(path),
      isFile: isFile,
      isDiractory: isDiractory
    });
  }
  function _normalizeCopiedFiles(files) {
    if (!Array.isArray(files)) return [];
    return files.map(_normalizeCopiedFileEntry).filter(function(file) {
      return Boolean(file.path);
    });
  }

  function _attachmentKey(docId, name) {
    return '__attachment__:' + String(docId) + ':' + String(name || 'attachment');
  }

  function _putAttachment(args) {
    var docId = args[0];
    var name = 'attachment';
    var data;
    var contentType;

    if (args.length >= 5) {
      name = args[2];
      data = args[3];
      contentType = args[4];
    } else if (args.length >= 4) {
      name = args[1];
      data = args[2];
      contentType = args[3];
    } else {
      data = args[1];
      contentType = args[2];
    }

    if (!docId) return Promise.reject(new Error('postAttachment missing document id'));
    if (data == null) return Promise.reject(new Error('postAttachment missing data'));

    return _invokeFn("put_plugin_data", {
      pluginId: __PLUGIN_ID__,
      doc: {
        _id: _attachmentKey(docId, name),
        docId: String(docId),
        name: String(name || 'attachment'),
        data: String(data),
        contentType: contentType || 'application/octet-stream'
      }
    }).then(function() {
      return { ok: true, id: String(docId), name: String(name || 'attachment') };
    });
  }

  function _getAttachment(args) {
    var docId = args[0];
    var name = args.length >= 2 ? args[1] : 'attachment';
    if (!docId) return Promise.reject(new Error('getAttachment missing document id'));

    return _invokeFn("get_plugin_data_item", {
      pluginId: __PLUGIN_ID__,
      docId: _attachmentKey(docId, name)
    }).then(function(doc) {
      return doc ? doc.data : null;
    });
  }

  function _getAttachmentType(args) {
    var docId = args[0];
    var name = args.length >= 2 ? args[1] : 'attachment';
    if (!docId) return Promise.reject(new Error('getAttachmentType missing document id'));

    return _invokeFn("get_plugin_data_item", {
      pluginId: __PLUGIN_ID__,
      docId: _attachmentKey(docId, name)
    }).then(function(doc) {
      return doc ? (doc.contentType || 'application/octet-stream') : null;
    });
  }

  var _dbStorageMemory = {};
  function _dbStorageKey(key) {
    return 'atools:dbStorage:' + __PLUGIN_ID__ + ':' + String(key);
  }
  function _dbStorageSetRaw(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return;
    } catch (err) {}
    _dbStorageMemory[key] = value;
  }
  function _dbStorageGetRaw(key) {
    try {
      var stored = window.localStorage.getItem(key);
      if (stored != null) return stored;
    } catch (err) {}
    return Object.prototype.hasOwnProperty.call(_dbStorageMemory, key) ? _dbStorageMemory[key] : null;
  }
  function _dbStorageRemoveRaw(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {}
    delete _dbStorageMemory[key];
  }
  function _dbStorageEncode(value) {
    return JSON.stringify({ value: value });
  }
  function _dbStorageDecode(value) {
    if (value == null) return null;
    try {
      var parsed = JSON.parse(value);
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'value')) return parsed.value;
      return parsed;
    } catch (err) {
      return value;
    }
  }
  function _createDbStorage() {
    return {
      setItem: function(key, value) {
        _dbStorageSetRaw(_dbStorageKey(key), _dbStorageEncode(value));
      },
      getItem: function(key) {
        return _dbStorageDecode(_dbStorageGetRaw(_dbStorageKey(key)));
      },
      removeItem: function(key) {
        _dbStorageRemoveRaw(_dbStorageKey(key));
      }
    };
  }

  var _nativeIdMemory = '';
  function _randomNativeId() {
    return 'atools-native-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function _getNativeId() {
    if (_nativeIdMemory) return _nativeIdMemory;
    try {
      var stored = window.localStorage.getItem('atools:nativeId');
      if (stored) {
        _nativeIdMemory = stored;
        return _nativeIdMemory;
      }
      _nativeIdMemory = _randomNativeId();
      window.localStorage.setItem('atools:nativeId', _nativeIdMemory);
      return _nativeIdMemory;
    } catch (err) {
      _nativeIdMemory = _nativeIdMemory || _randomNativeId();
      return _nativeIdMemory;
    }
  }

  var _lastCursorScreenPoint = { x: 0, y: 0 };
  window.addEventListener('mousemove', function(e) {
    var x = Number(e && e.screenX);
    var y = Number(e && e.screenY);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      _lastCursorScreenPoint = { x: x, y: y };
    }
  });
  function _screenNumber(value, fallback) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  function _screenScaleFactor() {
    var scale = _screenNumber(window.devicePixelRatio, 1);
    return scale > 0 ? scale : 1;
  }
  function _normalizePoint(point) {
    point = point || {};
    return {
      x: _screenNumber(point.x, 0),
      y: _screenNumber(point.y, 0)
    };
  }
  function _normalizeRect(rect) {
    rect = rect || {};
    return {
      x: _screenNumber(rect.x, 0),
      y: _screenNumber(rect.y, 0),
      width: _screenNumber(rect.width, 0),
      height: _screenNumber(rect.height, 0)
    };
  }
  function _createDisplaySnapshot() {
    var screenInfo = window.screen || {};
    var width = _screenNumber(screenInfo.width, _screenNumber(window.innerWidth, 0));
    var height = _screenNumber(screenInfo.height, _screenNumber(window.innerHeight, 0));
    var workX = _screenNumber(screenInfo.availLeft, 0);
    var workY = _screenNumber(screenInfo.availTop, 0);
    var workWidth = _screenNumber(screenInfo.availWidth, width);
    var workHeight = _screenNumber(screenInfo.availHeight, height);
    return {
      id: 1,
      label: 'Primary Display',
      bounds: { x: 0, y: 0, width: width, height: height },
      workArea: { x: workX, y: workY, width: workWidth, height: workHeight },
      size: { width: width, height: height },
      workAreaSize: { width: workWidth, height: workHeight },
      scaleFactor: _screenScaleFactor(),
      rotation: 0,
      touchSupport: 'unknown',
      monochrome: false,
      colorDepth: _screenNumber(screenInfo.colorDepth, 24),
      colorSpace: 'unknown',
      depthPerComponent: 0,
      displayFrequency: 0,
      internal: false,
      accelerometerSupport: 'unknown'
    };
  }
  function _screenToDipPoint(point) {
    var normalized = _normalizePoint(point);
    var scale = _screenScaleFactor();
    return { x: normalized.x / scale, y: normalized.y / scale };
  }
  function _dipToScreenPoint(point) {
    var normalized = _normalizePoint(point);
    var scale = _screenScaleFactor();
    return { x: normalized.x * scale, y: normalized.y * scale };
  }
  function _screenToDipRect(rect) {
    var normalized = _normalizeRect(rect);
    var scale = _screenScaleFactor();
    return {
      x: normalized.x / scale,
      y: normalized.y / scale,
      width: normalized.width / scale,
      height: normalized.height / scale
    };
  }
  function _dipToScreenRect(rect) {
    var normalized = _normalizeRect(rect);
    var scale = _screenScaleFactor();
    return {
      x: normalized.x * scale,
      y: normalized.y * scale,
      width: normalized.width * scale,
      height: normalized.height * scale
    };
  }

  // utools/ztools API bridge
  var _dbListeners = { change: [], docs: [] };
  var _mainPushCallback = null;
  var _mainPushSelectCallback = null;
  function _eventDetail(event) {
    return event && event.detail && typeof event.detail === 'object' ? event.detail : {};
  }
  function _pluginEnterAction(detail) {
    detail = detail || {};
    var payload = Object.prototype.hasOwnProperty.call(detail, 'payload') ? detail.payload : __ACTION_PAYLOAD__;
    var action = {
      code: detail.code || __FEATURE_CODE__,
      type: detail.type || 'text',
      payload: payload,
      from: detail.from || 'main'
    };
    if (Object.prototype.hasOwnProperty.call(detail, 'option')) action.option = detail.option;
    return action;
  }
  function _emitMainPush(action, reqId) {
    if (typeof _mainPushCallback !== 'function') return;
    var results = [];
    try {
      var returned = _mainPushCallback(action || _pluginEnterAction({}));
      results = Array.isArray(returned) ? returned : [];
    } catch (err) {
      console.error('[onMainPush]', err);
    }
    if (reqId != null) {
      window.parent.postMessage({
        __ipc_main_push_result__: true,
        reqId: reqId,
        results: results
      }, '*');
    }
  }
  function _emitMainPushSelect(action) {
    if (typeof _mainPushSelectCallback !== 'function') return;
    try {
      _mainPushSelectCallback(action || _pluginEnterAction({}));
    } catch (err) {
      console.error('[onMainPush select]', err);
    }
  }
  function _emitDbPull(docs) {
    var payload = Array.isArray(docs) ? docs : [];
    _dbListeners.docs.slice().forEach(function(cb) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[onDbPull]', err);
      }
    });
  }
  window.addEventListener('message', function(e) {
    if (e.data && e.data.__ipc_db_pull__) {
      _emitDbPull(e.data.docs);
    }
    if (e.data && e.data.__ipc_main_push__) {
      _emitMainPush(e.data.action, e.data.reqId);
    }
    if (e.data && e.data.__ipc_main_push_select__) {
      _emitMainPushSelect(e.data.action);
    }
  });
  window.__atools_dynamic_features__ = {};
  function _dynamicFeatureList() {
    return Object.keys(window.__atools_dynamic_features__).map(function(code) {
      return window.__atools_dynamic_features__[code];
    });
  }
  function _normalizeDynamicFeature(feature) {
    if (!feature || typeof feature !== 'object') return null;
    var code = feature.code || feature.feature_code || feature.cmd || feature.name;
    if (!code) return null;
    code = String(code);
    var label = feature.label || feature.explain || feature.title || code;
    var explain = feature.explain || feature.description || feature.label || '';
    return {
      code: code,
      label: String(label),
      explain: String(explain)
    };
  }
  function _postDynamicFeatureUpdate(action, features, codes) {
    window.parent.postMessage({
      __ipc_dynamic_feature__: true,
      action: action,
      features: features || [],
      codes: codes || [],
      allFeatures: _dynamicFeatureList()
    }, '*');
  }
  function _setDynamicFeatures(features) {
    var list = Array.isArray(features) ? features : [features];
    var normalized = [];
    list.forEach(function(feature) {
      var item = _normalizeDynamicFeature(feature);
      if (!item) return;
      window.__atools_dynamic_features__[item.code] = item;
      normalized.push(item);
    });
    _postDynamicFeatureUpdate('set', normalized, []);
    return _dynamicFeatureList();
  }
  function _removeDynamicFeatures(features) {
    var list = Array.isArray(features) ? features : [features];
    var codes = [];
    list.forEach(function(feature) {
      var code = typeof feature === 'string'
        ? feature
        : feature && typeof feature === 'object'
          ? feature.code || feature.feature_code || feature.cmd || feature.name
          : '';
      if (!code) return;
      code = String(code);
      delete window.__atools_dynamic_features__[code];
      codes.push(code);
    });
    _postDynamicFeatureUpdate('remove', [], codes);
    return _dynamicFeatureList();
  }
  function _setPluginHeight(height) {
    var numeric = Number(height);
    if (!Number.isFinite(numeric) || numeric <= 0) return false;
    var normalized = Math.max(120, Math.min(900, Math.round(numeric)));
    window.parent.postMessage({ __ipc_plugin_height__: true, height: normalized }, '*');
    return normalized;
  }
  function _isDarkColors() {
    if (typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function _fileIconDataUrl(filePath) {
    var raw = String(filePath || '').trim();
    var name = raw === 'folder'
      ? 'DIR'
      : (raw.split(/[\\/]/).pop() || raw || 'FILE');
    var ext = name.charAt(0) === '.'
      ? name
      : (name.indexOf('.') >= 0 ? '.' + name.split('.').pop() : name);
    var label = String(ext || 'FILE')
      .replace(/[^a-zA-Z0-9.]/g, '')
      .slice(0, 6)
      .toUpperCase() || 'FILE';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
      + '<rect x="12" y="6" width="40" height="52" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>'
      + '<path d="M40 6v14h12" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/>'
      + '<text x="32" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#334155">'
      + label
      + '</text></svg>';
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }
  function _bridgeNumber(value) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : 0;
  }
  function _contextMenuTagName(target) {
    return target && typeof target.tagName === 'string'
      ? target.tagName.toUpperCase().slice(0, 32)
      : '';
  }
  function _contextMenuEditable(target, tagName) {
    if (!target) return false;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    return target.isContentEditable === true;
  }
  function _contextMenuSelectedText() {
    try {
      if (typeof window.getSelection !== 'function') return '';
      return String(window.getSelection() || '').slice(0, 200);
    } catch (err) {
      return '';
    }
  }
  function _emitPluginContextMenu(event) {
    var tagName = _contextMenuTagName(event.target);
    var payload = {
      __ipc_plugin_contextmenu__: true,
      x: _bridgeNumber(event.clientX),
      y: _bridgeNumber(event.clientY),
      screenX: _bridgeNumber(event.screenX),
      screenY: _bridgeNumber(event.screenY),
      tagName: tagName,
      editable: _contextMenuEditable(event.target, tagName),
      selectedText: _contextMenuSelectedText(),
      defaultPrevented: false
    };
    setTimeout(function() {
      payload.defaultPrevented = event.defaultPrevented === true;
      window.parent.postMessage(payload, '*');
    }, 0);
  }
  window.addEventListener('contextmenu', _emitPluginContextMenu, true);
  function _dbDocId(doc) {
    return doc && typeof doc._id === 'string' ? doc._id : '';
  }
  function _filterDbDocs(docs, opts) {
    var list = Array.isArray(docs) ? docs : [];
    if (Array.isArray(opts)) {
      var byId = {};
      list.forEach(function(doc) {
        var id = _dbDocId(doc);
        if (id) byId[id] = doc;
      });
      return opts.map(function(id) { return byId[String(id)]; }).filter(Boolean);
    }
    if (typeof opts === 'string' && opts.length > 0) {
      return list.filter(function(doc) {
        return _dbDocId(doc).indexOf(opts) === 0;
      });
    }
    return list;
  }
  window.utools = {
    db: {
      put: function(doc) { return _invokeFn("put_plugin_data", { pluginId: __PLUGIN_ID__, doc: doc }); },
      get: function(id) { return _invokeFn("get_plugin_data_item", { pluginId: __PLUGIN_ID__, docId: id }); },
      remove: function(idOrDoc) {
        var id = typeof idOrDoc === 'string' ? idOrDoc : idOrDoc._id;
        return _invokeFn("remove_plugin_data", { pluginId: __PLUGIN_ID__, docId: id });
      },
      allDocs: function(opts) {
        return _invokeFn("get_plugin_data", { pluginId: __PLUGIN_ID__ }).then(function(docs) {
          return _filterDbDocs(docs, opts);
        });
      },
      bulkDocs: function(docs) { return _invokeFn("put_plugin_data_bulk", { pluginId: __PLUGIN_ID__, docs: docs }); },
      putAttachment: function() { return _putAttachment(arguments); },
      postAttachment: function() { return _putAttachment(arguments); },
      getAttachment: function() { return _getAttachment(arguments); },
      getAttachmentType: function() { return _getAttachmentType(arguments); },
      replicateStateFromCloud: function() { return Promise.resolve(null); },
      promises: {}
    },
    dbStorage: _createDbStorage(),
    showNotification: function(msg) { return _invokeFn("show_notification", { message: String(msg) }); },
    copyText: function(text) { return _invokeFn("copy_text", { text: text }); },
    copyImage: function(img) { return _nativeCall('copyImage', { image: img }); },
    copyFile: function(file) { return _nativeCall('copyFile', { file: file }); },
    getCopyedFiles: function() { return _nativeCall('getCopyedFiles').then(_normalizeCopiedFiles); },
    getCopiedFiles: function() { return _nativeCall('getCopyedFiles').then(_normalizeCopiedFiles); },
    hideMainWindowPasteText: function(text) { return _nativeCall('hideMainWindowPasteText', { text: String(text || '') }); },
    hideMainWindowPasteImage: function(image) { return _nativeCall('hideMainWindowPasteImage', { image: image }); },
    hideMainWindowPasteFile: function(file) { return _nativeCall('hideMainWindowPasteFile', { file: file }); },
    hideMainWindowTypeString: function(text) { return _nativeCall('hideMainWindowTypeString', { text: String(text || '') }); },
    outPlugin: function(data) {
      var items = data || [];
      if (Array.isArray(items)) {
        window.parent.postMessage({ __ipc_out__: true, data: items }, '*');
      } else {
        window.parent.postMessage({ __ipc_out__: true, data: [items] }, '*');
      }
    },
    redirect: function(label, payload) { return _nativeCall('redirect', { label: label, payload: payload }); },
    redirectHotKeySetting: function(cmdLabel, autocopy) {
      return _nativeCall('redirectHotKeySetting', {
        cmdLabel: String(cmdLabel || ''),
        autocopy: autocopy === true
      });
    },
    redirectAiModelsSetting: function() { return _nativeCall('redirectAiModelsSetting', {}); },
    createBrowserWindow: function(url, options, callback) {
      return _nativeCall('createBrowserWindow', {
        url: String(url || ''),
        options: options || {},
        hasCallback: typeof callback === 'function'
      }).then(function(result) {
        return _createBrowserWindowHandle(result, callback);
      });
    },
    sendToParent: function(channel) {
      return _nativeCall('sendToParent', {
        channel: String(channel || ''),
        args: Array.prototype.slice.call(arguments, 1),
        windowType: _atoolsWindowType || 'main',
        browserWindowId: _atoolsBrowserWindowId || ''
      });
    },
    setSubInput: function(opts, placeholder, focus) {
      if (typeof opts === 'function') {
        window.__atools_subinput_cb__ = opts;
        window.parent.postMessage({ __ipc_subinput__: true, opts: { placeholder: placeholder || '', focus: !!focus } }, '*');
        return;
      }
      window.parent.postMessage({ __ipc_subinput__: true, opts: opts || {} }, '*');
    },
    setSubInputValue: function(value) {
      window.parent.postMessage({ __ipc_subinput__: true, opts: { value: String(value || '') } }, '*');
    },
    removeSubInput: function() {
      window.parent.postMessage({ __ipc_subinput_remove__: true }, '*');
      return Promise.resolve(true);
    },
    subInputFocus: function() {
      window.parent.postMessage({ __ipc_subinput_focus__: true, action: 'focus' }, '*');
      return Promise.resolve(true);
    },
    subInputBlur: function() {
      window.parent.postMessage({ __ipc_subinput_focus__: true, action: 'blur' }, '*');
      return Promise.resolve(true);
    },
    subInputSelect: function() {
      window.parent.postMessage({ __ipc_subinput_focus__: true, action: 'select' }, '*');
      return Promise.resolve(true);
    },
    onSubInput: function(cb) {
      // Listen for input changes from parent
      window.addEventListener('message', function(e) {
        if (e.data && e.data.__ipc_subinput_change__) {
          if (typeof window.__atools_subinput_cb__ === 'function') {
            try { window.__atools_subinput_cb__({ text: e.data.text || '' }); } catch (err) { console.error('[setSubInput]', err); }
          }
          try { cb({ text: e.data.text || '' }); } catch (err) { console.error('[onSubInput]', err); }
        }
      });
    },
    onPluginEnter: function(cb) { window.addEventListener('atools-plugin-enter', function(event) { cb(_pluginEnterAction(_eventDetail(event))); }); },
    onPluginReady: function(cb) { window.addEventListener('atools-plugin-ready', function() { cb(); }); },
    onPluginOut: function(cb) { window.addEventListener('atools-plugin-out', function(event) { var detail = _eventDetail(event); cb(detail.isKill === true); }); },
    onPluginDetach: function(cb) { window.addEventListener('atools-plugin-detach', function() { cb(); }); },
    onMainPush: function(callback, onSelect) {
      _mainPushCallback = typeof callback === 'function' ? callback : null;
      _mainPushSelectCallback = typeof onSelect === 'function' ? onSelect : null;
    },
    onDbPull: function(cb) {
      if (typeof cb === 'function') {
        _dbListeners.docs.push(cb);
      }
    },
    getPath: function(n) { return _invokeFn("system_get_path", { name: n }); },
    getNativeId: function() { return _getNativeId(); },
    getAppName: function() { return __APP_NAME__; },
    getAppVersion: function() { return __APP_VERSION__; },
    isDev: function() { return false; },
    getFileIcon: function(filePath) { return _fileIconDataUrl(filePath); },
    getUser: function() { return null; },
    fetchUserServerTemporaryToken: function() {
      return Promise.reject(new Error('fetchUserServerTemporaryToken unsupported: user server temporary token is not available in the current local-only host'));
    },
    getPathForFile: function(file) { return file && (file.path || file.name) || ''; },
    shellOpenExternal: function(url) { return _invokeFn("shell_open", { url: url }); },
    shellOpenPath: function(path) { return _invokeFn("shell_open", { url: path }); },
    shellShowItemInFolder: function(path) { return _nativeCall('shellShowItemInFolder', { path: path }); },
    shellTrashItem: function(path) { return _nativeCall('shellTrashItem', { path: String(path || '') }); },
    shellBeep: function() { return _nativeCall('shellBeep', {}); },
    showOpenDialog: function(opts) { return _nativeCall('showOpenDialog', { options: opts || {} }); },
    showSaveDialog: function(opts) { return _nativeCall('showSaveDialog', { options: opts || {} }); },
    screenCapture: function(callback) { return _nativeCallbackCall('screenCapture', {}, callback); },
    screenColorPick: function(callback) { return _nativeCallbackCall('screenColorPick', {}, callback); },
    getPrimaryDisplay: function() { return _createDisplaySnapshot(); },
    getAllDisplays: function() { return [_createDisplaySnapshot()]; },
    getCursorScreenPoint: function() {
      return { x: _lastCursorScreenPoint.x, y: _lastCursorScreenPoint.y };
    },
    getDisplayNearestPoint: function(point) {
      _normalizePoint(point);
      return _createDisplaySnapshot();
    },
    getDisplayMatching: function(rect) {
      _normalizeRect(rect);
      return _createDisplaySnapshot();
    },
    screenToDipPoint: function(point) { return _screenToDipPoint(point); },
    dipToScreenPoint: function(point) { return _dipToScreenPoint(point); },
    screenToDipRect: function(rect) { return _screenToDipRect(rect); },
    dipToScreenRect: function(rect) { return _dipToScreenRect(rect); },
    desktopCaptureSources: function(options) { return _nativeCall('desktopCaptureSources', { options: options || {} }); },
    readCurrentBrowserUrl: function() { return _nativeCall('readCurrentBrowserUrl'); },
    getCurrentBrowserUrl: function() { return _nativeCall('readCurrentBrowserUrl'); },
    readCurrentFolderPath: function() { return _nativeCall('readCurrentFolderPath'); },
    simulateKeyboardTap: function(key, modifiers) {
      var modifierList = Array.isArray(modifiers)
        ? modifiers
        : Array.prototype.slice.call(arguments, 1).filter(Boolean);
      return _nativeCall('simulateKeyboardTap', { key: key, modifiers: modifierList });
    },
    hideMainWindow: function(isRestorePreWindow) {
      window.parent.postMessage({
        __ipc_main_window__: true,
        action: 'hide',
        restorePreviousWindow: isRestorePreWindow !== false
      }, '*');
      return true;
    },
    showMainWindow: function() {
      window.parent.postMessage({ __ipc_main_window__: true, action: 'show' }, '*');
      return true;
    },
    getWindowType: function() { return _atoolsWindowType || 'main'; },
    findInPage: function(text, options) {
      window.parent.postMessage({
        __ipc_find_in_page__: true,
        text: String(text || ''),
        options: options || {}
      }, '*');
    },
    stopFindInPage: function(action) {
      window.parent.postMessage({
        __ipc_stop_find_in_page__: true,
        action: action || 'clearSelection'
      }, '*');
    },
    startDrag: function(filePath) { return _nativeCall('startDrag', { filePath: filePath }); },
    setExpendHeight: function(height) { return Promise.resolve(_setPluginHeight(height)); },
    setExpandHeight: function(height) { return Promise.resolve(_setPluginHeight(height)); },
    setFeature: function(features) { return Promise.resolve(_setDynamicFeatures(features)); },
    setFeatures: function(features) { return Promise.resolve(_setDynamicFeatures(features)); },
    removeFeature: function(features) { return Promise.resolve(_removeDynamicFeatures(features)); },
    getFeatures: function() { return Promise.resolve(_dynamicFeatureList()); },
    registerTool: function(name, handler) {
      window.__atools_registered_tools__ = window.__atools_registered_tools__ || {};
      window.__atools_registered_tools__[name] = handler;
      window.parent.postMessage({ __ipc_register_tool__: true, name: name }, '*');
      return true;
    },
    isDarkColors: function() { return _isDarkColors(); },
    isMacOS: function() { return navigator.platform.indexOf('Mac') > -1; },
    isMacOs: function() { return navigator.platform.indexOf('Mac') > -1; },
    isWindows: function() { return navigator.platform.indexOf('Win') > -1; },
    isLinux: function() {
      return /Linux/i.test(String(navigator.platform || '')) || /Linux/i.test(String(navigator.userAgent || ''));
    }
  };
  window.utools.db.promises = window.utools.db;
  window.ztools = window.utools;
  _installRuntimeCssStyleSheetPatch();
  _installRuntimePreinsertResourcePatch();
  _installRuntimeResourceObserver();

  // Fire lifecycle events after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      window.dispatchEvent(new Event('atools-plugin-enter'));
      setTimeout(function() { window.dispatchEvent(new Event('atools-plugin-ready')); }, 50);
    });
  } else {
    window.dispatchEvent(new Event('atools-plugin-enter'));
    setTimeout(function() { window.dispatchEvent(new Event('atools-plugin-ready')); }, 50);
  }
})();
<\/script>`;

  function desktopPluginPanelRenderSmokeEnabled() {
    const env = import.meta.env as Record<string, unknown>;
    return env.VITE_ATOOLS_DESKTOP_SMOKE !== undefined
      && pluginDialogSmokeGuardEnabled(env)
      && desktopBrowserWindowSmokeQueueEnabled(desktopSmokeExpectedSamples, ondesktopsmokerender);
  }

  function desktopSmokeBridgeProbeFailure(reason: string): DesktopSmokeBridgeProbeResult {
    const browserWindowProbeExpected = desktopSmokeSampleIndex === 0;
    return {
      reported: false,
      passed: false,
      checks: 0,
      passedChecks: 0,
      failedIds: [reason],
      domInputVisible: false,
      domInputPlaceholder: "",
      nativeMethodReported: false,
      nativeMethodPassed: false,
      nativeMethodChecks: 0,
      nativeMethodPassedChecks: 0,
      nativeMethodFailedIds: [reason],
      browserWindowProbeExpected,
      browserWindowProbeReported: false,
      browserWindowProbePassed: false,
      browserWindowProbeChecks: 0,
      browserWindowProbePassedChecks: 0,
      browserWindowProbeFailedIds: browserWindowProbeExpected ? [reason] : [],
      browserWindowCreated: false,
      browserWindowChildOriginOpaque: false,
      browserWindowSelfTauriUnavailable: false,
      browserWindowParentTauriUnavailable: false,
      browserWindowParentDocumentBlocked: false,
      browserWindowSendToParentChecked: false,
      browserWindowExecuteJavascriptChecked: false,
      browserWindowIpcRoundtripChecked: false,
      browserWindowCleanupChecked: false,
    };
  }

  function desktopSmokeBridgeProbeTimeoutMs(iframeSrcdocBytes: number) {
    const bytes = Number.isFinite(iframeSrcdocBytes) ? Math.max(0, iframeSrcdocBytes) : 0;
    const sizeBudget = Math.ceil(bytes / 512_000) * 1000;
    return Math.min(20000, Math.max(12000, 4500 + sizeBudget));
  }

  function normalizeDesktopSmokeProbeList(value: unknown) {
    const probes = Array.isArray(value) ? value : [];
    const normalized = probes
      .map((probe) => {
        if (!probe || typeof probe !== "object") return null;
        const record = probe as Record<string, unknown>;
        const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "unknown";
        return { id, passed: record.passed === true };
      })
      .filter((probe): probe is { id: string; passed: boolean } => probe !== null);
    const failedIds = normalized.filter((probe) => !probe.passed).map((probe) => probe.id);
    return {
      reported: Array.isArray(value),
      passed: normalized.length > 0 && failedIds.length === 0,
      checks: normalized.length,
      passedChecks: normalized.length - failedIds.length,
      failedIds,
    };
  }

  function normalizeDesktopSmokeBridgeProbe(data: Record<string, unknown>): DesktopSmokeBridgeProbeResult {
    const bridgeProbe = normalizeDesktopSmokeProbeList(data.probes);
    const nativeMethodProbe = normalizeDesktopSmokeProbeList(data.nativeMethodProbes);
    const browserWindowProbeExpected = Number(data.sampleIndex) === 0;
    const browserWindowProbe = browserWindowProbeExpected
      ? normalizeDesktopBrowserWindowProbeContract(data.browserWindowProbes)
      : normalizeDesktopSmokeProbeList(null);
    const browserWindowProbeReported = browserWindowProbeExpected
      && data.browserWindowProbeExpected === true
      && data.browserWindowProbeReported === true
      && browserWindowProbe.reported;
    const browserWindowProbePassed = browserWindowProbeReported
      && data.browserWindowProbePassed === true
      && browserWindowProbe.passed
      && browserWindowProbe.checks === 9
      && browserWindowProbe.passedChecks === 9;
    return {
      reported: bridgeProbe.reported,
      passed: bridgeProbe.passed,
      checks: bridgeProbe.checks,
      passedChecks: bridgeProbe.passedChecks,
      failedIds: bridgeProbe.failedIds,
      domInputVisible: data.domInputVisible === true,
      domInputPlaceholder: typeof data.domInputPlaceholder === "string" ? data.domInputPlaceholder : "",
      nativeMethodReported: nativeMethodProbe.reported,
      nativeMethodPassed: nativeMethodProbe.passed,
      nativeMethodChecks: nativeMethodProbe.checks,
      nativeMethodPassedChecks: nativeMethodProbe.passedChecks,
      nativeMethodFailedIds: nativeMethodProbe.failedIds,
      browserWindowProbeExpected,
      browserWindowProbeReported,
      browserWindowProbePassed,
      browserWindowProbeChecks: browserWindowProbeExpected ? browserWindowProbe.checks : 0,
      browserWindowProbePassedChecks: browserWindowProbeExpected ? browserWindowProbe.passedChecks : 0,
      browserWindowProbeFailedIds: browserWindowProbeExpected ? browserWindowProbe.failedIds : [],
      browserWindowCreated: browserWindowProbeExpected && data.browserWindowCreated === true,
      browserWindowChildOriginOpaque: browserWindowProbeExpected && data.browserWindowChildOriginOpaque === true,
      browserWindowSelfTauriUnavailable: browserWindowProbeExpected && data.browserWindowSelfTauriUnavailable === true,
      browserWindowParentTauriUnavailable: browserWindowProbeExpected && data.browserWindowParentTauriUnavailable === true,
      browserWindowParentDocumentBlocked: browserWindowProbeExpected && data.browserWindowParentDocumentBlocked === true,
      browserWindowSendToParentChecked: browserWindowProbeExpected && data.browserWindowSendToParentChecked === true,
      browserWindowExecuteJavascriptChecked: browserWindowProbeExpected && data.browserWindowExecuteJavascriptChecked === true,
      browserWindowIpcRoundtripChecked: browserWindowProbeExpected && data.browserWindowIpcRoundtripChecked === true,
      browserWindowCleanupChecked: browserWindowProbeExpected && data.browserWindowCleanupChecked === true,
    };
  }

  function resolveDesktopSmokeBridgeProbe(result: DesktopSmokeBridgeProbeResult) {
    if (!desktopSmokeBridgeProbeWaiter) return;
    const waiter = desktopSmokeBridgeProbeWaiter;
    desktopSmokeBridgeProbeWaiter = null;
    window.clearTimeout(waiter.timeoutId);
    waiter.resolve(result);
  }

  function waitForDesktopSmokeMacrotask() {
    return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  async function waitForDesktopSmokeHostState() {
    await tick();
    await waitForDesktopSmokeMacrotask();
    await tick();
  }

  function waitForDesktopSmokeBridgeProbe(
    pluginId: string,
    featureCode: string,
    sampleIndex: number,
    iframeSrcdocBytes = 0
  ): Promise<DesktopSmokeBridgeProbeResult> {
    if (!desktopPluginPanelRenderSmokeEnabled()) {
      return Promise.resolve(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-disabled"));
    }
    resolveDesktopSmokeBridgeProbe(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-superseded"));
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        resolveDesktopSmokeBridgeProbe(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-timeout"));
      }, desktopSmokeBridgeProbeTimeoutMs(iframeSrcdocBytes));
      desktopSmokeBridgeProbeWaiter = {
        pluginId,
        featureCode,
        sampleIndex,
        resolve,
        timeoutId,
      };
    });
  }

  function handleDesktopSmokeBridgeProbe(data: Record<string, unknown>) {
    if (!desktopSmokeBridgeProbeWaiter) return;
    const pluginId = typeof data.pluginId === "string" ? data.pluginId : "";
    const featureCode = typeof data.featureCode === "string" ? data.featureCode : "";
    const sampleIndex = Number(data.sampleIndex);
    if (
      pluginId !== desktopSmokeBridgeProbeWaiter.pluginId ||
      featureCode !== desktopSmokeBridgeProbeWaiter.featureCode ||
      sampleIndex !== desktopSmokeBridgeProbeWaiter.sampleIndex
    ) {
      return;
    }
    resolveDesktopSmokeBridgeProbe(normalizeDesktopSmokeBridgeProbe(data));
  }

  async function reportPluginPanelRenderSmoke(options: {
    mainFile: string;
    html: string;
    fsLoad: boolean;
    loadError?: string;
    bridgeProbe?: DesktopSmokeBridgeProbeResult;
  }) {
    if (!desktopPluginPanelRenderSmokeEnabled() || action.plugin_path === WEB_PREVIEW_PLUGIN_PATH) {
      return;
    }
    const html = options.html || "";
    const bridgeProbe = options.bridgeProbe ?? desktopSmokeBridgeProbeFailure("desktop-bridge-probe-missing");
    await waitForDesktopSmokeHostState();
    const browserWindowCleanupChecked = bridgeProbe.browserWindowCleanupChecked
      && pluginBrowserWindows.length === 0;
    try {
      await invoke("report_plugin_panel_render_smoke", {
        report: {
          pluginId: action.plugin_id,
          featureCode: action.feature_code,
          mainUrl: options.mainFile || action.main_url || "index.html",
          pluginPath: action.plugin_path,
          fsLoad: options.fsLoad,
          iframeSrcdocLoaded: html.length > 0,
          iframeSrcEmpty: iframeSrc === "",
          loadError: options.loadError || "",
          iframeSrcdocBytes: new TextEncoder().encode(html).length,
          expectedSamples: Math.max(1, desktopSmokeExpectedSamples),
          sampleIndex: desktopSmokeSampleIndex,
          externalPlanSample: desktopSmokeExternalPlanSample,
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
	          subinputVisible: hasSubInput || bridgeProbe.domInputVisible,
	          subinputPlaceholder: subInputOpts.placeholder || bridgeProbe.domInputPlaceholder || "",
	        },
	      });
      await ondesktopsmokerender?.();
    } catch (error) {
      console.warn("[PluginPanel] Failed to report desktop render smoke:", error);
    }
  }

  async function loadPluginHtml() {
    const mainFile = action.main_url || "index.html";
    try {
      if (action.plugin_path === WEB_PREVIEW_PLUGIN_PATH) {
        loadPreviewPluginHtml();
        return;
      }

      const pluginDir = action.plugin_path;
      const htmlPath = mainFile.startsWith("/") ? mainFile : `${pluginDir}/${mainFile}`;

      let html = await readTextFile(htmlPath);
      html = await preparePluginHtmlResources(html, {
        pluginDir,
        mainFile,
        readTextFile,
        convertFileSrc,
        warn: (message, error) => console.warn(`[PluginPanel] ${message}`, error),
      });

      // Inline preload.js if referenced
      if (action.preload_path) {
        try {
          const preloadJs = await readTextFile(action.preload_path);
          const preloadScript = `<script>\n${preloadJs}\n<\/script>`;
          if (html.includes("</head>")) {
            html = html.replace("</head>", `${preloadScript}</head>`);
          } else {
            html = preloadScript + html;
          }
        } catch (e) {
          console.warn("[PluginPanel] Failed to load preload.js:", e);
        }
      }

      html = injectPluginBridge(html);
      html = injectDesktopSmokeBridgeProbe(html);

      const bridgeProbePromise = waitForDesktopSmokeBridgeProbe(
        action.plugin_id,
        action.feature_code,
        desktopSmokeSampleIndex,
        html.length
      );
      iframeSrc = "";
      iframeSrcDoc = html;
      loadError = null;
      await tick();
      const bridgeProbe = await bridgeProbePromise;
      await reportPluginPanelRenderSmoke({
        mainFile,
        html,
        fsLoad: true,
        bridgeProbe,
      });
    } catch (e) {
      console.error("[PluginPanel] Load failed:", e);
      loadError = `无法加载插件: ${e}`;
      await reportPluginPanelRenderSmoke({
        mainFile,
        html: "",
        fsLoad: false,
        loadError,
        bridgeProbe: desktopSmokeBridgeProbeFailure("desktop-bridge-probe-load-failed"),
      });
    }
  }

  $effect(() => {
    if (action.plugin_path) {
      loadPluginHtml();
    }
  });

  type NativeBridgeCall = {
    __atools_native_call__: true;
    reqId: number;
    method: string;
    args?: Record<string, unknown>;
  };

  type RuntimeResourceResolveCall = {
    __atools_resource_resolve__: true;
    reqId: number;
    url: string;
    baseDir?: string;
  };

  function dirnameRuntimeResourcePath(path: string): string {
    const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const index = normalized.lastIndexOf("/");
    if (index <= 0) return normalized.startsWith("/") ? "/" : "";
    return normalized.slice(0, index);
  }

  function runtimeResourceBaseDir(baseDir: unknown): string | undefined {
    if (typeof baseDir !== "string") return undefined;
    const raw = baseDir.trim();
    if (!raw || !action.plugin_path || action.plugin_path === WEB_PREVIEW_PLUGIN_PATH) return undefined;

    const basePath = pluginResourceFilePath(action.plugin_path, action.main_url || "index.html", raw);
    if (!basePath) return undefined;

    const rawPath = raw.split(/[?#]/, 1)[0].replace(/\\/g, "/");
    return rawPath.endsWith("/") ? basePath : dirnameRuntimeResourcePath(basePath);
  }

  function pathFromBridgeValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.path === "string") return record.path;
      if (typeof record.name === "string") return record.name;
    }
    throw new Error("Expected a file path");
  }

  function pathsFromBridgeValue(value: unknown): string[] {
    const paths = Array.isArray(value)
      ? value.map((entry) => pathFromBridgeValue(entry))
      : [pathFromBridgeValue(value)];
    if (paths.length === 0) throw new Error("Expected at least one file path");
    return paths;
  }

  type CopiedFileEntry = {
    path: string;
    name: string;
    isFile: boolean;
    isDiractory: boolean;
    [key: string]: unknown;
  };

  function copiedFileName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || path;
  }

  function normalizeCopiedFileEntry(entry: unknown): CopiedFileEntry | null {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const path = typeof entry === "string"
      ? entry
      : typeof record.path === "string"
        ? record.path
        : typeof record.name === "string"
          ? record.name
          : "";
    if (!path) return null;
    const isDiractory = typeof record.isDiractory === "boolean" ? record.isDiractory : /[\\/]$/.test(path);
    const isFile = typeof record.isFile === "boolean" ? record.isFile : !isDiractory;
    const name = typeof record.name === "string" && record.name ? record.name : copiedFileName(path);
    return { ...record, path, name, isFile, isDiractory };
  }

  function normalizeCopiedFileEntries(entries: unknown): CopiedFileEntry[] {
    if (!Array.isArray(entries)) return [];
    return entries
      .map(normalizeCopiedFileEntry)
      .filter((entry): entry is CopiedFileEntry => Boolean(entry));
  }

  function appleScriptString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  async function runCommand(program: string, args: string[], label: string): Promise<string> {
    const output = await Command.create(program, args).execute();
    if (output.code !== 0) {
      const detail = output.stderr?.trim() || `exit code ${output.code}`;
      throw new Error(`${label} failed: ${detail}`);
    }
    return output.stdout || "";
  }

  async function runAppleScript(script: string, label: string): Promise<string> {
    return runCommand("osascript", ["-e", script], label);
  }

  async function hideMainWindowForPluginPaste(): Promise<void> {
    if ("__TAURI_INTERNALS__" in window) {
      await invoke("hide_main_window");
    } else {
      onclose();
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  function dataUrlToBytes(value: string): Uint8Array | null {
    const match = value.match(/^data:[^;]+;base64,(.*)$/);
    if (!match) return null;
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function writePluginImageToClipboard(image: unknown): Promise<void> {
    if (typeof image !== "string") {
      throw new Error("copyImage currently requires an image path or data URL");
    }
    const dataUrlBytes = dataUrlToBytes(image);
    await writeImage(dataUrlBytes || image);
  }

  function pluginFileClipboardAppleScript(paths: string[]): string {
    const fileRefs = paths.map((path) => `(POSIX file ${appleScriptString(path)})`).join(", ");
    return `set the clipboard to {${fileRefs}}`;
  }

  function normalizeEyeDropperHex(value: unknown): string {
    if (typeof value !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(value)) {
      throw new Error("screenColorPick unavailable: EyeDropper did not return a valid sRGB color");
    }
    return value.startsWith("#") ? value.toLowerCase() : `#${value.toLowerCase()}`;
  }

  function rgbStringFromHex(hex: string): string {
    const normalized = normalizeEyeDropperHex(hex).slice(1);
    const r = Number.parseInt(normalized.slice(0, 2), 16);
    const g = Number.parseInt(normalized.slice(2, 4), 16);
    const b = Number.parseInt(normalized.slice(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }

  async function pickScreenColorWithEyeDropper(): Promise<{ hex: string; rgb: string }> {
    const EyeDropper = (window as EyeDropperWindow).EyeDropper;
    if (!EyeDropper) {
      throw new Error("screenColorPick unavailable: EyeDropper API is not available in the current WebView host");
    }
    const result = await new EyeDropper().open();
    const hex = normalizeEyeDropperHex(result.sRGBHex);
    return { hex, rgb: rgbStringFromHex(hex) };
  }

  function browserWindowOptions(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function browserWindowTitle(url: string, options: Record<string, unknown>): string {
    return typeof options.title === "string" && options.title.trim()
      ? options.title.trim().slice(0, 80)
      : url;
  }

  function browserWindowCapabilityFlag(options: Record<string, unknown>, key: string): boolean {
    return options[key] !== false;
  }

  function browserWindowFullScreenFlag(options: Record<string, unknown>): boolean {
    return options.fullScreen === true || options.fullscreen === true;
  }

  function browserWindowFullScreenableFlag(options: Record<string, unknown>): boolean {
    return options.fullScreenable !== false && options.fullscreenable !== false;
  }

  function browserWindowOpacity(value: unknown): number {
    const opacity = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(opacity)) return 1;
    return Math.min(1, Math.max(0, opacity));
  }

  function browserWindowProgressMode(value: unknown, fallback = "normal"): string {
    const mode = typeof value === "string" ? value.trim() : "";
    return ["none", "normal", "indeterminate", "error", "paused"].includes(mode) ? mode : fallback;
  }

  function browserWindowProgressState(progressValue: unknown, optionsValue: unknown): { progressBar: number | null; progressBarMode: string } {
    const progress = typeof progressValue === "number" ? progressValue : Number(progressValue);
    const options = optionsValue && typeof optionsValue === "object" ? optionsValue as Record<string, unknown> : {};
    if (!Number.isFinite(progress) || progress < 0) return { progressBar: null, progressBarMode: "none" };
    if (progress > 1) return { progressBar: null, progressBarMode: "indeterminate" };
    return {
      progressBar: Math.min(1, Math.max(0, progress)),
      progressBarMode: browserWindowProgressMode(options.mode),
    };
  }

  function pluginBrowserWindowZoomLevelFromFactor(factor: number): number {
    return Math.log(factor) / Math.log(1.2);
  }

  function pluginBrowserWindowZoomFactorFromLevel(level: number): number {
    return Math.pow(1.2, level);
  }

  function normalizePluginBrowserWindowZoomFactor(value: unknown): number {
    const factor = Number(value);
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error("webContents.setZoomFactor requires a factor greater than 0");
    }
    return factor;
  }

  function normalizePluginBrowserWindowZoomLevel(value: unknown, label: string): number {
    const level = Number(value);
    if (!Number.isFinite(level)) {
      throw new Error(`${label} requires a finite zoom level`);
    }
    return level;
  }

  function pluginBrowserWindowZoomResult(childWindow: PluginBrowserWindowState) {
    return {
      zoomFactor: childWindow.zoomFactor,
      zoomLevel: childWindow.zoomLevel,
      minimumLevel: childWindow.visualZoomMinimumLevel,
      maximumLevel: childWindow.visualZoomMaximumLevel,
    };
  }

  function browserWindowInitialUserAgent(options: Record<string, unknown>): string {
    const webPreferences = options.webPreferences && typeof options.webPreferences === "object"
      ? options.webPreferences as Record<string, unknown>
      : {};
    const configured = typeof options.userAgent === "string"
      ? options.userAgent
      : typeof webPreferences.userAgent === "string"
        ? webPreferences.userAgent
        : "";
    return configured || (typeof navigator !== "undefined" ? navigator.userAgent : "");
  }

  function browserWindowProcessId(windowSeq: number): number {
    return Math.max(1, Math.round(windowSeq));
  }

  function browserWindowOSProcessId(windowSeq: number): number {
    return 100000 + browserWindowProcessId(windowSeq);
  }

  function normalizePluginBrowserWindowFrameRate(value: unknown): number {
    const frameRate = Number(value);
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      throw new Error("webContents.setFrameRate requires a positive frame rate");
    }
    return Math.min(240, Math.max(1, Math.round(frameRate)));
  }

  function pluginBrowserWindowRuntimeResult(childWindow: PluginBrowserWindowState) {
    return {
      userAgent: childWindow.userAgent,
      frameRate: childWindow.frameRate,
      backgroundThrottling: childWindow.backgroundThrottling,
      processId: childWindow.processId,
      osProcessId: childWindow.osProcessId,
    };
  }

  function updatePluginBrowserWindowUserAgent(id: string, value: unknown) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setUserAgent failed: browser window ${id} is not active`);
    const userAgent = String(value ?? "");
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, userAgent };
      return updatedWindow;
    });
    const result = pluginBrowserWindowRuntimeResult(updatedWindow || { ...existing, userAgent });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setUserAgent", args: [userAgent] };
    return result;
  }

  function updatePluginBrowserWindowFrameRate(id: string, value: unknown) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setFrameRate failed: browser window ${id} is not active`);
    const frameRate = normalizePluginBrowserWindowFrameRate(value);
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, frameRate };
      return updatedWindow;
    });
    const result = pluginBrowserWindowRuntimeResult(updatedWindow || { ...existing, frameRate });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setFrameRate", args: [frameRate] };
    return result;
  }

  function updatePluginBrowserWindowBackgroundThrottling(id: string, value: unknown) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setBackgroundThrottling failed: browser window ${id} is not active`);
    const backgroundThrottling = value !== false;
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, backgroundThrottling };
      return updatedWindow;
    });
    const result = pluginBrowserWindowRuntimeResult(updatedWindow || { ...existing, backgroundThrottling });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setBackgroundThrottling", args: [backgroundThrottling] };
    return result;
  }

  function nextPluginBrowserWindowZOrder(): number {
    return Math.max(0, ...pluginBrowserWindows.map((childWindow) => childWindow.zOrder)) + 1;
  }

  function browserWindowNumber(value: unknown, fallback: number): number {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numberValue) ? Math.round(numberValue) : fallback;
  }

  function browserWindowDimension(value: unknown, fallback: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, browserWindowNumber(value, fallback)));
  }

  function browserWindowHexPair(value: unknown): string {
    const numeric = Math.min(255, Math.max(0, Math.round(Number(value) || 0)));
    return numeric.toString(16).padStart(2, "0");
  }

  function normalizePluginBrowserWindowBackgroundColor(value: unknown, fallback = "#ffffff"): string {
    const raw = String(value ?? "").trim();
    const fallbackColor = /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : "#ffffff";
    const hex = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
    if (hex) {
      const body = hex[1];
      if (body.length === 3) return `#${body.split("").map((ch) => ch + ch).join("")}`.toLowerCase();
      if (body.length === 4) return `#${body.slice(1).split("").map((ch) => ch + ch).join("")}`.toLowerCase();
      if (body.length === 8) return `#${body.slice(2)}`.toLowerCase();
      return `#${body}`.toLowerCase();
    }
    const rgb = raw.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
    if (rgb) return `#${browserWindowHexPair(rgb[1])}${browserWindowHexPair(rgb[2])}${browserWindowHexPair(rgb[3])}`;
    const namedColors: Record<string, string> = {
      black: "#000000",
      white: "#ffffff",
      red: "#ff0000",
      green: "#008000",
      blue: "#0000ff",
      blueviolet: "#8a2be2",
    };
    return namedColors[raw] || fallbackColor;
  }

  function browserWindowPosition(value: unknown, fallback: number): number {
    return Math.min(PLUGIN_BROWSER_WINDOW_MAX_POSITION, Math.max(0, browserWindowNumber(value, fallback)));
  }

  function browserWindowOptionNumber(options: Record<string, unknown>, keys: string[], fallback: number): number {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(options, key)) return browserWindowNumber(options[key], fallback);
    }
    return fallback;
  }

  function normalizePluginBrowserWindowSize(
    value: unknown,
    fallback: PluginBrowserWindowSize = {
      width: PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS.width,
      height: PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS.height,
    },
    constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
  ): PluginBrowserWindowSize {
    const source = Array.isArray(value) ? value : [];
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return constrainPluginBrowserWindowSize(
      {
        width: browserWindowNumber(source[0] ?? record.width, fallback.width),
        height: browserWindowNumber(source[1] ?? record.height, fallback.height),
      },
      constraints,
    );
  }

  function constrainPluginBrowserWindowSize(
    size: PluginBrowserWindowSize,
    constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
  ): PluginBrowserWindowSize {
    const minimumWidth = constraints?.minimumWidth ?? PLUGIN_BROWSER_WINDOW_MIN_WIDTH;
    const minimumHeight = constraints?.minimumHeight ?? PLUGIN_BROWSER_WINDOW_MIN_HEIGHT;
    const maximumWidth = Math.max(minimumWidth, constraints?.maximumWidth ?? PLUGIN_BROWSER_WINDOW_MAX_WIDTH);
    const maximumHeight = Math.max(minimumHeight, constraints?.maximumHeight ?? PLUGIN_BROWSER_WINDOW_MAX_HEIGHT);
    return {
      width: Math.min(maximumWidth, Math.max(minimumWidth, size.width)),
      height: Math.min(maximumHeight, Math.max(minimumHeight, size.height)),
    };
  }

  function initialPluginBrowserWindowSizeConstraints(options: Record<string, unknown>) {
    const minimumWidth = browserWindowDimension(
      browserWindowOptionNumber(options, ["minWidth", "minimumWidth", "minwidth", "minimumwidth", "min-width"], PLUGIN_BROWSER_WINDOW_MIN_WIDTH),
      PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
      PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
      PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
    );
    const minimumHeight = browserWindowDimension(
      browserWindowOptionNumber(options, ["minHeight", "minimumHeight", "minheight", "minimumheight", "min-height"], PLUGIN_BROWSER_WINDOW_MIN_HEIGHT),
      PLUGIN_BROWSER_WINDOW_MIN_HEIGHT,
      PLUGIN_BROWSER_WINDOW_MIN_HEIGHT,
      PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
    );
    const maximumWidth = browserWindowDimension(
      browserWindowOptionNumber(options, ["maxWidth", "maximumWidth", "maxwidth", "maximumwidth", "max-width"], PLUGIN_BROWSER_WINDOW_MAX_WIDTH),
      PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
      minimumWidth,
      PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
    );
    const maximumHeight = browserWindowDimension(
      browserWindowOptionNumber(options, ["maxHeight", "maximumHeight", "maxheight", "maximumheight", "max-height"], PLUGIN_BROWSER_WINDOW_MAX_HEIGHT),
      PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
      minimumHeight,
      PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
    );
    return { minimumWidth, minimumHeight, maximumWidth, maximumHeight };
  }

  function pluginBrowserWindowAspectRatioExtraSize(value: unknown): PluginBrowserWindowSize {
    return normalizePluginBrowserWindowSize(value, { width: 0, height: 0 }, {
      minimumWidth: 0,
      minimumHeight: 0,
      maximumWidth: PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
      maximumHeight: PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
    });
  }

  function pluginBrowserWindowNumber(value: unknown, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function pluginBrowserWindowPlainOptions(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  function normalizePluginBrowserWindowPoint(value: unknown): PluginBrowserWindowPoint | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return {
      x: pluginBrowserWindowNumber(record.x, 0),
      y: pluginBrowserWindowNumber(record.y, 0),
    };
  }

  function pluginBrowserWindowNullableString(value: unknown) {
    if (value == null) return "";
    const raw = String(value);
    return raw.length > 0 ? raw : "";
  }

  function normalizePluginBrowserWindowBounds(
    value: unknown,
    fallback: PluginBrowserWindowBounds = PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS,
    constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
  ): PluginBrowserWindowBounds {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const size = normalizePluginBrowserWindowSize(record, fallback, constraints);
    return {
      x: browserWindowPosition(record.x, fallback.x),
      y: browserWindowPosition(record.y, fallback.y),
      ...size,
    };
  }

  function initialPluginBrowserWindowBounds(
    options: Record<string, unknown>,
    constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
  ): PluginBrowserWindowBounds & { positioned: boolean } {
    const bounds = normalizePluginBrowserWindowBounds(options, PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS, constraints);
    return {
      ...bounds,
      positioned: Object.prototype.hasOwnProperty.call(options, "x") || Object.prototype.hasOwnProperty.call(options, "y"),
    };
  }

  function pluginBrowserWindowBounds(childWindow: PluginBrowserWindowState): PluginBrowserWindowBounds {
    return {
      x: childWindow.x,
      y: childWindow.y,
      width: childWindow.width,
      height: childWindow.height,
    };
  }

  function pluginBrowserWindowLayer(childWindow: PluginBrowserWindowState): string {
    const base = childWindow.alwaysOnTop ? 3000 : childWindow.focused ? 2000 : 1000;
    return ` z-index: ${base + childWindow.zOrder};`;
  }

  function pluginBrowserWindowStyle(childWindow: PluginBrowserWindowState): string {
    const appearance = childWindow.opacity < 1 ? ` opacity: ${childWindow.opacity};` : "";
    const background = ` background: ${childWindow.backgroundColor};`;
    if (childWindow.kiosk || childWindow.fullScreen || childWindow.maximized) {
      const layer = pluginBrowserWindowLayer(childWindow);
      return `width: 100%; height: 100%; left: 0; top: 0;${layer}${appearance}${background}`;
    }
    const size = `width: ${childWindow.width}px; height: ${childWindow.height}px;`;
    if (childWindow.minimized) {
      const layer = pluginBrowserWindowLayer(childWindow);
      const position = childWindow.positioned ? ` left: ${childWindow.x}px; top: ${childWindow.y}px;` : "";
      return `width: ${childWindow.width}px; height: 42px;${position}${layer}${appearance}${background}`;
    }
    const layer = pluginBrowserWindowLayer(childWindow);
    if (!childWindow.positioned) return `${size}${layer}${appearance}${background}`;
    return `${size} left: ${childWindow.x}px; top: ${childWindow.y}px;${layer}${appearance}${background}`;
  }

  function pluginBrowserWindowFrameStyle(childWindow: PluginBrowserWindowState): string {
    const factor = Number.isFinite(childWindow.zoomFactor) && childWindow.zoomFactor > 0
      ? childWindow.zoomFactor
      : 1;
    if (Math.abs(factor - 1) < 0.0001) return "";
    return `transform: scale(${factor}); transform-origin: 0 0; width: ${100 / factor}%; height: ${100 / factor}%;`;
  }

  function browserWindowActionArgs(args: Record<string, unknown>): unknown[] {
    return Array.isArray(args.args) ? args.args : [];
  }

  function browserWindowSizeFromArgs(
    actionArgs: unknown[],
    fallback: PluginBrowserWindowSize,
    constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
  ): PluginBrowserWindowSize {
    const source = Array.isArray(actionArgs[0]) ? actionArgs[0] : actionArgs;
    return normalizePluginBrowserWindowSize(source, fallback, constraints);
  }

  function browserWindowPositionFromArgs(actionArgs: unknown[], fallback: PluginBrowserWindowBounds): Pick<PluginBrowserWindowBounds, "x" | "y"> {
    const source = Array.isArray(actionArgs[0]) ? actionArgs[0] : actionArgs;
    return {
      x: browserWindowPosition(source[0], fallback.x),
      y: browserWindowPosition(source[1], fallback.y),
    };
  }

  function previewBrowserWindowHtml(url: string): string {
    const payload = previewPayload();
    if (typeof payload.browserWindowSrcdoc === "string") return payload.browserWindowSrcdoc;
    const safeUrl = escapePluginPreviewHtml(url);
    return `<!doctype html><html><body><main class="browser-window-smoke"><h1>Browser Window</h1><p>${safeUrl}</p><button id="browser-window-send">发送给父窗口</button><script>
      document.getElementById('browser-window-send').addEventListener('click', function() {
        window.utools.sendToParent('browser-window-message', { windowType: window.utools.getWindowType(), url: ${JSON.stringify(url)} });
        document.body.setAttribute('data-parent-message-sent', 'true');
      });
    <\/script></main></body></html>`;
  }

  async function pluginBrowserWindowHtml(url: string): Promise<string> {
    if (!action.plugin_path || action.plugin_path === WEB_PREVIEW_PLUGIN_PATH) {
      return previewBrowserWindowHtml(url);
    }
    const mainFile = action.main_url || "index.html";
    const path = pluginResourceFilePath(action.plugin_path, mainFile, url);
    if (!path) {
      throw new Error(`createBrowserWindow requires a local plugin HTML file: ${url}`);
    }
    let html = await readTextFile(path);
    html = await preparePluginHtmlResources(html, {
      pluginDir: action.plugin_path,
      mainFile,
      readTextFile,
      convertFileSrc,
      warn: (message, error) => console.warn(`[PluginPanel] ${message}`, error),
    });
    return html;
  }

  async function createPluginBrowserWindow(args: Record<string, unknown>) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) throw new Error("createBrowserWindow requires a non-empty url");
    const options = browserWindowOptions(args.options);
    const windowSeq = ++pluginBrowserWindowSeq;
    const id = `plugin-browser-window-${windowSeq}`;
    const navigationToken = pluginBrowserWindowNavigation.begin(id);
    const mediaSourceId = `window:${windowSeq}:0`;
    const webContentsMediaSourceId = `web-contents:${windowSeq}:0`;
    const title = browserWindowTitle(url, options);
    const html = await runCurrentPluginBrowserWindowNavigation(
      id,
      navigationToken,
      () => pluginBrowserWindowHtml(url),
    );
    const srcdoc = injectPluginBridge(html, "browserWindow", id);
    const history = [{ url, title, srcdoc }];
    const visible = options.show !== false;
    const sizeConstraints = initialPluginBrowserWindowSizeConstraints(options);
    const bounds = initialPluginBrowserWindowBounds(options, sizeConstraints);
    const alwaysOnTop = options.alwaysOnTop === true;
    const backgroundColor = normalizePluginBrowserWindowBackgroundColor(options.backgroundColor ?? options.backgroundcolor);
    const menuBarAutoHide = options.autoHideMenuBar === true || options.autohidemenubar === true;
    const menuRemoved = options.menu === null;
    const menuBarVisible = !menuRemoved && options.menuBarVisible !== false && options.menubarvisible !== false;
    const windowButtonVisible = options.windowButtonVisible !== false && options.windowbuttonvisible !== false && options.windowButtonVisibility !== false && options.windowbuttonvisibility !== false;
    const windowButtonPosition = normalizePluginBrowserWindowPoint(options.windowButtonPosition ?? options.windowbuttonposition ?? options.trafficLightPosition ?? options.trafficlightposition);
    const vibrancy = pluginBrowserWindowNullableString(options.vibrancy);
    const vibrancyOptions = pluginBrowserWindowPlainOptions(options.vibrancyOptions ?? options.vibrancyoptions);
    const backgroundMaterial = pluginBrowserWindowNullableString(options.backgroundMaterial ?? options.backgroundmaterial) || "none";
    const sheetOffsetY = pluginBrowserWindowNumber(options.sheetOffsetY ?? options.sheetoffsety, 0);
    const sheetOffsetX = pluginBrowserWindowNumber(options.sheetOffsetX ?? options.sheetoffsetx, 0);
    const documentEdited = options.documentEdited === true || options.documentedited === true;
    const representedFilename = String(options.representedFilename ?? options.representedfilename ?? "");
    const modal = options.modal === true;
    const parentWindowId = typeof options.parentWindowId === "string" && options.parentWindowId.trim()
      ? options.parentWindowId.trim()
      : null;
    const resizable = browserWindowCapabilityFlag(options, "resizable");
    const movable = browserWindowCapabilityFlag(options, "movable");
    const closable = browserWindowCapabilityFlag(options, "closable");
    const minimizable = browserWindowCapabilityFlag(options, "minimizable");
    const maximizable = browserWindowCapabilityFlag(options, "maximizable");
    const fullScreenable = browserWindowFullScreenableFlag(options);
    const fullScreen = fullScreenable && browserWindowFullScreenFlag(options);
    const opacity = browserWindowOpacity(options.opacity);
    const hasShadow = options.hasShadow !== false && options.hasshadow !== false;
    const skipTaskbar = options.skipTaskbar === true || options.skiptaskbar === true;
    const kiosk = options.kiosk === true;
    const visibleOnAllWorkspaces = options.visibleOnAllWorkspaces === true || options.visibleonallworkspaces === true;
    const contentProtected = options.contentProtection === true || options.contentProtected === true || options.contentprotected === true;
    const focusable = options.focusable !== false;
    const userAgent = browserWindowInitialUserAgent(options);
    const frameRate = 60;
    const backgroundThrottling = true;
    const processId = browserWindowProcessId(windowSeq);
    const osProcessId = browserWindowOSProcessId(windowSeq);
    pluginBrowserWindows = [
      ...pluginBrowserWindows.map((childWindow) => ({ ...childWindow, focused: false })),
      {
        id,
        url,
        title,
        srcdoc,
        documentGeneration: navigationToken,
        history,
        historyIndex: 0,
        loading: false,
        visible,
        focused: visible && focusable,
        alwaysOnTop,
        backgroundColor,
        menuBarAutoHide,
        menuBarVisible,
        menuRemoved,
        windowButtonVisible,
        windowButtonPosition,
        vibrancy,
        vibrancyOptions,
        backgroundMaterial,
        sheetOffsetY,
        sheetOffsetX,
        documentEdited,
        representedFilename,
        modal,
        parentWindowId,
        minimized: false,
        maximized: false,
        resizable,
        movable,
        closable,
        minimizable,
        maximizable,
        ...sizeConstraints,
        aspectRatio: 0,
        aspectRatioExtraSize: { width: 0, height: 0 },
        fullScreen,
        fullScreenable,
        opacity,
        hasShadow,
        skipTaskbar,
        kiosk,
        visibleOnAllWorkspaces,
        contentProtected,
        focusable,
        flashing: false,
        progressBar: null,
        progressBarMode: "none",
        mediaSourceId,
        webContentsMediaSourceId,
        webContentsFocused: visible && focusable,
        webContentsBeingCaptured: false,
        ignoreMenuShortcuts: false,
        zOrder: windowSeq,
        devToolsOpened: false,
        devToolsFocused: false,
        devToolsMode: "",
        devToolsTitle: "",
        inspectedElement: null,
        zoomFactor: 1,
        zoomLevel: 0,
        visualZoomMinimumLevel: 0,
        visualZoomMaximumLevel: 0,
        audioMuted: false,
        currentlyAudible: false,
        userAgent,
        frameRate,
        backgroundThrottling,
        processId,
        osProcessId,
        crashed: false,
        ...bounds,
      },
    ];
    return {
      id,
      type: "browserWindow",
      windowType: "browserWindow",
      url,
      title,
      userAgent,
      frameRate,
      backgroundThrottling,
      backgroundColor,
      menuBarAutoHide,
      menuBarVisible,
      menuRemoved,
      windowButtonVisible,
      windowButtonPosition,
      vibrancy,
      vibrancyOptions,
      backgroundMaterial,
      sheetOffsetY,
      sheetOffsetX,
      documentEdited,
      representedFilename,
      modal,
      parentWindowId,
      processId,
      osProcessId,
      webContentsMediaSourceId,
      focused: visible && focusable,
      webContentsFocused: visible && focusable,
      webContentsBeingCaptured: false,
      ignoreMenuShortcuts: false,
      crashed: false,
    };
  }

  function pluginBrowserWindowNavigationResult(childWindow: PluginBrowserWindowState, extra: Record<string, unknown> = {}) {
    return {
      url: childWindow.url,
      title: childWindow.title,
      historyIndex: childWindow.historyIndex,
      historyLength: childWindow.history.length,
      loading: childWindow.loading,
      crashed: childWindow.crashed,
      ...extra,
    };
  }

  function pluginBrowserWindowHistoryForLoad(
    existing: PluginBrowserWindowState,
    entry: PluginBrowserWindowHistoryEntry,
    reloaded: boolean
  ) {
    if (reloaded) {
      const history = existing.history.length > 0 ? [...existing.history] : [entry];
      const historyIndex = Math.max(0, Math.min(existing.historyIndex, history.length - 1));
      history[historyIndex] = entry;
      return { history, historyIndex };
    }
    const history = existing.history.slice(0, existing.historyIndex + 1);
    history.push(entry);
    return { history, historyIndex: history.length - 1 };
  }

  async function currentPluginBrowserWindowPageTitle(windowId: string, fallback: string) {
    const description = await pluginBrowserWindowRpc.call(windowId, "describe", {});
    const title = description && typeof description === "object"
      ? String((description as Record<string, unknown>).title ?? "").trim()
      : "";
    return title || fallback;
  }

  async function runCurrentPluginBrowserWindowNavigation<T>(
    windowId: string,
    navigationToken: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    pluginBrowserWindowNavigation.assertCurrent(windowId, navigationToken);
    try {
      const result = await operation();
      pluginBrowserWindowNavigation.assertCurrent(windowId, navigationToken);
      return result;
    } catch (error) {
      pluginBrowserWindowNavigation.assertCurrent(windowId, navigationToken);
      throw error;
    }
  }

  async function loadPluginBrowserWindowUrl(existing: PluginBrowserWindowState, url: string, reloaded = false, ignoreCache = false) {
    const nextUrl = url.trim();
    if (!nextUrl) throw new Error("browserWindow loadURL requires a non-empty url");
    const navigationToken = pluginBrowserWindowNavigation.begin(existing.id);
    const html = await runCurrentPluginBrowserWindowNavigation(
      existing.id,
      navigationToken,
      () => pluginBrowserWindowHtml(nextUrl),
    );
    const srcdoc = injectPluginBridge(html, "browserWindow", existing.id);
    const title = reloaded ? existing.title : browserWindowTitle(nextUrl, {});
    const entry = { url: nextUrl, title, srcdoc };
    const nextHistory = pluginBrowserWindowHistoryForLoad(existing, entry, reloaded);
    clearPluginBrowserWindowInsertedCss(existing.id);
    pluginBrowserWindowRpc.invalidate(existing.id, "reloaded");
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
      childWindow.id === existing.id
        ? {
            ...childWindow,
            url: nextUrl,
            title,
            srcdoc,
            documentGeneration: navigationToken,
            visible: true,
            loading: true,
            crashed: false,
            ...nextHistory,
          }
        : childWindow
    );
    lastBrowserWindowMessage = {
      windowId: existing.id,
      channel: reloaded ? "window:reload" : "window:loadURL",
      args: [nextUrl],
    };
    await runCurrentPluginBrowserWindowNavigation(existing.id, navigationToken, () => tick());
    await runCurrentPluginBrowserWindowNavigation(
      existing.id,
      navigationToken,
      () => readyPluginBrowserWindowFrame(existing.id, reloaded ? "webContents.reload" : "webContents.loadURL"),
    );
    const finalTitle = await runCurrentPluginBrowserWindowNavigation(
      existing.id,
      navigationToken,
      () => currentPluginBrowserWindowPageTitle(existing.id, title),
    );
    pluginBrowserWindowNavigation.assertCurrent(existing.id, navigationToken);
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== existing.id) return childWindow;
      updatedWindow = { ...childWindow, title: finalTitle, loading: false, crashed: false };
      updatedWindow.history[updatedWindow.historyIndex] = {
        ...updatedWindow.history[updatedWindow.historyIndex],
        title: finalTitle,
      };
      return updatedWindow;
    });
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, url: nextUrl, title: finalTitle, srcdoc, loading: false, ...nextHistory }, {
      reloaded,
      ignoreCache,
    });
  }

  function stopPluginBrowserWindowLoading(id: string) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.stop failed: browser window ${id} is not active`);
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, loading: false };
      return updatedWindow;
    });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:stop", args: [] };
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, loading: false });
  }

  function focusPluginBrowserWindowWebContents(id: string) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.focus failed: browser window ${id} is not active`);
    const focused = existing.focusable;
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return { ...childWindow, focused: false, webContentsFocused: false };
      updatedWindow = { ...childWindow, visible: true, focused, webContentsFocused: focused };
      return updatedWindow;
    });
    const result = {
      visible: true,
      focused,
      webContentsFocused: focused,
    };
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:focus", args: [] };
    dispatchPluginBrowserWindowEvent(id, "focus", [{ visible: true, focused, closed: false }]);
    return updatedWindow ? { ...result, webContentsMediaSourceId: updatedWindow.webContentsMediaSourceId } : result;
  }

  function setPluginBrowserWindowIgnoreMenuShortcuts(id: string, value: unknown) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setIgnoreMenuShortcuts failed: browser window ${id} is not active`);
    const ignoreMenuShortcuts = value === true;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
      childWindow.id === id ? { ...childWindow, ignoreMenuShortcuts } : childWindow
    );
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setIgnoreMenuShortcuts", args: [ignoreMenuShortcuts] };
    return { ignoreMenuShortcuts };
  }

  function forcefullyCrashPluginBrowserWindowRenderer(id: string) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.forcefullyCrashRenderer failed: browser window ${id} is not active`);
    const details = { reason: "crashed", exitCode: 1 };
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, loading: false, crashed: true };
      return updatedWindow;
    });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:forcefullyCrashRenderer", args: [details] };
    dispatchPluginBrowserWindowWebContentsEvent(id, "render-process-gone", [details]);
    return {
      ...pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, loading: false, crashed: true }),
      reason: details.reason,
      exitCode: details.exitCode,
    };
  }

  async function navigatePluginBrowserWindowHistoryToIndex(
    existing: PluginBrowserWindowState,
    nextIndex: number,
    label: string
  ) {
    if (nextIndex < 0 || nextIndex >= existing.history.length) {
      throw new Error(`${label} failed: history index ${nextIndex} is unavailable`);
    }
    const navigationToken = pluginBrowserWindowNavigation.begin(existing.id);
    const entry = existing.history[nextIndex];
    clearPluginBrowserWindowInsertedCss(existing.id);
    pluginBrowserWindowRpc.invalidate(existing.id, "reloaded");
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
      childWindow.id === existing.id
        ? {
            ...childWindow,
            ...entry,
            documentGeneration: navigationToken,
            historyIndex: nextIndex,
            visible: true,
            loading: true,
            crashed: false,
          }
        : childWindow
    );
    lastBrowserWindowMessage = { windowId: existing.id, channel: label.replace(/\./g, ":"), args: [entry.url] };
    await runCurrentPluginBrowserWindowNavigation(existing.id, navigationToken, () => tick());
    await runCurrentPluginBrowserWindowNavigation(
      existing.id,
      navigationToken,
      () => readyPluginBrowserWindowFrame(existing.id, label),
    );
    const finalTitle = await runCurrentPluginBrowserWindowNavigation(
      existing.id,
      navigationToken,
      () => currentPluginBrowserWindowPageTitle(existing.id, entry.title),
    );
    pluginBrowserWindowNavigation.assertCurrent(existing.id, navigationToken);
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== existing.id) return childWindow;
      const history = [...childWindow.history];
      history[nextIndex] = { ...history[nextIndex], title: finalTitle };
      updatedWindow = { ...childWindow, title: finalTitle, history, loading: false, crashed: false };
      return updatedWindow;
    });
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, ...entry, historyIndex: nextIndex, loading: false });
  }

  async function navigatePluginBrowserWindowHistory(
    existing: PluginBrowserWindowState,
    direction: "back" | "forward"
  ) {
    const nextIndex = direction === "back" ? existing.historyIndex - 1 : existing.historyIndex + 1;
    return navigatePluginBrowserWindowHistoryToIndex(
      existing,
      nextIndex,
      `webContents.go${direction === "back" ? "Back" : "Forward"}`
    );
  }

  function pluginBrowserWindowHistoryIndex(value: unknown, label: string): number {
    const index = Number(value);
    if (!Number.isFinite(index)) throw new Error(`${label} requires a finite history index`);
    return Math.trunc(index);
  }

  function pluginBrowserWindowHistoryOffset(value: unknown, label: string): number {
    const offset = Number(value);
    if (!Number.isFinite(offset)) throw new Error(`${label} requires a finite history offset`);
    return Math.trunc(offset);
  }

  function clearPluginBrowserWindowNavigationHistory(id: string) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.navigationHistory.clear failed: browser window ${id} is not active`);
    const currentEntry = existing.history[existing.historyIndex] || {
      url: existing.url,
      title: existing.title,
      srcdoc: existing.srcdoc,
    };
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = {
        ...childWindow,
        ...currentEntry,
        history: [currentEntry],
        historyIndex: 0,
        loading: false,
        crashed: false,
      };
      return updatedWindow;
    });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:navigationHistory:clear", args: [currentEntry.url] };
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, ...currentEntry, history: [currentEntry], historyIndex: 0, loading: false });
  }

  function pluginBrowserWindowDevToolsResult(childWindow: PluginBrowserWindowState) {
    return {
      devToolsOpened: childWindow.devToolsOpened,
      devToolsFocused: childWindow.devToolsOpened && childWindow.devToolsFocused,
      devToolsMode: childWindow.devToolsMode,
      devToolsTitle: childWindow.devToolsTitle,
    };
  }

  function normalizePluginBrowserWindowDevToolsMode(value: unknown, fallback = "") {
    const mode = typeof value === "string" ? value.trim() : "";
    return ["left", "right", "bottom", "undocked", "detach"].includes(mode) ? mode : fallback;
  }

  function updatePluginBrowserWindowDevTools(id: string, opened: boolean, options: Record<string, unknown> = {}) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents DevTools failed: browser window ${id} is not active`);
    const devToolsMode = opened
      ? normalizePluginBrowserWindowDevToolsMode(options.mode, existing.devToolsMode)
      : existing.devToolsMode;
    const devToolsTitle = opened && typeof options.title === "string"
      ? options.title
      : existing.devToolsTitle;
    const devToolsFocused = opened ? options.activate !== false : false;
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = {
        ...childWindow,
        devToolsOpened: opened,
        devToolsFocused,
        devToolsMode,
        devToolsTitle,
      };
      return updatedWindow;
    });
    const result = pluginBrowserWindowDevToolsResult(updatedWindow || {
      ...existing,
      devToolsOpened: opened,
      devToolsFocused,
      devToolsMode,
      devToolsTitle,
    });
    lastBrowserWindowMessage = {
      windowId: id,
      channel: opened ? "webContents:openDevTools" : "webContents:closeDevTools",
      args: [result],
    };
    dispatchPluginBrowserWindowWebContentsEvent(id, opened ? "devtools-opened" : "devtools-closed", [result]);
    return result;
  }

  async function inspectPluginBrowserWindowElement(id: string, args: unknown[]) {
    void args;
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === id)) {
      throw new Error(`webContents.inspectElement failed: browser window ${id} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.inspectElement");
  }

  async function capturePluginBrowserWindowPage(windowId: string, args: unknown[]) {
    void args;
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.capturePage failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.capturePage");
  }

  function printPluginBrowserWindowPage(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.print failed: browser window ${windowId} is not active`);
    }
    const options = args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
      ? args[0] as Record<string, unknown>
      : {};
    const result = {
      success: false,
      failureReason: "webContents.print is native-only in hosted BrowserWindow",
      options,
    };
    lastBrowserWindowMessage = { windowId, channel: "webContents:print", args: [result] };
    return result;
  }

  async function printPluginBrowserWindowToPdf(windowId: string, args: unknown[]) {
    void args;
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.printToPDF failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.printToPDF");
  }

  async function savePluginBrowserWindowPage(windowId: string, args: unknown[]) {
    void args;
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.savePage failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.savePage");
  }

  function updatePluginBrowserWindowZoomFactor(id: string, factor: number) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setZoomFactor failed: browser window ${id} is not active`);
    const zoomFactor = normalizePluginBrowserWindowZoomFactor(factor);
    const zoomLevel = pluginBrowserWindowZoomLevelFromFactor(zoomFactor);
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, zoomFactor, zoomLevel };
      return updatedWindow;
    });
    const result = pluginBrowserWindowZoomResult(updatedWindow || { ...existing, zoomFactor, zoomLevel });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setZoomFactor", args: [result] };
    return result;
  }

  function updatePluginBrowserWindowZoomLevel(id: string, level: number) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setZoomLevel failed: browser window ${id} is not active`);
    const zoomLevel = normalizePluginBrowserWindowZoomLevel(level, "webContents.setZoomLevel");
    const zoomFactor = pluginBrowserWindowZoomFactorFromLevel(zoomLevel);
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, zoomFactor, zoomLevel };
      return updatedWindow;
    });
    const result = pluginBrowserWindowZoomResult(updatedWindow || { ...existing, zoomFactor, zoomLevel });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setZoomLevel", args: [result] };
    return result;
  }

  function updatePluginBrowserWindowVisualZoomLimits(id: string, minimumValue: unknown, maximumValue: unknown) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setVisualZoomLevelLimits failed: browser window ${id} is not active`);
    const minimumLevel = normalizePluginBrowserWindowZoomLevel(minimumValue, "webContents.setVisualZoomLevelLimits");
    const maximumLevel = normalizePluginBrowserWindowZoomLevel(maximumValue, "webContents.setVisualZoomLevelLimits");
    if (minimumLevel > maximumLevel) {
      throw new Error("webContents.setVisualZoomLevelLimits requires minimumLevel <= maximumLevel");
    }
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
      childWindow.id === id
        ? { ...childWindow, visualZoomMinimumLevel: minimumLevel, visualZoomMaximumLevel: maximumLevel }
        : childWindow
    );
    const result = {
      minimumLevel,
      maximumLevel,
      zoomFactor: existing.zoomFactor,
      zoomLevel: existing.zoomLevel,
    };
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setVisualZoomLevelLimits", args: [result] };
    return result;
  }

  function pluginBrowserWindowAudioResult(childWindow: PluginBrowserWindowState) {
    return {
      audioMuted: childWindow.audioMuted,
      currentlyAudible: childWindow.currentlyAudible,
    };
  }

  function updatePluginBrowserWindowAudioMuted(id: string, mutedValue: unknown) {
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setAudioMuted failed: browser window ${id} is not active`);
    const audioMuted = mutedValue === true;
    const currentlyAudible = audioMuted ? false : existing.currentlyAudible;
    let updatedWindow: PluginBrowserWindowState | undefined;
    pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, audioMuted, currentlyAudible };
      return updatedWindow;
    });
    const result = pluginBrowserWindowAudioResult(updatedWindow || { ...existing, audioMuted, currentlyAudible });
    lastBrowserWindowMessage = { windowId: id, channel: "webContents:setAudioMuted", args: [result] };
    if (existing.currentlyAudible !== currentlyAudible) {
      dispatchPluginBrowserWindowWebContentsEvent(id, "audio-state-changed", [currentlyAudible]);
    }
    return result;
  }

  function dispatchPluginBrowserWindowEvent(windowId: string, event: string, args: unknown[] = []) {
    iframeRef?.contentWindow?.postMessage({
      __atools_browser_window_event__: true,
      windowId,
      event,
      args,
    }, "*");
  }

  function dispatchPluginBrowserWindowWebContentsEvent(windowId: string, event: string, args: unknown[] = []) {
    iframeRef?.contentWindow?.postMessage({
      __atools_browser_window_event__: true,
      windowId,
      target: "webContents",
      event,
      args,
    }, "*");
  }

  function browserWindowDelay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function readyPluginBrowserWindowFrame(windowId: string, errorPrefix: string) {
    const deadline = Date.now() + HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS;
    while (true) {
      const frame = pluginBrowserWindowFrames.get(windowId);
      if (frame?.contentWindow && pluginBrowserWindowRpc.isAttached(windowId)) {
        await pluginBrowserWindowRpc.waitReady(windowId);
        return frame;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await browserWindowDelay(Math.min(25, remainingMs));
    }
    throw new Error(`${errorPrefix} failed: browser window ${windowId} frame is not ready`);
  }

  function postPluginBrowserWindowIpcMessage(windowId: string, channel: string, args: unknown[], attempt = 0) {
    const frame = pluginBrowserWindowFrames.get(windowId);
    const ready = frame?.contentWindow && pluginBrowserWindowRpc.isReady(windowId);
    if (!ready) {
      if (attempt < 40) {
        setTimeout(() => postPluginBrowserWindowIpcMessage(windowId, channel, args, attempt + 1), 25);
      }
      return;
    }
    const targetWindow = frame.contentWindow;
    if (!targetWindow) return;
    targetWindow.postMessage({
      __atools_browser_window_ipc__: true,
      windowId,
      channel,
      args,
    }, "*");
  }

  function dispatchPluginBrowserWindowIpcMessage(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.send failed: browser window ${windowId} is not active`);
    }
    const channel = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!channel) throw new Error("webContents.send requires a non-empty channel");
    const messageArgs = args.slice(1);
    lastBrowserWindowMessage = { windowId, channel: `webContents:${channel}`, args: messageArgs };
    postPluginBrowserWindowIpcMessage(windowId, channel, messageArgs);
    return true;
  }

  async function executePluginBrowserWindowJavaScript(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.executeJavaScript failed: browser window ${windowId} is not active`);
    }
    const code = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    const userGesture = args[1] === true;
    lastBrowserWindowMessage = { windowId, channel: "webContents:executeJavaScript", args: [code, userGesture] };
    try {
      await readyPluginBrowserWindowFrame(windowId, "webContents.executeJavaScript");
      return await pluginBrowserWindowRpc.call(windowId, "executeJavaScript", { code, userGesture });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`webContents.executeJavaScript failed: ${message}`);
    }
  }

  function browserWindowInputString(value: unknown, fallback = "") {
    if (typeof value === "string") return value;
    if (value == null) return fallback;
    return String(value);
  }

  async function dispatchPluginBrowserWindowInputEvent(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.sendInputEvent failed: browser window ${windowId} is not active`);
    }
    const inputEvent = args[0];
    if (!inputEvent || typeof inputEvent !== "object" || Array.isArray(inputEvent)) {
      throw new Error("webContents.sendInputEvent requires an input event object");
    }
    const eventRecord = inputEvent as Record<string, unknown>;
    const eventType = browserWindowInputString(eventRecord.type).trim().toLowerCase();
    if (!eventType) throw new Error("webContents.sendInputEvent requires an input event type");

    lastBrowserWindowMessage = { windowId, channel: "webContents:sendInputEvent", args: [eventRecord] };
    await readyPluginBrowserWindowFrame(windowId, "webContents.sendInputEvent");
    await pluginBrowserWindowRpc.call(windowId, "sendInputEvent", { inputEvent: eventRecord });
    return undefined;
  }

  function clearPluginBrowserWindowInsertedCss(windowId: string) {
    for (const [key, record] of pluginBrowserWindowInsertedCss.entries()) {
      if (record.windowId === windowId) pluginBrowserWindowInsertedCss.delete(key);
    }
  }

  function browserWindowCssOrigin(value: unknown): "author" | "user" {
    return value === "user" ? "user" : "author";
  }

  async function insertPluginBrowserWindowCss(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.insertCSS failed: browser window ${windowId} is not active`);
    }
    const css = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!css) throw new Error("webContents.insertCSS requires CSS text");
    const options = args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
      ? args[1] as Record<string, unknown>
      : {};
    const cssOrigin = browserWindowCssOrigin(options.cssOrigin);
    lastBrowserWindowMessage = { windowId, channel: "webContents:insertCSS", args: [css, { cssOrigin }] };
    const key = `${windowId}:css:${++pluginBrowserWindowCssSeq}`;
    await readyPluginBrowserWindowFrame(windowId, "webContents.insertCSS");
    await pluginBrowserWindowRpc.call(windowId, "insertCSS", { key, css, cssOrigin });
    pluginBrowserWindowInsertedCss.set(key, { windowId, key, css, cssOrigin });
    return key;
  }

  async function removePluginBrowserWindowCss(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.removeInsertedCSS failed: browser window ${windowId} is not active`);
    }
    const key = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!key) throw new Error("webContents.removeInsertedCSS requires a CSS key");
    const record = pluginBrowserWindowInsertedCss.get(key);
    if (!record || record.windowId !== windowId) {
      throw new Error(`webContents.removeInsertedCSS failed: unknown CSS key ${key}`);
    }
    lastBrowserWindowMessage = { windowId, channel: "webContents:removeInsertedCSS", args: [key] };
    await readyPluginBrowserWindowFrame(windowId, "webContents.removeInsertedCSS");
    await pluginBrowserWindowRpc.call(windowId, "removeInsertedCSS", { key });
    pluginBrowserWindowInsertedCss.delete(key);
    return undefined;
  }

  function browserWindowFindRequestId(value: unknown) {
    const numericValue = Number(value);
    if (Number.isInteger(numericValue) && numericValue > 0) return numericValue;
    return ++pluginBrowserWindowFindSeq;
  }

  function browserWindowFindOptions(value: unknown) {
    const options = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return {
      forward: options.forward !== false,
      findNext: options.findNext === true,
      matchCase: options.matchCase === true,
    };
  }

  async function findPluginBrowserWindowInPage(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.findInPage failed: browser window ${windowId} is not active`);
    }
    const text = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!text) throw new Error("webContents.findInPage requires non-empty text");
    const options = browserWindowFindOptions(args[1]);
    const requestId = browserWindowFindRequestId(args[2]);
    lastBrowserWindowMessage = { windowId, channel: "webContents:findInPage", args: [text, options, requestId] };

    await readyPluginBrowserWindowFrame(windowId, "webContents.findInPage");
    const result = await pluginBrowserWindowRpc.call(windowId, "findInPage", {
      text,
      ...options,
      requestId,
    });
    dispatchPluginBrowserWindowWebContentsEvent(windowId, "found-in-page", [result]);
    return requestId;
  }

  function browserWindowStopFindAction(value: unknown) {
    const action = typeof value === "string" ? value.trim() : "";
    if (action === "keepSelection" || action === "activateSelection") return action;
    return "clearSelection";
  }

  async function stopPluginBrowserWindowFindInPage(windowId: string, args: unknown[]) {
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.stopFindInPage failed: browser window ${windowId} is not active`);
    }
    const action = browserWindowStopFindAction(args[0]);
    lastBrowserWindowMessage = { windowId, channel: "webContents:stopFindInPage", args: [action] };
    await readyPluginBrowserWindowFrame(windowId, "webContents.stopFindInPage");
    await pluginBrowserWindowRpc.call(windowId, "stopFindInPage", { action });
    return undefined;
  }

  async function controlPluginBrowserWindowSelection(windowId: string, actionName: string, args: unknown[]) {
    void args;
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`${actionName} failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported(actionName);
  }

  async function editPluginBrowserWindowText(windowId: string, actionName: string, args: unknown[]) {
    void args;
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`${actionName} failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported(actionName);
  }

  function dispatchPluginBrowserWindowParentMessage(args: Record<string, unknown>) {
    const windowType = typeof args.windowType === "string" ? args.windowType : "main";
    const windowId = typeof args.browserWindowId === "string" ? args.browserWindowId.trim() : "";
    if (windowType !== "browserWindow" || !windowId) {
      throw new Error("sendToParent requires a hosted browser window child");
    }
    if (!pluginBrowserWindows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`sendToParent failed: browser window ${windowId} is not active`);
    }
    const channel = typeof args.channel === "string" ? args.channel : String(args.channel ?? "");
    if (!channel) throw new Error("sendToParent requires a non-empty channel");
    const messageArgs = Array.isArray(args.args) ? args.args : [];
    lastBrowserWindowMessage = { windowId, channel, args: messageArgs };
    iframeRef?.contentWindow?.postMessage({
      __atools_browser_window_parent_message__: true,
      windowId,
      channel,
      args: messageArgs,
    }, "*");
    return true;
  }

  function handlePluginBrowserWindowAction(args: Record<string, unknown>) {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const actionName = typeof args.action === "string" ? args.action.trim() : "";
    if (!id) throw new Error("browserWindowAction requires a window id");
    if (!actionName) throw new Error("browserWindowAction requires an action");
    const existing = pluginBrowserWindows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`browserWindowAction failed: browser window ${id} is not active`);
    const actionArgs = browserWindowActionArgs(args);
    if (actionName === "webContents.send") {
      return dispatchPluginBrowserWindowIpcMessage(id, actionArgs);
    }
    if (actionName === "webContents.executeJavaScript") {
      return executePluginBrowserWindowJavaScript(id, actionArgs);
    }
    if (actionName === "webContents.sendInputEvent") {
      return dispatchPluginBrowserWindowInputEvent(id, actionArgs);
    }
    if (actionName === "webContents.insertCSS") {
      return insertPluginBrowserWindowCss(id, actionArgs);
    }
    if (actionName === "webContents.removeInsertedCSS") {
      return removePluginBrowserWindowCss(id, actionArgs);
    }
    if (actionName === "webContents.findInPage") {
      return findPluginBrowserWindowInPage(id, actionArgs);
    }
    if (actionName === "webContents.stopFindInPage") {
      return stopPluginBrowserWindowFindInPage(id, actionArgs);
    }
    if (actionName === "webContents.loadURL") {
      return loadPluginBrowserWindowUrl(existing, String(actionArgs[0] ?? ""), false);
    }
    if (actionName === "webContents.reload") {
      return loadPluginBrowserWindowUrl(existing, existing.url, true);
    }
    if (actionName === "webContents.reloadIgnoringCache") {
      return loadPluginBrowserWindowUrl(existing, existing.url, true, true);
    }
    if (actionName === "webContents.stop") {
      return stopPluginBrowserWindowLoading(id);
    }
    if (actionName === "webContents.focus") {
      return focusPluginBrowserWindowWebContents(id);
    }
    if (actionName === "webContents.setIgnoreMenuShortcuts") {
      return setPluginBrowserWindowIgnoreMenuShortcuts(id, actionArgs[0]);
    }
    if (actionName === "webContents.forcefullyCrashRenderer") {
      return forcefullyCrashPluginBrowserWindowRenderer(id);
    }
    if (actionName === "webContents.goBack") {
      return navigatePluginBrowserWindowHistory(existing, "back");
    }
    if (actionName === "webContents.goForward") {
      return navigatePluginBrowserWindowHistory(existing, "forward");
    }
    if (actionName === "webContents.navigationHistory.goBack") {
      return navigatePluginBrowserWindowHistoryToIndex(existing, existing.historyIndex - 1, "webContents.navigationHistory.goBack");
    }
    if (actionName === "webContents.navigationHistory.goForward") {
      return navigatePluginBrowserWindowHistoryToIndex(existing, existing.historyIndex + 1, "webContents.navigationHistory.goForward");
    }
    if (actionName === "webContents.navigationHistory.goToIndex") {
      const targetIndex = pluginBrowserWindowHistoryIndex(actionArgs[0], "webContents.navigationHistory.goToIndex");
      return navigatePluginBrowserWindowHistoryToIndex(existing, targetIndex, "webContents.navigationHistory.goToIndex");
    }
    if (actionName === "webContents.navigationHistory.goToOffset") {
      const offset = pluginBrowserWindowHistoryOffset(actionArgs[0], "webContents.navigationHistory.goToOffset");
      return navigatePluginBrowserWindowHistoryToIndex(existing, existing.historyIndex + offset, "webContents.navigationHistory.goToOffset");
    }
    if (actionName === "webContents.navigationHistory.clear") {
      return clearPluginBrowserWindowNavigationHistory(id);
    }
    if (actionName === "webContents.openDevTools") {
      const options = actionArgs[0] && typeof actionArgs[0] === "object" && !Array.isArray(actionArgs[0])
        ? actionArgs[0] as Record<string, unknown>
        : {};
      return updatePluginBrowserWindowDevTools(id, true, options);
    }
    if (actionName === "webContents.closeDevTools") {
      return updatePluginBrowserWindowDevTools(id, false);
    }
    if (actionName === "webContents.toggleDevTools") {
      return updatePluginBrowserWindowDevTools(id, !existing.devToolsOpened);
    }
    if (actionName === "webContents.inspectElement") {
      return inspectPluginBrowserWindowElement(id, actionArgs);
    }
    if (actionName === "webContents.capturePage") {
      return capturePluginBrowserWindowPage(id, actionArgs);
    }
    if (actionName === "webContents.print") {
      return printPluginBrowserWindowPage(id, actionArgs);
    }
    if (actionName === "webContents.printToPDF") {
      return printPluginBrowserWindowToPdf(id, actionArgs);
    }
    if (actionName === "webContents.savePage") {
      return savePluginBrowserWindowPage(id, actionArgs);
    }
    if (actionName === "webContents.setUserAgent") {
      return updatePluginBrowserWindowUserAgent(id, actionArgs[0]);
    }
    if (actionName === "webContents.setFrameRate") {
      return updatePluginBrowserWindowFrameRate(id, actionArgs[0]);
    }
    if (actionName === "webContents.setBackgroundThrottling") {
      return updatePluginBrowserWindowBackgroundThrottling(id, actionArgs[0]);
    }
    if ([
      "webContents.centerSelection",
      "webContents.scrollToTop",
      "webContents.scrollToBottom",
      "webContents.adjustSelection",
    ].includes(actionName)) {
      return controlPluginBrowserWindowSelection(id, actionName, actionArgs);
    }
    if ([
      "webContents.insertText",
      "webContents.undo",
      "webContents.redo",
      "webContents.cut",
      "webContents.copy",
      "webContents.paste",
      "webContents.pasteAndMatchStyle",
      "webContents.delete",
      "webContents.selectAll",
      "webContents.unselect",
      "webContents.replace",
      "webContents.replaceMisspelling",
    ].includes(actionName)) {
      return editPluginBrowserWindowText(id, actionName, actionArgs);
    }
    if (actionName === "webContents.setZoomFactor") {
      return updatePluginBrowserWindowZoomFactor(id, Number(actionArgs[0]));
    }
    if (actionName === "webContents.setZoomLevel") {
      return updatePluginBrowserWindowZoomLevel(id, Number(actionArgs[0]));
    }
    if (actionName === "webContents.setVisualZoomLevelLimits") {
      return updatePluginBrowserWindowVisualZoomLimits(id, actionArgs[0], actionArgs[1]);
    }
    if (actionName === "webContents.setAudioMuted") {
      return updatePluginBrowserWindowAudioMuted(id, actionArgs[0]);
    }
    if (actionName === "close") {
      pluginBrowserWindowNavigation.close(id);
      pluginBrowserWindowRpc.close(id);
      pluginMessageSources.unregisterChild(id);
      pluginBrowserWindowFrames.delete(id);
      clearPluginBrowserWindowInsertedCss(id);
      pluginBrowserWindows = pluginBrowserWindows
        .filter((childWindow) => childWindow.id !== id)
        .map((childWindow) => childWindow.parentWindowId === id ? { ...childWindow, parentWindowId: null } : childWindow);
      lastBrowserWindowMessage = { windowId: id, channel: "window:close", args: [] };
      dispatchPluginBrowserWindowEvent(id, "closed", [{ visible: false, focused: false, closed: true }]);
      return { visible: false, focused: false, closed: true };
    }
    if (actionName === "hide") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, visible: false, focused: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:hide", args: [] };
      dispatchPluginBrowserWindowEvent(id, "hide", [{ visible: false, focused: false, closed: false }]);
      return { visible: false, focused: false, closed: false };
    }
    if (actionName === "show" || actionName === "focus") {
      const focused = existing.focusable;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => ({
        ...childWindow,
        visible: childWindow.id === id ? true : childWindow.visible,
        focused: childWindow.id === id ? focused : false,
      }));
      lastBrowserWindowMessage = { windowId: id, channel: `window:${actionName}`, args: [] };
      dispatchPluginBrowserWindowEvent(id, actionName, [{ visible: true, focused, closed: false }]);
      return { visible: true, focused, closed: false };
    }
    if (actionName === "isVisible") {
      return existing.visible;
    }
    if (actionName === "isFocused") {
      return existing.focused;
    }
    if (actionName === "showInactive") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, visible: true, focused: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:showInactive", args: [] };
      dispatchPluginBrowserWindowEvent(id, "show", [{ visible: true, focused: false, closed: false }]);
      return { visible: true, focused: false, closed: false };
    }
    if (actionName === "blur") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, focused: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:blur", args: [] };
      dispatchPluginBrowserWindowEvent(id, "blur", [{ visible: existing.visible, focused: false, closed: false }]);
      return { visible: existing.visible, focused: false, closed: false };
    }
    if (actionName === "getTitle") {
      return existing.title;
    }
    if (actionName === "setTitle") {
      const title = String(actionArgs[0] ?? "").trim().slice(0, 80) || existing.title;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, title } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setTitle", args: [title] };
      return { title };
    }
    if (actionName === "getURL") {
      return existing.url;
    }
    if (actionName === "loadURL") {
      return loadPluginBrowserWindowUrl(existing, String(actionArgs[0] ?? ""), false);
    }
    if (actionName === "reload") {
      return loadPluginBrowserWindowUrl(existing, existing.url, true);
    }
    if (actionName === "minimize") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimized: true, maximized: false, fullScreen: false, focused: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:minimize", args: [] };
      dispatchPluginBrowserWindowEvent(id, "minimize", [{ minimized: true, maximized: false }]);
      return { minimized: true, maximized: false };
    }
    if (actionName === "isMinimized") {
      return existing.minimized;
    }
    if (actionName === "restore") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimized: false, maximized: false, fullScreen: false, visible: true } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:restore", args: [] };
      dispatchPluginBrowserWindowEvent(id, "restore", [{ minimized: false, maximized: false }]);
      return { minimized: false, maximized: false };
    }
    if (actionName === "maximize") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) => ({
        ...childWindow,
        minimized: childWindow.id === id ? false : childWindow.minimized,
        maximized: childWindow.id === id,
        fullScreen: childWindow.id === id ? false : childWindow.fullScreen,
        visible: childWindow.id === id ? true : childWindow.visible,
        focused: childWindow.id === id,
      }));
      lastBrowserWindowMessage = { windowId: id, channel: "window:maximize", args: [] };
      dispatchPluginBrowserWindowEvent(id, "maximize", [{ minimized: false, maximized: true }]);
      return { minimized: false, maximized: true };
    }
    if (actionName === "unmaximize") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, maximized: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:unmaximize", args: [] };
      dispatchPluginBrowserWindowEvent(id, "unmaximize", [{ minimized: existing.minimized, maximized: false }]);
      return { minimized: existing.minimized, maximized: false };
    }
    if (actionName === "isMaximized") {
      return existing.maximized;
    }
    if (actionName === "isAlwaysOnTop") {
      return existing.alwaysOnTop;
    }
    if (actionName === "setAlwaysOnTop") {
      const alwaysOnTop = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, alwaysOnTop } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setAlwaysOnTop", args: [alwaysOnTop] };
      return { alwaysOnTop };
    }
    if (actionName === "getBackgroundColor") {
      return existing.backgroundColor;
    }
    if (actionName === "setBackgroundColor") {
      const backgroundColor = normalizePluginBrowserWindowBackgroundColor(actionArgs[0], existing.backgroundColor);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, backgroundColor } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setBackgroundColor", args: [backgroundColor] };
      return { backgroundColor };
    }
    if (actionName === "setAutoHideMenuBar") {
      const menuBarAutoHide = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuBarAutoHide } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setAutoHideMenuBar", args: [menuBarAutoHide] };
      return { menuBarAutoHide };
    }
    if (actionName === "isMenuBarAutoHide") {
      return existing.menuBarAutoHide;
    }
    if (actionName === "setMenuBarVisibility") {
      const menuBarVisible = actionArgs[0] === true && !existing.menuRemoved;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuBarVisible } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMenuBarVisibility", args: [menuBarVisible] };
      return { menuBarVisible };
    }
    if (actionName === "isMenuBarVisible") {
      return existing.menuBarVisible && !existing.menuRemoved;
    }
    if (actionName === "removeMenu") {
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuRemoved: true, menuBarVisible: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:removeMenu", args: [] };
      return { menuRemoved: true, menuBarVisible: false };
    }
    if (actionName === "setMenu") {
      const menuRemoved = actionArgs[0] == null;
      const menuBarVisible = !menuRemoved;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuRemoved, menuBarVisible } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMenu", args: [actionArgs[0] ?? null] };
      return { menuRemoved, menuBarVisible };
    }
    if (actionName === "setWindowButtonVisibility") {
      const windowButtonVisible = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, windowButtonVisible } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setWindowButtonVisibility", args: [windowButtonVisible] };
      return { windowButtonVisible };
    }
    if (actionName === "setWindowButtonPosition") {
      const windowButtonPosition = normalizePluginBrowserWindowPoint(actionArgs[0]);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, windowButtonPosition } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setWindowButtonPosition", args: [windowButtonPosition] };
      return { windowButtonPosition };
    }
    if (actionName === "getWindowButtonPosition") {
      return existing.windowButtonPosition ? { ...existing.windowButtonPosition } : null;
    }
    if (actionName === "setVibrancy") {
      const vibrancy = pluginBrowserWindowNullableString(actionArgs[0]);
      const vibrancyOptions = pluginBrowserWindowPlainOptions(actionArgs[1]);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, vibrancy, vibrancyOptions } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setVibrancy", args: [vibrancy || null, vibrancyOptions] };
      return { vibrancy, vibrancyOptions };
    }
    if (actionName === "setBackgroundMaterial") {
      const backgroundMaterial = pluginBrowserWindowNullableString(actionArgs[0]) || "none";
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, backgroundMaterial } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setBackgroundMaterial", args: [backgroundMaterial] };
      return { backgroundMaterial };
    }
    if (actionName === "setSheetOffset") {
      const sheetOffsetY = pluginBrowserWindowNumber(actionArgs[0], 0);
      const sheetOffsetX = pluginBrowserWindowNumber(actionArgs[1], 0);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, sheetOffsetY, sheetOffsetX } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setSheetOffset", args: actionArgs.length > 1 ? [sheetOffsetY, sheetOffsetX] : [sheetOffsetY] };
      return { sheetOffsetY, sheetOffsetX };
    }
    if (actionName === "isNormal") {
      return !existing.minimized && !existing.maximized && !existing.fullScreen && !existing.kiosk;
    }
    if (actionName === "isModal") {
      return existing.modal;
    }
    if (actionName === "setDocumentEdited") {
      const documentEdited = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, documentEdited } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setDocumentEdited", args: [documentEdited] };
      return { documentEdited };
    }
    if (actionName === "isDocumentEdited") {
      return existing.documentEdited;
    }
    if (actionName === "setRepresentedFilename") {
      const representedFilename = String(actionArgs[0] ?? "");
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, representedFilename } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setRepresentedFilename", args: [representedFilename] };
      return { representedFilename };
    }
    if (actionName === "getRepresentedFilename") {
      return existing.representedFilename;
    }
    if (actionName === "setParentWindow") {
      const requestedParentWindowId = typeof actionArgs[0] === "string" && actionArgs[0].trim() ? actionArgs[0].trim() : null;
      if (requestedParentWindowId === id) throw new Error("setParentWindow failed: a window cannot parent itself");
      if (requestedParentWindowId && !pluginBrowserWindows.some((childWindow) => childWindow.id === requestedParentWindowId)) {
        throw new Error(`setParentWindow failed: parent window ${requestedParentWindowId} is not active`);
      }
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, parentWindowId: requestedParentWindowId } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setParentWindow", args: [requestedParentWindowId] };
      return { parentWindowId: requestedParentWindowId };
    }
    if (actionName === "getParentWindow") {
      return existing.parentWindowId;
    }
    if (actionName === "getChildWindows") {
      return pluginBrowserWindows.filter((childWindow) => childWindow.parentWindowId === id).map((childWindow) => childWindow.id);
    }
    if (actionName === "getBounds") {
      return pluginBrowserWindowBounds(existing);
    }
    if (actionName === "setBounds") {
      const bounds = normalizePluginBrowserWindowBounds(actionArgs[0], pluginBrowserWindowBounds(existing), existing);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...bounds, positioned: true } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setBounds", args: [bounds] };
      dispatchPluginBrowserWindowEvent(id, "resize", [{ width: bounds.width, height: bounds.height, bounds }]);
      dispatchPluginBrowserWindowEvent(id, "move", [{ x: bounds.x, y: bounds.y, bounds }]);
      return bounds;
    }
    if (actionName === "getSize") {
      return [existing.width, existing.height];
    }
    if (actionName === "setSize") {
      const size = browserWindowSizeFromArgs(actionArgs, pluginBrowserWindowBounds(existing), existing);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...size } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setSize", args: [size] };
      dispatchPluginBrowserWindowEvent(id, "resize", [{ width: size.width, height: size.height }]);
      return [size.width, size.height];
    }
    if (actionName === "getContentSize") {
      return [existing.width, existing.height];
    }
    if (actionName === "setContentSize") {
      const size = browserWindowSizeFromArgs(actionArgs, pluginBrowserWindowBounds(existing), existing);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...size } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setContentSize", args: [size, actionArgs[2] === true] };
      dispatchPluginBrowserWindowEvent(id, "resize", [{ width: size.width, height: size.height, contentSize: true }]);
      return [size.width, size.height];
    }
    if (actionName === "setMinimumSize") {
      const requested = browserWindowSizeFromArgs(actionArgs, { width: existing.minimumWidth, height: existing.minimumHeight }, {
        minimumWidth: PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
        minimumHeight: PLUGIN_BROWSER_WINDOW_MIN_HEIGHT,
        maximumWidth: PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
        maximumHeight: PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
      });
      const minimumWidth = requested.width;
      const minimumHeight = requested.height;
      const maximumWidth = Math.max(existing.maximumWidth, minimumWidth);
      const maximumHeight = Math.max(existing.maximumHeight, minimumHeight);
      const size = constrainPluginBrowserWindowSize(pluginBrowserWindowBounds(existing), {
        minimumWidth,
        minimumHeight,
        maximumWidth,
        maximumHeight,
      });
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimumWidth, minimumHeight, maximumWidth, maximumHeight, ...size } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMinimumSize", args: [[minimumWidth, minimumHeight]] };
      if (size.width !== existing.width || size.height !== existing.height) {
        dispatchPluginBrowserWindowEvent(id, "resize", [{ width: size.width, height: size.height, constrained: true }]);
      }
      return [minimumWidth, minimumHeight];
    }
    if (actionName === "getMinimumSize") {
      return [existing.minimumWidth, existing.minimumHeight];
    }
    if (actionName === "setMaximumSize") {
      const requested = browserWindowSizeFromArgs(actionArgs, { width: existing.maximumWidth, height: existing.maximumHeight }, {
        minimumWidth: existing.minimumWidth,
        minimumHeight: existing.minimumHeight,
        maximumWidth: PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
        maximumHeight: PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
      });
      const maximumWidth = requested.width;
      const maximumHeight = requested.height;
      const size = constrainPluginBrowserWindowSize(pluginBrowserWindowBounds(existing), {
        minimumWidth: existing.minimumWidth,
        minimumHeight: existing.minimumHeight,
        maximumWidth,
        maximumHeight,
      });
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, maximumWidth, maximumHeight, ...size } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMaximumSize", args: [[maximumWidth, maximumHeight]] };
      if (size.width !== existing.width || size.height !== existing.height) {
        dispatchPluginBrowserWindowEvent(id, "resize", [{ width: size.width, height: size.height, constrained: true }]);
      }
      return [maximumWidth, maximumHeight];
    }
    if (actionName === "getMaximumSize") {
      return [existing.maximumWidth, existing.maximumHeight];
    }
    if (actionName === "setAspectRatio") {
      const ratioValue = typeof actionArgs[0] === "number" ? actionArgs[0] : Number(actionArgs[0]);
      const aspectRatio = Number.isFinite(ratioValue) && ratioValue > 0 ? ratioValue : 0;
      const aspectRatioExtraSize = pluginBrowserWindowAspectRatioExtraSize(actionArgs[1]);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, aspectRatio, aspectRatioExtraSize } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setAspectRatio", args: [aspectRatio, aspectRatioExtraSize] };
      return { aspectRatio, aspectRatioExtraSize };
    }
    if (actionName === "getPosition") {
      return [existing.x, existing.y];
    }
    if (actionName === "setPosition") {
      const position = browserWindowPositionFromArgs(actionArgs, pluginBrowserWindowBounds(existing));
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...position, positioned: true } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setPosition", args: [position] };
      dispatchPluginBrowserWindowEvent(id, "move", [{ x: position.x, y: position.y }]);
      return [position.x, position.y];
    }
    if (actionName === "center") {
      const bounds = { ...pluginBrowserWindowBounds(existing), x: 0, y: 0 };
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, x: 0, y: 0, positioned: false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:center", args: [] };
      dispatchPluginBrowserWindowEvent(id, "move", [{ x: 0, y: 0, centered: true }]);
      return { ...bounds, centered: true };
    }
    if (actionName === "isResizable") {
      return existing.resizable;
    }
    if (actionName === "setResizable") {
      const resizable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, resizable } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setResizable", args: [resizable] };
      return { resizable };
    }
    if (actionName === "isMovable") {
      return existing.movable;
    }
    if (actionName === "setMovable") {
      const movable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, movable } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMovable", args: [movable] };
      return { movable };
    }
    if (actionName === "isClosable") {
      return existing.closable;
    }
    if (actionName === "setClosable") {
      const closable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, closable } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setClosable", args: [closable] };
      return { closable };
    }
    if (actionName === "isMinimizable") {
      return existing.minimizable;
    }
    if (actionName === "setMinimizable") {
      const minimizable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimizable } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMinimizable", args: [minimizable] };
      return { minimizable };
    }
    if (actionName === "isMaximizable") {
      return existing.maximizable;
    }
    if (actionName === "setMaximizable") {
      const maximizable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, maximizable } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setMaximizable", args: [maximizable] };
      return { maximizable };
    }
    if (actionName === "isFullScreen") {
      return existing.fullScreen;
    }
    if (actionName === "setFullScreen") {
      const requestedFullScreen = actionArgs[0] === true;
      const fullScreen = requestedFullScreen && existing.fullScreenable;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id
          ? { ...childWindow, fullScreen, minimized: false, maximized: false, visible: true, focused: fullScreen || childWindow.focused }
          : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setFullScreen", args: [fullScreen] };
      dispatchPluginBrowserWindowEvent(id, fullScreen ? "enter-full-screen" : "leave-full-screen", [{ fullScreen }]);
      return { fullScreen };
    }
    if (actionName === "isFullScreenable") {
      return existing.fullScreenable;
    }
    if (actionName === "setFullScreenable") {
      const fullScreenable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, fullScreenable, fullScreen: fullScreenable ? childWindow.fullScreen : false } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setFullScreenable", args: [fullScreenable] };
      return { fullScreenable };
    }
    if (actionName === "getOpacity") {
      return existing.opacity;
    }
    if (actionName === "setOpacity") {
      const opacity = browserWindowOpacity(actionArgs[0]);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, opacity } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setOpacity", args: [opacity] };
      return { opacity };
    }
    if (actionName === "hasShadow") {
      return existing.hasShadow;
    }
    if (actionName === "setHasShadow") {
      const hasShadow = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, hasShadow } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setHasShadow", args: [hasShadow] };
      return { hasShadow };
    }
    if (actionName === "invalidateShadow") {
      lastBrowserWindowMessage = { windowId: id, channel: "window:invalidateShadow", args: [] };
      return { hasShadow: existing.hasShadow };
    }
    if (actionName === "setSkipTaskbar") {
      const skipTaskbar = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, skipTaskbar } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setSkipTaskbar", args: [skipTaskbar] };
      return { skipTaskbar };
    }
    if (actionName === "isKiosk") {
      return existing.kiosk;
    }
    if (actionName === "setKiosk") {
      const kiosk = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, kiosk, minimized: false, maximized: false, visible: true, focused: kiosk || childWindow.focused } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setKiosk", args: [kiosk] };
      return { kiosk };
    }
    if (actionName === "isVisibleOnAllWorkspaces") {
      return existing.visibleOnAllWorkspaces;
    }
    if (actionName === "setVisibleOnAllWorkspaces") {
      const visibleOnAllWorkspaces = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, visibleOnAllWorkspaces } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setVisibleOnAllWorkspaces", args: [visibleOnAllWorkspaces, actionArgs[1] || {}] };
      return { visibleOnAllWorkspaces };
    }
    if (actionName === "isContentProtected") {
      return existing.contentProtected;
    }
    if (actionName === "setContentProtection") {
      const contentProtected = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, contentProtected } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setContentProtection", args: [contentProtected] };
      return { contentProtected };
    }
    if (actionName === "isFocusable") {
      return existing.focusable;
    }
    if (actionName === "setFocusable") {
      const focusable = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, focusable } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setFocusable", args: [focusable] };
      return { focusable };
    }
    if (actionName === "flashFrame") {
      const flashing = actionArgs[0] === true;
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, flashing } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:flashFrame", args: [flashing] };
      return { flashing };
    }
    if (actionName === "setProgressBar") {
      const progressState = browserWindowProgressState(actionArgs[0], actionArgs[1]);
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...progressState } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:setProgressBar", args: [progressState.progressBar, progressState.progressBarMode] };
      return progressState;
    }
    if (actionName === "getMediaSourceId") {
      return existing.mediaSourceId;
    }
    if (actionName === "moveTop") {
      const zOrder = nextPluginBrowserWindowZOrder();
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, zOrder } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:moveTop", args: [zOrder] };
      return { zOrder };
    }
    if (actionName === "moveAbove") {
      const mediaSourceId = String(actionArgs[0] ?? "").trim();
      const sourceWindow = pluginBrowserWindows.find((childWindow) => childWindow.mediaSourceId === mediaSourceId);
      if (!sourceWindow) throw new Error(`moveAbove failed: mediaSourceId ${mediaSourceId || "(empty)"} is not active`);
      const zOrder = Math.max(sourceWindow.zOrder + 1, nextPluginBrowserWindowZOrder());
      pluginBrowserWindows = pluginBrowserWindows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, zOrder } : childWindow
      );
      lastBrowserWindowMessage = { windowId: id, channel: "window:moveAbove", args: [mediaSourceId, zOrder] };
      return { zOrder, mediaSourceId };
    }
    throw new Error(`Unsupported browserWindowAction: ${actionName}`);
  }

  function closePluginBrowserWindow(id: string) {
    try {
      handlePluginBrowserWindowAction({ id, action: "close" });
    } catch (err) {
      console.warn("[PluginPanel] browser window close failed:", err);
    }
  }

  function pluginMainFrame(node: HTMLIFrameElement) {
    const registerSource = () => pluginMessageSources.setMain(node.contentWindow);
    const reportReady = () => {
      registerSource();
      if (pluginReadyReported || (!iframeSrc && !iframeSrcDoc)) return;
      pluginReadyReported = true;
      void Promise.resolve(onready?.())
        .catch((error) => console.warn("[PluginPanel] plugin load callback failed:", error));
    };
    registerSource();
    node.addEventListener("load", reportReady);
    return {
      destroy() {
        node.removeEventListener("load", reportReady);
        pluginMessageSources.unregisterMain(node.contentWindow);
      },
    };
  }

  function pluginBrowserWindowFrame(node: HTMLIFrameElement, windowId: string) {
    let currentWindowId = windowId;
    const markReady = () => {
      pluginMessageSources.registerChild(currentWindowId, node.contentWindow);
      if (node.contentWindow) {
        pluginBrowserWindowRpc.attach(currentWindowId, node.contentWindow);
      }
    };
    pluginBrowserWindowFrames.set(currentWindowId, node);
    pluginMessageSources.registerChild(currentWindowId, node.contentWindow);
    node.addEventListener("load", markReady);
    return {
      update(nextWindowId: string) {
        if (nextWindowId === currentWindowId) return;
        pluginMessageSources.unregisterChild(currentWindowId, node.contentWindow);
        pluginBrowserWindowRpc.close(currentWindowId);
        pluginBrowserWindowFrames.delete(currentWindowId);
        currentWindowId = nextWindowId;
        pluginBrowserWindowFrames.set(currentWindowId, node);
        pluginMessageSources.registerChild(currentWindowId, node.contentWindow);
      },
      destroy() {
        node.removeEventListener("load", markReady);
        pluginMessageSources.unregisterChild(currentWindowId, node.contentWindow);
        pluginBrowserWindowRpc.close(currentWindowId);
        pluginBrowserWindowFrames.delete(currentWindowId);
      },
    };
  }

  async function handleNativeBridgeMethod(method: string, args: Record<string, unknown> = {}) {
    switch (method) {
      case "showOpenDialog":
        if (pluginDialogSmokeGuardEnabled()) throw new Error(dialogSmokeGuardError("showOpenDialog"));
        return openDialog(normalizeDialogBridgeOptions(args.options));
      case "showSaveDialog":
        if (pluginDialogSmokeGuardEnabled()) throw new Error(dialogSmokeGuardError("showSaveDialog"));
        return saveDialog(normalizeDialogBridgeOptions(args.options));
      case "copyImage": {
        await writePluginImageToClipboard(args.image);
        return null;
      }
      case "copyFile": {
        const path = pathFromBridgeValue(args.file);
        await runAppleScript(
          `set the clipboard to (POSIX file ${appleScriptString(path)})`,
          "copyFile"
        );
        return null;
      }
      case "getCopyedFiles": {
        const output = await runAppleScript(`
set clipboardItems to the clipboard as list
set output to {}
repeat with itemRef in clipboardItems
  try
    set end of output to POSIX path of itemRef
  end try
end repeat
set AppleScript's text item delimiters to linefeed
return output as text
`, "getCopyedFiles");
        return normalizeCopiedFileEntries(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      }
      case "shellShowItemInFolder": {
        const path = pathFromBridgeValue(args.path);
        await runCommand("open", ["-R", path], "shellShowItemInFolder");
        return null;
      }
      case "shellTrashItem": {
        const path = normalizeShellTrashPath(pathFromBridgeValue(args.path));
        await runAppleScript(shellTrashAppleScript(path), "shellTrashItem");
        return null;
      }
      case "shellBeep": {
        await runAppleScript("beep", "shellBeep");
        return true;
      }
      case "hideMainWindowPasteText": {
        await writeText(typeof args.text === "string" ? args.text : String(args.text ?? ""));
        await hideMainWindowForPluginPaste();
        await runAppleScript(
          'tell application "System Events" to keystroke "v" using command down',
          "hideMainWindowPasteText"
        );
        return null;
      }
      case "hideMainWindowPasteImage": {
        await writePluginImageToClipboard(args.image);
        await hideMainWindowForPluginPaste();
        await runAppleScript(
          'tell application "System Events" to keystroke "v" using command down',
          "hideMainWindowPasteImage"
        );
        return null;
      }
      case "hideMainWindowPasteFile": {
        await runAppleScript(
          pluginFileClipboardAppleScript(pathsFromBridgeValue(args.file)),
          "hideMainWindowPasteFile"
        );
        await hideMainWindowForPluginPaste();
        await runAppleScript(
          'tell application "System Events" to keystroke "v" using command down',
          "hideMainWindowPasteFile"
        );
        return null;
      }
      case "hideMainWindowTypeString": {
        await hideMainWindowForPluginPaste();
        await runAppleScript(
          `tell application "System Events" to keystroke ${appleScriptString(String(args.text ?? ""))}`,
          "hideMainWindowTypeString"
        );
        return null;
      }
      case "screenCapture": {
        return invoke<string>("screen_capture");
      }
      case "screenColorPick": {
        return pickScreenColorWithEyeDropper();
      }
      case "desktopCaptureSources": {
        return desktopCaptureSourcesForDisplay(args.options, window.screen, window.devicePixelRatio);
      }
      case "readCurrentBrowserUrl": {
        const output = await runAppleScript(`
set frontApp to ""
tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is "Google Chrome" or frontApp is "Chromium" or frontApp is "Microsoft Edge" then
  tell application frontApp to return URL of active tab of front window
else if frontApp is "Safari" then
  tell application "Safari" to return URL of front document
else
  return ""
end if
`, "readCurrentBrowserUrl");
        return output.trim() || null;
      }
      case "readCurrentFolderPath": {
        const output = await runAppleScript(`
tell application "Finder"
  if (count of Finder windows) is 0 then
    return POSIX path of (path to desktop)
  end if
  return POSIX path of (target of front Finder window as alias)
end tell
`, "readCurrentFolderPath");
        return output.trim() || null;
      }
      case "simulateKeyboardTap": {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        throw new Error(
          key
            ? `simulateKeyboardTap unsupported: keyboard automation is not available for ${key}`
            : "simulateKeyboardTap unsupported: keyboard automation is not available"
        );
      }
      case "startDrag": {
        throw new Error("startDrag unsupported: native file dragging is not available in the current WebView host");
      }
      case "redirect": {
        if (!onredirect) {
          throw new Error("redirect unsupported: plugin feature navigation is not available in the current host");
        }
        return await onredirect(args.label, Object.prototype.hasOwnProperty.call(args, "payload") ? args.payload : null);
      }
      case "redirectHotKeySetting": {
        if (!onsettingsredirect) {
          throw new Error("settings redirect unsupported: settings navigation is not available in the current host");
        }
        return await onsettingsredirect("shortcuts", {
          cmdLabel: typeof args.cmdLabel === "string" ? args.cmdLabel : String(args.cmdLabel ?? ""),
          autocopy: args.autocopy === true,
        });
      }
      case "redirectAiModelsSetting": {
        if (!onsettingsredirect) {
          throw new Error("settings redirect unsupported: settings navigation is not available in the current host");
        }
        return await onsettingsredirect("ai", {});
      }
      case "createBrowserWindow": {
        return createPluginBrowserWindow(args);
      }
      case "sendToParent": {
        return dispatchPluginBrowserWindowParentMessage(args);
      }
      case "browserWindowAction": {
        return handlePluginBrowserWindowAction(args);
      }
      case "shellOpenPath":
      case "shellOpenExternal": {
        const path = pathFromBridgeValue(args.path || args.url);
        await shellOpen(path);
        return null;
      }
      default:
        throw new Error(`Unsupported native bridge method: ${method}`);
    }
  }

  async function handleNativeBridgeCall(
    e: MessageEvent,
    data: NativeBridgeCall,
    sourceIdentity: PluginFrameIdentity,
  ) {
    if (!isPluginBridgeRequestId(data.reqId)) return;
    try {
      const permission = nativePermissionForMethod(data.method);
      await ensureHostPluginPermission(permission, e.source as Window | null);
      const result = await runPluginFrameOperation({
        source: e.source,
        identity: sourceIdentity,
        sources: pluginMessageSources,
        operation: () => {
          const args = bindNativeBridgeArgsToSource(data.method, data.args || {}, sourceIdentity);
          return handleNativeBridgeMethod(data.method, args);
        },
      });
      postPluginFrameMessageIfCurrent({
        source: e.source,
        identity: sourceIdentity,
        sources: pluginMessageSources,
        message: {
          __atools_native_response__: true,
          reqId: data.reqId,
          result,
        },
      });
    } catch (err) {
      postPluginFrameMessageIfCurrent({
        source: e.source,
        identity: sourceIdentity,
        sources: pluginMessageSources,
        message: {
          __atools_native_response__: true,
          reqId: data.reqId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  function handleRuntimeResourceResolveCall(e: MessageEvent, data: RuntimeResourceResolveCall) {
    try {
      const url = typeof data.url === "string" ? data.url : String(data.url ?? "");
      const baseDir = runtimeResourceBaseDir(data.baseDir);
      const resolved = action.plugin_path && action.plugin_path !== WEB_PREVIEW_PLUGIN_PATH
        ? convertPluginResourceUrl(url, {
            pluginDir: action.plugin_path,
            mainFile: action.main_url || "index.html",
            convertFileSrc,
          }, baseDir)
        : url;
      (e.source as Window)?.postMessage({
        __atools_resource_response__: true,
        reqId: data.reqId,
        url: resolved,
      }, "*");
    } catch (err) {
      (e.source as Window)?.postMessage({
        __atools_resource_response__: true,
        reqId: data.reqId,
        error: err instanceof Error ? err.message : String(err),
      }, "*");
    }
  }

  function handleUiHostProbeResult(data: Record<string, unknown>) {
    const pluginId = typeof data.pluginId === "string" ? data.pluginId : "";
    const featureCode = typeof data.featureCode === "string" ? data.featureCode : "";
    if (pluginId && pluginId !== action.plugin_id) return;
    if (featureCode && featureCode !== action.feature_code) return;
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
    uiHostProbeResult = {
      pluginId: pluginId || action.plugin_id,
      featureCode: featureCode || action.feature_code,
      passed: normalized.length - failedIds.length,
      total: normalized.length,
      failedIds,
    };
  }

  function handleRealEntryFixtureProbeResult(data: Record<string, unknown>) {
    const pluginId = typeof data.pluginId === "string" ? data.pluginId : "";
    const featureCode = typeof data.featureCode === "string" ? data.featureCode : "";
    if (pluginId && pluginId !== action.plugin_id) return;
    if (featureCode && featureCode !== action.feature_code) return;
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
      { id: "plugin-panel-iframe-src", passed: Boolean(iframeSrc) },
      ...fixtureProbes,
    ];
    const failedIds = panelProbes.filter((probe) => !probe.passed).map((probe) => probe.id);
    handleUiHostProbeResult({
      pluginId: pluginId || action.plugin_id,
      featureCode: featureCode || action.feature_code,
      probes: panelProbes,
    });
    const payload = previewPayload();
    if (payload.realEntryFixture === true && window.parent !== window) {
      window.parent.postMessage({
        __atools_plugin_panel_real_entry_probe__: true,
        pluginId: pluginId || action.plugin_id,
        featureCode: featureCode || action.feature_code,
        fixtureSrc: iframeSrc,
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
        await invoke("hide_main_window");
      } else {
        closePluginPanel();
      }
      return;
    }
    if (data.action === "show" && "__TAURI_INTERNALS__" in window) {
      await invoke("show_main_window");
    }
  }

  type FindableWindow = Window & {
    find?: (
      text: string,
      caseSensitive?: boolean,
      backwards?: boolean,
      wrapAround?: boolean,
      wholeWord?: boolean,
      searchInFrames?: boolean,
      showDialog?: boolean
    ) => boolean;
  };

  function runPluginFindInPage(text: unknown, options: Record<string, unknown> = {}) {
    const query = typeof text === "string" ? text : String(text ?? "");
    if (!query) return;
    try {
      const pluginWindow = iframeRef?.contentWindow as FindableWindow | null;
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
      iframeRef?.contentWindow?.getSelection?.()?.removeAllRanges();
    } catch (err) {
      console.info("[PluginPanel] selection clear unavailable for sandboxed plugin iframe:", err);
    }
  }

  function stopPluginFindInPage(action: unknown) {
    const mode = typeof action === "string" ? action : "clearSelection";
    if (mode === "keepSelection" || mode === "activateSelection") return;
    clearMainPluginSelection();
  }

  // Unified message handler for iframe communication
  function handleMessage(e: MessageEvent) {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    const sourceIdentity = identifyPluginMessageEvent(pluginMessageSources, e);
    if (!sourceIdentity) return;
    if (
      sourceIdentity.kind === "child"
      && !pluginBrowserWindows.some((childWindow) => childWindow.id === sourceIdentity.windowId)
    ) {
      pluginMessageSources.unregisterChild(sourceIdentity.windowId, e.source);
      return;
    }

    if (data.__atools_permission_request__) {
      handlePluginPermissionRequest(e, data as Record<string, unknown>);
      return;
    }

    if (data.__atools_resource_resolve__) {
      handleRuntimeResourceResolveCall(e, data as RuntimeResourceResolveCall);
      return;
    }

    if (data.__atools_native_call__) {
      handleNativeBridgeCall(e, data as NativeBridgeCall, sourceIdentity);
      return;
    }

    if (data.__ipc_call__) {
      void dispatchPluginInvokeMessage({
        source: e.source,
        message: data,
        sources: pluginMessageSources,
        pluginId: action.plugin_id,
        authorize: (permission) => ensureHostPluginPermission(permission, e.source as Window | null),
        invoke: (command, args) => invoke(command, args),
      })
        .then((dispatch) => {
          if (!dispatch.handled) return;
          postPluginFrameMessageIfCurrent({
            source: e.source,
            identity: dispatch.identity,
            sources: pluginMessageSources,
            message: {
              __ipc_response__: true,
              reqId: dispatch.request.reqId,
              result: dispatch.result,
            },
          });
        })
        .catch((error) => {
          if (!isPluginBridgeRequestId(data.reqId)) return;
          postPluginFrameMessageIfCurrent({
            source: e.source,
            identity: sourceIdentity,
            sources: pluginMessageSources,
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
      handleDesktopSmokeBridgeProbe(data as Record<string, unknown>);
      return;
    }

    if (data.__atools_ui_host_probe_result__) {
      handleUiHostProbeResult(data as Record<string, unknown>);
      return;
    }

    if (data.__atools_real_entry_fixture_probe__) {
      handleRealEntryFixtureProbeResult(data as Record<string, unknown>);
      return;
    }

    if (data.__ipc_plugin_contextmenu__) {
      handlePluginContextMenu(data as Record<string, unknown>);
      return;
    }

    if (data.__ipc_main_window__) {
      void handleMainWindowLifecycle(data as Record<string, unknown>)
        .catch((err) => console.warn("[PluginPanel] main window lifecycle failed:", err));
      return;
    }

    if (data.__ipc_find_in_page__) {
      runPluginFindInPage(data.text, data.options || {});
      return;
    }

    if (data.__ipc_stop_find_in_page__) {
      stopPluginFindInPage(data.action);
      return;
    }

    // Handle close requests from iframe
    if (data.__ipc_close__) {
      closePluginPanel();
      return;
    }

    // Handle subinput requests from iframe
    if (data.__ipc_subinput__) {
      const opts = data.opts || {};
      subInputOpts = { ...subInputOpts, ...opts };
      if ("value" in opts) {
        subInputValue = String(opts.value || "");
      }
      return;
    }

    if (data.__ipc_subinput_focus__) {
      const shouldFocus = data.action !== "blur";
      const shouldSelect = data.action === "select";
      subInputOpts = { ...subInputOpts, focus: shouldFocus };
      setTimeout(() => {
        if (shouldFocus) {
          subInputRef?.focus();
          if (shouldSelect) subInputRef?.select();
        } else {
          subInputRef?.blur();
        }
      }, 0);
      return;
    }

    if (data.__ipc_subinput_remove__) {
      subInputOpts = {};
      subInputValue = "";
      setTimeout(() => subInputRef?.blur(), 0);
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
      dynamicFeatures = nextFeatures
        .filter((feature): feature is DynamicPluginFeature => feature !== null);
      return;
    }

    if (data.__ipc_register_tool__) {
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (name && !registeredTools.includes(name)) {
        registeredTools = [...registeredTools, name];
      }
      return;
    }

    if (data.__ipc_plugin_height__) {
      const height = Number(data.height);
      if (Number.isFinite(height) && height > 0) {
        requestedPluginHeight = Math.max(120, Math.min(900, Math.round(height)));
      }
      return;
    }

    // Handle plugin output from iframe
    if (data.__ipc_out__) {
      pluginItems = normalizePluginOutputItems(data.data);
      selectedIndex = 0;
      // Fire output event
      if (onoutput) {
        onoutput({
          items: pluginItems,
          plugin_id: action.plugin_id,
          feature_code: action.feature_code
        });
      }
      return;
    }

  }
</script>

<svelte:window onmessage={handleMessage} onclick={closeOutputContextMenu} />

<div class="plugin-panel">
  <div class="plugin-header">
    <div class="header-left">
      <button class="back-btn" onclick={closePluginPanel} title="返回">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
        <span>返回</span>
      </button>
      <div class="title-block">
        <div class="plugin-title">{hostView.chrome.title}</div>
        <div class="feature-code">{hostView.chrome.feature}</div>
      </div>
    </div>
    <div class="plugin-actions" aria-label="插件操作">
      {#each hostView.actions.slice(1) as chromeAction}
        <button class="chrome-action" disabled={!chromeAction.available} title={chromeAction.available ? chromeAction.label : `${chromeAction.label}未接入`} onclick={() => handlePluginChromeAction(chromeAction.id)}>
          {chromeAction.label}
        </button>
      {/each}
    </div>
    <div class="plugin-source">{hostView.chrome.source}</div>
  </div>

  <div class="plugin-runtime-strip" aria-label="插件运行状态">
    {#each hostView.runtimeChips as chip}
      <div class="runtime-chip" class:ready={chip.tone === "ready"} class:warning={chip.tone === "warning"} class:error={chip.tone === "error"} class:muted={chip.tone === "muted"}>
        <span>{chip.label}</span>
        <strong>{chip.value}</strong>
        <small>{chip.detail}</small>
      </div>
    {/each}
  </div>

  {#if hasSubInput}
    <div class="sub-input-row">
      <input
        bind:this={subInputRef}
        type="text"
        class="sub-input"
        placeholder={subInputOpts.placeholder || "输入关键词"}
        bind:value={subInputValue}
        oninput={handleSubInputChange}
        onkeydown={handleSubInputKeydown}
      />
    </div>
  {/if}

  <div class="plugin-body">
    {#if hostView.bodyMode === "error"}
      <div class="plugin-error">
        <div class="err-icon">!</div>
        <div class="err-message">{hostView.loadError}</div>
      </div>
    {:else if hostView.bodyMode === "output"}
      <div class={hostView.outputLayerClass}>
        <div class="results-list">
          {#each hostView.outputRows as item, i (`${item.title}-${i}`)}
            <button
              class="result-item"
              class:selected={item.selected}
              onclick={() => handleItemClick(i)}
              oncontextmenu={(event) => openOutputContextMenu(event, i)}
            >
              <div class="result-content">
                <div class="result-title">{item.title}</div>
                {#if item.description}
                  <div class="result-description">{item.description}</div>
                {/if}
              </div>
              {#if item.actionHint}
                <span class="result-hint">{item.actionHint}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
      {#if outputContextMenu.visible}
        <div
          class="plugin-output-menu"
          role="menu"
          style={`left:${outputContextMenu.x}px;top:${outputContextMenu.y}px;`}
        >
          <button
            type="button"
            role="menuitem"
            onclick={(event) => {
              event.stopPropagation();
              copyOutputContextMenuItem();
            }}
          >复制结果</button>
        </div>
      {/if}
    {:else if hostView.bodyMode === "loading"}
      <div class="plugin-loading">
        <div class="spinner"></div>
        <div class="loading-text">加载插件中...</div>
      </div>
    {:else}
      <iframe
        bind:this={iframeRef}
        use:pluginMainFrame
        src={iframeSrc || undefined}
        srcdoc={iframeSrc ? undefined : iframeSrcDoc}
        class={hostView.iframeClass}
        title="Plugin"
        sandbox={PLUGIN_IFRAME_SANDBOX}
      ></iframe>
    {/if}
    {#if pluginBrowserWindows.length > 0}
      <div class="plugin-browser-window-layer" aria-label="插件子窗口">
        {#each pluginBrowserWindows as childWindow (childWindow.id)}
          <section
            class="plugin-browser-window"
            class:hidden={!childWindow.visible}
            class:focused={childWindow.focused}
            class:positioned={childWindow.positioned}
            class:alwaysOnTop={childWindow.alwaysOnTop}
            class:minimized={childWindow.minimized}
            class:maximized={childWindow.maximized}
            class:fullScreen={childWindow.fullScreen}
            class:kiosk={childWindow.kiosk}
            class:flashing={childWindow.flashing}
            class:noShadow={!childWindow.hasShadow}
            class:windowButtonsHidden={!childWindow.windowButtonVisible}
            style={pluginBrowserWindowStyle(childWindow)}
            data-window-id={childWindow.id}
          >
            <header class="plugin-browser-window-bar">
              <div>
                <strong>{childWindow.title}</strong>
                <small>{childWindow.url}</small>
              </div>
              <button
                type="button"
                disabled={!childWindow.closable}
                title={childWindow.closable ? "关闭" : "关闭已禁用"}
                onclick={() => closePluginBrowserWindow(childWindow.id)}
              >关闭</button>
            </header>
            {#if childWindow.progressBar !== null || childWindow.progressBarMode === "indeterminate"}
              <div
                class="plugin-browser-window-progress"
                data-mode={childWindow.progressBarMode}
                aria-hidden="true"
              >
                <span style={`width: ${Math.round((childWindow.progressBar ?? 1) * 100)}%;`}></span>
              </div>
            {/if}
            {#key childWindow.documentGeneration}
              <iframe
                class="plugin-browser-window-frame"
                use:pluginBrowserWindowFrame={childWindow.id}
                srcdoc={childWindow.srcdoc}
                title={childWindow.title}
                style={pluginBrowserWindowFrameStyle(childWindow)}
                sandbox={PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX}
              ></iframe>
            {/key}
          </section>
        {/each}
      </div>
    {/if}
    {#if activePluginPermissionRequest}
      <div class="plugin-permission-dialog" role="dialog" aria-modal="true" aria-label="插件运行时权限请求">
        <div>
          <strong>插件请求运行时权限</strong>
          <p>{action.plugin_name || action.plugin_id} 请求使用 <code>{activePluginPermissionRequest.permission}</code></p>
        </div>
        <div class="plugin-permission-actions">
          <button type="button" onclick={() => respondPluginPermissionRequest(activePluginPermissionRequest, false)}>拒绝</button>
          <button type="button" onclick={() => respondPluginPermissionRequest(activePluginPermissionRequest, true)}>本次会话允许</button>
          <button type="button" class="primary" onclick={() => respondPluginPermissionRequest(activePluginPermissionRequest, true, true)}>始终允许</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .plugin-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    overflow: hidden;
    animation: slideUp 0.2s var(--ease-out-expo);
  }
  .plugin-header {
    min-height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex-shrink: 0;
  }
  .header-left {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-secondary);
  }

  .back-btn {
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 0 9px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font-size: 12px;
    font-weight: 700;
  }

  .back-btn:hover {
    border-color: var(--accent);
    background: var(--bg-hover);
  }

  .title-block {
    min-width: 0;
  }

  .plugin-title {
    overflow: hidden;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 750;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feature-code {
    overflow: hidden;
    margin-top: 2px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-tertiary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .plugin-source {
    overflow: hidden;
    max-width: 160px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .plugin-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .chrome-action {
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-secondary);
    background: transparent;
    font-size: 11.5px;
    font-weight: 700;
  }

  .chrome-action:not(:disabled):hover {
    border-color: var(--accent);
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .chrome-action:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .plugin-runtime-strip {
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 7px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-secondary) 58%, var(--bg-primary));
  }

  .runtime-chip {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 1px 7px;
    align-items: baseline;
    padding: 5px 8px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 18%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--bg-primary) 80%, transparent);
  }

  .runtime-chip.ready {
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    background: color-mix(in srgb, var(--accent-subtle) 44%, var(--bg-primary));
  }

  .runtime-chip.warning {
    border-color: color-mix(in srgb, #d97706 34%, transparent);
    background: color-mix(in srgb, #f59e0b 10%, var(--bg-primary));
  }

  .runtime-chip.error {
    border-color: color-mix(in srgb, var(--danger) 36%, transparent);
    background: color-mix(in srgb, var(--danger) 9%, var(--bg-primary));
  }

  .runtime-chip.muted {
    background: color-mix(in srgb, var(--bg-secondary) 54%, transparent);
  }

  .runtime-chip span,
  .runtime-chip strong,
  .runtime-chip small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-chip span {
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 800;
  }

  .runtime-chip strong {
    color: var(--text-primary);
    font-size: 11.5px;
    font-weight: 850;
  }

  .runtime-chip small {
    grid-column: 1 / -1;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 650;
  }

  .sub-input-row {
    flex-shrink: 0;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
  }

  .sub-input {
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-primary);
    background: var(--bg-secondary);
    font-size: 13px;
  }

  .sub-input:focus {
    border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
    background: var(--bg-elevated);
  }
  .plugin-body {
    position: relative;
    flex: 1;
    overflow: hidden;
    display: flex;
    min-height: 0;
    background: var(--bg-primary);
  }

  .plugin-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: var(--bg-primary);
  }

  .plugin-iframe.full-bleed {
    flex: 1;
    min-height: 0;
  }

  .plugin-browser-window-layer {
    position: absolute;
    inset: 12px;
    z-index: 4;
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .plugin-browser-window {
    max-width: 100%;
    min-width: 260px;
    min-height: 160px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
    pointer-events: auto;
  }

  .plugin-permission-dialog {
    position: absolute;
    right: 18px;
    bottom: 18px;
    z-index: 12;
    width: min(420px, calc(100% - 36px));
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    box-sizing: border-box;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
  }

  .plugin-permission-dialog strong {
    display: block;
    margin-bottom: 4px;
    font-size: 13px;
    line-height: 1.3;
  }

  .plugin-permission-dialog p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.45;
  }

  .plugin-permission-dialog code {
    color: var(--accent);
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    word-break: break-word;
  }

  .plugin-permission-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  }

  .plugin-permission-actions button {
    min-width: 74px;
    height: 30px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 0 10px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .plugin-permission-actions button.primary {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
    color: #fff;
    background: var(--accent);
  }

  @media (max-width: 520px) {
    .plugin-permission-dialog {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .plugin-browser-window.hidden {
    display: none;
  }

  .plugin-browser-window.focused {
    border-color: color-mix(in srgb, var(--accent) 54%, var(--border));
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.2), 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .plugin-browser-window.alwaysOnTop {
    border-color: color-mix(in srgb, var(--accent) 36%, var(--border));
  }

  .plugin-browser-window.flashing {
    border-color: color-mix(in srgb, #f59e0b 58%, var(--border));
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18), 0 0 0 2px color-mix(in srgb, #f59e0b 22%, transparent);
  }

  .plugin-browser-window.noShadow {
    box-shadow: none;
  }

  .plugin-browser-window.windowButtonsHidden .plugin-browser-window-bar button {
    visibility: hidden;
    pointer-events: none;
  }

  .plugin-browser-window.minimized {
    min-height: 0;
  }

  .plugin-browser-window.maximized,
  .plugin-browser-window.kiosk,
  .plugin-browser-window.fullScreen {
    position: absolute;
    inset: 0;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
  }

  .plugin-browser-window.positioned {
    position: absolute;
    justify-self: start;
    align-self: start;
  }

  .plugin-browser-window-bar {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 9px 7px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
  }

  .plugin-browser-window-bar div {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .plugin-browser-window-bar strong,
  .plugin-browser-window-bar small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .plugin-browser-window-bar strong {
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 650;
  }

  .plugin-browser-window-bar small {
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .plugin-browser-window-bar button {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text-secondary);
    background: var(--bg-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .plugin-browser-window-bar button:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .plugin-browser-window-progress {
    height: 3px;
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-secondary) 72%, var(--border));
  }

  .plugin-browser-window-progress span {
    display: block;
    height: 100%;
    max-width: 100%;
    background: var(--accent);
  }

  .plugin-browser-window-progress[data-mode="error"] span {
    background: var(--danger);
  }

  .plugin-browser-window-progress[data-mode="paused"] span {
    background: #d97706;
  }

  .plugin-browser-window-progress[data-mode="indeterminate"] span {
    width: 100% !important;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
  }

  .plugin-browser-window-bar button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .plugin-browser-window-bar button:disabled:hover {
    color: var(--text-secondary);
    background: var(--bg-primary);
  }

  .plugin-browser-window-frame {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: none;
    background: var(--bg-primary);
  }

  .plugin-browser-window.minimized .plugin-browser-window-frame {
    display: none;
  }

  .plugin-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    gap: 12px;
    color: var(--text-secondary);
  }
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--bg-tertiary);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .loading-text {
    font-size: 12px;
    color: var(--text-tertiary);
  }
  .plugin-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    color: var(--danger);
    gap: 8px;
  }
  .err-icon {
    font-size: 24px;
  }
  .err-message {
    font-size: 12px;
    color: var(--text-secondary);
    text-align: center;
    max-width: 400px;
    padding: 0 24px;
    word-break: break-word;
  }
  .plugin-output-layer {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--bg-primary);
  }

  .results-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }
  .result-item {
    position: relative;
    min-height: 50px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    width: 100%;
    padding: 8px 14px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background 0.1s ease;
  }
  .result-item:hover,
  .result-item.selected {
    background: var(--bg-hover);
  }
  .result-item.selected::before {
    content: "";
    position: absolute;
    left: 0;
    top: 7px;
    bottom: 7px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
  }
  .result-content {
    min-width: 0;
  }

  .result-hint {
    flex-shrink: 0;
    margin-left: 12px;
    padding: 3px 7px;
    border-radius: 5px;
    color: var(--text-tertiary);
    background: var(--bg-tertiary);
    font-size: 11px;
    font-weight: 700;
  }
  .plugin-output-menu {
    position: fixed;
    z-index: 20;
    min-width: 112px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  }
  .plugin-output-menu button {
    display: block;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .plugin-output-menu button:hover {
    background: var(--bg-hover);
  }
  .result-title {
    overflow: hidden;
    font-size: 13px;
    font-weight: 650;
    color: var(--text-primary);
    margin-bottom: 2px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result-description {
    overflow: hidden;
    font-size: 12px;
    color: var(--text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
