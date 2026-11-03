<script lang="ts">
  import type LauncherMainPushHost from "./components/LauncherMainPushHost.svelte";
  import LauncherPrimarySurface from "./components/LauncherPrimarySurface.svelte";
  import WindowResizeNotice from "./components/WindowResizeNotice.svelte";
  import type { MainPushState } from "./lib/launcherMainPush";
  import { createLauncherTabTargetController } from "./lib/launcherTabTargetController";
  import { createLauncherControllerHost, type LauncherControllerState } from "./lib/launcherControllerHost";
  import type { LauncherSystemDestination } from "./lib/launcherSystemSearchActions";
  import { createLauncherKeyboardHost } from "./lib/launcherKeyboardHost";
  import { createLauncherTauriWindowRuntime } from "./lib/launcherTauriWindowRuntime";
  import { createLauncherWindowRuntimeHost } from "./lib/launcherWindowRuntimeHost";
  import { createLauncherPluginDetachBridge } from "./lib/launcherPluginDetachContract";
  import type { PluginPanelMountExports } from "./lib/pluginPanelMount";
  import { LAUNCHER_LAYOUT } from "./lib/launcherWindowLayout";
  import { createLauncherSurfacePresentation } from "./lib/launcherSurfacePresentation.svelte";
import { createLauncherPluginPanelSurfaceBindings } from "./lib/launcherPluginPanelSurfaceBindings";
  import { createLauncherWindowResize } from "./lib/launcherWindowResize.svelte";
  import { initialPluginHostSmokeAction } from "./lib/pluginHostSmokeAction";
  import type { DesktopSmokeDeepReadFilesActivation } from "./lib/desktopSmokeDeepReadFilesActivationPort";
  import { createLauncherMediaSearch, emptyLauncherMediaSearchState } from "./lib/launcherMediaSearch";
  import { createLauncherMediaPaste } from "./lib/launcherMediaPaste";
  import type { LauncherClipboardMedia, LauncherFile } from "./lib/launcherMediaContext";
  import { createLauncherContentSearch, emptyLauncherContentSearchState } from "./lib/launcherContentSearch";

  import { searchSelectionIdentity, type SearchSelectionIdentity } from "./lib/launcherSearch";
  import { onMount, onDestroy, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { permissionDialogOpen } from "./lib/permissionDialogFocus";
  import { listen } from "@tauri-apps/api/event";

  import { readText } from "@tauri-apps/plugin-clipboard-manager";
  import AppUpdatePrompt from "./components/AppUpdatePrompt.svelte";
  import PermissionPromptHost from "./components/PermissionPromptHost.svelte";
  import LauncherActionMenu from "./components/LauncherActionMenu.svelte";
  import { PLUGIN_CODE_CHANGED_EVENT, type PluginCodeChange } from "./lib/pluginCodeLifecycle";
  import { resolveLauncherAction } from "./lib/launcherCommandActions";
  import { loadLauncherPinSnapshots } from "./lib/launcherPins";
  import PasteboardDialog from "./components/PasteboardDialog.svelte";
  import PasteboardShelf from "./components/PasteboardShelf.svelte";
  import SuperPanelWindow from "./components/SuperPanelWindow.svelte";
  import FloatingBallWindow from "./components/FloatingBallWindow.svelte";
  import type { FeatureAction, SearchResult } from "./lib/types";
  import {
    loadAToolsSettingsSync,
    type AToolsSettings,
  } from "./lib/settings";
  import type { SettingsMenuId } from "./lib/settingsPages";
  import { type PluginMarketRequest } from "./lib/pluginMarketNavigation";

  import { type ShellPanel, type RecommendedCommand } from "./lib/uiState";
  import {
    loadLocalLaunchEntries,
    type LocalLaunchEntry,
  } from "./lib/localLaunch";
  import {
    loadWebQuickOpenEntries,
    type WebQuickOpenEntry,
  } from "./lib/webQuickOpen";
  import { type RemoteSearchStatus } from "./lib/searchFeedback";
  import { useLauncherPanelAutoReturn } from "./lib/launcherPanelAutoReturn.svelte";


  import { loadCommandHistory, type CommandHistoryEntry } from "./lib/commandHistory";
  import type { PastedItem } from "./lib/pasteIntake";

  import { loadCommandAliases, type CommandAliasEntry } from "./lib/commandAliases";
  import {
    loadPinnedCommandCodes,
  } from "./lib/pinnedCommands";
  import { resultOptionId } from "./lib/launcherKeyboard";
  import { appUpdater, appUpdaterState } from "./lib/appUpdater";


  type DesktopSmokeActivationReady = (activate: DesktopSmokeDeepReadFilesActivation) => void;
  let { backgroundServices = true, onDesktopSmokeFilesActivationReady }: {
    backgroundServices?: boolean;
    onDesktopSmokeFilesActivationReady?: DesktopSmokeActivationReady;
  } = $props();



  let query = $state("");
  let textMatch = $state(emptyLauncherContentSearchState());
  let mediaMatch = $state(emptyLauncherMediaSearchState());
  let searchSelectAllToken = $state(0);
  let results: SearchResult[] = $state([]);
  let activePlugin: FeatureAction | null = $state(initialPluginHostSmokeAction());
  let pluginLifecycleNotice = $state<PluginCodeChange | null>(null);
  let pluginActivationError = $state("");
  let desktopSmokePluginActions: FeatureAction[] = $state([]);
  let desktopSmokePluginIndex = $state(0);
  let activePanel: ShellPanel = $state("home");
  let settingsMenuTarget = $state<SettingsMenuId>("general");
  let pluginMarketRequest = $state<PluginMarketRequest | null>(null);
  $effect(() => { if (activePanel !== "settings") pluginMarketRequest = null; });
  let selectedIndex = $state(0);
  let userSearchSelection: SearchSelectionIdentity | null = null;
  let selectedRecentIndex = $state(0);
  let searchFocusToken = $state(0);
  let permissionPrompt: { refresh: () => Promise<void> } | null = $state(null);
  let launcherActionMenu: LauncherActionMenu | undefined = $state();
  let resultsListInstance: { pageSelection: (direction: -1 | 1) => boolean } | null = null;
  let appSettings = $state<AToolsSettings>(loadAToolsSettingsSync());
  let localLaunchEntries = $state<LocalLaunchEntry[]>(loadLocalLaunchEntries());
  let webQuickOpenEntries = $state<WebQuickOpenEntry[]>(loadWebQuickOpenEntries());
  let commandHistory = $state<CommandHistoryEntry[]>(loadCommandHistory());
  let availableFeatureIdentities = $state<Set<string>>(new Set());
  let featureCatalog = $state<SearchResult[]>([]);
  let tabTargetFeedback = $state("");
  const tabTargetController = createLauncherTabTargetController({
    current: () => ({ target: appSettings.tabTarget, query, inScope: isHomeSearch && appSettings.tabKeyFunction === "target-command" && !permissionDialogOpen() && !document.querySelector('[role="menu"]') && textMatch.content === null && mediaMatch.content === null && mediaMatch.intakeKind === null }),
    refresh: () => refreshFeatureCatalog(true), catalog: () => featureCatalog,
    activate: (code, payload, expectedPluginId, isCancelled) => activateFeature(code, payload, { expectedPluginId, isCancelled, throwOnError: true }),
    feedback: (message) => { tabTargetFeedback = message; },
  });
  onDestroy(() => tabTargetController.cancel());
  let availableFeatureCodesReady = $state(false);
  let pinnedCatalogReady = $state(false);
  let pinnedSnapshots = $state(loadLauncherPinSnapshots());
  let featureCatalogRunId = 0;
  let commandAliases = $state<CommandAliasEntry[]>(loadCommandAliases());
  let pinnedCommandCodes = $state<string[]>(loadPinnedCommandCodes());
  let pastedItems = $state<PastedItem[]>([]);
  let remoteSearchStatus = $state<RemoteSearchStatus>("idle");
  let searchError = $state("");
  let searchRunId = 0;
  let launcherDisposed = false;
  let readVisibleRecentCommands = (): RecommendedCommand[] => [];
  let presentation = $state<ReturnType<typeof createLauncherSurfacePresentation> | null>(null);
  function currentPresentation() {
    if (!presentation) throw new Error("Launcher presentation is not initialized");
    return presentation;
  }
  async function resetPalette() { await currentPresentation().resetPalette(); }
  function syncLauncherSearchPresentation() { currentPresentation().syncSearchPresentation(); }
  onDestroy(() => { launcherDisposed = true; searchRunId++; });
  let featureCatalogRetryCount = 0;
  let featureCatalogRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const pluginDetachBridge = createLauncherPluginDetachBridge(invoke, typeof window !== "undefined" ? window.location.hash : "");
  const isFloatingBallWindow = typeof window !== "undefined" && window.location.hash === "#/floating-ball";
  const isSuperPanelWindow = typeof window !== "undefined" && window.location.hash === "#/super-panel";
  const isPasteboardShelfWindow = typeof window !== "undefined" && window.location.hash === "#/pasteboard-shelf";
  const isPasteboardDialogWindow = typeof window !== "undefined" && window.location.hash.startsWith("#/pasteboard-dialog");
  const tauriWindowRuntime = createLauncherTauriWindowRuntime(() => invoke);
  const { hasTauriRuntime, currentTauriWindowLabel, waitForTauriRuntime, sleep } = tauriWindowRuntime;
  const windowResize = createLauncherWindowResize({ hasRuntime: hasTauriRuntime, invokeResize: async height => { await invoke("expand_window", { height }); } });
  onDestroy(() => windowResize.dispose());
  const currentWindowLabel = currentTauriWindowLabel();
  const isMainRoute = typeof window !== "undefined"
    && (window.location.hash === "" || window.location.hash === "#/");
  const isMainWindow = currentWindowLabel === "main"
    || (isMainRoute
      && !isFloatingBallWindow
      && !isSuperPanelWindow
      && !pluginDetachBridge.isPluginDetachWindow
      && !isPasteboardShelfWindow
      && !isPasteboardDialogWindow);
  let superPanelClipboardText = $state("");
  let superPanelStatus = $state("");
  let pluginPanelInstance: PluginPanelMountExports | null = $state(null);
  let mainPushHostInstance = $state<ReturnType<typeof LauncherMainPushHost> | undefined>();
  let mainPushState = $state<MainPushState>({ rows: [], pending: false, deferred: 0, message: "", promotedId: null });
  let launcherResults = $derived([...results, ...mainPushState.rows]);
  let defaultWindowHeight = $derived(appSettings.windowDefaultHeight || LAUNCHER_LAYOUT.fallbackWindowHeight);
  let isHomeSearch = $derived(activePlugin === null && activePanel === "home");
  const contentSearch = createLauncherContentSearch({
    search: content => invoke<SearchResult[]>("search_text_content_features", { content }),
    available: hasTauriRuntime, isActive: () => isHomeSearch,
    onUpdate: update => {
      textMatch = update;
      if (update.content === null) return;
      results = update.results;
      remoteSearchStatus = update.status; searchError = update.error;
      syncLauncherSearchPresentation();
    },
  });
  const mediaSearch = createLauncherMediaSearch({
    searchFiles: paths => invoke<{files:LauncherFile[];results:SearchResult[]}>("search_file_content_features", {paths}),
    searchImage: () => invoke<SearchResult[]>("search_image_content_features"),
    available: hasTauriRuntime, isActive: () => isHomeSearch,
    onUpdate: update => {
      mediaMatch = update;
      if (update.content === null && update.intakeKind === null) return;
      pastedItems = update.pastedItems; results = update.results;
      remoteSearchStatus = update.status; searchError = update.error;
      syncLauncherSearchPresentation();
    },
  });
  const mediaPaste = createLauncherMediaPaste({
    begin: kind => { tabTargetController.cancel(); return mediaSearch.beginIntake(kind); }, current: mediaSearch.isIntakeCurrent, cancel: mediaSearch.cancelIntake,
    read: filesOnly => invoke<LauncherClipboardMedia>("read_launcher_clipboard_media", filesOnly ? {filesOnly:true} : undefined), available: hasTauriRuntime,
    query: () => query, pin: (...args) => pinLauncherMedia(...args), error: mediaSearch.reportIntakeError,
  });
  async function activateSystemDestination(destination: LauncherSystemDestination) {
    await navigationController.activateSystemDestination(destination);
  }

  let searchControllerOnQueryChange: ((query: string) => Promise<void>) | undefined;
  const onQueryChange = (value: string) => searchControllerOnQueryChange?.(value) ?? Promise.resolve();

  const interactionState: LauncherControllerState = {
    get query() { return query; }, set query(value) { query = value; },
    get activePlugin() { return activePlugin; }, set activePlugin(value) { activePlugin = value; },
    get activePanel() { return activePanel; }, set activePanel(value) { activePanel = value; },
    get commandHistory() { return commandHistory; }, set commandHistory(value) { commandHistory = value; },
    get desktopSmokePluginActions() { return desktopSmokePluginActions; }, set desktopSmokePluginActions(value) { desktopSmokePluginActions = value; },
    get desktopSmokePluginIndex() { return desktopSmokePluginIndex; }, set desktopSmokePluginIndex(value) { desktopSmokePluginIndex = value; },
    get featureCatalogRunId() { return featureCatalogRunId; }, set featureCatalogRunId(value) { featureCatalogRunId = value; },
    get pluginActivationError() { return pluginActivationError; }, set pluginActivationError(value) { pluginActivationError = value; },
    get localLaunchEntries() { return localLaunchEntries; }, set localLaunchEntries(value) { localLaunchEntries = value; },
    get webQuickOpenEntries() { return webQuickOpenEntries; }, set webQuickOpenEntries(value) { webQuickOpenEntries = value; },
    get featureCatalog() { return featureCatalog; }, set featureCatalog(value: SearchResult[]) { featureCatalog = value; },
    get pinnedCommandCodes() { return pinnedCommandCodes; },
    set pinnedCommandCodes(value) { pinnedCommandCodes = value; },
    get pinnedSnapshots() { return pinnedSnapshots; }, set pinnedSnapshots(value) { pinnedSnapshots = value; },
    get pinnedCatalogReady() { return pinnedCatalogReady; }, set pinnedCatalogReady(value: boolean) { pinnedCatalogReady = value; },
    get appSettings() { return appSettings; }, set appSettings(value: AToolsSettings) { appSettings = value; },
    get pastedItems() { return pastedItems; }, set pastedItems(value: PastedItem[]) { pastedItems = value; },
    get availableFeatureCodesReady() { return availableFeatureCodesReady; }, set availableFeatureCodesReady(value: boolean) { availableFeatureCodesReady = value; },
    get searchSelectAllToken() { return searchSelectAllToken; }, set searchSelectAllToken(value: number) { searchSelectAllToken = value; },
    get availableFeatureIdentities() { return availableFeatureIdentities; }, set availableFeatureIdentities(value) { availableFeatureIdentities = value; },
    get featureCatalogRetryCount() { return featureCatalogRetryCount; }, set featureCatalogRetryCount(value) { featureCatalogRetryCount = value; },
    get featureCatalogRetryTimer() { return featureCatalogRetryTimer; }, set featureCatalogRetryTimer(value) { featureCatalogRetryTimer = value; },
    get commandAliases() { return commandAliases; }, set commandAliases(value) { commandAliases = value; }, get mediaMatch() { return mediaMatch; }, get textMatch() { return textMatch; },
    get searchRunId() { return searchRunId; }, set searchRunId(value) { searchRunId = value; },
    get results() { return results; }, set results(value) { results = value; },
    get selectedIndex() { return selectedIndex; }, set selectedIndex(value) { selectedIndex = value; },
    get selectedRecentIndex() { return selectedRecentIndex; }, set selectedRecentIndex(value) { selectedRecentIndex = value; },
    get settingsMenuTarget() { return settingsMenuTarget; }, set settingsMenuTarget(value) { settingsMenuTarget = value; },
    get pluginMarketRequest() { return pluginMarketRequest; }, set pluginMarketRequest(value) { pluginMarketRequest = value; },
    get visibleRecentCommands() { return readVisibleRecentCommands(); },
    get searchError() { return searchError; }, set searchError(value) { searchError = value; },
    get remoteSearchStatus() { return remoteSearchStatus; }, set remoteSearchStatus(value) { remoteSearchStatus = value; },
    get tabTargetFeedback() { return tabTargetFeedback; }, set tabTargetFeedback(value) { tabTargetFeedback = value; },
    get userSearchSelection() { return userSearchSelection; }, set userSearchSelection(value) { userSearchSelection = value; },
    get launcherDisposed() { return launcherDisposed; },
    get pluginLifecycleNotice() { return pluginLifecycleNotice; }, set pluginLifecycleNotice(value) { pluginLifecycleNotice = value; },
  };
  const controllerHost = createLauncherControllerHost({
    state: interactionState,
    pluginLifecycle: {
      subscribe: receive => listen(PLUGIN_CODE_CHANGED_EVENT, event => receive(event.payload)),
      activePluginId: () => activePlugin?.plugin_id ?? null,
      invalidateActivePlugin: change => {
        pluginLifecycleNotice = change;
        cancelPluginActivationWaiter(new Error("Plugin code changed during activation"));
        void returnPluginToSearch(true);
      },
      updateNotice: change => {
        if (pluginLifecycleNotice?.pluginId === change.pluginId) pluginLifecycleNotice = change;
      },
      refreshCatalog: async () => {
        clearFeatureCatalogRetry();
        await refreshFeatureCatalog(true);
        if (!pluginCodeLifecycle.isDisposed() && activePlugin === null && activePanel === "home" && query.trim()) await onQueryChange(query);
      },
      onError: error => console.debug("Plugin lifecycle listener unavailable:", error),
    },
    cancelActivation: () => cancelPluginActivationWaiter(new Error("Plugin activation cancelled while returning")),
    getLauncherResults: () => launcherResults,
    closePromoted: () => mainPushHostInstance?.closePromoted(),
    onReturnRefreshError: error => console.warn("Failed to restore launcher query:", error),
    tabTargetController,
    mediaSearch,
    contentSearch,
    mediaPaste,
    hasTauriRuntime,
    readClipboardText: () => readText(),
    refreshPermissionPrompt: async () => { await permissionPrompt?.refresh(); },
    clipboardText: () => superPanelClipboardText,
    setClipboardText: value => { superPanelClipboardText = value; },
    setClipboardStatus: value => { superPanelStatus = value; },
    focusSearch,
    resetPalette,
    returnPluginToSearch: () => returnPluginToSearch(),
    onQueryChange,
    activateSystemDestination,
    getMainPushHost: () => mainPushHostInstance ?? null,
    searchSelection: searchSelectionIdentity,
    clearSearchContexts: () => { contentSearch.clear(); mediaSearch.clear(); },
    advanceSearchRun: () => { searchRunId += 1; },
    defaultWindowHeight: () => defaultWindowHeight,
    expandPalette: height => expandPalette(height),
    tabTargetControllerForSearch: tabTargetController,
    mediaPasteForSearch: mediaPaste,
    cancelTabTarget: () => tabTargetController.cancel(),
    openHideMainWindow: async () => { try { await invoke("hide_main_window"); } catch (error) { console.warn("Failed to hide:", error); } },
    pluginDetach: pluginDetachBridge,
    syncLauncherSearchPresentation,
    getResults: () => launcherResults,
    cancelMediaIntake: () => mediaSearch.cancelIntake(),
  });
  const { auxiliaryWindows: auxiliaryWindowController, intakeController, pluginSession, interactionRuntime, pluginCodeLifecycle, launcherReturnCoordinator } = controllerHost;
  onDestroy(() => launcherReturnCoordinator.dispose());
  const { openMainFromFloatingBall, openMainFromSuperPanel, refreshSuperPanelClipboard,
    copySuperPanelText } = auxiliaryWindowController;
  const { onSearchPaste, pinLauncherMedia, onLauncherVisibilityChange, removeLauncherMedia, removeLauncherText,
    pinLauncherText, restoreLauncherText } = intakeController;
  const { activateFeature, cancelPluginActivationWaiter } = pluginSession;

  const { resultActions, homeController, navigationController, searchController } = interactionRuntime;
  searchControllerOnQueryChange = searchController.onQueryChange;
  const { onSelect, pinnedCommandOptions, launcherPinsContext, maybeActivateAppShortcut } = resultActions;
  const { availableCommandHistory, recommendedCommandsForHome, refreshFeatureCatalog,
    clearFeatureCatalogRetry } = homeController;
  const { onEscape, onPanelChange, onHomeCommand, openSettingsMenu, openPluginMarket,
    onHomePanelChange, onRecentSelectionChange, activateRecentCommand, removeRecentCommand,
    handlePluginSettingsRedirect } = navigationController;

  presentation = createLauncherSurfacePresentation({
    state: () => ({ query, activePlugin, activePanel, pluginLifecycleNotice, isHomeSearch,
      textMatch, mediaMatch, appSettings, selectedRecentIndex, selectedIndex, userSearchSelection, launcherDisposed,
      mainPushPromoted: Boolean(mainPushState.promotedId),
      setSelectedRecentIndex: index => { selectedRecentIndex = index; },
      remoteSearchStatus, searchError, launcherResults, mainPushState, defaultWindowHeight,
      setSelectedIndex: index => { selectedIndex = index; } }),
    availableCommandHistory, recommendedCommandsForHome, pinnedCommandOptions, resizePalette,
    isDisposed: () => launcherDisposed,
  });
  readVisibleRecentCommands = () => currentPresentation().visibleRecentCommands;
  const { currentShellHeight } = currentPresentation();

  const windowRuntimeHost = createLauncherWindowRuntimeHost({
    state: interactionState,
    routes: { isPasteboardShelfWindow, isPasteboardDialogWindow, isFloatingBallWindow, isSuperPanelWindow,
      isPluginDetachWindow: pluginDetachBridge.isPluginDetachWindow, isMainWindow },
    backgroundServices: () => backgroundServices,
    pluginCodeLifecycle,
    pluginSession,
    interactionRuntime,
    intakeController,
    auxiliaryWindowController,
    tabTargetController,
    hasTauriRuntime,
    waitForTauriRuntime,
    sleep,
    resizePalette,
    returnPluginToSearch,
    openSettingsMenu,
    resizeCurrentPalette: resetPalette,
    onReturnToSearch: returnPluginToSearch,
    pluginDetach: pluginDetachBridge,
    // The smoke activation callback is captured once for this App instance's lifetime.
    onDesktopSmokeFilesActivationReady: untrack(() => onDesktopSmokeFilesActivationReady),
  });
  onDestroy(() => windowRuntimeHost.smoke.dispose());
  const { pluginWindow: pluginWindowController, lifecycle: runtimeLifecycle } = windowRuntimeHost;
  const { handlePluginRedirect } = pluginWindowController;
  onMount(() => runtimeLifecycle.start());

  useLauncherPanelAutoReturn({
    activePanel: () => activePanel,
    activePlugin: () => activePlugin,
    settings: () => appSettings,
    onPanelChange,
  });

  onMount(() => {
    if (!hasTauriRuntime() || (!isMainWindow && !pluginDetachBridge.isPluginDetachWindow)) return;
    void pluginCodeLifecycle.start();
    return () => { void pluginCodeLifecycle.dispose(); featureCatalogRunId += 1; };
  });

  let pluginSurfaceBindings = $derived(createLauncherPluginPanelSurfaceBindings({
    activeAction: activePlugin, enabled: backgroundServices && isMainWindow && hasTauriRuntime(), promotedRunnerId: mainPushState.promotedId,
    panelPropsForAction: action => pluginWindowController.pluginPanelProps(action),
    onPluginPanelInstance: instance => { pluginPanelInstance = instance; }, activePluginId: () => activePlugin?.plugin_id ?? null,
    returnToSearch: () => returnPluginToSearch(true),
  }));

  async function returnPluginToSearch(codeChanged = false) {
    await launcherReturnCoordinator.returnToSearch(codeChanged);
  }

  async function expandPalette(height: number) {
    await resizePalette(height);
  }

  function resizePalette(height: number) { return windowResize.resize(height); }

  function focusSearch() {
    searchFocusToken += 1;
  }

  const keyboardHost = createLauncherKeyboardHost({
    state: interactionState, homeNavigationSections: () => currentPresentation().homeSections,
    routes: { isPasteboardShelfWindow, isPasteboardDialogWindow },
    results: () => launcherResults,
    mainPushPromoted: () => Boolean(mainPushState.promotedId),
    removeLauncherMedia,
    pinLauncherText,
    restoreLauncherText,
    menuShortcut: (event, item) => launcherActionMenu?.shortcut(event, item) ?? false,
    mainPushHost: () => mainPushHostInstance ?? null,
    pluginPanel: () => pluginPanelInstance,
    pageResults: direction => resultsListInstance?.pageSelection(direction) ?? false,
    focusSearch,
    activateRecentCommand: () => { void activateRecentCommand(); },
    onSelect,
    onQueryChange: value => onQueryChange(value),
    launchTabTarget: () => { void tabTargetController.launch(); },
    activateAppShortcut: maybeActivateAppShortcut,
    onEscape: () => { void onEscape(); },
  });
  const onKeyDown = keyboardHost.onKeyDown;

</script>

<svelte:window onkeydown={onKeyDown} onblur={() => mediaSearch.cancelIntake()} />
<svelte:document onvisibilitychange={onLauncherVisibilityChange} />

{#if isPasteboardShelfWindow}
  <PasteboardShelf />
{:else if isPasteboardDialogWindow}
  <PasteboardDialog />
{:else if isSuperPanelWindow}
  <SuperPanelWindow clipboardText={superPanelClipboardText} status={superPanelStatus} onRefresh={refreshSuperPanelClipboard} onCopy={copySuperPanelText} onOpenMain={openMainFromSuperPanel} />
{:else if isFloatingBallWindow}
  <FloatingBallWindow onOpenMain={openMainFromFloatingBall} />
{:else}
  <LauncherPrimarySurface
    activePanel={activePanel}
    expanded={activePlugin !== null || activePanel !== "home" || currentPresentation().showQueryResults || currentPresentation().showHomeRecent || currentPresentation().showTabTargetStatus || pluginLifecycleNotice !== null}
    contentVisible={currentPresentation().hasContent}
    searchVisible={activePlugin === null}
    targetHeight={currentShellHeight()}
    activationError={pluginActivationError || textMatch.error || mediaMatch.error}
    showSettingsHeader={(activePanel === "settings" || activePanel === "plugins") && activePlugin === null}
    {query}
    placeholder={mediaMatch.content !== null || mediaMatch.intakeKind !== null ? "筛选内容处理命令" : textMatch.content !== null ? "筛选处理命令" : appSettings.placeholder}
    focusToken={searchFocusToken}
    selectAllToken={searchSelectAllToken}
    matchSummary={textMatch.content !== null ? textMatch.summary : null}
    mediaContext={mediaMatch.content !== null ? {kind:mediaMatch.content.kind,summary:mediaMatch.summary} : mediaMatch.intakeKind !== null ? {kind:mediaMatch.intakeKind,summary:mediaMatch.intakeKind === "img" ? "正在读取图片" : "正在读取文件"} : null}
    resultsId={activePlugin === null && activePanel === "home" ? "launcher-results" : undefined}
    resultsExpanded={currentPresentation().showQueryResults}
    activeDescendant={launcherResults[selectedIndex] ? resultOptionId(selectedIndex) : undefined}
    onQueryChange={value => searchController.onQueryChange(value)}
    onMediaRemove={removeLauncherMedia}
    onMatchEdit={() => restoreLauncherText()}
    onMatchRemove={removeLauncherText}
    onBadgeClick={() => openSettingsMenu("general")}
    onPaste={onSearchPaste}
    onPanelChange={onPanelChange}
    lifecycleNotice={pluginLifecycleNotice}
    detached={pluginDetachBridge.isPluginDetachWindow}
    onReturn={() => { if (pluginDetachBridge.isPluginDetachWindow) void openMainFromFloatingBall(); void returnPluginToSearch(); }}
    {activePlugin}
    {...pluginSurfaceBindings}
    resultsSurface={{
      results: launcherResults, selectedIndex, query, feedback: currentPresentation().searchFeedback, onselect: onSelect,
      onretry: () => { keyboardHost.retryFromPointer(); },
      onselectionchange: index => { selectedIndex = index; userSearchSelection = searchSelectionIdentity(launcherResults, index); },
      oncommandmenu: (event, item) => { if (!mainPushHostInstance?.owns(item.code)) launcherActionMenu?.open(event, item); },
      canOpenCommandMenu: item => Boolean(isHomeSearch && mediaMatch.content === null && mediaMatch.intakeKind === null && !mainPushHostInstance?.owns(item.code) && resolveLauncherAction(item, launcherPinsContext())),
      ongroupenter: group => { void mainPushHostInstance?.enterGroup(group); },
      showQueryResults: currentPresentation().showQueryResults, showHomeRecent: currentPresentation().showHomeRecent, showTabTargetStatus: currentPresentation().showTabTargetStatus,
      fullRecentCommands: currentPresentation().fullRecentCommands, visibleRecentCommands: currentPresentation().visibleRecentCommands,
      homeSections: currentPresentation().homeSections, onHomeSectionToggle: section => currentPresentation().toggleHomeSection(section), recentSelectedIndex: selectedRecentIndex,
      recentSelectedLabel: currentPresentation().selectedRecentLabel, recentStatus: currentPresentation().selectedRecentStatus, settings: appSettings,
      tabAction: currentPresentation().searchStatusTabAction, tabTargetFeedback, featureCatalog, pushState: mainPushState,
      onHomeCommand, onHomePanelChange, onRecentSelectionChange,
      onRecentActivate: command => activateRecentCommand(currentPresentation().visibleRecentCommands.indexOf(command)),
      onRecentRemove: removeRecentCommand,
      onRecentCommandMenu: (event, item) => launcherActionMenu?.open(event, item),
      onTargetSettings: openSettingsMenu,
      onBindResultsList: instance => { resultsListInstance = instance ?? null; },
    }}
    settingsMenu={settingsMenuTarget}
    marketRequest={pluginMarketRequest}
    onMarketRequest={openPluginMarket}
    onMainPushInstance={instance => { mainPushHostInstance = instance; }}
    mainPushQuery={textMatch.content ?? query}
    mainPushFixed={textMatch.content !== null}
    mainPushFilter={textMatch.content !== null ? query : ""}
    mainPushActive={hasTauriRuntime() && isHomeSearch && mediaMatch.content === null && mediaMatch.intakeKind === null}
    {invoke} {listen}
    onMainPushClose={returnPluginToSearch}
    {onEscape}
    onRedirect={handlePluginRedirect}
    onSettingsRedirect={handlePluginSettingsRedirect}
    onMainPushUpdate={state => { mainPushState = state; syncLauncherSearchPresentation(); }}
    onMainPushActivate={pluginSession.activateMainPush}
  />
  {#if isMainWindow && windowResize.notice}
    <WindowResizeNotice onclose={() => windowResize.dismiss()} />
  {/if}

  <PermissionPromptHost bind:this={permissionPrompt} {invoke} {listen} enabled={hasTauriRuntime()} />
  <LauncherActionMenu bind:this={launcherActionMenu} enabled={isHomeSearch && mediaMatch.content === null && mediaMatch.intakeKind === null} generation={`${textMatch.generation}:${mediaMatch.generation}:${query}`}  pinnedCodes={pinnedCommandCodes}
    resolve={(item) => resolveLauncherAction(item, launcherPinsContext())} onremove={removeRecentCommand} onreturnfocus={focusSearch} />

  {#if !pluginDetachBridge.isPluginDetachWindow && $appUpdaterState.promptVisible}
    <AppUpdatePrompt
      state={$appUpdaterState}
      ondismiss={() => appUpdater.dismiss()}
      oninstall={() => appUpdater.installAndRestart()}
    />
  {/if}
{/if}
