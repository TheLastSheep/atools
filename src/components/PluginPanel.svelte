<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import PluginPanelBody from "./PluginPanelBody.svelte";
  import PluginPanelChrome from "./PluginPanelChrome.svelte";
  import { createPluginFeatureListId } from "../lib/pluginFeatureA11yIds";
  import { createPluginFeatureActiveDescendantController } from "../lib/pluginFeatureActiveDescendant.svelte.js";
  import { emptyPluginFeatureList } from "../lib/pluginFeatureExportsState";
  import { createPluginPanelEntryController } from "../lib/pluginPanelEntryController";
  import { applyPluginSubInputMessage, createPluginSubInputFocus, emptyPluginSubInput } from "../lib/pluginSubInputState";
  import { permissionDialogOpen } from "../lib/permissionDialogFocus";
  import type { FeatureAction, PluginItem } from "../lib/types";
  import type { PluginDataStatus } from "../lib/pluginDataController";
  import type { DynamicPluginFeature, PluginPanelProps as Props, UiHostProbeResult } from "../lib/pluginPanelContracts";
  import { createPluginPanelContextMenu } from "../lib/pluginPanelContextMenu.svelte.js";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { open as shellOpen } from "@tauri-apps/plugin-shell";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import { listen as listenTauriEvent } from "@tauri-apps/api/event";
  import packageInfo from "../../package.json";
  import { normalizePluginOutputItems, pluginHostView } from "../lib/pluginHostView";
  import { createPluginWorkerDocumentLifecycle } from "../lib/pluginWorkerDocumentLifecycle";
  import { modalFocusOwner } from "../lib/modalFocusOwner";
  import { createPluginPanelActiveResources } from "../lib/pluginPanelActiveResources";
  import { pluginPageDocumentModeEnabled } from "../lib/pluginPageDocument";
  import { createPluginPanelLoadRetryController, type PluginPanelLoadRetrySnapshot } from "../lib/pluginPanelLoadRetry";
  import { type PluginRuntimePermissionRequest } from "../lib/pluginFramePermissionQueue";
  import { isPluginDocumentIdentity } from "../lib/pluginFrameDocumentIdentity";
  import { createPluginMainPushHost } from "../lib/pluginMainPushHost";
  import { createPluginMainPushPermissionTracker } from "../lib/pluginMainPushPermissions";
  import type { MainPushEntry } from "../lib/pluginMainPushProtocol";
  import type { HostClipboardStatus } from "../lib/hostClipboardController";
  import { createPluginWebStorageRelay } from "../lib/pluginWebStorageRelay";
  import "./PluginPanel.css";
  import { PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, grantPluginRuntimePermission, pluginRuntimePermissionGrantList } from "../lib/pluginRuntimePermissions";
  import { createPluginPanelBrowserWindowRuntimeBindings } from "../lib/pluginPanelBrowserWindowRuntimeBindings";
  import { createPluginPanelDocumentSourceHost } from "../lib/pluginPanelDocumentSourceHost";
  import { createPluginPanelMessageHost } from "../lib/pluginPanelMessageHost";
  import { createPluginPanelBrowserWindowState } from "../lib/pluginPanelBrowserWindowState.svelte.js";
  import { createPluginPanelCapabilityReopen } from "../lib/pluginPanelCapabilityReopen";
  import { createPluginPanelMainFrameFocus } from "../lib/pluginPanelFrameFocus";
  import { createPluginPanelFrameMountHost } from "../lib/pluginPanelFrameMountHost";
  import { createPluginPanelLoadController } from "../lib/pluginPanelLoadController";
  import { createPluginPanelRenderSmokeController } from "../lib/pluginPanelRenderSmokeController";
  import { createPluginPanelPermissionController } from "../lib/pluginPanelPermissionController";
