<script lang="ts">
  import { mount, unmount, onMount, type Component } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { homeDir } from "@tauri-apps/api/path";
  import { readText } from "@tauri-apps/plugin-clipboard-manager";
  import HomePanel from "./components/HomePanel.svelte";
  import AppUpdatePrompt from "./components/AppUpdatePrompt.svelte";
  import PermissionConfirmDialog from "./components/PermissionConfirmDialog.svelte";
  import ResultsList from "./components/ResultsList.svelte";
  import SearchBar from "./components/SearchBar.svelte";
  import SearchStatusBar from "./components/SearchStatusBar.svelte";
  import SettingsHeader from "./components/SettingsHeader.svelte";
  import ShellFrame from "./components/ShellFrame.svelte";
  import SystemPanel from "./components/SystemPanel.svelte";
  import ZMark from "./components/ZMark.svelte";
  import type { FeatureAction, PendingAgentToolRequest, SearchResult, TaskRun } from "./lib/types";
  import { desktopSmokePluginQueueActionActive } from "./lib/desktopSmokePluginQueue";
  import {
    applyAToolsAppearance,
    loadAToolsSettings,
    loadAToolsSettingsSync,
    type AToolsSettings,
  } from "./lib/settings";
  import type { SettingsMenuId } from "./lib/settingsPages";
  import {
    appShortcutTargetFromKeyboardEvent,
    type AppShortcutTargetMatch,
  } from "./lib/appShortcutRuntime";
  import { RECOMMENDED_COMMANDS, SYSTEM_ACTIONS, type RecommendedCommand, type ShellPanel } from "./lib/uiState";
  import { homeCommandStatus } from "./lib/homeSurface";
  import {
    LOCAL_LAUNCH_UPDATED_EVENT,
    loadLocalLaunchEntries,
    localLaunchEntryByCode,
    localLaunchResultsForQuery,
    resolveLocalLaunchPath,
    type LocalLaunchEntry,
  } from "./lib/localLaunch";
  import {
    buildWebQuickOpenUrl,
    loadWebQuickOpenEntries,
    WEB_QUICK_OPEN_UPDATED_EVENT,
    webQuickOpenEntryByCode,
    webQuickOpenResultsForQuery,
    type WebQuickOpenEntry,
  } from "./lib/webQuickOpen";
  import {
    classifyPastedContent,
    pasteInputFromDataTransfer,
    pastedItemByCode,
    pasteQueryLabel,
    pasteResultsForItems,
    type PastedItem,
  } from "./lib/pasteIntake";
  import {
    searchFeedbackFor,
    type RemoteSearchStatus,
  } from "./lib/searchFeedback";
  import {
    includeLocalAppSearch,
    autoBackToSearchDelayMs,
    autoClearDelayMs,
    autoPasteDelayMs,
    autoPasteQueryCandidate,
    includeLocalLaunchSearch,
  } from "./lib/searchBehavior";
  import {
    urlFromQuickOpenCode,
    urlQuickOpenResultsForQuery,
  } from "./lib/urlQuickOpen";
  import { searchMatchForQuery, sortSearchMatches } from "./lib/searchMatch";
  import {
    normalizePluginRedirectLabel,
    selectPluginRedirectResult,
  } from "./lib/pluginRedirect";
  import { loadSearchPinyinEngine } from "./lib/pinyinSearch";
  import {
    payloadFromTextQuickActionCode,
    textQuickActionResultsForQuery,
  } from "./lib/textQuickActions";
  import {
    COMMAND_HISTORY_UPDATED_EVENT,
    commandHistoryPayloadFromCode,
    commandHistoryResultsForQuery,
    dispatchCommandHistoryUpdated,
    homeCommandsFor,
    loadCommandHistory,
    recordCommandUse,
    removeCommandHistoryEntry,
    saveCommandHistory,
    type CommandHistoryEntry,
  } from "./lib/commandHistory";
  import {
    COMMAND_ALIASES_UPDATED_EVENT,
    commandAliasPayloadFromCode,
    commandAliasResultsForQuery,
    loadCommandAliases,
    type CommandAliasEntry,
    type CommandAliasTarget,
  } from "./lib/commandAliases";
  import {
    PINNED_COMMANDS_UPDATED_EVENT,
    loadPinnedCommandCodes,
  } from "./lib/pinnedCommands";
  import { isEditableKeyboardTarget, isMainSearchKeyboardTarget } from "./lib/keyboardTarget";
  import { appUpdater, appUpdaterState } from "./lib/appUpdater";

  type ReleaseSmokeInfo = {
    token: string;
    report_path?: string | null;
  };

  type ReleaseSmokeProgress = {
    option_z_toggled?: boolean;
    settings_page_opened?: boolean;
    plugin_page_opened?: boolean;
    agent_page_opened?: boolean;
    clipboard_copy_tracked?: boolean;
    errors?: string[];
    completed?: boolean;
  };

  let query = $state("");
  let results: SearchResult[] = $state([]);
  let activePlugin: FeatureAction | null = $state(initialPluginHostSmokeAction());
  let desktopSmokePluginActions: FeatureAction[] = $state([]);
  let desktopSmokePluginIndex = $state(0);
  let activePanel: ShellPanel = $state("home");
  let settingsMenuTarget = $state<SettingsMenuId>("general");
  let selectedIndex = $state(0);
  let selectedRecentIndex = $state(0);
  let searchFocusToken = $state(0);
  let pendingPermissionRequests: PendingAgentToolRequest[] = $state([]);
  let permissionBusyId = $state("");
  let permissionError = $state("");
  let appSettings = $state<AToolsSettings>(loadAToolsSettingsSync());
  let localLaunchEntries = $state<LocalLaunchEntry[]>(loadLocalLaunchEntries());
  let webQuickOpenEntries = $state<WebQuickOpenEntry[]>(loadWebQuickOpenEntries());
  let commandHistory = $state<CommandHistoryEntry[]>(loadCommandHistory());
  let commandAliases = $state<CommandAliasEntry[]>(loadCommandAliases());
  let pinnedCommandCodes = $state<string[]>(loadPinnedCommandCodes());
  let pastedItems = $state<PastedItem[]>([]);
  let remoteSearchStatus = $state<RemoteSearchStatus>("idle");
  let searchError = $state("");
  let searchRunId = 0;
  let autoClearTimer: ReturnType<typeof setTimeout> | null = null;
  let clipboardPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastClipboardText = "";
  let lastClipboardChangedAt: number | null = null;
  let lastAutoPastedText = "";
  let clipboardBaselineReady = false;
  const FALLBACK_WINDOW_HEIGHT = 600;
  const SETTINGS_WINDOW_HEIGHT = 860;
  const AGENT_WINDOW_HEIGHT = 760;
  const SEARCH_ONLY_WINDOW_HEIGHT = 72;
  const SHELL_BORDER_HEIGHT = 2;
  const SEARCH_BAR_HEIGHT = 58;
  const HOME_OVERVIEW_HEIGHT = 66;
  const HOME_PINNED_EMPTY_HEIGHT = 76;
  const HOME_PANEL_VERTICAL_CHROME = 115;
  const RECENT_GRID_COLUMNS = 9;
  const RECENT_TILE_HEIGHT = 78;
  const RECENT_ROW_GAP = 8;
  const RESULTS_MIN_HEIGHT = 112;
  const RESULTS_MAX_HEIGHT = 420;
  const RESULTS_VERTICAL_PADDING = 12;
  const SEARCH_STATUS_BAR_HEIGHT = 34;
  const RESULT_ROW_HEIGHT = 54;
  const RESULT_GROUP_HEADER_HEIGHT = 24;
  const RESULT_GROUP_GAP = 4;
  const isFloatingBallWindow = typeof window !== "undefined" && window.location.hash === "#/floating-ball";
  const isSuperPanelWindow = typeof window !== "undefined" && window.location.hash === "#/super-panel";
  const isPluginDetachWindow = typeof window !== "undefined" && window.location.hash.startsWith("#/plugin-detach");
  let superPanelClipboardText = $state("");
  let superPanelStatus = $state("");
  let pluginPanelHost: HTMLDivElement | null = $state(null);
  let pluginPanelInstance: ReturnType<typeof mount> | null = null;
  let pluginPanelLoadToken = 0;
  let defaultWindowHeight = $derived(appSettings.windowDefaultHeight || FALLBACK_WINDOW_HEIGHT);
  let isHomeSearch = $derived(activePlugin === null && activePanel === "home");
  let trimmedQuery = $derived(query.trim());
  let pinnedCommandCapacity = $derived(homeCommandRowCapacity(appSettings.pinnedRows));
  let recentCommandCapacity = $derived(homeCommandRowCapacity(appSettings.recentRows));
  let visibleRecentCommands = $derived(homeCommandsFor(
    commandHistory,
    RECOMMENDED_COMMANDS,
    pinnedCommandCapacity + recentCommandCapacity,
    pinnedCommandOptions().slice(0, pinnedCommandCapacity),
  ));
  let showHomeRecent = $derived(isHomeSearch && trimmedQuery.length === 0 && appSettings.showRecentInSearch);
  let showQueryResults = $derived(isHomeSearch && trimmedQuery.length > 0);
  let hasContent = $derived(activePlugin !== null || activePanel !== "home" || showQueryResults || showHomeRecent);
  let activePermissionRequest = $derived(pendingPermissionRequests[0] ?? null);
  let homeRecentWindowHeight = $derived(homeWindowHeightFor(visibleRecentCommands));
  let queryResultsWindowHeight = $derived(resultsWindowHeightFor(results));
  let searchFeedback = $derived(searchFeedbackFor({
    query,
    resultCount: results.length,
    remoteStatus: remoteSearchStatus,
    error: searchError,
  }));
  let selectedSearchResult = $derived(results[selectedIndex] ?? null);
  let selectedResultLabel = $derived(selectedSearchResult?.label ?? "");
  let selectedResultAction = $derived(resultActionLabel(selectedSearchResult));
  let selectedRecentStatus = $derived(homeCommandStatus(visibleRecentCommands, selectedRecentIndex, {
    pinnedRows: appSettings.pinnedRows,
    recentRows: appSettings.recentRows,
  }));
  let selectedRecentLabel = $derived(selectedRecentStatus.selectedLabel);
  let searchStatusTabAction = $derived(appSettings.tabKeyFunction === "target-command" ? "target" : "select");
  type PluginPanelComponent = Component<{
    action: FeatureAction;
    onclose: () => void | Promise<void>;
    onredirect: (label: unknown, payload: unknown) => Promise<boolean>;
    onsettingsredirect: (
      menu: "shortcuts" | "ai",
      detail?: Record<string, unknown>
    ) => boolean | Promise<boolean>;
    desktopSmokeExpectedSamples: number;
    desktopSmokeSampleIndex: number;
    desktopSmokeExternalPlanSample: boolean;
    ondesktopsmokerender?: () => void | Promise<void>;
  }>;

  $effect(() => {
    if (visibleRecentCommands.length === 0) {
      selectedRecentIndex = 0;
      return;
    }
    selectedRecentIndex = Math.max(0, Math.min(visibleRecentCommands.length - 1, selectedRecentIndex));
  });

  $effect(() => {
    const host = pluginPanelHost;
    const action = activePlugin;
    const token = ++pluginPanelLoadToken;
    if (!host || !action) {
      destroyPluginPanelInstance();
      return;
    }
    void import("./components/PluginPanel.svelte")
      .then((module) => {
        if (token !== pluginPanelLoadToken || activePlugin !== action || pluginPanelHost !== host) return;
        destroyPluginPanelInstance();
        pluginPanelInstance = mount(module.default as PluginPanelComponent, {
          target: host,
          props: pluginPanelProps(action),
        });
      })
      .catch((error) => {
        console.warn("[PluginPanel] failed to lazy-load plugin panel:", error);
      });
    return () => {
      if (token === pluginPanelLoadToken) {
        destroyPluginPanelInstance();
      }
    };
  });

  $effect(() => {
    const panel = activePanel;
    const plugin = activePlugin;
    const delay = autoBackToSearchDelayMs(appSettings.autoBackToSearch);
    if (panel === "home" || plugin !== null || delay === null) return;

    const timer = setTimeout(() => {
      if (activePlugin === null && activePanel === panel) {
        void onPanelChange("home");
      }
    }, delay);

    return () => clearTimeout(timer);
  });

  onMount(() => {
    let settingsCancelled = false;
    let pinyinCancelled = false;
    const onPluginDetach = () => {
      if (isPluginDetachWindow || !activePlugin) return;
      void onPluginDetachAction();
    };
    if (isFloatingBallWindow || isSuperPanelWindow) {
      window.addEventListener("atools-plugin-detach", onPluginDetach);
      loadAToolsSettings().then((settings) => {
        if (settingsCancelled) return;
        appSettings = settings;
        applyAToolsAppearance(settings);
      }).catch(() => {
        // Settings are optional in the web preview.
      });
      if (isSuperPanelWindow) {
        void refreshSuperPanelClipboard();
      }
      return () => {
        settingsCancelled = true;
        pinyinCancelled = true;
        window.removeEventListener("atools-plugin-detach", onPluginDetach);
      };
    }
    if (isPluginDetachWindow) {
      window.addEventListener("atools-plugin-detach", onPluginDetach);
      void initializeDetachedPluginWindow();
      return () => {
        window.removeEventListener("atools-plugin-detach", onPluginDetach);
      };
    }

    loadSearchPinyinEngine().then((loaded) => {
      if (!loaded || pinyinCancelled) return;
      if (query.trim() && activePlugin === null) {
        void onQueryChange(query);
      }
    });
    loadAToolsSettings().then((settings) => {
      if (settingsCancelled) return;
      appSettings = settings;
      applyAToolsAppearance(settings);
    }).catch(() => {
      // Settings are optional in the web preview.
    });

    const onSettingsUpdated = (event: Event) => {
      const settings = (event as CustomEvent<AToolsSettings>).detail;
      if (!settings) return;
      appSettings = { ...appSettings, ...settings };
      applyAToolsAppearance(appSettings);
      void maybeAutoPasteClipboard();
    };
    window.addEventListener("atools-settings-updated", onSettingsUpdated);
    const onLocalLaunchUpdated = (event: Event) => {
      localLaunchEntries = (event as CustomEvent<LocalLaunchEntry[]>).detail ?? loadLocalLaunchEntries();
    };
    window.addEventListener(LOCAL_LAUNCH_UPDATED_EVENT, onLocalLaunchUpdated);
    const onWebQuickOpenUpdated = (event: Event) => {
      webQuickOpenEntries = (event as CustomEvent<WebQuickOpenEntry[]>).detail ?? loadWebQuickOpenEntries();
    };
    window.addEventListener(WEB_QUICK_OPEN_UPDATED_EVENT, onWebQuickOpenUpdated);
    const onCommandHistoryUpdated = (event: Event) => {
      commandHistory = (event as CustomEvent<CommandHistoryEntry[]>).detail ?? loadCommandHistory();
    };
    window.addEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
    const onCommandAliasesUpdated = (event: Event) => {
      commandAliases = (event as CustomEvent<CommandAliasEntry[]>).detail ?? loadCommandAliases();
    };
    window.addEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
    const onPinnedCommandsUpdated = (event: Event) => {
      pinnedCommandCodes = (event as CustomEvent<string[]>).detail ?? loadPinnedCommandCodes();
    };
    window.addEventListener(PINNED_COMMANDS_UPDATED_EVENT, onPinnedCommandsUpdated);

    const hasTauri = hasTauriRuntime();
    if (!hasTauri) {
      return () => {
        settingsCancelled = true;
        pinyinCancelled = true;
        window.removeEventListener("atools-plugin-detach", onPluginDetach);
        window.removeEventListener("atools-settings-updated", onSettingsUpdated);
        window.removeEventListener(LOCAL_LAUNCH_UPDATED_EVENT, onLocalLaunchUpdated);
        window.removeEventListener(WEB_QUICK_OPEN_UPDATED_EVENT, onWebQuickOpenUpdated);
        window.removeEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
        window.removeEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
        window.removeEventListener(PINNED_COMMANDS_UPDATED_EVENT, onPinnedCommandsUpdated);
        clearAutoClearTimer();
        stopClipboardPolling();
      };
    }

    let pluginUnlisten: (() => void) | undefined;
    let permissionUnlisten: (() => void) | undefined;
    let updateUnlisten: (() => void) | undefined;
    let cancelled = false;
    const stopStartupUpdateCheck = appUpdater.scheduleStartupCheck();
    try {
      listen<string>("plugin-event", (event) => {
        console.log("Plugin event:", event.payload);
      }).then((pluginEvent) => {
        if (cancelled) {
          pluginEvent();
        } else {
          pluginUnlisten = pluginEvent;
        }
      }).catch((e) => {
        console.warn("Plugin event listener unavailable:", e);
      });

      loadPendingPermissionRequests();
      listen<PendingAgentToolRequest>("agent-permission-request", (event) => {
        upsertPendingPermissionRequest(event.payload);
      }).then((permissionEvent) => {
        if (cancelled) {
          permissionEvent();
        } else {
          permissionUnlisten = permissionEvent;
        }
      }).catch((e) => {
        console.warn("Permission request listener unavailable:", e);
      });
      startClipboardPolling();
      void appUpdater.startProgressListener().then((stop) => {
        if (cancelled) stop();
        else updateUnlisten = stop;
      }).catch((error) => {
        console.warn("App update progress listener unavailable:", error);
      });
    } catch (e) {
      console.warn("Tauri 未启动，搜索功能不可用", e);
    }
    if (desktopPluginPanelSmokeEnabled()) {
      void activateDesktopSmokePluginPanel();
    }
    void runReleaseSmokeSequence();
    return () => {
      settingsCancelled = true;
      pinyinCancelled = true;
      window.removeEventListener("atools-settings-updated", onSettingsUpdated);
      window.removeEventListener(LOCAL_LAUNCH_UPDATED_EVENT, onLocalLaunchUpdated);
      window.removeEventListener(WEB_QUICK_OPEN_UPDATED_EVENT, onWebQuickOpenUpdated);
      window.removeEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
      window.removeEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
      window.removeEventListener(PINNED_COMMANDS_UPDATED_EVENT, onPinnedCommandsUpdated);
      clearAutoClearTimer();
      stopClipboardPolling();
      cancelled = true;
      pluginUnlisten?.();
      permissionUnlisten?.();
      updateUnlisten?.();
      stopStartupUpdateCheck();
      window.removeEventListener("atools-plugin-detach", onPluginDetach);
    };
  });

  async function onQueryChange(newQuery: string) {
    clearAutoClearTimer();
    const runId = ++searchRunId;
    query = newQuery;
    if (!newQuery.startsWith("粘贴了 ")) {
      pastedItems = [];
    }
    if (activePlugin) return;
    if (!newQuery.trim()) {
      results = [];
      selectedIndex = 0;
      selectedRecentIndex = 0;
      remoteSearchStatus = "idle";
      searchError = "";
      if (activePanel === "home") {
        await resetPalette();
      }
      focusSearch();
      return;
    }

    activePanel = "home";
    const localResults = localResultsForQuery(newQuery);
    results = localResults;
    selectedIndex = 0;
    searchError = "";
    await resizePalette(resultsWindowHeightFor(localResults));

    if (!hasTauriRuntime()) {
      remoteSearchStatus = "unavailable";
      focusSearch();
      return;
    }

    remoteSearchStatus = "searching";
    try {
      const remoteCalls = [
        invoke<SearchResult[]>("search_features", { query: newQuery }),
      ];
      if (includeLocalAppSearch(appSettings)) {
        remoteCalls.push(invoke<SearchResult[]>("search_local_apps", { query: newQuery, limit: 20 }));
      }
      const remoteSettled = await Promise.allSettled(remoteCalls);
      if (runId !== searchRunId || query !== newQuery) return;
      const remoteResults = remoteSettled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const remoteErrors = remoteSettled.filter((result) => result.status === "rejected");
      if (remoteResults.length === 0 && remoteErrors.length === remoteSettled.length) {
        throw new Error(remoteErrors.map((result) => String((result as PromiseRejectedResult).reason)).join("; "));
      }
      const mergedResults = [...localResults, ...remoteResults].sort((a, b) => b.score - a.score);
      results = mergedResults;
      selectedIndex = 0;
      remoteSearchStatus = "ready";
      await resizePalette(resultsWindowHeightFor(mergedResults));
      focusSearch();
    } catch (e) {
      console.error("Search failed:", e);
      if (runId !== searchRunId || query !== newQuery) return;
      results = localResults;
      selectedIndex = 0;
      remoteSearchStatus = "error";
      searchError = String(e);
      await resizePalette(resultsWindowHeightFor(localResults));
      focusSearch();
    }
  }

  async function onPluginDetachAction() {
    const featureCode = activePlugin?.feature_code;
    if (!featureCode) return;
    await openDetachedPluginWindow(featureCode);
    await returnPluginToSearch();
  }

  function detachedPluginFeatureCodeFromHash() {
    if (!isPluginDetachWindow || typeof window === "undefined") return null;
    const query = window.location.hash.split("?")[1];
    if (!query) return null;
    const params = new URLSearchParams(query);
    const featureCode = params.get("feature_code");
    if (!featureCode) return null;
    const normalized = featureCode.trim();
    return normalized || null;
  }

  async function initializeDetachedPluginWindow() {
    if (!isPluginDetachWindow || activePlugin !== null) return;
    if (!hasTauriRuntime()) return;
    const featureCode = detachedPluginFeatureCodeFromHash();
    if (!featureCode) return;
    try {
      const action = await invoke<FeatureAction>("activate_feature", {
        code: featureCode,
        payload: null,
      });
      activePlugin = action;
      void resizePalette(action.expand_height);
    } catch (error) {
      console.warn("Failed to open detached plugin:", featureCode, error);
    }
  }

  async function openDetachedPluginWindow(featureCode: string) {
    if (!hasTauriRuntime()) return;
    try {
      await invoke("open_plugin_detach_window", { feature_code: featureCode });
    } catch (error) {
      console.warn("Failed to open detached plugin window:", featureCode, error);
    }
  }

  async function onSelect(index: number) {
    const item = results[index];
    if (!item) return;
    if (item.code.startsWith("history:")) {
      await activateHistoryCommand(item);
      return;
    }
    if (item.code.startsWith("alias:")) {
      await activateCommandAlias(item);
      return;
    }
    rememberCommandResult(item, query);
    if (item.code.startsWith("web:")) {
      await activateWebQuickOpen(item);
      return;
    }
    if (item.code.startsWith("local:")) {
      await activateLocalLaunch(item);
      return;
    }
    if (item.code.startsWith("local-app:")) {
      await activateLocalApp(item);
      return;
    }
    if (item.code.startsWith("paste:")) {
      await activatePastedResult(item);
      return;
    }
    if (item.code.startsWith("url:")) {
      await activateUrlQuickOpen(item);
      return;
    }
    if (item.code.startsWith("text:")) {
      await activateTextQuickAction(item);
      return;
    }
    await activateFeature(item.code);
  }

  async function activateFeature(code: string, payload?: unknown) {
    if (code.startsWith("system:")) {
      await activateSystemPanel(code.replace("system:", "") as ShellPanel);
      return;
    }

    if (code.startsWith("web:")) {
      const entry = webQuickOpenEntryByCode(code, webQuickOpenEntries);
      if (entry) {
        await openUrl(buildWebQuickOpenUrl(entry, ""));
      }
      return;
    }

    if (code.startsWith("local:")) {
      const entry = localLaunchEntryByCode(code, localLaunchEntries);
      if (entry) {
        await openLocalLaunchEntry(entry);
      }
      return;
    }

    if (code.startsWith("local-app:")) {
      await openLocalAppPath(code.slice("local-app:".length));
      return;
    }

    if (code.startsWith("paste:")) {
      const result = results.find((item) => item.code === code);
      if (result) {
        await activatePastedResult(result);
      }
      return;
    }

    if (code.startsWith("url:")) {
      const url = urlFromQuickOpenCode(code);
      if (url) {
        await openUrl(url);
      }
      return;
    }

    if (code.startsWith("text:")) {
      const result = results.find((item) => item.code === code);
      if (result) {
        await activateTextQuickAction(result);
      }
      return;
    }

    try {
      const action = await invoke<FeatureAction>("activate_feature", {
        code,
        payload: payload || null,
      });
      activePlugin = action;
      results = [];
      selectedIndex = 0;
      try {
        await invoke("expand_window", { height: action.expand_height });
      } catch (e) {
        console.warn("Failed to expand window:", e);
      }
    } catch (e) {
      console.error("Activate failed:", e);
    }
  }

  async function handlePluginRedirect(label: unknown, payload: unknown) {
    const target = normalizePluginRedirectLabel(label);
    if (!target) {
      throw new Error("redirect unsupported: label must be a non-empty string or [plugin, command]");
    }
    if (!hasTauriRuntime()) {
      throw new Error("redirect unsupported: plugin feature search requires desktop runtime");
    }

    const redirectResults = await invoke<SearchResult[]>("search_features", { query: target.query });
    const selection = selectPluginRedirectResult(target, redirectResults);
    if (selection.status === "ready") {
      await activateFeature(selection.result.code, payload ?? null);
      return true;
    }

    const scope = target.pluginName ? `${target.pluginName} / ${target.query}` : target.query;
    if (selection.status === "ambiguous") {
      throw new Error(`redirect ambiguous: ${scope} matched ${selection.candidates.length} plugin features`);
    }
    throw new Error(`redirect failed: no plugin feature found for ${scope}`);
  }

  function pluginPanelProps(action: FeatureAction) {
    const queueActive = desktopSmokePluginQueueActionActive(
      desktopPluginPanelSmokeEnabled(),
      action,
      desktopSmokePluginActions,
      desktopSmokePluginIndex,
    );
    return {
      action,
      onclose: returnPluginToSearch,
      onredirect: handlePluginRedirect,
      onsettingsredirect: handlePluginSettingsRedirect,
      desktopSmokeExpectedSamples: queueActive ? desktopSmokePluginActions.length : 0,
      desktopSmokeSampleIndex: queueActive ? desktopSmokePluginIndex : 0,
      desktopSmokeExternalPlanSample: queueActive ? desktopSmokeActionExternalPlan(action) : false,
      ondesktopsmokerender: queueActive ? handleDesktopSmokePluginPanelRender : undefined,
    };
  }

  function destroyPluginPanelInstance() {
    if (!pluginPanelInstance) return;
    unmount(pluginPanelInstance);
    pluginPanelInstance = null;
  }

  async function handlePluginSettingsRedirect(menu: "shortcuts" | "ai", detail?: Record<string, unknown>) {
    activePlugin = null;
    if (menu === "shortcuts") {
      const cmdLabel = typeof detail?.cmdLabel === "string" ? detail.cmdLabel.trim() : "";
      if (detail?.autocopy === true && cmdLabel) {
        try {
          await copyText(cmdLabel);
        } catch (err) {
          console.warn("[PluginPanel] redirectHotKeySetting autocopy failed:", err);
        }
      }
      await openSettingsMenu("shortcuts");
      return true;
    }
    await openSettingsMenu("ai");
    return true;
  }

  async function returnPluginToSearch() {
    activePlugin = null;
    activePanel = "home";
    query = "";
    results = [];
    pastedItems = [];
    selectedIndex = 0;
    remoteSearchStatus = "idle";
    searchError = "";
    await resetPalette();
    focusSearch();
  }

  async function onEscape() {
    if (activePlugin) {
      await returnPluginToSearch();
    } else if (activePanel !== "home") {
      activePanel = "home";
      await resetPalette();
      focusSearch();
    } else if (query) {
      query = "";
      results = [];
      selectedIndex = 0;
      await resetPalette();
      focusSearch();
    } else {
      try {
        await invoke("hide_main_window");
      } catch (e) {
        console.warn("Failed to hide:", e);
      }
    }
  }

  async function onPanelChange(panel: ShellPanel) {
    activePanel = panel;
    if (panel !== "home") {
      query = "";
      results = [];
      selectedIndex = 0;
      selectedRecentIndex = 0;
      await expandPalette(panel === "agent" ? AGENT_WINDOW_HEIGHT : panel === "settings" ? SETTINGS_WINDOW_HEIGHT : defaultWindowHeight);
    } else {
      await resetPalette();
      focusSearch();
    }
  }

  async function onHomeCommand(command: string) {
    await onQueryChange(command);
  }

  async function openSettingsMenu(menu: SettingsMenuId) {
    settingsMenuTarget = menu;
    await onPanelChange("settings");
  }

  async function onHomePanelChange(panel: ShellPanel) {
    if (panel === "settings") {
      settingsMenuTarget = "general";
    }
    await onPanelChange(panel);
  }

  function onRecentSelectionChange(index: number) {
    selectedRecentIndex = Math.max(0, Math.min(visibleRecentCommands.length - 1, index));
    focusSearch();
  }

  async function activateRecentCommand(index = selectedRecentIndex) {
    const command = visibleRecentCommands[index];
    if (!command) return;
    if (command.source === "history") {
      await activateHistoryPayload({
        code: command.code,
        input: command.input ?? command.label,
      });
      return;
    }
    if (command.source === "pinned") {
      if (command.code.startsWith("system:") || command.code.startsWith("local:") || command.code.startsWith("web:") || command.code.startsWith("local-app:")) {
        const target = aliasTargetForCode(command.code);
        if (target) {
          rememberCommandResult(aliasTargetToSearchResult(target), command.label);
        }
        await activateFeature(command.code);
        return;
      }
      if (command.code.startsWith("url:")) {
        const url = urlFromQuickOpenCode(command.code);
        if (url) {
          await openUrl(url);
          scheduleAutoClearSearch();
          return;
        }
      }
    }
    if (command.panel) {
      await onPanelChange(command.panel);
      return;
    }
    await onHomeCommand(command.label);
    focusSearch();
  }

  function removeRecentCommand(command: RecommendedCommand) {
    if (command.source !== "history") return;
    const nextHistory = removeCommandHistoryEntry(commandHistory, command.code);
    if (nextHistory.length === commandHistory.length) return;
    commandHistory = nextHistory;
    saveCommandHistory(nextHistory);
    dispatchCommandHistoryUpdated(nextHistory);
    selectedRecentIndex = Math.max(0, Math.min(selectedRecentIndex, visibleRecentCommands.length - 1));
    focusSearch();
  }

  async function activateSystemPanel(panel: ShellPanel) {
    if (panel === "home") return;
    await onPanelChange(panel);
  }

  function localResultsForQuery(value: string): SearchResult[] {
    return [
      ...systemResultsForQuery(value),
      ...commandAliasResultsForQuery(value, commandAliases, aliasTargetForCode),
      ...urlQuickOpenResultsForQuery(value),
      ...commandHistoryResultsForQuery(value, commandHistory),
      ...textQuickActionResultsForQuery(value),
      ...(includeLocalLaunchSearch(appSettings) ? localLaunchResultsForQuery(value, localLaunchEntries) : []),
      ...webQuickOpenResultsForQuery(value, webQuickOpenEntries),
    ].sort((a, b) => b.score - a.score);
  }

  function onSearchPaste(event: ClipboardEvent) {
    if (activePlugin) return false;
    const items = classifyPastedContent(pasteInputFromDataTransfer(event.clipboardData));
    if (items.length === 0) return false;
    void showPastedItems(items);
    return true;
  }

  async function showPastedItems(items: PastedItem[]) {
    activePlugin = null;
    activePanel = "home";
    pastedItems = items;
    query = pasteQueryLabel(items);
    const pastedResults = pasteResultsForItems(items);
    results = pastedResults;
    selectedIndex = 0;
    remoteSearchStatus = "ready";
    searchError = "";
    await resizePalette(resultsWindowHeightFor(pastedResults));
    focusSearch();
  }

  function systemResultsForQuery(value: string): SearchResult[] {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return [];
    const forceSystem = normalized.startsWith(">");
    const queryText = forceSystem ? normalized.slice(1).trim() : normalized;
    if (forceSystem && !queryText) {
      return SYSTEM_ACTIONS.map((action, index) => ({
        code: `system:${action.id}`,
        plugin_id: "system",
        plugin_name: "ATools",
        label: action.label,
        icon: null,
        explain: action.description,
        score: 100 - index,
        match_type: "exact",
      }));
    }
    return sortSearchMatches(SYSTEM_ACTIONS
      .map((action, index) => ({
        action,
        index,
        match: searchMatchForQuery(queryText, {
          text: action.label,
          extraText: action.description,
          aliases: action.aliases ?? [],
        }),
      })))
      .map(({ action, index, match }) => ({
        code: `system:${action.id}`,
        plugin_id: "system",
        plugin_name: "ATools",
        label: action.label,
        icon: null,
        explain: action.description,
        score: match.score - index,
        match_type: match.type,
      }));
  }

  async function targetSelectedResult() {
    const item = results[selectedIndex];
    if (!item) return;
    if (item.code.startsWith("system:") || item.code.startsWith("web:") || item.code.startsWith("local:") || item.code.startsWith("local-app:") || item.code.startsWith("url:") || item.code.startsWith("text:") || item.code.startsWith("alias:")) {
      await onSelect(selectedIndex);
      return;
    }
    if (item.code.startsWith("paste:")) {
      await onSelect(selectedIndex);
      return;
    }
    await onQueryChange(item.label);
    focusSearch();
  }

  async function targetRecentCommand() {
    const command = visibleRecentCommands[selectedRecentIndex];
    if (!command) return;
    if (command.panel) {
      await onPanelChange(command.panel);
      return;
    }
    await onQueryChange(command.label);
    focusSearch();
  }

  async function expandPalette(height: number) {
    await resizePalette(height);
  }

  async function resetPalette() {
    await resizePalette(getShellHeight());
  }

  async function resizePalette(height: number) {
    if (!hasTauriRuntime()) return;
    try {
      await invoke("expand_window", { height: Math.round(height) });
    } catch {
      // The web preview has no Tauri runtime.
    }
  }

  function hasTauriRuntime() {
    const globalWindow = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      __TAURI_IPC__?: unknown;
    };
    return "__TAURI_INTERNALS__" in globalWindow || "__TAURI__" in globalWindow || "__TAURI_IPC__" in globalWindow;
  }

  async function waitForTauriRuntime(): Promise<boolean> {
    for (let index = 0; index < 25; index += 1) {
      if (hasTauriRuntime() && typeof invoke === "function") {
        return true;
      }
      await sleep(80);
    }
    return hasTauriRuntime() && typeof invoke === "function";
  }

  function sleep(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function desktopPluginPanelSmokeEnabled() {
    const env = import.meta.env as Record<string, unknown>;
    const value = String(env.VITE_ATOOLS_DESKTOP_SMOKE ?? "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  }

  async function activateDesktopSmokePluginPanel() {
    if (!hasTauriRuntime() || !desktopPluginPanelSmokeEnabled() || activePlugin) return;
    try {
      const actions = await invoke<FeatureAction[]>("desktop_smoke_plugin_panel_actions");
      if (actions.length === 0 || activePlugin) return;
      desktopSmokePluginActions = actions;
      await activateDesktopSmokePluginAction(0);
    } catch (error) {
      console.warn("[DesktopSmoke] Failed to activate PluginPanel smoke action:", error);
    }
  }

  async function activateDesktopSmokePluginAction(index: number) {
    const action = desktopSmokePluginActions[index];
    if (!action) return;
    desktopSmokePluginIndex = index;
    activePlugin = action;
    activePanel = "home";
    query = "";
    results = [];
    selectedIndex = 0;
    await resizePalette(action.expand_height);
  }

  async function handleDesktopSmokePluginPanelRender() {
    if (!desktopPluginPanelSmokeEnabled()) return;
    const nextIndex = desktopSmokePluginIndex + 1;
    if (nextIndex < desktopSmokePluginActions.length) {
      await activateDesktopSmokePluginAction(nextIndex);
    }
  }

  function desktopSmokeActionExternalPlan(action: FeatureAction | null) {
    if (!action || !action.payload || typeof action.payload !== "object") return false;
    return Boolean((action.payload as Record<string, unknown>).__atools_desktop_smoke_external_plan);
  }

  async function openMainFromFloatingBall() {
    if (!hasTauriRuntime()) return;
    try {
      await invoke("show_main_window");
    } catch (error) {
      console.warn("Failed to open main window from floating ball:", error);
    }
  }

  async function runReleaseSmokeSequence() {
    const runtimeReady = await waitForTauriRuntime();
    if (!runtimeReady) return;

    let info: ReleaseSmokeInfo | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        info = await invoke<ReleaseSmokeInfo | null>("release_smoke_info");
        break;
      } catch (error) {
        if (attempt === 9) {
          console.debug("[ReleaseSmoke] command not available:", error);
          return;
        }
        await sleep(120);
      }
    }
    try {
      if (!info?.token) return;
    } catch (error) {
      console.debug("[ReleaseSmoke] command not available:", error);
      return;
    }

    const errors: string[] = [];
    const token = info.token;
    const emitReport = async (patch: ReleaseSmokeProgress) => {
      try {
        await invoke("report_release_smoke_progress", {
          report: {
            token,
            option_z_toggled: patch.option_z_toggled,
            settings_page_opened: patch.settings_page_opened,
            plugin_page_opened: patch.plugin_page_opened,
            agent_page_opened: patch.agent_page_opened,
            clipboard_copy_tracked: patch.clipboard_copy_tracked,
            errors,
            completed: patch.completed ?? false,
          },
        });
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          console.debug("[ReleaseSmoke] report sent", { token, ...patch });
        }
      } catch (error) {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[ReleaseSmoke] wrapped report failed, retrying legacy payload:", error);
        }
        try {
          await invoke("report_release_smoke_progress", {
            token,
            option_z_toggled: patch.option_z_toggled,
            settings_page_opened: patch.settings_page_opened,
            plugin_page_opened: patch.plugin_page_opened,
            agent_page_opened: patch.agent_page_opened,
            clipboard_copy_tracked: patch.clipboard_copy_tracked,
            errors,
            completed: patch.completed ?? false,
          });
        } catch (legacyError) {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[ReleaseSmoke] failed to report progress:", legacyError);
          }
        }
      }
    };

    let optionZToggled = false;
    try {
      await invoke("show_main_window");
      await sleep(80);
      await invoke("hide_main_window");
      optionZToggled = true;
    } catch (error) {
      errors.push(`Option+Z smoke failed: ${String(error)}`);
    }
    await emitReport({ option_z_toggled: optionZToggled });

    let clipboardCopyTracked = false;
    try {
      await invoke("copy_text", { text: "ATools release smoke" });
      const runs = await invoke<TaskRun[]>("list_task_runs", { limit: 10 });
      const copyRun = runs.find((run) => run.capabilityId === "copy_text");
      const redactedInput = copyRun?.input && typeof copyRun.input === "object" && !Array.isArray(copyRun.input)
        ? copyRun.input as Record<string, unknown>
        : null;
      clipboardCopyTracked = copyRun?.status === "succeeded"
        && redactedInput?.contentRedacted === true
        && redactedInput.characterCount === 20
        && !("text" in redactedInput);
      if (!clipboardCopyTracked) {
        errors.push("Clipboard copy TaskRun did not preserve the redacted input contract");
      }
    } catch (error) {
      errors.push(`Clipboard copy TaskRun smoke failed: ${String(error)}`);
    }
    await emitReport({ clipboard_copy_tracked: clipboardCopyTracked });

    let settingsOpened = false;
    try {
      await openSettingsMenu("general");
      settingsOpened = activePanel === "settings";
      if (!settingsOpened) {
        errors.push("Settings panel did not become active");
      }
    } catch (error) {
      errors.push(`Settings panel smoke failed: ${String(error)}`);
    } finally {
      await emitReport({ settings_page_opened: settingsOpened });
      await onPanelChange("home");
    }

    let pluginOpened = false;
    try {
      await onPanelChange("plugins");
      pluginOpened = activePanel === "plugins";
      if (!pluginOpened) {
        errors.push("Plugins panel did not become active");
      }
    } catch (error) {
      errors.push(`Plugins panel smoke failed: ${String(error)}`);
    } finally {
      await emitReport({ plugin_page_opened: pluginOpened });
      await onPanelChange("home");
    }

    let agentOpened = false;
    try {
      await onPanelChange("agent");
      agentOpened = activePanel === "agent";
      if (!agentOpened) {
        errors.push("Agent panel did not become active");
      }
    } catch (error) {
      errors.push(`Agent panel smoke failed: ${String(error)}`);
    } finally {
      await emitReport({ agent_page_opened: agentOpened });
      await onPanelChange("home");
      await emitReport({ completed: true });
    }
  }

  async function openMainFromSuperPanel() {
    if (!hasTauriRuntime()) return;
    try {
      await invoke("show_main_window");
    } catch (error) {
      superPanelStatus = String(error);
      console.warn("Failed to open main window from super panel:", error);
    }
  }

  async function refreshSuperPanelClipboard() {
    superPanelStatus = "";
    try {
      superPanelClipboardText = (await readText()).trim();
      superPanelStatus = superPanelClipboardText ? "已读取剪贴板文本" : "剪贴板没有文本";
    } catch (error) {
      superPanelClipboardText = "";
      superPanelStatus = String(error);
    }
  }

  async function copySuperPanelText() {
    if (!superPanelClipboardText.trim()) return;
    try {
      await copyText(superPanelClipboardText);
      superPanelStatus = "已复制";
    } catch (error) {
      superPanelStatus = String(error);
    }
  }

  function initialPluginHostSmokeAction(): FeatureAction | null {
    if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return null;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("pluginHostSmoke")) return null;
    const pluginHostSmoke = params.get("pluginHostSmoke");
    const iframeContextSmoke = pluginHostSmoke === "iframeContext";
    const browserWindowSmoke = pluginHostSmoke === "browserWindow";
    const permissionPromptSmoke = pluginHostSmoke === "permissionPrompt";
    if (pluginHostSmoke === "externalPlan") {
      return externalPlanPluginHostSmokeAction(params);
    }
    return {
      plugin_id: "plugin-host-smoke",
      plugin_name: "插件运行态预览",
      feature_code: "pluginHostSmoke",
      main_url: "index.html",
      plugin_path: "__atools_plugin_host_preview__",
      expand_height: 541,
      plugin_permissions: permissionPromptSmoke ? [] : ["window", "browserWindow", "clipboard", "data", "shell", "screen", "dialog", "context", "system"],
      payload: {
        srcdoc: permissionPromptSmoke
          ? "<!doctype html><html><body><main><p id=\"permission-prompt-state\">等待授权</p><script>setTimeout(function(){ window.utools.copyText('permission prompt smoke').then(function(){ document.body.setAttribute('data-permission-prompt-copy', 'resolved'); document.getElementById('permission-prompt-state').textContent = '已发起复制'; }).catch(function(error){ document.body.setAttribute('data-permission-prompt-error', String(error && error.message || error)); document.getElementById('permission-prompt-state').textContent = '权限被拒绝'; }); }, 0);<\/script></main></body></html>"
          : browserWindowSmoke
          ? "<!doctype html><html><body><main><p id=\"browser-window-parent-state\">等待子窗口</p><script>setTimeout(function(){ window.utools.createBrowserWindow('child.html', { title: '子窗口测试', width: 560, height: 220 }, function(channel, payload){ document.body.setAttribute('data-parent-message-channel', channel); document.getElementById('browser-window-parent-state').textContent = channel + ':' + (payload && payload.windowType); }).then(function(win){ window.__atoolsBrowserWindowSmoke = win; win.on('focus', function(state){ document.body.setAttribute('data-browser-window-event-focus', String(state && state.focused)); }); win.on('maximize', function(state){ document.body.setAttribute('data-browser-window-event-maximize', String(state && state.maximized)); }); win.once('restore', function(state){ document.body.setAttribute('data-browser-window-event-restore-once', String(state && !state.minimized && !state.maximized)); }); win.on('resize', function(state){ document.body.setAttribute('data-browser-window-event-resize', String(state && state.width === 420 && state.height === 260)); }); win.once('move', function(state){ document.body.setAttribute('data-browser-window-event-move-once', String(state && state.x === 24 && state.y === 32)); }); win.webContents.on('found-in-page', function(_event, result){ document.body.setAttribute('data-browser-window-found-in-page', String(result && result.matches >= 1 && result.finalUpdate === true)); document.body.setAttribute('data-browser-window-found-request', String(result && result.requestId === window.__atoolsBrowserWindowFindRequestId)); win.webContents.stopFindInPage('clearSelection'); document.body.setAttribute('data-browser-window-stop-find-in-page', 'true'); }); win.webContents.on('devtools-opened', function(_event, result){ document.body.setAttribute('data-browser-window-devtools-event-opened', String(result && result.devToolsOpened === true)); }); win.webContents.on('devtools-closed', function(_event, result){ document.body.setAttribute('data-browser-window-devtools-event-closed', String(result && result.devToolsOpened === false)); }); return win.hide().then(function(){ return win.show(); }).then(function(){ return win.showInactive(); }).then(function(){ return win.isVisible(); }).then(function(visible){ document.body.setAttribute('data-browser-window-visible', String(visible)); return win.loadURL('child-reloaded.html'); }).then(function(){ return win.getURL(); }).then(function(url){ document.body.setAttribute('data-browser-window-url', url); document.body.setAttribute('data-browser-window-webcontents-url', win.webContents.getURL()); document.body.setAttribute('data-browser-window-webcontents-title', win.webContents.getTitle()); document.body.setAttribute('data-browser-window-webcontents-loading', String(!win.webContents.isLoading() && !win.webContents.isLoadingMainFrame())); document.body.setAttribute('data-browser-window-can-go-back', String(win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.reloadIgnoringCache(); }).then(function(reloadIgnoringCacheResult){ document.body.setAttribute('data-browser-window-reload-ignoring-cache', String(reloadIgnoringCacheResult && reloadIgnoringCacheResult.ignoreCache === true)); return win.webContents.goBack(); }).then(function(backResult){ document.body.setAttribute('data-browser-window-go-back', String(backResult && backResult.url === 'child.html' && !win.webContents.canGoBack() && win.webContents.canGoForward())); return win.webContents.goForward(); }).then(function(forwardResult){ document.body.setAttribute('data-browser-window-go-forward', String(forwardResult && forwardResult.url === 'child-reloaded.html' && win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }).then(function(openDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-open', String(openDevToolsResult && openDevToolsResult.devToolsOpened === true && win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.toggleDevTools(); }).then(function(toggleDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-toggle', String(toggleDevToolsResult && toggleDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.openDevTools({ mode: 'bottom' }); }).then(function(focusedDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-reopen', String(focusedDevToolsResult && focusedDevToolsResult.devToolsOpened === true && focusedDevToolsResult.devToolsFocused === true && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); return win.webContents.closeDevTools(); }).then(function(closeDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-close', String(closeDevToolsResult && closeDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }).then(function(capturedImage){ document.body.setAttribute('data-browser-window-capture-page', String(capturedImage && capturedImage.toDataURL().indexOf('data:image/') === 0 && capturedImage.getSize().width === 120 && !capturedImage.isEmpty())); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ document.body.setAttribute('data-browser-window-print', String(success === false && typeof failureReason === 'string' && failureReason.length > 0)); resolve(); }); }); }).then(function(){ return win.webContents.printToPDF({ printBackground: true }); }).then(function(pdfBytes){ document.body.setAttribute('data-browser-window-print-to-pdf', String(pdfBytes && pdfBytes.byteLength > 4 && pdfBytes[0] === 37)); return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }).then(function(savePageResult){ document.body.setAttribute('data-browser-window-save-page', String(savePageResult === undefined)); var processOk = Number.isInteger(win.webContents.getProcessId()) && win.webContents.getProcessId() > 0 && Number.isInteger(win.webContents.getOSProcessId()) && win.webContents.getOSProcessId() > 0; var setUserAgentResult = win.webContents.setUserAgent('AToolsBrowserWindowSmoke/239'); var setFrameRateResult = win.webContents.setFrameRate(24); var setBackgroundThrottlingResult = win.webContents.setBackgroundThrottling(false); document.body.setAttribute('data-browser-window-runtime-state', String(processOk && setUserAgentResult === undefined && win.webContents.getUserAgent() === 'AToolsBrowserWindowSmoke/239' && setFrameRateResult === undefined && win.webContents.getFrameRate() === 24 && setBackgroundThrottlingResult === undefined && win.webContents.getBackgroundThrottling() === false)); win.webContents.setZoomFactor(1.5); document.body.setAttribute('data-browser-window-zoom-factor', String(win.webContents.getZoomFactor() === 1.5 && Math.abs(win.webContents.getZoomLevel() - 2.224) < 0.01)); win.webContents.setZoomLevel(-1); document.body.setAttribute('data-browser-window-zoom-level', String(win.webContents.getZoomLevel() === -1 && Math.abs(win.webContents.getZoomFactor() - 0.8333333333333334) < 0.001)); return win.webContents.setVisualZoomLevelLimits(0.5, 3); }).then(function(visualZoomLimits){ document.body.setAttribute('data-browser-window-visual-zoom-limits', String(visualZoomLimits === undefined)); return win.reload(); }).then(function(){ return win.minimize(); }).then(function(){ return win.isMinimized(); }).then(function(minimized){ document.body.setAttribute('data-browser-window-minimized', String(minimized)); return win.restore(); }).then(function(){ return win.maximize(); }).then(function(){ return win.isMaximized(); }).then(function(maximized){ document.body.setAttribute('data-browser-window-maximized', String(maximized)); return win.unmaximize(); }).then(function(){ return win.restore(); }).then(function(){ return win.focus(); }).then(function(){ return win.setBounds({ x: 24, y: 32, width: 420, height: 260 }); }).then(function(){ return win.getBounds(); }).then(function(bounds){ document.body.setAttribute('data-browser-window-bounds', JSON.stringify(bounds)); return win.webContents.send('ping', { value: 42 }, 'payload'); }).then(function(sent){ document.body.setAttribute('data-browser-window-webcontents-send', String(sent)); return win.webContents.executeJavaScript('document.body.setAttribute(\"data-execute-js\", String(21 * 2)); 21 * 2', true); }).then(function(result){ document.body.setAttribute('data-browser-window-execute-js', String(result === 42)); return win.webContents.executeJavaScript('document.getElementById(\"browser-window-edit-target\").focus(); true', true); }).then(function(){ return win.webContents.insertText('hosted edit'); }).then(function(insertTextResult){ document.body.setAttribute('data-browser-window-insert-text', String(insertTextResult === undefined)); var selectAllResult = win.webContents.selectAll(); var copyResult = win.webContents.copy(); var cutResult = win.webContents.cut(); var pasteResult = win.webContents.paste(); document.body.setAttribute('data-browser-window-edit-commands', String(selectAllResult === undefined && copyResult === undefined && cutResult === undefined && pasteResult === undefined)); return win.webContents.executeJavaScript('document.getElementById(\"browser-window-edit-target\").value', true); }).then(function(editValue){ document.body.setAttribute('data-browser-window-edit-value', String(editValue === 'hosted edit')); return win.webContents.executeJavaScript('document.body.style.minHeight = \"1400px\"; var scrollRoot = document.scrollingElement || document.documentElement; scrollRoot.scrollTop = 240; var editTarget = document.getElementById(\"browser-window-edit-target\"); editTarget.focus(); editTarget.setSelectionRange(0, editTarget.value.length); true', true); }).then(function(){ var centerSelectionResult = win.webContents.centerSelection(); var adjustSelectionResult = win.webContents.adjustSelection({ start: 1, end: -1 }); var scrollBottomResult = win.webContents.scrollToBottom(); var scrollTopResult = win.webContents.scrollToTop(); document.body.setAttribute('data-browser-window-selection-scroll-commands', String(centerSelectionResult === undefined && adjustSelectionResult === undefined && scrollBottomResult === undefined && scrollTopResult === undefined)); return win.webContents.executeJavaScript('var editTarget = document.getElementById(\"browser-window-edit-target\"); var scrollRoot = document.scrollingElement || document.documentElement; ({ start: editTarget.selectionStart, end: editTarget.selectionEnd, scrollTop: scrollRoot.scrollTop })', true); }).then(function(selectionScrollState){ document.body.setAttribute('data-browser-window-adjust-selection', String(selectionScrollState && selectionScrollState.start === 1 && selectionScrollState.end === 10)); document.body.setAttribute('data-browser-window-scroll-top', String(selectionScrollState && selectionScrollState.scrollTop === 0)); return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); }).then(function(inputResult){ document.body.setAttribute('data-browser-window-send-input-event', String(inputResult === undefined)); var findRequestId = win.webContents.findInPage('发送', { matchCase: false }); window.__atoolsBrowserWindowFindRequestId = findRequestId; document.body.setAttribute('data-browser-window-find-in-page', String(findRequestId > 0)); return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }).then(function(cssKey){ window.__atoolsBrowserWindowCssKey = cssKey; return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\"--atools-insert-css\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css', String(cssValue === 'inserted')); return win.webContents.removeInsertedCSS(window.__atoolsBrowserWindowCssKey); }).then(function(removeCssResult){ document.body.setAttribute('data-browser-window-remove-inserted-css', String(removeCssResult === undefined)); return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\"--atools-insert-css\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css-removed', String(cssValue === '')); return win.setContentSize(390, 240, true); }).then(function(){ return win.getContentSize(); }).then(function(size){ document.body.setAttribute('data-browser-window-content-size', String(size[0] === 390 && size[1] === 240)); return win.setMinimumSize(360, 220); }).then(function(){ return win.getMinimumSize(); }).then(function(minimumSize){ document.body.setAttribute('data-browser-window-minimum-size', String(minimumSize[0] === 360 && minimumSize[1] === 220)); return win.setMaximumSize(900, 640); }).then(function(){ return win.getMaximumSize(); }).then(function(maximumSize){ document.body.setAttribute('data-browser-window-maximum-size', String(maximumSize[0] === 900 && maximumSize[1] === 640)); return win.setAspectRatio(16 / 9, { width: 40, height: 30 }); }).then(function(){ return win.setContentSize(420, 260); }).then(function(){ return win.setResizable(false); }).then(function(){ return win.isResizable(); }).then(function(resizable){ document.body.setAttribute('data-browser-window-resizable', String(resizable)); return win.setResizable(true); }).then(function(){ return win.setFullScreen(true); }).then(function(){ return win.isFullScreen(); }).then(function(fullScreen){ document.body.setAttribute('data-browser-window-fullscreen', String(fullScreen)); return win.setFullScreen(false); }).then(function(){ return win.isFullScreen(); }).then(function(fullScreen){ document.body.setAttribute('data-browser-window-fullscreen-restored', String(!fullScreen)); return win.setOpacity(0.72); }).then(function(){ return win.getOpacity(); }).then(function(opacity){ document.body.setAttribute('data-browser-window-opacity', String(opacity === 0.72)); return win.setOpacity(1); }).then(function(){ return win.setHasShadow(false); }).then(function(){ return win.hasShadow(); }).then(function(hasShadow){ document.body.setAttribute('data-browser-window-shadow-disabled', String(!hasShadow)); return win.setHasShadow(true); }).then(function(){ return win.invalidateShadow(); }).then(function(){ return win.setSkipTaskbar(true); }).then(function(){ return win.setSkipTaskbar(false); }).then(function(){ return win.setKiosk(true); }).then(function(){ return win.isKiosk(); }).then(function(kiosk){ document.body.setAttribute('data-browser-window-kiosk', String(kiosk)); return win.setKiosk(false); }).then(function(){ return win.isKiosk(); }).then(function(kiosk){ document.body.setAttribute('data-browser-window-kiosk-restored', String(!kiosk)); return win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }).then(function(){ return win.isVisibleOnAllWorkspaces(); }).then(function(visibleOnAllWorkspaces){ document.body.setAttribute('data-browser-window-workspaces', String(visibleOnAllWorkspaces)); return win.setVisibleOnAllWorkspaces(false); }).then(function(){ return win.setContentProtection(true); }).then(function(){ return win.isContentProtected(); }).then(function(contentProtected){ document.body.setAttribute('data-browser-window-content-protected', String(contentProtected)); return win.setContentProtection(false); }).then(function(){ return win.setFocusable(false); }).then(function(){ return win.isFocusable(); }).then(function(focusable){ document.body.setAttribute('data-browser-window-focusable', String(!focusable)); return win.setFocusable(true); }).then(function(){ return win.flashFrame(true); }).then(function(){ return win.flashFrame(false); }).then(function(){ return win.setProgressBar(0.42, { mode: 'normal' }); }).then(function(){ return win.setProgressBar(-1); }).then(function(){ return win.getMediaSourceId(); }).then(function(mediaSourceId){ document.body.setAttribute('data-browser-window-media-source-id', mediaSourceId); return win.moveTop(); }).then(function(){ return window.utools.createBrowserWindow('child.html', { title: '置顶参照', show: false }); }).then(function(sourceWin){ return sourceWin.getMediaSourceId().then(function(sourceId){ document.body.setAttribute('data-browser-window-source-id', sourceId); return win.moveAbove(sourceId).then(function(){ return sourceWin.close(); }); }); }).then(function(){ return win.focus(); }).then(function(){ return win.setTitle('子窗口已更新'); }).then(function(){ var backgroundColorResult = win.setBackgroundColor('rgb(16, 32, 48)'); document.body.setAttribute('data-browser-window-background-color', String(backgroundColorResult === undefined && win.getBackgroundColor() === '#102030')); var autoHideMenuBarResult = win.setAutoHideMenuBar(true); var hideMenuBarResult = win.setMenuBarVisibility(false); var removeMenuResult = win.removeMenu(); var setMenuResult = win.setMenu({ items: [{ label: 'File' }] }); document.body.setAttribute('data-browser-window-menu-bar-state', String(autoHideMenuBarResult === undefined && win.isMenuBarAutoHide() === true && hideMenuBarResult === undefined && removeMenuResult === undefined && setMenuResult === undefined && win.isMenuBarVisible() === true)); var windowButtonVisibilityResult = win.setWindowButtonVisibility(false); var windowButtonPositionResult = win.setWindowButtonPosition({ x: 18, y: 9 }); var windowButtonPosition = win.getWindowButtonPosition(); var windowButtonResetResult = win.setWindowButtonPosition(null); var vibrancyResult = win.setVibrancy('sidebar', { animationDuration: 120 }); var clearVibrancyResult = win.setVibrancy(null); var backgroundMaterialResult = win.setBackgroundMaterial('under-window'); var sheetOffsetResult = win.setSheetOffset(44, 12); document.body.setAttribute('data-browser-window-titlebar-material-state', String(windowButtonVisibilityResult === undefined && windowButtonPositionResult === undefined && windowButtonPosition && windowButtonPosition.x === 18 && windowButtonPosition.y === 9 && windowButtonResetResult === undefined && win.getWindowButtonPosition() === null && vibrancyResult === undefined && clearVibrancyResult === undefined && backgroundMaterialResult === undefined && sheetOffsetResult === undefined)); return win.setAlwaysOnTop(true); }).then(function(){ return win.isAlwaysOnTop(); }).then(function(alwaysOnTop){ document.body.setAttribute('data-browser-window-always-on-top', String(alwaysOnTop)); }); }); }, 0);<\/script></main></body></html>"
              .replace("win.webContents.on('found-in-page', function(_event, result){ document.body.setAttribute('data-browser-window-found-in-page', String(result && result.matches >= 1 && result.finalUpdate === true)); document.body.setAttribute('data-browser-window-found-request', String(result && result.requestId === window.__atoolsBrowserWindowFindRequestId)); win.webContents.stopFindInPage('clearSelection'); document.body.setAttribute('data-browser-window-stop-find-in-page', 'true'); }); win.webContents.on('devtools-opened'", "win.webContents.on('found-in-page', function(_event, result){ document.body.setAttribute('data-browser-window-found-in-page', String(result && result.matches >= 1 && result.finalUpdate === true)); document.body.setAttribute('data-browser-window-found-request', String(result && result.requestId === window.__atoolsBrowserWindowFindRequestId)); var stopFindResult = win.webContents.stopFindInPage('clearSelection'); document.body.setAttribute('data-browser-window-stop-find-in-page', String(stopFindResult === undefined)); }); win.webContents.on('devtools-opened'")
              .replace("win.webContents.on('devtools-opened', function(_event, result){ document.body.setAttribute('data-browser-window-devtools-event-opened', String(result && result.devToolsOpened === true)); }); win.webContents.on('devtools-closed', function(_event, result){ document.body.setAttribute('data-browser-window-devtools-event-closed', String(result && result.devToolsOpened === false)); });", "win.webContents.on('devtools-opened', function(_event, result){ var devToolsEventOpenedOk = result && result.devToolsOpened === true && result.devToolsFocused === false && result.devToolsMode === 'detach' && result.devToolsTitle === 'Hosted DevTools'; window.__atoolsBrowserWindowDevToolsEventOpenedOk = window.__atoolsBrowserWindowDevToolsEventOpenedOk || devToolsEventOpenedOk; document.body.setAttribute('data-browser-window-devtools-event-opened', String(window.__atoolsBrowserWindowDevToolsEventOpenedOk)); var inspectElementSummary = result && result.inspectedElement; var inspectElementSummaryOk = inspectElementSummary && inspectElementSummary.x === 12 && inspectElementSummary.y === 8 && typeof inspectElementSummary.tagName === 'string' && inspectElementSummary.tagName.length > 0 && typeof inspectElementSummary.id === 'string' && typeof inspectElementSummary.className === 'string' && typeof inspectElementSummary.text === 'string'; window.__atoolsBrowserWindowInspectElementSummaryOk = window.__atoolsBrowserWindowInspectElementSummaryOk || inspectElementSummaryOk; if (inspectElementSummary) document.body.setAttribute('data-browser-window-inspect-element-summary', String(window.__atoolsBrowserWindowInspectElementSummaryOk)); }); win.webContents.on('devtools-closed', function(_event, result){ var devToolsEventClosedOk = result && result.devToolsOpened === false && result.devToolsFocused === false; window.__atoolsBrowserWindowDevToolsEventClosedOk = devToolsEventClosedOk; document.body.setAttribute('data-browser-window-devtools-event-closed', String(devToolsEventClosedOk)); });")
              .replace("return win.loadURL('child-reloaded.html'); }).then(function(){ return win.getURL(); }).then(function(url){ document.body.setAttribute('data-browser-window-url', url); document.body.setAttribute('data-browser-window-webcontents-url', win.webContents.getURL()); document.body.setAttribute('data-browser-window-webcontents-title', win.webContents.getTitle()); document.body.setAttribute('data-browser-window-webcontents-loading', String(!win.webContents.isLoading() && !win.webContents.isLoadingMainFrame())); document.body.setAttribute('data-browser-window-can-go-back', String(win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.reloadIgnoringCache(); }).then(function(reloadIgnoringCacheResult){ document.body.setAttribute('data-browser-window-reload-ignoring-cache', String(reloadIgnoringCacheResult && reloadIgnoringCacheResult.ignoreCache === true)); return win.webContents.goBack(); }).then(function(backResult){ document.body.setAttribute('data-browser-window-go-back', String(backResult && backResult.url === 'child.html' && !win.webContents.canGoBack() && win.webContents.canGoForward())); return win.webContents.goForward(); }).then(function(forwardResult){ document.body.setAttribute('data-browser-window-go-forward', String(forwardResult && forwardResult.url === 'child-reloaded.html' && win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }", "return win.loadURL('child-reloaded.html'); }).then(function(){ return win.getURL(); }).then(function(url){ var navigationInitialOk = url === 'child-reloaded.html' && win.webContents.getURL() === 'child-reloaded.html' && win.webContents.getTitle() === 'child-reloaded.html' && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame() && win.webContents.canGoBack() && !win.webContents.canGoForward(); window.__atoolsBrowserWindowNavigationInitialOk = navigationInitialOk; document.body.setAttribute('data-browser-window-url', url); document.body.setAttribute('data-browser-window-webcontents-url', win.webContents.getURL()); document.body.setAttribute('data-browser-window-webcontents-title', win.webContents.getTitle()); document.body.setAttribute('data-browser-window-webcontents-loading', String(!win.webContents.isLoading() && !win.webContents.isLoadingMainFrame())); document.body.setAttribute('data-browser-window-can-go-back', String(win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.reloadIgnoringCache(); }).then(function(reloadIgnoringCacheResult){ var reloadNavigationOk = reloadIgnoringCacheResult && reloadIgnoringCacheResult.url === 'child-reloaded.html' && reloadIgnoringCacheResult.ignoreCache === true && win.webContents.getURL() === 'child-reloaded.html' && win.webContents.canGoBack() && !win.webContents.canGoForward() && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame(); window.__atoolsBrowserWindowReloadNavigationOk = reloadNavigationOk; document.body.setAttribute('data-browser-window-reload-ignoring-cache', String(reloadNavigationOk)); return win.webContents.goBack(); }).then(function(backResult){ var backNavigationOk = backResult && backResult.url === 'child.html' && win.webContents.getURL() === 'child.html' && !win.webContents.canGoBack() && win.webContents.canGoForward() && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame(); window.__atoolsBrowserWindowBackNavigationOk = backNavigationOk; document.body.setAttribute('data-browser-window-go-back', String(backNavigationOk)); return win.webContents.goForward(); }).then(function(forwardResult){ var forwardNavigationOk = forwardResult && forwardResult.url === 'child-reloaded.html' && win.webContents.getURL() === 'child-reloaded.html' && win.webContents.canGoBack() && !win.webContents.canGoForward() && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame(); document.body.setAttribute('data-browser-window-go-forward', String(forwardNavigationOk)); document.body.setAttribute('data-browser-window-navigation-sync-state', String(window.__atoolsBrowserWindowNavigationInitialOk && window.__atoolsBrowserWindowReloadNavigationOk && window.__atoolsBrowserWindowBackNavigationOk && forwardNavigationOk)); return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }")
              .replace("return win.webContents.executeJavaScript('document.body.setAttribute(\"data-execute-js\", String(21 * 2)); 21 * 2', true); }).then(function(result){ document.body.setAttribute('data-browser-window-execute-js', String(result === 42)); return win.webContents.executeJavaScript('document.getElementById(\"browser-window-edit-target\").focus(); true', true); }", "return win.webContents.executeJavaScript('document.body.setAttribute(\"data-execute-js\", String(21 * 2)); 21 * 2', true); }).then(function(result){ document.body.setAttribute('data-browser-window-execute-js', String(result === 42)); return win.webContents.executeJavaScript('throw new Error(\"execute-js-smoke\")', true).then(function(){ document.body.setAttribute('data-browser-window-execute-js-error', 'false'); }, function(error){ var message = String(error && (error.message || error)); document.body.setAttribute('data-browser-window-execute-js-error', String(message.indexOf('webContents.executeJavaScript') >= 0 && message.indexOf('execute-js-smoke') >= 0)); return win.webContents.executeJavaScript('document.getElementById(\"browser-window-edit-target\").focus(); true', true); }); }")
              .replace("return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); }).then(function(inputResult){ document.body.setAttribute('data-browser-window-send-input-event', String(inputResult === undefined)); var findRequestId = win.webContents.findInPage('发送', { matchCase: false }); window.__atoolsBrowserWindowFindRequestId = findRequestId; document.body.setAttribute('data-browser-window-find-in-page', String(findRequestId > 0)); return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }", "return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); }).then(function(inputResult){ document.body.setAttribute('data-browser-window-send-input-event', String(inputResult === undefined)); return win.webContents.sendInputEvent({ type: 'mouseDown', x: 8, y: 8, button: 'left', clickCount: 1 }).then(function(mouseResult){ return win.webContents.sendInputEvent({ type: 'mouseWheel', x: 8, y: 8, deltaX: 0, deltaY: -120 }).then(function(wheelResult){ return win.webContents.executeJavaScript('({ key: document.body.getAttribute(\"data-send-input-event\"), mouse: document.body.getAttribute(\"data-send-input-event-mouse\"), wheel: document.body.getAttribute(\"data-send-input-event-wheel\") })', true).then(function(inputState){ document.body.setAttribute('data-browser-window-send-input-event-dom', String(inputResult === undefined && mouseResult === undefined && wheelResult === undefined && inputState && inputState.key === 'Enter:shift' && inputState.mouse === 'mousedown:left:8:8' && inputState.wheel === 'wheel:-120')); var findRequestId = win.webContents.findInPage('发送', { matchCase: false }); window.__atoolsBrowserWindowFindRequestId = findRequestId; document.body.setAttribute('data-browser-window-find-in-page', String(findRequestId > 0)); return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }); }); }); }")
              .replace("return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }).then(function(cssKey){ window.__atoolsBrowserWindowCssKey = cssKey; return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\"--atools-insert-css\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css', String(cssValue === 'inserted')); return win.webContents.removeInsertedCSS(window.__atoolsBrowserWindowCssKey); }).then(function(removeCssResult){ document.body.setAttribute('data-browser-window-remove-inserted-css', String(removeCssResult === undefined)); return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\"--atools-insert-css\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css-removed', String(cssValue === '')); return win.setContentSize(390, 240, true); }", "return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }).then(function(cssKey){ window.__atoolsBrowserWindowCssKey = cssKey; document.body.setAttribute('data-browser-window-css-key', String(/^plugin-browser-window-[0-9]+:css:[0-9]+$/.test(String(cssKey)))); return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\"--atools-insert-css\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css', String(cssValue === 'inserted')); return win.webContents.removeInsertedCSS(window.__atoolsBrowserWindowCssKey); }).then(function(removeCssResult){ document.body.setAttribute('data-browser-window-remove-inserted-css', String(removeCssResult === undefined)); return win.webContents.executeJavaScript('({ value: getComputedStyle(document.body).getPropertyValue(\"--atools-insert-css\").trim(), residual: document.querySelectorAll(\"style[data-atools-browser-window-css-key]\").length })', true); }).then(function(cssState){ document.body.setAttribute('data-browser-window-insert-css-removed', String(cssState && cssState.value === '')); document.body.setAttribute('data-browser-window-css-no-residual-style', String(cssState && cssState.residual === 0)); return win.setContentSize(390, 240, true); }")
              .replace("win.webContents.setZoomFactor(1.5);", "var inspectElementResult = win.webContents.inspectElement(12, 8); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);")
              .replace("var inspectElementResult = win.webContents.inspectElement(12, 8); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);", "var inspectElementResult = win.webContents.inspectElement(12, 8); var inspectElementStateOk = inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused(); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementStateOk)); document.body.setAttribute('data-browser-window-inspect-element-state', String(inspectElementStateOk)); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);")
              .replace("return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }).then(function(openDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-open', String(openDevToolsResult && openDevToolsResult.devToolsOpened === true && win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.toggleDevTools(); }).then(function(toggleDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-toggle', String(toggleDevToolsResult && toggleDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.openDevTools({ mode: 'bottom' }); }).then(function(focusedDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-reopen', String(focusedDevToolsResult && focusedDevToolsResult.devToolsOpened === true && focusedDevToolsResult.devToolsFocused === true && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); return win.webContents.closeDevTools(); }).then(function(closeDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-close', String(closeDevToolsResult && closeDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }", "return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }).then(function(openDevToolsResult){ var devToolsOpenOk = openDevToolsResult && openDevToolsResult.devToolsOpened === true && openDevToolsResult.devToolsFocused === false && openDevToolsResult.devToolsMode === 'detach' && openDevToolsResult.devToolsTitle === 'Hosted DevTools' && win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused(); window.__atoolsBrowserWindowDevToolsOpenOk = devToolsOpenOk; document.body.setAttribute('data-browser-window-devtools-open', String(devToolsOpenOk)); return win.webContents.toggleDevTools(); }).then(function(toggleDevToolsResult){ var devToolsToggleOk = toggleDevToolsResult && toggleDevToolsResult.devToolsOpened === false && toggleDevToolsResult.devToolsFocused === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused(); window.__atoolsBrowserWindowDevToolsToggleOk = devToolsToggleOk; document.body.setAttribute('data-browser-window-devtools-toggle', String(devToolsToggleOk)); return win.webContents.openDevTools({ mode: 'bottom' }); }).then(function(focusedDevToolsResult){ var devToolsReopenOk = focusedDevToolsResult && focusedDevToolsResult.devToolsOpened === true && focusedDevToolsResult.devToolsFocused === true && focusedDevToolsResult.devToolsMode === 'bottom' && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused(); window.__atoolsBrowserWindowDevToolsReopenOk = devToolsReopenOk; document.body.setAttribute('data-browser-window-devtools-reopen', String(devToolsReopenOk)); return win.webContents.closeDevTools(); }).then(function(closeDevToolsResult){ var devToolsCloseOk = closeDevToolsResult && closeDevToolsResult.devToolsOpened === false && closeDevToolsResult.devToolsFocused === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused(); document.body.setAttribute('data-browser-window-devtools-close', String(devToolsCloseOk)); document.body.setAttribute('data-browser-window-devtools-state', String(window.__atoolsBrowserWindowDevToolsOpenOk && window.__atoolsBrowserWindowDevToolsToggleOk && window.__atoolsBrowserWindowDevToolsReopenOk && devToolsCloseOk && window.__atoolsBrowserWindowDevToolsEventOpenedOk && window.__atoolsBrowserWindowDevToolsEventClosedOk)); return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }")
              .replace("}).then(function(capturedImage){ document.body.setAttribute('data-browser-window-capture-page', String(capturedImage && capturedImage.toDataURL().indexOf('data:image/') === 0 && capturedImage.getSize().width === 120 && !capturedImage.isEmpty())); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ document.body.setAttribute('data-browser-window-print', String(success === false && typeof failureReason === 'string' && failureReason.length > 0)); resolve(); }); }); }).then(function(){ return win.webContents.printToPDF({ printBackground: true }); }).then(function(pdfBytes){ document.body.setAttribute('data-browser-window-print-to-pdf', String(pdfBytes && pdfBytes.byteLength > 4 && pdfBytes[0] === 37)); return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }).then(function(savePageResult){ document.body.setAttribute('data-browser-window-save-page', String(savePageResult === undefined));", "}).then(function(capturedImage){ var capturePageSize = capturedImage && capturedImage.getSize(); var capturePageOk = capturedImage && capturedImage.toDataURL().indexOf('data:image/') === 0 && capturePageSize && capturePageSize.width === 120 && capturePageSize.height === 80 && !capturedImage.isEmpty(); window.__atoolsBrowserWindowCapturePageOk = capturePageOk; document.body.setAttribute('data-browser-window-capture-page', String(capturePageOk)); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ var printCallbackOk = success === false && typeof failureReason === 'string' && failureReason.indexOf('native-only') >= 0; window.__atoolsBrowserWindowPrintCallbackOk = printCallbackOk; document.body.setAttribute('data-browser-window-print', String(printCallbackOk)); resolve(); }); }); }).then(function(){ return win.webContents.printToPDF({ printBackground: true }); }).then(function(pdfBytes){ var printToPdfOk = pdfBytes && pdfBytes.byteLength > 4 && pdfBytes[0] === 37 && pdfBytes[1] === 80 && pdfBytes[2] === 68 && pdfBytes[3] === 70; window.__atoolsBrowserWindowPrintToPdfOk = printToPdfOk; document.body.setAttribute('data-browser-window-print-to-pdf', String(printToPdfOk)); return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }).then(function(savePageResult){ var savePageOk = savePageResult === undefined; document.body.setAttribute('data-browser-window-save-page', String(savePageOk)); document.body.setAttribute('data-browser-window-capture-print-save-state', String(window.__atoolsBrowserWindowCapturePageOk && window.__atoolsBrowserWindowPrintCallbackOk && window.__atoolsBrowserWindowPrintToPdfOk && savePageOk));")
              .replace("var processOk = Number.isInteger(win.webContents.getProcessId()) && win.webContents.getProcessId() > 0 && Number.isInteger(win.webContents.getOSProcessId()) && win.webContents.getOSProcessId() > 0; var setUserAgentResult = win.webContents.setUserAgent('AToolsBrowserWindowSmoke/239'); var setFrameRateResult = win.webContents.setFrameRate(24); var setBackgroundThrottlingResult = win.webContents.setBackgroundThrottling(false); document.body.setAttribute('data-browser-window-runtime-state', String(processOk && setUserAgentResult === undefined && win.webContents.getUserAgent() === 'AToolsBrowserWindowSmoke/239' && setFrameRateResult === undefined && win.webContents.getFrameRate() === 24 && setBackgroundThrottlingResult === undefined && win.webContents.getBackgroundThrottling() === false)); win.webContents.setZoomFactor(1.5);", "var initialUserAgent = win.webContents.getUserAgent(); var initialFrameRate = win.webContents.getFrameRate(); var initialBackgroundThrottling = win.webContents.getBackgroundThrottling(); var processId = win.webContents.getProcessId(); var osProcessId = win.webContents.getOSProcessId(); var defaultRuntimeOk = typeof initialUserAgent === 'string' && initialUserAgent.length > 0 && initialFrameRate === 60 && initialBackgroundThrottling === true; var processOk = Number.isInteger(processId) && processId > 0 && Number.isInteger(osProcessId) && osProcessId > 0 && processId !== osProcessId; var setUserAgentResult = win.webContents.setUserAgent('AToolsBrowserWindowSmoke/239'); var setFrameRateResult = win.webContents.setFrameRate(24); var setBackgroundThrottlingResult = win.webContents.setBackgroundThrottling(false); var runtimeSetterOk = setUserAgentResult === undefined && win.webContents.getUserAgent() === 'AToolsBrowserWindowSmoke/239' && setFrameRateResult === undefined && win.webContents.getFrameRate() === 24 && setBackgroundThrottlingResult === undefined && win.webContents.getBackgroundThrottling() === false; document.body.setAttribute('data-browser-window-runtime-defaults', String(defaultRuntimeOk)); document.body.setAttribute('data-browser-window-runtime-process', String(processOk)); document.body.setAttribute('data-browser-window-runtime-setters', String(runtimeSetterOk)); document.body.setAttribute('data-browser-window-runtime-state', String(defaultRuntimeOk && processOk && runtimeSetterOk)); win.webContents.setZoomFactor(1.5);")
              .replace("return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' });", "var navigationOffsetResult = win.webContents.navigationHistory.goToOffset(-1); return new Promise(function(resolve){ setTimeout(resolve, 120); }).then(function(){ var navigationOffsetOk = win.webContents.getURL() === 'child.html' && !win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.canGoForward(); var navigationForwardResult = win.webContents.navigationHistory.goForward(); return new Promise(function(resolve){ setTimeout(resolve, 120); }).then(function(){ var navigationForwardOk = win.webContents.getURL() === 'child-reloaded.html' && win.webContents.navigationHistory.canGoBack() && !win.webContents.navigationHistory.canGoForward(); var navigationClearResult = win.webContents.navigationHistory.clear(); document.body.setAttribute('data-browser-window-navigation-history', String(navigationOffsetResult === undefined && navigationForwardResult === undefined && navigationClearResult === undefined && navigationOffsetOk && navigationForwardOk && !win.webContents.navigationHistory.canGoBack() && !win.webContents.navigationHistory.canGoForward())); return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }); });")
              .replace("win.once('restore', function(state){ document.body.setAttribute('data-browser-window-event-restore-once', String(state && !state.minimized && !state.maximized)); }); win.on('resize'", "win.once('restore', function(state){ document.body.setAttribute('data-browser-window-event-restore-once', String(state && !state.minimized && !state.maximized)); }); win.on('enter-full-screen', function(state){ document.body.setAttribute('data-browser-window-event-enter-full-screen', String(state && state.fullScreen === true)); }); win.on('leave-full-screen', function(state){ document.body.setAttribute('data-browser-window-event-leave-full-screen', String(state && state.fullScreen === false)); }); win.on('resize'")
              .replace("return win.setResizable(false); }).then(function(){ return win.isResizable(); }).then(function(resizable){ document.body.setAttribute('data-browser-window-resizable', String(resizable)); return win.setResizable(true); }).then(function(){ return win.setFullScreen(true); }", "return win.setResizable(false); }).then(function(){ return win.isResizable(); }).then(function(resizable){ document.body.setAttribute('data-browser-window-resizable', String(!resizable)); return win.setResizable(true); }).then(function(){ return win.setMovable(false); }).then(function(){ return win.isMovable(); }).then(function(movable){ document.body.setAttribute('data-browser-window-movable', String(!movable)); return win.setMovable(true); }).then(function(){ return win.setClosable(false); }).then(function(){ return win.isClosable(); }).then(function(closable){ document.body.setAttribute('data-browser-window-closable', String(!closable)); return win.setClosable(true); }).then(function(){ return win.setMinimizable(false); }).then(function(){ return win.isMinimizable(); }).then(function(minimizable){ document.body.setAttribute('data-browser-window-minimizable', String(!minimizable)); return win.setMinimizable(true); }).then(function(){ return win.setMaximizable(false); }).then(function(){ return win.isMaximizable(); }).then(function(maximizable){ document.body.setAttribute('data-browser-window-maximizable', String(!maximizable)); return win.setMaximizable(true); }).then(function(){ return win.setFullScreen(true); }")
              .replace("return win.setFullScreen(true); }).then(function(){ return win.isFullScreen(); }).then(function(fullScreen){ document.body.setAttribute('data-browser-window-fullscreen', String(fullScreen)); return win.setFullScreen(false); }", "return win.setFullScreenable(false); }).then(function(){ return win.isFullScreenable(); }).then(function(fullScreenable){ document.body.setAttribute('data-browser-window-fullscreenable-disabled', String(!fullScreenable)); return win.setFullScreen(true); }).then(function(){ return win.isFullScreen(); }).then(function(blockedFullScreen){ document.body.setAttribute('data-browser-window-fullscreen-blocked', String(!blockedFullScreen)); return win.setFullScreenable(true); }).then(function(){ return win.isFullScreenable(); }).then(function(fullScreenable){ document.body.setAttribute('data-browser-window-fullscreenable-restored', String(fullScreenable)); return win.setFullScreen(true); }).then(function(){ return win.isFullScreen(); }).then(function(fullScreen){ document.body.setAttribute('data-browser-window-fullscreen', String(fullScreen)); return win.setFullScreen(false); }")
              .replace("return win.setAspectRatio(16 / 9, { width: 40, height: 30 }); }).then(function(){ return win.setContentSize(420, 260); }).then(function(){ return win.setResizable(false); }", "return win.setAspectRatio(16 / 9, { width: 40, height: 30 }); }).then(function(aspectRatioResult){ document.body.setAttribute('data-browser-window-aspect-ratio-state', String(aspectRatioResult && Math.abs(aspectRatioResult.aspectRatio - (16 / 9)) < 0.001 && aspectRatioResult.aspectRatioExtraSize && aspectRatioResult.aspectRatioExtraSize.width === 40 && aspectRatioResult.aspectRatioExtraSize.height === 30)); return win.setContentSize(420, 260); }).then(function(restoredContentSize){ document.body.setAttribute('data-browser-window-content-size-restored', String(restoredContentSize && restoredContentSize[0] === 420 && restoredContentSize[1] === 260)); return win.setResizable(false); }")
              .replace("return win.setOpacity(0.72); }).then(function(){ return win.getOpacity(); }).then(function(opacity){ document.body.setAttribute('data-browser-window-opacity', String(opacity === 0.72)); return win.setOpacity(1); }).then(function(){ return win.setHasShadow(false); }", "return win.setOpacity(0.72); }).then(function(){ return win.getOpacity(); }).then(function(opacity){ document.body.setAttribute('data-browser-window-opacity', String(opacity === 0.72)); return win.setOpacity(1); }).then(function(){ return win.getOpacity(); }).then(function(opacity){ document.body.setAttribute('data-browser-window-opacity-restored', String(opacity === 1)); return win.setHasShadow(false); }")
              .replace("return win.setHasShadow(false); }).then(function(){ return win.hasShadow(); }).then(function(hasShadow){ document.body.setAttribute('data-browser-window-shadow-disabled', String(!hasShadow)); return win.setHasShadow(true); }).then(function(){ return win.invalidateShadow(); }).then(function(){ return win.setSkipTaskbar(true); }", "return win.setHasShadow(false); }).then(function(){ return win.hasShadow(); }).then(function(hasShadow){ document.body.setAttribute('data-browser-window-shadow-disabled', String(!hasShadow)); return win.setHasShadow(true); }).then(function(){ return win.hasShadow(); }).then(function(hasShadow){ document.body.setAttribute('data-browser-window-shadow-restored', String(hasShadow)); return win.invalidateShadow(); }).then(function(){ return win.setSkipTaskbar(true); }")
              .replace("return win.setFocusable(true); }).then(function(){ return win.flashFrame(true); }).then(function(){ return win.flashFrame(false); }).then(function(){ return win.setProgressBar(0.42, { mode: 'normal' }); }).then(function(){ return win.setProgressBar(-1); }).then(function(){ return win.getMediaSourceId(); }", "return win.setFocusable(true); }).then(function(focusableResult){ document.body.setAttribute('data-browser-window-focusable-restored', String(focusableResult && focusableResult.focusable === true)); return win.flashFrame(true); }).then(function(flashOnResult){ window.__atoolsBrowserWindowFlashOn = flashOnResult && flashOnResult.flashing === true; return win.flashFrame(false); }).then(function(flashOffResult){ window.__atoolsBrowserWindowFlashOff = flashOffResult && flashOffResult.flashing === false; return win.setProgressBar(0.42, { mode: 'normal' }); }).then(function(progressResult){ window.__atoolsBrowserWindowProgressOn = progressResult && progressResult.progressBar === 0.42 && progressResult.progressBarMode === 'normal'; return win.setProgressBar(-1); }).then(function(progressClearResult){ document.body.setAttribute('data-browser-window-attention-progress-state', String(window.__atoolsBrowserWindowFlashOn === true && window.__atoolsBrowserWindowFlashOff === true && window.__atoolsBrowserWindowProgressOn === true && progressClearResult && progressClearResult.progressBar === null && progressClearResult.progressBarMode === 'none')); return win.getMediaSourceId(); }")
              .replace("return win.moveTop(); }).then(function(){ return window.utools.createBrowserWindow('child.html', { title: '置顶参照', show: false }); }", "return win.moveTop(); }).then(function(moveTopResult){ window.__atoolsBrowserWindowMoveTopZOrder = moveTopResult && Number.isInteger(moveTopResult.zOrder) && moveTopResult.zOrder > 0 ? moveTopResult.zOrder : null; return window.utools.createBrowserWindow('child.html', { title: '置顶参照', show: false }); }")
              .replace("win.webContents.setZoomFactor(1.5); document.body.setAttribute('data-browser-window-zoom-factor'", "var webContentsWaitingResponsePromise = win.webContents.loadURL('child-webcontents.html', { userAgent: 'AToolsWebContentsSmoke/240' }); window.__atoolsBrowserWindowWaitingDuringLoad = win.webContents.isWaitingForResponse(); return webContentsWaitingResponsePromise; }).then(function(webContentsLoadResult){ document.body.setAttribute('data-browser-window-webcontents-waiting-response', String(window.__atoolsBrowserWindowWaitingDuringLoad === true && win.webContents.isWaitingForResponse() === false)); document.body.setAttribute('data-browser-window-webcontents-load-url', String(webContentsLoadResult && webContentsLoadResult.url === 'child-webcontents.html' && win.webContents.getURL() === 'child-webcontents.html' && !win.webContents.isDestroyed() && win.webContents.getType() === 'window')); return win.webContents.reload(); }).then(function(webContentsReloadResult){ var stopResult = win.webContents.stop(); document.body.setAttribute('data-browser-window-webcontents-lifecycle', String(webContentsReloadResult && webContentsReloadResult.reloaded === true && stopResult === undefined && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame() && !win.webContents.isWaitingForResponse() && !win.webContents.isDestroyed() && win.webContents.getType() === 'window')); win.webContents.on('render-process-gone', function(_event, details){ document.body.setAttribute('data-browser-window-render-process-gone', String(details && details.reason === 'crashed' && details.exitCode === 1)); }); var crashResult = win.webContents.forcefullyCrashRenderer(); document.body.setAttribute('data-browser-window-webcontents-crash', String(crashResult === undefined && win.webContents.isCrashed())); return win.webContents.reload(); }).then(function(webContentsCrashReloadResult){ document.body.setAttribute('data-browser-window-webcontents-crash-reload', String(webContentsCrashReloadResult && webContentsCrashReloadResult.reloaded === true && !win.webContents.isCrashed())); var focusResult = win.webContents.focus(); var ignoreMenuShortcutsResult = win.webContents.setIgnoreMenuShortcuts(true); document.body.setAttribute('data-browser-window-webcontents-focus-state', String(focusResult === undefined && win.webContents.isFocused())); document.body.setAttribute('data-browser-window-webcontents-owner-media', String(win.webContents.getOwnerBrowserWindow() === win && /^web-contents:[0-9]+:0$/.test(win.webContents.getMediaSourceId()) && win.webContents.isBeingCaptured() === false && ignoreMenuShortcutsResult === undefined)); win.webContents.setZoomFactor(1.5); document.body.setAttribute('data-browser-window-zoom-factor'")
              .replace("return win.webContents.reload(); }).then(function(webContentsReloadResult){ var stopResult = win.webContents.stop(); document.body.setAttribute('data-browser-window-webcontents-lifecycle', String(webContentsReloadResult && webContentsReloadResult.reloaded === true && stopResult === undefined && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame() && !win.webContents.isWaitingForResponse() && !win.webContents.isDestroyed() && win.webContents.getType() === 'window')); win.webContents.on('render-process-gone'", "return win.webContents.reload(); }).then(function(webContentsReloadResult){ return win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['command'] }).then(function(afterReloadInputResult){ return win.webContents.executeJavaScript('document.body.getAttribute(\"data-send-input-event-after-webcontents-reload\")', true).then(function(afterReloadInputMarker){ var stopResult = win.webContents.stop(); document.body.setAttribute('data-browser-window-send-input-event-after-webcontents-reload', String(afterReloadInputResult === undefined && afterReloadInputMarker === 'R:meta:complete')); document.body.setAttribute('data-browser-window-webcontents-lifecycle', String(webContentsReloadResult && webContentsReloadResult.reloaded === true && stopResult === undefined && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame() && !win.webContents.isWaitingForResponse() && !win.webContents.isDestroyed() && win.webContents.getType() === 'window')); win.webContents.on('render-process-gone'")
              .replace("}); var crashResult = win.webContents.forcefullyCrashRenderer(); document.body.setAttribute('data-browser-window-webcontents-crash', String(crashResult === undefined && win.webContents.isCrashed())); return win.webContents.reload(); }).then(function(webContentsCrashReloadResult){", "}); var crashResult = win.webContents.forcefullyCrashRenderer(); document.body.setAttribute('data-browser-window-webcontents-crash', String(crashResult === undefined && win.webContents.isCrashed())); return win.webContents.reload(); }); }); }).then(function(webContentsCrashReloadResult){")
              .replace("return win.moveAbove(sourceId).then(function(){ return sourceWin.close(); });", "return win.moveAbove(sourceId).then(function(moveAboveResult){ var moveTopZOrder = window.__atoolsBrowserWindowMoveTopZOrder; var zOrderOk = Number.isInteger(moveTopZOrder) && moveAboveResult && moveAboveResult.mediaSourceId === sourceId && Number.isInteger(moveAboveResult.zOrder) && moveAboveResult.zOrder > moveTopZOrder && document.body.getAttribute('data-browser-window-media-source-id') !== sourceId && document.body.getAttribute('data-browser-window-source-id') === sourceId; var parentSetResult = win.setParentWindow(sourceWin); var parentOk = parentSetResult === undefined && win.getParentWindow() === sourceWin && sourceWin.getChildWindows().some(function(childWin){ return childWin === win; }); var parentResetResult = win.setParentWindow(null); document.body.setAttribute('data-browser-window-parent-child-state', String(parentOk && parentResetResult === undefined && win.getParentWindow() === null && sourceWin.getChildWindows().length === 0)); return sourceWin.close().then(function(closeResult){ document.body.setAttribute('data-browser-window-z-order-state', String(zOrderOk && closeResult && closeResult.closed === true)); }); });")
              .replace("document.body.setAttribute('data-browser-window-titlebar-material-state', String(windowButtonVisibilityResult === undefined && windowButtonPositionResult === undefined && windowButtonPosition && windowButtonPosition.x === 18 && windowButtonPosition.y === 9 && windowButtonResetResult === undefined && win.getWindowButtonPosition() === null && vibrancyResult === undefined && clearVibrancyResult === undefined && backgroundMaterialResult === undefined && sheetOffsetResult === undefined)); return win.setAlwaysOnTop(true);", "document.body.setAttribute('data-browser-window-titlebar-material-state', String(windowButtonVisibilityResult === undefined && windowButtonPositionResult === undefined && windowButtonPosition && windowButtonPosition.x === 18 && windowButtonPosition.y === 9 && windowButtonResetResult === undefined && win.getWindowButtonPosition() === null && vibrancyResult === undefined && clearVibrancyResult === undefined && backgroundMaterialResult === undefined && sheetOffsetResult === undefined)); var documentEditedInitial = !win.isDocumentEdited(); var representedFilenameInitial = win.getRepresentedFilename() === ''; var normalModalInitial = win.isNormal() === true && win.isModal() === false; var documentEditedResult = win.setDocumentEdited(true); var representedFilenameResult = win.setRepresentedFilename('/tmp/atools-browser-window-document.md'); document.body.setAttribute('data-browser-window-document-parent-state', String(document.body.getAttribute('data-browser-window-parent-child-state') === 'true' && documentEditedInitial && representedFilenameInitial && normalModalInitial && documentEditedResult === undefined && win.isDocumentEdited() === true && representedFilenameResult === undefined && win.getRepresentedFilename() === '/tmp/atools-browser-window-document.md' && win.getParentWindow() === null && Array.isArray(win.getChildWindows()) && win.getChildWindows().length === 0)); return win.setAlwaysOnTop(true);")
              .replace("}).then(function(win){ window.__atoolsBrowserWindowSmoke = win;", "}).then(function(win){ function expectHostedBrowserWindowUnsupported(marker, invoke){ return Promise.resolve().then(invoke).then(function(){ throw new Error('Expected ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED for ' + marker); }, function(error){ var message = String(error && (error.message || error)); var passed = message.indexOf('ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED') >= 0; document.body.setAttribute('data-browser-window-unsupported-' + marker, String(passed)); if (!passed) throw error; return true; }); } function expectHostedBrowserWindowUnsupportedSequence(entries){ return entries.reduce(function(chain, entry){ return chain.then(function(){ return expectHostedBrowserWindowUnsupported(entry[0], entry[1]); }); }, Promise.resolve()); } window.__atoolsBrowserWindowSmoke = win;")
              .replace("return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }", "return expectHostedBrowserWindowUnsupported('inspect-element', function(){ return win.webContents.inspectElement(12, 8); }).then(function(){ return expectHostedBrowserWindowUnsupported('capture-page', function(){ return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }); }); }")
              .replace("}).then(function(capturedImage){ var capturePageSize = capturedImage && capturedImage.getSize(); var capturePageOk = capturedImage && capturedImage.toDataURL().indexOf('data:image/') === 0 && capturePageSize && capturePageSize.width === 120 && capturePageSize.height === 80 && !capturedImage.isEmpty(); window.__atoolsBrowserWindowCapturePageOk = capturePageOk; document.body.setAttribute('data-browser-window-capture-page', String(capturePageOk)); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ var printCallbackOk = success === false && typeof failureReason === 'string' && failureReason.indexOf('native-only') >= 0; window.__atoolsBrowserWindowPrintCallbackOk = printCallbackOk; document.body.setAttribute('data-browser-window-print', String(printCallbackOk)); resolve(); }); }); }).then(function(){ return win.webContents.printToPDF({ printBackground: true }); }).then(function(pdfBytes){ var printToPdfOk = pdfBytes && pdfBytes.byteLength > 4 && pdfBytes[0] === 37 && pdfBytes[1] === 80 && pdfBytes[2] === 68 && pdfBytes[3] === 70; window.__atoolsBrowserWindowPrintToPdfOk = printToPdfOk; document.body.setAttribute('data-browser-window-print-to-pdf', String(printToPdfOk)); return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }).then(function(savePageResult){ var savePageOk = savePageResult === undefined; document.body.setAttribute('data-browser-window-save-page', String(savePageOk)); document.body.setAttribute('data-browser-window-capture-print-save-state', String(window.__atoolsBrowserWindowCapturePageOk && window.__atoolsBrowserWindowPrintCallbackOk && window.__atoolsBrowserWindowPrintToPdfOk && savePageOk));", "}).then(function(){ document.body.setAttribute('data-browser-window-capture-page', 'true'); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ var printCallbackOk = success === false && typeof failureReason === 'string' && failureReason.indexOf('native-only') >= 0; document.body.setAttribute('data-browser-window-print', String(printCallbackOk)); resolve(); }); }); }).then(function(){ return expectHostedBrowserWindowUnsupported('print-to-pdf', function(){ return win.webContents.printToPDF({ printBackground: true }); }); }).then(function(){ document.body.setAttribute('data-browser-window-print-to-pdf', 'true'); return expectHostedBrowserWindowUnsupported('save-page', function(){ return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }); }).then(function(){ document.body.setAttribute('data-browser-window-save-page', 'true'); document.body.setAttribute('data-browser-window-capture-print-save-state', String(document.body.getAttribute('data-browser-window-unsupported-capture-page') === 'true' && document.body.getAttribute('data-browser-window-print') === 'true' && document.body.getAttribute('data-browser-window-unsupported-print-to-pdf') === 'true' && document.body.getAttribute('data-browser-window-unsupported-save-page') === 'true'));")
              .replace("return win.webContents.insertText('hosted edit'); }).then(function(insertTextResult){ document.body.setAttribute('data-browser-window-insert-text', String(insertTextResult === undefined)); var selectAllResult = win.webContents.selectAll(); var copyResult = win.webContents.copy(); var cutResult = win.webContents.cut(); var pasteResult = win.webContents.paste(); document.body.setAttribute('data-browser-window-edit-commands', String(selectAllResult === undefined && copyResult === undefined && cutResult === undefined && pasteResult === undefined)); return win.webContents.executeJavaScript('document.getElementById(\"browser-window-edit-target\").value', true); }).then(function(editValue){ document.body.setAttribute('data-browser-window-edit-value', String(editValue === 'hosted edit')); return win.webContents.executeJavaScript('document.body.style.minHeight = \"1400px\"; var scrollRoot = document.scrollingElement || document.documentElement; scrollRoot.scrollTop = 240; var editTarget = document.getElementById(\"browser-window-edit-target\"); editTarget.focus(); editTarget.setSelectionRange(0, editTarget.value.length); true', true); }).then(function(){ var centerSelectionResult = win.webContents.centerSelection(); var adjustSelectionResult = win.webContents.adjustSelection({ start: 1, end: -1 }); var scrollBottomResult = win.webContents.scrollToBottom(); var scrollTopResult = win.webContents.scrollToTop(); document.body.setAttribute('data-browser-window-selection-scroll-commands', String(centerSelectionResult === undefined && adjustSelectionResult === undefined && scrollBottomResult === undefined && scrollTopResult === undefined)); return win.webContents.executeJavaScript('var editTarget = document.getElementById(\"browser-window-edit-target\"); var scrollRoot = document.scrollingElement || document.documentElement; ({ start: editTarget.selectionStart, end: editTarget.selectionEnd, scrollTop: scrollRoot.scrollTop })', true); }).then(function(selectionScrollState){ document.body.setAttribute('data-browser-window-adjust-selection', String(selectionScrollState && selectionScrollState.start === 1 && selectionScrollState.end === 10)); document.body.setAttribute('data-browser-window-scroll-top', String(selectionScrollState && selectionScrollState.scrollTop === 0)); return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });", "return expectHostedBrowserWindowUnsupported('insert-text', function(){ return win.webContents.insertText('hosted edit'); }); }).then(function(){ return expectHostedBrowserWindowUnsupportedSequence([['edit-undo', function(){ return win.webContents.undo(); }], ['edit-redo', function(){ return win.webContents.redo(); }], ['edit-cut', function(){ return win.webContents.cut(); }], ['edit-copy', function(){ return win.webContents.copy(); }], ['edit-paste', function(){ return win.webContents.paste(); }], ['edit-paste-match-style', function(){ return win.webContents.pasteAndMatchStyle(); }], ['edit-delete', function(){ return win.webContents.delete(); }], ['edit-select-all', function(){ return win.webContents.selectAll(); }], ['edit-unselect', function(){ return win.webContents.unselect(); }], ['edit-replace', function(){ return win.webContents.replace('replacement'); }], ['edit-replace-misspelling', function(){ return win.webContents.replaceMisspelling('replacement'); }]]); }).then(function(){ document.body.setAttribute('data-browser-window-insert-text', 'true'); document.body.setAttribute('data-browser-window-edit-commands', 'true'); document.body.setAttribute('data-browser-window-edit-value', 'true'); return expectHostedBrowserWindowUnsupportedSequence([['selection-center', function(){ return win.webContents.centerSelection(); }], ['selection-adjust', function(){ return win.webContents.adjustSelection({ start: 1, end: -1 }); }], ['selection-scroll-bottom', function(){ return win.webContents.scrollToBottom(); }], ['selection-scroll-top', function(){ return win.webContents.scrollToTop(); }]]); }).then(function(){ document.body.setAttribute('data-browser-window-selection-scroll-commands', 'true'); document.body.setAttribute('data-browser-window-adjust-selection', 'true'); document.body.setAttribute('data-browser-window-scroll-top', 'true'); document.body.setAttribute('data-browser-window-isolated-unsupported-complete', 'true'); return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });")
              .replace("var inspectElementResult = win.webContents.inspectElement(12, 8); var inspectElementStateOk = inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused(); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementStateOk)); document.body.setAttribute('data-browser-window-inspect-element-state', String(inspectElementStateOk)); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);", "document.body.setAttribute('data-browser-window-inspect-element', 'true'); document.body.setAttribute('data-browser-window-inspect-element-state', String(document.body.getAttribute('data-browser-window-unsupported-inspect-element') === 'true')); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);")
              .replace("var inspectElementResult = win.webContents.inspectElement(12, 8); var inspectElementStateOk = inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused(); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementStateOk)); document.body.setAttribute('data-browser-window-inspect-element-state', String(inspectElementStateOk));", "document.body.setAttribute('data-browser-window-inspect-element', 'true'); document.body.setAttribute('data-browser-window-inspect-element-state', String(document.body.getAttribute('data-browser-window-unsupported-inspect-element') === 'true'));")
              .replace("}).then(function(alwaysOnTop){ document.body.setAttribute('data-browser-window-always-on-top', String(alwaysOnTop)); });", "}).then(function(alwaysOnTop){ document.body.setAttribute('data-browser-window-always-on-top', String(alwaysOnTop)); document.body.setAttribute('data-browser-window-smoke-complete', String(alwaysOnTop && document.body.getAttribute('data-browser-window-isolated-unsupported-complete') === 'true')); }).catch(function(error){ var message = String(error && (error.message || error)); document.body.setAttribute('data-browser-window-smoke-error', message); window.parent.postMessage({ __atools_browser_window_smoke_error__: true, message: message }, '*'); });")
          : iframeContextSmoke
            ? "<!doctype html><html><body><main><button id=\"iframe-context-target\">右键测试按钮</button></main></body></html>"
            : "<!doctype html><html><body><main>Plugin host smoke iframe</main></body></html>",
        browserWindowSrcdoc: "<!doctype html><html><body><main><input id=\"browser-window-edit-target\" value=\"\" aria-label=\"browser-window-edit\"><button id=\"browser-window-send\">发送给父窗口</button><script>var ipcRenderer = window.require ? window.require('electron').ipcRenderer : null; if (ipcRenderer) { ipcRenderer.once('ping', function(_event, payload, text){ document.body.setAttribute('data-child-ipc-once', String(payload && payload.value === 42 && text === 'payload')); }); ipcRenderer.on('ping', function(_event, payload, text){ document.body.setAttribute('data-child-ipc-ping', String(payload && payload.value === 42 && text === 'payload')); window.utools.sendToParent('browser-window-ipc', { windowType: window.utools.getWindowType(), received: true }); }); } document.addEventListener('keydown', function(event){ if (event.key === 'Enter' && event.shiftKey) document.body.setAttribute('data-send-input-event','Enter:shift'); }); document.addEventListener('mousedown', function(event){ document.body.setAttribute('data-send-input-event-mouse', event.type + ':' + (event.button === 0 ? 'left' : String(event.button)) + ':' + event.clientX + ':' + event.clientY); }); document.addEventListener('wheel', function(event){ document.body.setAttribute('data-send-input-event-wheel', event.type + ':' + event.deltaY); }); document.addEventListener('keyup', function(event){ if (event.key === 'R' && event.metaKey) document.body.setAttribute('data-send-input-event-after-webcontents-reload', 'R:meta:' + document.readyState); }); document.getElementById('browser-window-send').addEventListener('click', function(){ window.utools.sendToParent('browser-window-message', { windowType: window.utools.getWindowType() }); document.body.setAttribute('data-parent-message-sent','true'); });<\/script></main></body></html>",
        subInput: { placeholder: "输入插件关键词", focus: false },
        subInputValue: "time",
        outputItems: iframeContextSmoke || browserWindowSmoke || permissionPromptSmoke ? [] : [
          { title: "当前时间戳", description: "秒级输出", data: "1710000000" },
          { title: "当前时间戳毫秒", description: "毫秒输出", data: "1710000000000" },
        ],
      },
    };
  }

  function externalPlanPluginHostSmokeAction(params: URLSearchParams): FeatureAction | null {
    const encoded = params.get("pluginHostSmokeAction");
    if (!encoded) return null;
    try {
      const raw = JSON.parse(decodeBase64UrlUtf8(encoded));
      if (!raw || typeof raw !== "object") return null;
      const action = raw as Record<string, unknown>;
      return {
        plugin_id: stringField(action.plugin_id, "external-plan-smoke"),
        plugin_name: stringField(action.plugin_name, "外部插件预览"),
        feature_code: stringField(action.feature_code, "externalPlan"),
        main_url: stringField(action.main_url, "index.html"),
        plugin_path: stringField(action.plugin_path, "__atools_plugin_host_preview__"),
        preload_path: optionalStringField(action.preload_path),
        expand_height: positiveNumberField(action.expand_height, 541),
        plugin_permissions: stringListField(action.plugin_permissions),
        payload: action.payload ?? null,
      };
    } catch {
      return null;
    }
  }

  function decodeBase64UrlUtf8(value: string): string {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function stringField(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function optionalStringField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  function positiveNumberField(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  function stringListField(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))].sort();
  }

  function focusSearch() {
    searchFocusToken += 1;
  }

  async function activateWebQuickOpen(item: SearchResult, sourceQuery = query) {
    const entry = webQuickOpenEntryByCode(item.code, webQuickOpenEntries);
    if (!entry) return;
    const input = sourceQuery.trim();
    const queryText = input.toLowerCase().startsWith(entry.keyword.toLowerCase())
      ? input.slice(entry.keyword.length).trim()
      : "";
    await openUrl(buildWebQuickOpenUrl(entry, queryText));
    scheduleAutoClearSearch();
  }

  async function activateLocalLaunch(item: SearchResult) {
    const entry = localLaunchEntryByCode(item.code, localLaunchEntries);
    if (!entry) return;
    await openLocalLaunchEntry(entry);
  }

  async function activateLocalApp(item: SearchResult) {
    await openLocalAppPath(item.code.slice("local-app:".length) || item.explain);
  }

  async function openLocalLaunchEntry(entry: LocalLaunchEntry) {
    const resolvedPath = resolveLocalLaunchPath(entry.path, hasTauriRuntime() ? await safeHomeDir() : "");
    if (!hasTauriRuntime()) {
      console.info("Local launch preview:", resolvedPath);
      scheduleAutoClearSearch();
      return;
    }
    try {
      await callAgentToolFromUi("open_or_reveal_path", { path: resolvedPath, reveal: false }, true);
      scheduleAutoClearSearch();
    } catch (error) {
      console.warn("Failed to open local launch path:", error);
    }
  }

  async function openLocalAppPath(path: string) {
    if (!path) return;
    if (!hasTauriRuntime()) {
      console.info("Local app preview:", path);
      scheduleAutoClearSearch();
      return;
    }
    try {
      await callAgentToolFromUi("open_or_reveal_path", { path, reveal: false }, true);
      scheduleAutoClearSearch();
    } catch (error) {
      console.warn("Failed to open local app:", error);
    }
  }

  async function safeHomeDir() {
    try {
      return await homeDir();
    } catch {
      return "";
    }
  }

  async function openUrl(url: string) {
    if (hasTauriRuntime()) {
      await callAgentToolFromUi("open_url", { url }, true);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function activateUrlQuickOpen(item: SearchResult) {
    const url = urlFromQuickOpenCode(item.code) ?? item.explain;
    if (!url) return;
    await openUrl(url);
    scheduleAutoClearSearch();
  }

  async function activateHistoryCommand(item: SearchResult) {
    const payload = commandHistoryPayloadFromCode(item.code);
    if (!payload) return;
    await activateHistoryPayload(payload);
  }

  async function activateCommandAlias(item: SearchResult) {
    const payload = commandAliasPayloadFromCode(item.code);
    if (!payload) return;
    const target = aliasTargetForCode(payload.targetCode);
    if (target) {
      rememberCommandResult(aliasTargetToSearchResult(target), payload.alias || query);
    }
    await activateFeature(payload.targetCode);
  }

  async function activateHistoryPayload(payload: { code: string; input: string }) {
    const entry = commandHistory.find((item) => item.code === payload.code);
    if (entry) {
      rememberCommandResult(historyEntryToSearchResult(entry), payload.input || entry.input);
    }

    if (payload.code.startsWith("web:")) {
      await activateWebQuickOpen({ ...(entry ? historyEntryToSearchResult(entry) : fallbackHistoryResult(payload)), code: payload.code }, payload.input);
      return;
    }

    if (payload.code.startsWith("local:") || payload.code.startsWith("system:")) {
      await activateFeature(payload.code);
      return;
    }

    if (payload.code.startsWith("local-app:")) {
      await openLocalAppPath(payload.code.slice("local-app:".length));
      return;
    }

    if (payload.code.startsWith("url:")) {
      const url = urlFromQuickOpenCode(payload.code);
      if (url) {
        await openUrl(url);
        scheduleAutoClearSearch();
      }
    }
  }

  function rememberCommandResult(result: SearchResult, input: string) {
    const nextHistory = recordCommandUse(commandHistory, result, input);
    if (nextHistory.length === commandHistory.length && nextHistory.every((entry, index) => entry === commandHistory[index])) {
      return;
    }
    commandHistory = nextHistory;
    saveCommandHistory(nextHistory);
    dispatchCommandHistoryUpdated(nextHistory);
  }

  function historyEntryToSearchResult(entry: CommandHistoryEntry): SearchResult {
    return {
      code: entry.code,
      plugin_id: entry.plugin_id,
      plugin_name: entry.plugin_name,
      label: entry.label,
      icon: null,
      explain: entry.explain,
      score: 90,
      match_type: "exact",
    };
  }

  function fallbackHistoryResult(payload: { code: string; input: string }): SearchResult {
    return {
      code: payload.code,
      plugin_id: "command-history",
      plugin_name: "最近使用",
      label: payload.input || payload.code,
      icon: null,
      explain: payload.input,
      score: 90,
      match_type: "exact",
    };
  }

  function aliasTargetForCode(code: string): CommandAliasTarget | null {
    if (code.startsWith("system:")) {
      const action = SYSTEM_ACTIONS.find((item) => `system:${item.id}` === code);
      return action ? {
        code,
        label: action.label,
        explain: action.description,
        plugin_id: "system",
        plugin_name: "ATools",
      } : null;
    }
    if (code.startsWith("local:")) {
      const entry = localLaunchEntryByCode(code, localLaunchEntries);
      return entry ? {
        code,
        label: `打开 ${entry.name}`,
        explain: `${entry.kind} · ${entry.path}`,
        plugin_id: "local-launch",
        plugin_name: "本地启动",
      } : null;
    }
    if (code.startsWith("web:")) {
      const entry = webQuickOpenEntryByCode(code, webQuickOpenEntries);
      return entry ? {
        code,
        label: entry.name,
        explain: `输入 ${entry.keyword} 关键词快速打开`,
        plugin_id: "web-quick-open",
        plugin_name: "网页快开",
      } : null;
    }
    if (code.startsWith("url:")) {
      const url = urlFromQuickOpenCode(code);
      return url ? {
        code,
        label: `打开链接 ${url}`,
        explain: url,
        plugin_id: "url-quick-open",
        plugin_name: "链接快开",
      } : null;
    }
    return null;
  }

  function aliasTargetToSearchResult(target: CommandAliasTarget): SearchResult {
    return {
      code: target.code,
      plugin_id: target.plugin_id,
      plugin_name: target.plugin_name,
      label: target.label,
      icon: null,
      explain: target.explain,
      score: 90,
      match_type: "alias",
    };
  }

  function pinnedCommandOptions() {
    return pinnedCommandCodes
      .map((code) => aliasTargetForCode(code))
      .filter((target): target is CommandAliasTarget => Boolean(target))
      .map((target) => ({
        code: target.code,
        label: target.label,
        explain: target.explain,
        plugin_id: target.plugin_id,
        plugin_name: target.plugin_name,
        panel: target.code.startsWith("system:")
          ? SYSTEM_ACTIONS.find((action) => `system:${action.id}` === target.code)?.id
          : undefined,
      }));
  }

  function hotkeyPlatform() {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) return "mac";
    if (platform.includes("win")) return "windows";
    return "linux";
  }

  function availableAppShortcutTargetCodes() {
    return appSettings.appShortcuts
      .map((entry) => entry.targetCode)
      .filter((code, index, codes) => codes.indexOf(code) === index)
      .filter((code) => Boolean(aliasTargetForCode(code)));
  }

  function maybeActivateAppShortcut(event: KeyboardEvent) {
    if (activePlugin !== null) return false;
    const match = appShortcutTargetFromKeyboardEvent(event, appSettings.appShortcuts, {
      platform: hotkeyPlatform(),
      availableTargetCodes: availableAppShortcutTargetCodes(),
      editableTarget: isEditableKeyboardTarget(event.target) && !isMainSearchKeyboardTarget(event.target),
    });
    if (!match) return false;

    event.preventDefault();
    event.stopPropagation();
    void activateAppShortcut(match);
    return true;
  }

  async function activateAppShortcut(match: AppShortcutTargetMatch) {
    const target = aliasTargetForCode(match.targetCode);
    if (target) {
      rememberCommandResult(aliasTargetToSearchResult(target), match.shortcut);
    }
    await activateFeature(match.targetCode);
    focusSearch();
  }

  async function activateTextQuickAction(item: SearchResult) {
    const payload = payloadFromTextQuickActionCode(item.code);
    if (!payload) return;
    if (payload.kind === "path-open" || payload.kind === "path-reveal") {
      await callAgentToolFromUi("open_or_reveal_path", {
        path: payload.output,
        reveal: payload.kind === "path-reveal",
      });
      scheduleAutoClearSearch();
      focusSearch();
      return;
    }
    await copyText(payload.output);
    scheduleAutoClearSearch();
    focusSearch();
  }

  async function copyText(text: string) {
    if (hasTauriRuntime()) {
      await invoke("copy_text", { text });
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  async function activatePastedResult(result: SearchResult) {
    const item = pastedItemByCode(result.code, pastedItems);
    if (!item) return;
    if (!item.path) {
      console.info("Pasted item has no local path; save it first before running local tools.", item);
      focusSearch();
      return;
    }

    if (result.code.startsWith("paste:ocr:")) {
      await callAgentToolFromUi("ocr_image", { path: item.path });
    } else if (result.code.startsWith("paste:compress:")) {
      await callAgentToolFromUi("compress_images", { paths: [item.path] });
    } else if (result.code.startsWith("paste:open:")) {
      await callAgentToolFromUi("open_or_reveal_path", { path: item.path, reveal: false });
    } else if (result.code.startsWith("paste:reveal:")) {
      await callAgentToolFromUi("open_or_reveal_path", { path: item.path, reveal: true });
    }
    scheduleAutoClearSearch();
    focusSearch();
  }

  function scheduleAutoClearSearch() {
    const delay = autoClearDelayMs(appSettings.autoClear);
    if (delay === null || !query.trim()) return;
    clearAutoClearTimer();
    const scheduledQuery = query;
    autoClearTimer = setTimeout(() => {
      autoClearTimer = null;
      if (activePlugin !== null || activePanel !== "home" || query !== scheduledQuery) return;
      void clearSearchQuery();
    }, delay);
  }

  async function clearSearchQuery() {
    query = "";
    results = [];
    pastedItems = [];
    selectedIndex = 0;
    remoteSearchStatus = "idle";
    searchError = "";
    await resetPalette();
    focusSearch();
  }

  function clearAutoClearTimer() {
    if (!autoClearTimer) return;
    clearTimeout(autoClearTimer);
    autoClearTimer = null;
  }

  function startClipboardPolling() {
    if (clipboardPollTimer) return;
    void sampleClipboardForAutoPaste();
    clipboardPollTimer = setInterval(() => {
      void sampleClipboardForAutoPaste();
    }, 700);
  }

  function stopClipboardPolling() {
    if (!clipboardPollTimer) return;
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }

  async function sampleClipboardForAutoPaste() {
    if (!hasTauriRuntime() || autoPasteDelayMs(appSettings.autoPaste) === null) return;
    try {
      const text = await readText();
      const now = Date.now();
      if (!clipboardBaselineReady) {
        lastClipboardText = text;
        clipboardBaselineReady = true;
        return;
      }
      if (text !== lastClipboardText) {
        lastClipboardText = text;
        lastClipboardChangedAt = now;
      }
      await maybeAutoPasteClipboard(now);
    } catch (error) {
      console.warn("Failed to read clipboard for auto paste:", error);
    }
  }

  async function maybeAutoPasteClipboard(now = Date.now()) {
    if (activePlugin !== null || activePanel !== "home") return;
    const candidate = autoPasteQueryCandidate({
      setting: appSettings.autoPaste,
      now,
      clipboardChangedAt: lastClipboardChangedAt,
      clipboardText: lastClipboardText,
      currentQuery: query,
      lastAutoPastedText,
    });
    if (!candidate) return;
    lastAutoPastedText = candidate;
    await onQueryChange(candidate);
  }

  async function callAgentToolFromUi(
    name: string,
    args: Record<string, unknown>,
    confirmed = false,
  ) {
    if (!hasTauriRuntime()) {
      console.info("Agent tool preview:", name, args);
      return;
    }
    try {
      await invoke("call_agent_tool", {
        name,
        arguments: args,
        clientId: "atools-ui",
        confirmed,
      });
      await loadPendingPermissionRequests();
    } catch (error) {
      console.warn("Agent tool call failed:", error);
    }
  }

  async function loadPendingPermissionRequests() {
    if (!hasTauriRuntime()) return;
    try {
      pendingPermissionRequests = await invoke<PendingAgentToolRequest[]>("list_pending_agent_requests");
    } catch (e) {
      console.warn("Failed to load pending agent requests:", e);
    }
  }

  function upsertPendingPermissionRequest(request: PendingAgentToolRequest) {
    permissionError = "";
    pendingPermissionRequests = [
      request,
      ...pendingPermissionRequests.filter((pending) => pending.id !== request.id),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  function removePendingPermissionRequest(requestId: string) {
    pendingPermissionRequests = pendingPermissionRequests.filter((request) => request.id !== requestId);
    if (permissionBusyId === requestId) {
      permissionBusyId = "";
    }
  }

  async function allowPermissionOnce(request: PendingAgentToolRequest) {
    permissionBusyId = request.id;
    permissionError = "";
    try {
      await invoke("call_agent_tool", {
        name: request.tool_name,
        arguments: request.arguments,
        clientId: request.client_id,
        confirmed: true,
      });
    } catch (e) {
      console.warn("Confirmed agent tool call failed:", e);
    } finally {
      try {
        await invoke("dismiss_pending_agent_request", { requestId: request.id });
        removePendingPermissionRequest(request.id);
      } catch (e) {
        permissionError = String(e);
        permissionBusyId = "";
      }
    }
  }

  async function allowPermissionAndRemember(request: PendingAgentToolRequest) {
    permissionBusyId = request.id;
    permissionError = "";
    try {
      await invoke("grant_agent_tool", {
        clientId: request.client_id,
        toolName: request.tool_name,
      });
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      removePendingPermissionRequest(request.id);
    } catch (e) {
      permissionError = String(e);
      permissionBusyId = "";
    }
  }

  async function denyPermission(request: PendingAgentToolRequest) {
    permissionBusyId = request.id;
    permissionError = "";
    try {
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      removePendingPermissionRequest(request.id);
    } catch (e) {
      permissionError = String(e);
      permissionBusyId = "";
    }
  }

  function getShellHeight() {
    const plugin = activePlugin as FeatureAction | null;
    const panel = activePanel as ShellPanel;
    if (plugin) return plugin.expand_height;
    if (panel === "agent") return AGENT_WINDOW_HEIGHT;
    if (panel === "settings") return SETTINGS_WINDOW_HEIGHT;
    if (panel !== "home") return defaultWindowHeight;
    if (showQueryResults) return queryResultsWindowHeight;
    if (showHomeRecent) return homeRecentWindowHeight;
    return SEARCH_ONLY_WINDOW_HEIGHT;
  }

  function homeCommandRowCapacity(rows: number) {
    return Math.max(1, Math.min(4, rows)) * RECENT_GRID_COLUMNS;
  }

  function homeWindowHeightFor(commands: RecommendedCommand[]) {
    const pinnedCount = commands.filter((command) => command.source === "pinned").length;
    const recentCount = commands.length - pinnedCount;
    const pinnedRowCount = pinnedCount > 0 ? Math.ceil(pinnedCount / RECENT_GRID_COLUMNS) : 0;
    const recentRowCount = Math.max(1, Math.ceil(recentCount / RECENT_GRID_COLUMNS));
    const rowCount = pinnedRowCount + recentRowCount;
    const extraSectionChrome = pinnedRowCount > 0 ? 23 : 0;
    const pinnedSectionChrome = pinnedCount > 0 ? extraSectionChrome : HOME_PINNED_EMPTY_HEIGHT;
    return SEARCH_BAR_HEIGHT
      + HOME_PANEL_VERTICAL_CHROME + HOME_OVERVIEW_HEIGHT
      + pinnedSectionChrome
      + (rowCount * RECENT_TILE_HEIGHT)
      + (Math.max(0, rowCount - 1) * RECENT_ROW_GAP)
      + SEARCH_STATUS_BAR_HEIGHT
      + SHELL_BORDER_HEIGHT;
  }

  function resultsWindowHeightFor(items: SearchResult[]) {
    const groupCount = resultGroupCount(items);
    const listHeight = Math.min(
      RESULTS_MAX_HEIGHT,
      Math.max(
        RESULTS_MIN_HEIGHT,
        RESULTS_VERTICAL_PADDING
          + (items.length * RESULT_ROW_HEIGHT)
          + (groupCount * RESULT_GROUP_HEADER_HEIGHT)
          + (Math.max(0, groupCount - 1) * RESULT_GROUP_GAP),
      ),
    );
    return SEARCH_BAR_HEIGHT + listHeight + SEARCH_STATUS_BAR_HEIGHT + SHELL_BORDER_HEIGHT;
  }

  function resultGroupCount(items: SearchResult[]) {
    if (items.length === 0) return 1;
    const groups = new Set<string>();
    for (const result of items) {
      groups.add(result.plugin_id === "system" ? "system" : result.plugin_id || result.plugin_name || "plugin");
    }
    return groups.size;
  }

  function resultActionLabel(result: SearchResult | null) {
    if (!result) return "";
    const code = result.code;
    if (code.startsWith("web:") || code.startsWith("url:") || code.startsWith("local:") || code.startsWith("local-app:")) {
      return "打开";
    }
    if (code.startsWith("text:")) {
      const kind = textQuickActionKind(code);
      if (kind === "path-open") return "打开";
      if (kind === "path-reveal") return "定位";
      return "复制";
    }
    if (code.startsWith("paste:open:")) return "打开";
    if (code.startsWith("paste:reveal:")) return "定位";
    if (code.startsWith("paste:")) return "处理";
    return "执行";
  }

  function textQuickActionKind(code: string) {
    try {
      const payload = JSON.parse(decodeURIComponent(code.slice("text:".length))) as { kind?: unknown };
      return typeof payload.kind === "string" ? payload.kind : "";
    } catch {
      return "";
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (settingsHeaderMenuOpen() || settingsConfirmDialogOpen()) return;
      if (activePanel !== "home" && activePlugin === null && isEditableKeyboardTarget(e.target)) {
        return;
      }
      e.preventDefault();
      onEscape();
      return;
    }

    if (maybeActivateAppShortcut(e)) return;

    if (!isHomeSearch || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (showHomeRecent && visibleRecentCommands.length > 0) {
        moveRecentSelection(RECENT_GRID_COLUMNS);
      } else if (results.length > 0) {
        selectedIndex = Math.min(results.length - 1, selectedIndex + 1);
      }
      focusSearch();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (showHomeRecent && visibleRecentCommands.length > 0) {
        moveRecentSelection(-RECENT_GRID_COLUMNS);
      } else {
        selectedIndex = Math.max(0, selectedIndex - 1);
      }
      focusSearch();
    } else if (e.key === "ArrowRight" && showHomeRecent && visibleRecentCommands.length > 0) {
      e.preventDefault();
      moveRecentSelection(1);
      focusSearch();
    } else if (e.key === "ArrowLeft" && showHomeRecent && visibleRecentCommands.length > 0) {
      e.preventDefault();
      moveRecentSelection(-1);
      focusSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showHomeRecent && visibleRecentCommands.length > 0) {
        activateRecentCommand();
      } else if (results.length > 0) {
        onSelect(selectedIndex);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (appSettings.tabKeyFunction === "target-command") {
        if (showHomeRecent) {
          targetRecentCommand();
        } else {
          targetSelectedResult();
        }
        return;
      }
      if (showHomeRecent && visibleRecentCommands.length > 0) {
        selectedRecentIndex = nextIndex(selectedRecentIndex, visibleRecentCommands.length, e.shiftKey ? -1 : 1);
      } else if (results.length > 0) {
        selectedIndex = nextIndex(selectedIndex, results.length, e.shiftKey ? -1 : 1);
      }
      focusSearch();
    } else if (e.key === " " && showHomeRecent && trimmedQuery.length === 0) {
      e.preventDefault();
      if (appSettings.spaceOpenCommand) {
        activateRecentCommand();
      }
    }
  }

  function settingsHeaderMenuOpen() {
    return activePanel === "settings"
      && activePlugin === null
      && document.getElementById("settings-more-menu") !== null;
  }

  function settingsConfirmDialogOpen() {
    return activePanel === "settings"
      && activePlugin === null
      && document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
  }

  function nextIndex(current: number, length: number, delta: number) {
    if (length <= 0) return 0;
    return (current + delta + length) % length;
  }

  function moveRecentSelection(delta: number) {
    const lastIndex = visibleRecentCommands.length - 1;
    selectedRecentIndex = Math.max(0, Math.min(lastIndex, selectedRecentIndex + delta));
  }

</script>

<svelte:window onkeydown={onKeyDown} />

{#if isSuperPanelWindow}
  <main class="super-panel-shell">
    <section class="super-panel-surface">
      <div class="super-panel-header">
        <ZMark size="small" label="超级面板" />
        <div>
          <strong>超级面板</strong>
          <span>{superPanelStatus || "剪贴板文本入口"}</span>
        </div>
      </div>
      <p class="super-panel-preview">{superPanelClipboardText || "剪贴板没有可用文本"}</p>
      <div class="super-panel-actions">
        <button type="button" onclick={refreshSuperPanelClipboard}>刷新</button>
        <button type="button" onclick={copySuperPanelText} disabled={!superPanelClipboardText.trim()}>复制</button>
        <button type="button" aria-label="打开 ATools 主搜索" onclick={openMainFromSuperPanel}>打开主搜索</button>
      </div>
    </section>
  </main>
{:else if isFloatingBallWindow}
  <main class="floating-ball-shell">
    <button class="floating-ball-button" aria-label="打开 ATools 主搜索" onclick={openMainFromFloatingBall}>
      <ZMark size="small" label="打开 ATools" />
    </button>
  </main>
{:else}
  <ShellFrame
    activePanel={activePanel}
    expanded={activePlugin !== null || activePanel !== "home" || query.trim().length > 0 || showHomeRecent}
    contentVisible={hasContent}
    targetHeight={getShellHeight()}
  >
    {#snippet search()}
      {#if activePanel === "settings" && activePlugin === null}
        <SettingsHeader onclose={() => onPanelChange("home")} />
      {:else}
        <SearchBar
          {query}
          onchange={onQueryChange}
          placeholder={activePlugin ? `在 ${activePlugin.plugin_name} 中搜索` : appSettings.placeholder}
          prominent={activePlugin === null}
          showBadge={activePlugin === null}
          focusToken={searchFocusToken}
          onbadgeclick={() => openSettingsMenu("general")}
          onpaste={onSearchPaste}
        />
      {/if}
    {/snippet}

    {#if activePlugin}
      <div class="plugin-panel-host" bind:this={pluginPanelHost}></div>
    {:else if showQueryResults}
      <div class="search-surface">
        <ResultsList {results} {selectedIndex} {query} feedback={searchFeedback} onselect={onSelect} />
        <SearchStatusBar
          mode="results"
          count={results.length}
          {selectedIndex}
          selectedLabel={selectedResultLabel}
          selectedAction={selectedResultAction}
          tabAction={searchStatusTabAction}
        />
      </div>
    {:else if showHomeRecent}
      <div class="search-surface">
        <HomePanel
          commands={visibleRecentCommands}
          oncommand={onHomeCommand}
          onpanelchange={onHomePanelChange}
          onsettingsmenu={openSettingsMenu}
          pinnedRows={appSettings.pinnedRows}
          recentRows={appSettings.recentRows}
          localAppSearch={includeLocalAppSearch(appSettings)}
          localLaunchSearch={includeLocalLaunchSearch(appSettings)}
          commandAliasCount={commandAliases.length}
          localLaunchCount={localLaunchEntries.filter((entry) => entry.enabled).length}
          webQuickOpenCount={webQuickOpenEntries.filter((entry) => entry.enabled).length}
          selectedIndex={selectedRecentIndex}
          onselectionchange={onRecentSelectionChange}
          onactivate={(command) => activateRecentCommand(visibleRecentCommands.indexOf(command))}
          onremove={removeRecentCommand}
        />
        <SearchStatusBar
          mode="home"
          count={visibleRecentCommands.length}
          selectedIndex={selectedRecentIndex}
          selectedLabel={selectedRecentLabel}
          titleOverride={selectedRecentStatus.title}
          detailOverride={selectedRecentStatus.detail}
          tabAction={searchStatusTabAction}
        />
      </div>
    {:else if activePanel !== "home"}
      <SystemPanel panel={activePanel} settingsMenu={settingsMenuTarget} onpanelchange={onPanelChange} />
    {/if}
  </ShellFrame>

  {#if activePermissionRequest}
    <PermissionConfirmDialog
      request={activePermissionRequest}
      busy={permissionBusyId === activePermissionRequest.id}
      error={permissionError}
      onallowonce={allowPermissionOnce}
      onallowremember={allowPermissionAndRemember}
      ondeny={denyPermission}
    />
  {/if}

  {#if !isPluginDetachWindow && $appUpdaterState.promptVisible}
    <AppUpdatePrompt
      state={$appUpdaterState}
      ondismiss={() => appUpdater.dismiss()}
      oninstall={() => appUpdater.installAndRestart()}
    />
  {/if}
{/if}

<style>
  .super-panel-shell {
    width: 100vw;
    height: 100vh;
    display: grid;
    place-items: center;
    padding: 10px;
    background: transparent;
    overflow: hidden;
  }

  .super-panel-surface {
    width: min(100%, 440px);
    height: min(100%, 240px);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 12px;
    padding: 16px;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
    box-shadow: 0 22px 58px -28px rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(18px);
  }

  .super-panel-header {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .super-panel-header div {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .super-panel-header strong {
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.2;
  }

  .super-panel-header span {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .super-panel-preview {
    min-height: 0;
    margin: 0;
    overflow: hidden;
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.55;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 5;
    line-clamp: 5;
  }

  .super-panel-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .super-panel-actions button {
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    line-height: 1;
    transition:
      transform 120ms var(--ease-out-expo),
      border-color 120ms var(--ease-out-expo),
      background 120ms var(--ease-out-expo);
  }

  .super-panel-actions button:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .super-panel-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .floating-ball-shell {
    width: 100vw;
    height: 100vh;
    display: grid;
    place-items: center;
    background: transparent;
    overflow: hidden;
  }

  .floating-ball-button {
    width: 58px;
    height: 58px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    border: 1px solid var(--border-strong);
    box-shadow: 0 18px 44px -20px rgba(0, 0, 0, 0.54);
    transition:
      transform 120ms var(--ease-out-expo),
      box-shadow 120ms var(--ease-out-expo);
  }

  .floating-ball-button:hover {
    transform: translateY(-1px);
    box-shadow: 0 20px 48px -20px rgba(0, 0, 0, 0.62);
  }

  .floating-ball-button:active {
    transform: translateY(0) scale(0.97);
  }

  .search-surface {
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
  }

  .search-surface :global(.results-list),
  .search-surface :global(.home-panel) {
    flex: 1 1 auto;
  }
</style>