import { createPluginPanelSessionLifecycle } from "../lib/pluginPanelSessionLifecycle";
import { createPluginPanelSurfaceApi } from "../lib/pluginPanelSurfaceApi";
  import { previewPayload as readPluginPreviewPayload } from "../lib/pluginPanelPreview";
  import { createPluginPanelInteractions, type OutputContextMenuState } from "../lib/pluginPanelInteractions";
  import { createPluginFeatureIconResolver, pluginBrowserWindowMessageLabel, pluginContextMenuTarget } from "../lib/pluginPanelPresentation";
  import { pluginBrowserWindowFrameStyle, pluginBrowserWindowStyle } from "../lib/pluginBrowserWindowPresentation";
  import { appleScriptString, hideMainWindowForPluginPaste as hidePluginPanelForPaste, normalizeCopiedFileEntries, pathsFromBridgeValue, pathFromBridgeValue, pickScreenColorWithEyeDropper, pluginFileClipboardAppleScript, runAppleScript, runCommand, writePluginImageToClipboard, writePluginOutputText } from "../lib/pluginPanelSystemClipboard";
  const previewPayload = () => readPluginPreviewPayload(currentAction);
  let {
    action,
    onclose,
    onescape,
    onoutput,
    onredirect,
    onsettingsredirect,
    desktopSmokeExpectedSamples = 0,
    desktopSmokeSampleIndex = 0,
    desktopSmokeExternalPlanSample = false,
    onready,
    onloaderror,
    ondesktopsmokerender,
    mainPushRunnerId,
    onmainpushwaiting,
    onbackgroundwaiting,
    persistentSessionId,
    persistentVisible = true,
  }: Props = $props();
  const initialDocumentAction = untrack(() => action);
  let documentAction = $state(initialDocumentAction);
  const initialPersistentSessionId = untrack(() => persistentSessionId);
  const initialPersistentVisible = untrack(() => persistentVisible);
  let currentAction = $state(initialDocumentAction);
  let panelSessionVisible = $state(initialPersistentSessionId ? initialPersistentVisible : true);
  const initialMainPushRunnerId = untrack(() => mainPushRunnerId);
  let mainPushMode = $state<"query" | "select" | "visible">(initialMainPushRunnerId ? "query" : "visible");
  const mainPushPermissions = initialMainPushRunnerId || initialPersistentSessionId ? createPluginMainPushPermissionTracker(waiting => {
    mainPushHost?.setWaiting(waiting); onmainpushwaiting?.(waiting); onbackgroundwaiting?.(waiting);
  }) : undefined;
  const WEB_PREVIEW_PLUGIN_PATH = "__atools_plugin_host_preview__";
  const PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-popups";
  const PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX = "allow-scripts allow-popups";
  let iframeSrcDoc = $state("");
  let iframeSrc = $state("");
  let pluginReadyReported = false;
  function reportPluginReady() {
    if (pluginReadyReported || (!iframeSrc && !iframeSrcDoc)) return;
    pluginReadyReported = true;
    void Promise.resolve(onready?.()).catch(error => console.warn("[PluginPanel] plugin load callback failed:", error));
  }
  let loadError = $state<string | null>(null);
  let pluginLoadRetryView = $state<PluginPanelLoadRetrySnapshot>({ generation: null, phase: "idle", error: null, retryable: false, busy: false });
  const pluginLoadRetry = createPluginPanelLoadRetryController(state => { pluginLoadRetryView = state; });
  let subInputState = $state(emptyPluginSubInput());
  const subInputOpts = $derived({ placeholder: subInputState.placeholder });
  let pluginItems = $state<PluginItem[]>([]);
  let featureList = $state(emptyPluginFeatureList());
  const featureListA11yId = createPluginFeatureListId();
  const featureActiveDescendant = createPluginFeatureActiveDescendantController();
  let selectedIndex = $state(0);
  let iframeRef = $state<HTMLIFrameElement | null>(null);
  const workerDocument = createPluginWorkerDocumentLifecycle({ getSource: () => iframeRef?.contentWindow ?? null });
  let pluginClosingAction: FeatureAction | undefined;
  let subInputRef = $state<HTMLInputElement | null>(null);
  const subInputValue = $derived(subInputState.value);
  let hasSubInput = $derived(subInputState.visible);
  const applySubInputFocus = createPluginSubInputFocus();
  let dynamicFeatures = $state<DynamicPluginFeature[]>([]);
  let registeredTools = $state<string[]>([]);
  let requestedPluginHeight = $state(0);
  let pluginOutDispatched = false;
  let pluginDetachDispatched = false;
  let outputContextMenu = $state<OutputContextMenuState>({ visible: false, x: 0, y: 0, itemIndex: -1 });
  const browserWindowPanelState = createPluginPanelBrowserWindowState();
  const interactions = createPluginPanelInteractions({
    action: () => currentAction, subInput: () => subInputState, setSubInput: state => { subInputState = state; }, hasSubInput: () => hasSubInput,
    featureList: () => featureList, setFeatureList: state => { featureList = state; },
    items: () => pluginItems, setItems: items => { pluginItems = items; },
    selectedIndex: () => selectedIndex, setSelectedIndex: index => { selectedIndex = index; },
    outputMenu: () => outputContextMenu, setOutputMenu: state => { outputContextMenu = state; },
    iframeWindow: () => iframeRef?.contentWindow ?? null, post: browserWindowPanelState.post, writeText: text => writePluginOutputText(text, writeText),
    onOutput: output => onoutput?.(output), onEscape: () => onescape?.(), closePanel: () => closePluginPanel(),
    permissionBlocked: () => permissionDialogOpen() || Boolean(activePluginPermissionRequest),
  });
  const { handleSubInputChange, featureListIntent, moveSubInputOutput, requestEscape, handleItemClick,
    notifySubInputChange, openOutputContextMenu, closeOutputContextMenu, copyOutputContextMenuItem,
    handlePluginPanelKeydown } = interactions;
  const pluginContextMenu = createPluginPanelContextMenu();
  let browserWindowRuntime: ReturnType<typeof createPluginPanelBrowserWindowRuntimeBindings> | undefined;
  function invalidatePluginBrowserWindows() { browserWindowRuntime?.invalidatePluginBrowserWindows(); }
  const mainPushHost = untrack(() => initialMainPushRunnerId ? createPluginMainPushHost({ runnerId: initialMainPushRunnerId, featureCode: currentAction.feature_code,
    parentOrigin: window.location.origin, source: () => iframeRef?.contentWindow ?? null, sources: browserWindowPanelState.sources,
    mode: mode => { mainPushMode = mode; },
  }) : undefined);
  let runtimeApprovedPluginPermissions = $state<string[]>([]);
  let runtimePersistentPluginPermissions = $state<string[]>([]);
  let pluginPermissionRequests = $state<PluginRuntimePermissionRequest[]>([]);
  let uiHostProbeResult = $state<UiHostProbeResult | null>(null);
  const pluginPanelRenderSmoke = createPluginPanelRenderSmokeController({
    action: () => currentAction, expectedSamples: () => desktopSmokeExpectedSamples,
    sampleIndex: () => desktopSmokeSampleIndex, externalPlanSample: () => desktopSmokeExternalPlanSample,
    onRender: () => ondesktopsmokerender?.(), windows: () => browserWindowPanelState.windows,
    iframeSrc: () => iframeSrc, hasSubInput: () => hasSubInput,
    subInputPlaceholder: () => subInputOpts.placeholder, invoke, tick,
  });
  const { isEnabled: desktopPluginPanelRenderSmokeEnabled, failure: desktopSmokeBridgeProbeFailure,
    waitFor: waitForDesktopSmokeBridgeProbe, receive: handleDesktopSmokeBridgeProbe,
    resolve: resolveDesktopSmokeBridgeProbe, report: reportPluginPanelRenderSmoke } = pluginPanelRenderSmoke;
  let pluginLoadGeneration = 0;
  const pluginActiveResources = createPluginPanelActiveResources();
  const resolveFeatureIcon = createPluginFeatureIconResolver(() => currentAction, path => pluginActiveResources.lease?.resolveModuleSrc(path));
  let pluginDisplayStatus = $state<PluginDataStatus | null>(null), pluginFileDropStatus = $state<string | null>(null);
  let pluginDataStatus = $state<PluginDataStatus | null>(null);
  let pluginDialogsStatus = $state<PluginDataStatus | null>(null);
  let pluginPathsStatus = $state<PluginDataStatus | null>(null);
  let hostClipboardStatus = $state<HostClipboardStatus | null>(null);
  let hostClipboardReopening = $state(false);
  const pluginPanelDocumentSourceHost = createPluginPanelDocumentSourceHost({
    action: () => currentAction, workerDocument, hostedIpc: browserWindowPanelState.hostedIpc, mainPushHost,
    generation: () => pluginLoadGeneration, pluginPathForPreview: WEB_PREVIEW_PLUGIN_PATH,
    productName: packageInfo.productName || packageInfo.name || "ATools", productVersion: packageInfo.version || "0.0.0",
    clipboard: () => pluginActiveResources.clipboard, data: () => pluginActiveResources.data, paths: () => pluginActiveResources.paths,
    dialogs: () => pluginActiveResources.dialogs, display: () => pluginActiveResources.display, secretStorage: () => pluginActiveResources.secretStorage, fileDrag: () => pluginActiveResources.fileDrag,
    bridgeScript: () => pluginActiveResources.page?.bridgeScript(), smokeEnabled: desktopPluginPanelRenderSmokeEnabled,
    smokeSampleIndex: () => desktopSmokeSampleIndex,
    subInputState: () => subInputState, setSubInputState: value => { subInputState = value; },
    iframeSrc: value => { iframeSrc = value; }, iframeSrcDoc: value => { iframeSrcDoc = value; },
    setPluginItems: value => { pluginItems = value; }, setSelectedIndex: value => { selectedIndex = value; },
    setLoadError: value => { loadError = value; },
  });
  const { injectBridge: injectPluginBridge, injectSmokeProbe: injectDesktopSmokeBridgeProbe,
    loadPreview: loadPreviewPluginHtml } = pluginPanelDocumentSourceHost;
  const pluginWebStorageRelay = createPluginWebStorageRelay({
    listen: (event, receive) => listenTauriEvent(event, receive),
    owner: () => pluginActiveResources.data ? { pluginId: currentAction.plugin_id, instanceId: pluginActiveResources.data.instanceId,
      authorized: Boolean(pluginActiveResources.data.configuration().endpoint) } : null,
    targets: () => [iframeRef?.contentWindow, ...Array.from(browserWindowPanelState.frames.values(), frame => frame.contentWindow)],
    sources: browserWindowPanelState.sources,
  });
  const pluginPermissionController = createPluginPanelPermissionController({
    action: () => currentAction, sources: browserWindowPanelState.sources,
    approved: () => runtimeApprovedPluginPermissions, setApproved: value => { runtimeApprovedPluginPermissions = value; },
    persistent: () => runtimePersistentPluginPermissions, setPersistent: value => { runtimePersistentPluginPermissions = value; },
    changed: requests => { pluginPermissionRequests = requests; },
    smokePermissionEnabled: desktopPluginPanelRenderSmokeEnabled,
    grantPersistent: grantPluginRuntimePermission, persistentForPlugin: pluginRuntimePermissionGrantList,
  });
  const { clear: clearPluginPermissionRequests,
    ensure: ensureHostPluginPermission, handleRequest: handlePluginPermissionRequest,
    respond: respondPluginPermissionRequest } = pluginPermissionController;
  const pluginPanelSessionLifecycle = createPluginPanelSessionLifecycle({
    action: () => currentAction, documentPluginId: initialDocumentAction.plugin_id, persistentSessionId: initialPersistentSessionId,
    closingAction: () => pluginClosingAction,
    beginStrictClose: () => pluginActiveResources.closeTracker.begin(),
    setClosingAction: value => { pluginClosingAction = value; }, workerDocument,
    nextGeneration: () => ++pluginLoadGeneration, currentGeneration: () => pluginLoadGeneration,
    retry: pluginLoadRetry,
    clearLoadError: () => { loadError = null; }, resetFeatures: generation => { featureList = emptyPluginFeatureList(generation); },
    resetEntry: next => { currentAction = next; panelEntryController.activate(next); },
    setVisible: value => { panelSessionVisible = value; },
    hostedIpc: browserWindowPanelState.hostedIpc, invalidateBrowserWindows: invalidatePluginBrowserWindows,
    clearPermissionRequests: clearPluginPermissionRequests,
    closeResources: pluginActiveResources.closeAll, closeResourcesStrict: pluginActiveResources.closeAllStrict,
    destroyBrowserWindows: () => browserWindowRuntime?.destroyPluginBrowserWindows(),
    iframeWindow: () => iframeRef?.contentWindow ?? null, post: browserWindowPanelState.post,
    wasOutDispatched: () => pluginOutDispatched, setOutDispatched: value => { pluginOutDispatched = value; },
    wasDetachDispatched: () => pluginDetachDispatched, setDetachDispatched: value => { pluginDetachDispatched = value; },
    onclose: isKill => onclose(isKill), invoke,
    mainPushHost, mainPushPermissions, webStorageRelay: pluginWebStorageRelay,
    sources: browserWindowPanelState.sources, persistentGrantsUpdatedEvent: PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT,
    currentPluginId: () => currentAction.plugin_id, permissionGrants: pluginRuntimePermissionGrantList,
    setPersistentPermissions: value => { runtimePersistentPluginPermissions = value; },
    handlePanelKeydown: handlePluginPanelKeydown,
    resolveDestroyedSmokeProbe: () => resolveDesktopSmokeBridgeProbe(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-destroyed")),
  });
  const { dispatchPluginDetachEvent, handlePluginChromeAction,
    closePluginPanel } = pluginPanelSessionLifecycle;
  let activePluginPermissionRequest = $derived(pluginPermissionRequests[0] ?? null);
  $effect(() => { mainPushPermissions?.setLocal(pluginPermissionRequests.length > 0); });
  const focusMainPluginFrame = createPluginPanelMainFrameFocus({
    visible: () => untrack(() => mainPushMode) === "visible" && untrack(() => panelSessionVisible),
    isCurrentMainFrame: frame => frame === iframeRef && !workerDocument.blocking
      && pluginClosingAction !== currentAction && !loadError && Boolean(iframeSrc || iframeSrcDoc),
    hasPermissionOrModal: () => permissionDialogOpen() || !!activePluginPermissionRequest || !!modalFocusOwner(),
    hasSubInputRequest: () => hasSubInput && (subInputState.focusRequest?.action === "focus"
      || subInputState.focusRequest?.action === "select"),
    hasActiveSubInput: () => !!subInputRef && document.activeElement === subInputRef,
    hasActiveChild: () => browserWindowPanelState.windows.some(child => child.visible && child.focused),
  });
  function waitForPluginHostPaint() {
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
  const { pluginMainFrame, pluginBrowserWindowFrame } = createPluginPanelFrameMountHost({
    state: browserWindowPanelState, activePage: () => pluginActiveResources.page,
    focusMainFrame: node => focusMainPluginFrame(node), reportReady: reportPluginReady,
  });
  let hostView = $derived(pluginHostView(currentAction, {
    subInputVisible: hasSubInput,
    iframeReady: Boolean(iframeSrcDoc || iframeSrc),
    retryBusy: pluginLoadRetryView.busy,
    outputItems: pluginItems,
    selectedIndex,
    loadError,
    dynamicFeatureCount: dynamicFeatures.length,
    registeredToolCount: registeredTools.length,
    requestedHeight: requestedPluginHeight,
    contextMenuTarget: pluginContextMenuTarget(pluginContextMenu.current),
    browserWindowCount: browserWindowPanelState.windows.length,
    browserWindowMessage: pluginBrowserWindowMessageLabel(browserWindowPanelState.lastMessage),
    uiHostProbePassed: uiHostProbeResult?.passed ?? 0,
    uiHostProbeTotal: uiHostProbeResult?.total ?? 0,
    uiHostProbeFailedIds: uiHostProbeResult?.failedIds ?? [],
  }));

  const panelEntryController = createPluginPanelEntryController({
    subInput: () => subInputState, setSubInput: value => { subInputState = value; },
    dynamicFeatures: () => dynamicFeatures, setDynamicFeatures: value => { dynamicFeatures = value; },
    registeredTools: () => registeredTools, setRegisteredTools: value => { registeredTools = value; },
    setRequestedHeight: value => { requestedPluginHeight = value; }, setOutDispatched: value => { pluginOutDispatched = value; },
    setDetachDispatched: value => { pluginDetachDispatched = value; }, clearContextMenu: () => pluginContextMenu.clear(),
    setLastBrowserWindowMessage: value => { browserWindowPanelState.lastMessage = value as typeof browserWindowPanelState.lastMessage; },
    setProbeResult: value => { uiHostProbeResult = value as UiHostProbeResult | null; }, clearPermissionRequests: clearPluginPermissionRequests,
    setApprovedPermissions: value => { runtimeApprovedPluginPermissions = value; },
    setPersistentPermissions: value => { runtimePersistentPluginPermissions = value; },
    loadPersistentPermissions: pluginRuntimePermissionGrantList,
    setPluginItems: value => { pluginItems = value; }, setSelectedIndex: value => { selectedIndex = value; },
    setFeatureList: value => { featureList = value; }, emptyFeatureList: emptyPluginFeatureList,
    generation: () => pluginLoadGeneration,
  });
  $effect(() => { const next = currentAction; untrack(() => panelEntryController.observe(next)); });

  $effect(() => {
    const state = subInputState;
    const input = subInputRef;
    return applySubInputFocus({ state, input, afterRender: tick,
      isCurrent: () => input === subInputRef && state.focusRequest === subInputState.focusRequest
        && (hasSubInput || state.focusRequest?.action === "blur")
        && !workerDocument.blocking && pluginClosingAction !== currentAction
        && !permissionDialogOpen() && !activePluginPermissionRequest && !modalFocusOwner()
        && !browserWindowPanelState.windows.some(child => child.visible && child.focused),
      focusFrame: () => focusMainPluginFrame(iframeRef),
    });
  });

  function handlePluginContextMenu(data: Record<string, unknown>) {
    closeOutputContextMenu();
    pluginContextMenu.receive(data);
  }

  onMount(pluginPanelSessionLifecycle.mount);

  const pluginPanelLoadController = createPluginPanelLoadController({
    action: () => documentAction, persistentSessionId: initialPersistentSessionId, entryMode: initialPersistentSessionId ? "preload" : "activate",
    closeTracker: pluginActiveResources.closeTracker, onLoadError: error => onloaderror?.(error),
    get pluginLoadGeneration() { return pluginLoadGeneration; }, set pluginLoadGeneration(value) { pluginLoadGeneration = value; },
    pluginLoadRetry, get loadError() { return loadError; }, set loadError(value) { loadError = value; },
    get pluginClosingAction() { return pluginClosingAction; }, set pluginClosingAction(value) { pluginClosingAction = value; },
    workerDocument, mainPushHost,
    get featureList() { return featureList; }, set featureList(value) { featureList = value; },
    hostedIpc: browserWindowPanelState.hostedIpc,
    get subInputState() { return subInputState; }, set subInputState(value) { subInputState = value; },
    clearPluginPermissionRequests,
    get activePluginPage() { return pluginActiveResources.page; }, set activePluginPage(value) { pluginActiveResources.page = value; },
    get activePluginRuntime() { return pluginActiveResources.runtime; }, set activePluginRuntime(value) { pluginActiveResources.runtime = value; },
    get activePluginResources() { return pluginActiveResources.lease; }, set activePluginResources(value) { pluginActiveResources.lease = value; },
    get activeHostClipboard() { return pluginActiveResources.clipboard; }, set activeHostClipboard(value) { pluginActiveResources.clipboard = value; },
    get activePluginDisplay() { return pluginActiveResources.display; }, set activePluginDisplay(value) { pluginActiveResources.display = value; },
    get activePluginData() { return pluginActiveResources.data; }, set activePluginData(value) { pluginActiveResources.data = value; },
    get activePluginPaths() { return pluginActiveResources.paths; }, set activePluginPaths(value) { pluginActiveResources.paths = value; },
    get activePluginDialogs() { return pluginActiveResources.dialogs; }, set activePluginDialogs(value) { pluginActiveResources.dialogs = value; },
    get activePluginSecretStorage() { return pluginActiveResources.secretStorage; }, set activePluginSecretStorage(value) { pluginActiveResources.secretStorage = value; }, get activePluginFileDrag() { return pluginActiveResources.fileDrag; }, set activePluginFileDrag(value) { pluginActiveResources.fileDrag = value; }, get activeFileDropHost() { return pluginActiveResources.fileDrop; }, set activeFileDropHost(value) { pluginActiveResources.fileDrop = value; }, get activePluginAi() { return pluginActiveResources.ai; }, set activePluginAi(value) { pluginActiveResources.ai = value; },
    invalidateBrowserWindows: invalidatePluginBrowserWindows, messageSources: browserWindowPanelState.sources, childFrames: browserWindowPanelState.frames,
    onFileDropStatus: value => { pluginFileDropStatus = value; }, get iframeRef() { return iframeRef; }, get iframeSrc() { return iframeSrc; }, set iframeSrc(value) { iframeSrc = value; },
    get iframeSrcDoc() { return iframeSrcDoc; }, set iframeSrcDoc(value) { iframeSrcDoc = value; },
    get hostClipboardStatus() { return hostClipboardStatus; }, set hostClipboardStatus(value) { hostClipboardStatus = value; },
    get pluginDisplayStatus() { return pluginDisplayStatus; }, set pluginDisplayStatus(value) { pluginDisplayStatus = value; },
    get pluginDataStatus() { return pluginDataStatus; }, set pluginDataStatus(value) { pluginDataStatus = value; },
    get pluginPathsStatus() { return pluginPathsStatus; }, set pluginPathsStatus(value) { pluginPathsStatus = value; },
    get pluginDialogsStatus() { return pluginDialogsStatus; }, set pluginDialogsStatus(value) { pluginDialogsStatus = value; },
    webStorageRelay: pluginWebStorageRelay, mainPushPermissions, webPreviewPluginPath: WEB_PREVIEW_PLUGIN_PATH,
    desktopSmokeSampleIndex: () => desktopSmokeSampleIndex, desktopSmokeExpectedSamples: () => desktopSmokeExpectedSamples,
    desktopSmokeExternalPlanSample: () => desktopSmokeExternalPlanSample,
    loadPreviewPluginHtml,
    injectPluginBridge: (html, windowType, browserWindowId, preloadScript, geometrySnapshot, entryMode) =>
      injectPluginBridge(html, windowType, browserWindowId, preloadScript, geometrySnapshot, undefined, entryMode),
    injectDesktopSmokeBridgeProbe,
    smokeProbeFailure: desktopSmokeBridgeProbeFailure,
    waitForSmokeProbe: waitForDesktopSmokeBridgeProbe, reportRenderSmoke: reportPluginPanelRenderSmoke,
    waitForHostPaint: waitForPluginHostPaint, focusMainFrame: focusMainPluginFrame, reportPluginReady,
    get pluginItems() { return pluginItems; }, set pluginItems(value) { pluginItems = value; },
    get selectedIndex() { return selectedIndex; }, set selectedIndex(value) { selectedIndex = value; },
    tick,
  });
  const { retryPluginLoad, loadPluginHtml } = pluginPanelLoadController;
  const pluginPanelCapabilityReopen = createPluginPanelCapabilityReopen({
    action: () => currentAction, page: () => pluginActiveResources.page, clipboard: () => pluginActiveResources.clipboard,
    data: () => pluginActiveResources.data, paths: () => pluginActiveResources.paths, dialogs: () => pluginActiveResources.dialogs,
    display: () => pluginActiveResources.display, generation: () => pluginLoadGeneration, loadError: () => loadError,
    pathsStatus: () => pluginPathsStatus,
    isBusy: () => hostClipboardReopening, setBusy: value => { hostClipboardReopening = value; },
    setClipboardStatus: value => { hostClipboardStatus = value; }, loadPluginHtml, invoke,
  });
  const { reopenClipboard: reopenHostClipboard, reopenData: reopenPluginData,
    reopenPaths: reopenPluginPaths } = pluginPanelCapabilityReopen;

  $effect(() => {
    const nextDocumentAction = initialPersistentSessionId ? initialDocumentAction : action;
    if (!initialPersistentSessionId) {
      documentAction = currentAction = nextDocumentAction;
      iframeSrc = iframeSrcDoc = "";
    }
    if (nextDocumentAction.plugin_path) {
      untrack(() => { void loadPluginHtml(); });
    }
    return () => { pluginLoadGeneration++; pluginLoadRetry.invalidate(pluginLoadGeneration); loadError = null; clearPluginPermissionRequests(); pluginActiveResources.closeAll(); };
  });

  const browserWindowHost = createPluginPanelBrowserWindowRuntimeBindings({
    state: browserWindowPanelState, mainFrame: () => iframeRef, action: () => currentAction,
    invoke: pluginActiveResources.closeTracker.wrap(invoke),
    previewPluginPath: WEB_PREVIEW_PLUGIN_PATH, previewPayload, hasPluginPage: () => Boolean(pluginActiveResources.page),
    resources: () => pluginActiveResources.lease, activePluginRuntime: () => pluginActiveResources.runtime,
    injectBridge: injectPluginBridge, mountNativeFrame: pluginBrowserWindowFrame, tick,
  });
  browserWindowRuntime = browserWindowHost;
  const { dispatchPluginBrowserWindowParentMessage, handlePluginBrowserWindowAction, closePluginBrowserWindow } = browserWindowHost;

  const pluginPanelMessageHost = createPluginPanelMessageHost({
    action: () => currentAction, invoke, sources: browserWindowPanelState.sources, hostedIpc: browserWindowPanelState.hostedIpc,
    browserWindows: () => browserWindowPanelState.windows, creatorFor: id => browserWindowPanelState.creators.get(id),
    ensurePermission: ensureHostPluginPermission, onclose: () => onclose(),
    onredirect: (label, payload) => onredirect?.(label, payload) ?? false,
    onsettingsredirect: (menu, detail) => onsettingsredirect?.(menu, detail) ?? false,
    writePluginImage: writePluginImageToClipboard, pathFromBridgeValue, pathsFromBridgeValue,
    runAppleScript, appleScriptString, normalizeCopiedFileEntries, runCommand, writeText,
    hidePanelForPaste: hidePluginPanelForPaste, pluginFileClipboardAppleScript,
    pickScreenColorWithEyeDropper, shellOpen,
    dispatchParentMessage: dispatchPluginBrowserWindowParentMessage,
    browserWindowAction: handlePluginBrowserWindowAction, createBrowserWindow: browserWindowHost.createPluginBrowserWindow,
    shouldUseNativeBrowserWindow: browserWindowHost.shouldUseNativeBrowserWindow,
    iframeSrc: () => iframeSrc, previewPayload, iframeWindow: () => iframeRef?.contentWindow ?? null,
    webPreviewPluginPath: WEB_PREVIEW_PLUGIN_PATH,
    pluginResourceUrl: () => pluginActiveResources.page?.resourceUrl ?? convertFileSrc, post: browserWindowPanelState.post,
    closePanel: isKill => pluginPanelSessionLifecycle.handlePluginClose(isKill === true), setUiHostProbeResult: result => { uiHostProbeResult = result; },
    handlePermissionRequest: handlePluginPermissionRequest, handleDesktopSmokeProbe: handleDesktopSmokeBridgeProbe,
    handleContextMenu: handlePluginContextMenu, requestEscape, featureList: () => featureList,
    setFeatureList: value => { featureList = value; }, featureListIntent,
    subInputState: () => subInputState, setSubInputState: value => { subInputState = value; },
    applySubInputMessage: applyPluginSubInputMessage,
    notifySubInputChange: value => { if (typeof value === "string") notifySubInputChange(value); },
    dynamicFeatures: () => dynamicFeatures, setDynamicFeatures: value => { dynamicFeatures = value; },
    registeredTools: () => registeredTools, setRegisteredTools: value => { registeredTools = value; },
    dispatchDetach: dispatchPluginDetachEvent, requestedHeight: () => requestedPluginHeight,
    setRequestedHeight: value => { requestedPluginHeight = value; }, pluginItems: () => pluginItems,
    setPluginItems: value => { pluginItems = value; }, normalizeOutputItems: normalizePluginOutputItems,
    selectedIndex: () => selectedIndex, setSelectedIndex: value => { selectedIndex = value; },
    activePage: () => pluginActiveResources.page, isDocumentIdentity: isPluginDocumentIdentity,
    clearPermissionRequests: clearPluginPermissionRequests, invalidateBrowserWindows: invalidatePluginBrowserWindows,
    onOutput: output => onoutput?.(output), emptyFeatureList: emptyPluginFeatureList,
    workerBlocking: () => workerDocument.blocking, closingActionIsCurrent: () => pluginClosingAction === currentAction,
    receiveMainPush: (event, identity) => mainPushHost?.receive(event, identity) ?? false,
    mainPushMode: () => mainPushMode, activeClipboard: () => pluginActiveResources.clipboard,
    activeDisplay: () => pluginActiveResources.display, activeData: () => pluginActiveResources.data,
    activeDialogs: () => pluginActiveResources.dialogs, activePaths: () => pluginActiveResources.paths,
  });

  const pluginPanelSurfaceApi = createPluginPanelSurfaceApi({
    mainPushHost, resolveIcon: resolveFeatureIcon, lifecycle: pluginPanelSessionLifecycle, messageHost: pluginPanelMessageHost,
    persistentSessionId: initialPersistentSessionId, documentPluginId: initialDocumentAction.plugin_id, afterRender: tick,
    focusFrame: () => focusMainPluginFrame(iframeRef), destroyBrowserWindows: () => browserWindowRuntime?.destroyPluginBrowserWindows(),
  });
  onDestroy(pluginPanelSurfaceApi.destroyOnUnmount);
  export function mainPushQuery(requestId: string, generation: number, payload: string, type: string) { return pluginPanelSurfaceApi.mainPushQuery(requestId, generation, payload, type); }
  export function mainPushSelect(requestId: string, queryId: string, generation: number, handle: string) { return pluginPanelSurfaceApi.mainPushSelect(requestId, queryId, generation, handle); }
  export function mainPushPromote(entry: MainPushEntry) { pluginPanelSurfaceApi.mainPushPromote(entry); }
  export function mainPushCancel() { pluginPanelSurfaceApi.mainPushCancel(); }
  export function mainPushReady() { return pluginPanelSurfaceApi.mainPushReady(); }
  export function mainPushResolveIcon(value: string) { return pluginPanelSurfaceApi.mainPushResolveIcon(value); }
  export function activatePersistentEntry(next: FeatureAction) { return pluginPanelSurfaceApi.activatePersistentEntry(next); }
  export function setPersistentVisible(visible: boolean) { return pluginPanelSurfaceApi.setPersistentVisible(visible); }
  export function closePersistentStrict(options?: { retry?: boolean }) { return pluginPanelSurfaceApi.closePersistentStrict(options); }

</script>

<svelte:window onmessage={pluginPanelMessageHost.handleMessage} onclick={closeOutputContextMenu} />

<div class="plugin-panel" class:query-only={mainPushMode !== "visible"} class:persistent-hidden={!panelSessionVisible}>
  <PluginPanelChrome
    visible={mainPushMode === "visible"}
    title={hostView.chrome.title}
    feature={hostView.chrome.feature}
    actions={hostView.actions.slice(1)}
    inputVisible={hasSubInput}
    value={subInputValue}
    placeholder={subInputOpts.placeholder}
    controlsId={featureList.mode === "list" ? featureListA11yId : undefined}
    activeDescendantId={featureActiveDescendant.activeDescendantIdFor(featureList, featureListA11yId)}
    bind:inputRef={subInputRef}
    onInput={handleSubInputChange}
    onReturn={closePluginPanel}
    onEscape={() => void requestEscape()}
    onMove={moveSubInputOutput}
    onBoundary={edge => featureListIntent(edge)}
    onActivate={() => { if (featureListIntent("activate")) return true; if (pluginItems.length === 0) return false; handleItemClick(selectedIndex); return true; }}
    onAction={handlePluginChromeAction}
    showDiagnostics={currentAction.plugin_path === WEB_PREVIEW_PLUGIN_PATH || desktopPluginPanelRenderSmokeEnabled()}
    diagnosticsChips={hostView.runtimeChips}
    diagnosticIdentity={hostView.diagnostics}
    displayStatus={pluginDisplayStatus} fileDropStatus={pluginFileDropStatus}
    hostClipboardStatus={hostClipboardStatus}
    dialogsStatus={pluginDialogsStatus}
    pathsStatus={pluginPathsStatus}
    dataStatus={pluginDataStatus}
    reopening={hostClipboardReopening}
    onReopenData={() => void reopenPluginData()}
    onReopenClipboard={() => void reopenHostClipboard()}
    onReopenPaths={() => void reopenPluginPaths()}
  />

  <PluginPanelBody
    hostView={hostView}
    featureList={featureList}
    featureListA11yId={featureListA11yId}
    reportActiveOption={featureActiveDescendant.report}
    resolveIcon={resolveFeatureIcon}
    onFeatureSelect={index => { featureList = { ...featureList, selected: index }; featureListIntent("activate"); }}
    onFeatureHover={index => { if (!featureList.busy) featureList = { ...featureList, selected: index }; }}
    onFeaturePointerMove={() => { if (featureList.keyboard) featureList = { ...featureList, keyboard: false }; }}
    retryView={pluginLoadRetryView}
    retryPluginLoad={retryPluginLoad}
    onItemClick={handleItemClick}
    outputContextMenu={outputContextMenu}
    contextMenuController={pluginPanelMessageHost.contextMenu}
    onOpenOutputContextMenu={openOutputContextMenu}
    onCopyOutputContextMenuItem={copyOutputContextMenuItem}
    bind:iframeRef
    iframeEpoch={subInputState.epoch}
    iframeAction={pluginMainFrame}
    iframeSrc={iframeSrc}
    iframeSrcDoc={iframeSrcDoc}
    iframeInert={mainPushMode !== "visible" || !panelSessionVisible}
    iframeSandbox={pluginPageDocumentModeEnabled() && currentAction.plugin_path !== WEB_PREVIEW_PLUGIN_PATH ? "allow-scripts allow-same-origin" : mainPushRunnerId ? "allow-scripts" : PLUGIN_IFRAME_SANDBOX}
    browserWindows={browserWindowPanelState.windows}
    browserWindowStyle={pluginBrowserWindowStyle}
    browserWindowFrameStyle={pluginBrowserWindowFrameStyle}
    closeBrowserWindow={closePluginBrowserWindow}
    browserWindowFrameAction={pluginBrowserWindowFrame}
    browserWindowSandbox={PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX}
    permissionRequest={activePluginPermissionRequest}
    pluginName={currentAction.plugin_name || currentAction.plugin_id}
    respondPermission={respondPluginPermissionRequest}
  />
</div>

<style>
  .persistent-hidden { position: absolute; inset: 0 auto auto -100000px; visibility: hidden; pointer-events: none; }
</style>
