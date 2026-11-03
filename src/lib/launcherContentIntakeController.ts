import { autoClearDelayMs, autoPasteDelayMs, autoPasteQueryCandidate } from "./searchBehavior";
import { plainTextPasteForEmptySearch } from "./launcherMatchContext";
import type { AToolsSettings } from "./settings";
import type { LauncherMediaInput } from "./launcherMediaContext";
import type { LauncherContentSearchState } from "./launcherContentSearch";
import type { LauncherMediaSearchState } from "./launcherMediaSearch";
import type { SearchResult } from "./types";

type IntakeState = {
  activePlugin: unknown | null;
  activePanel: string;
  query: string;
  mediaMatch: LauncherMediaSearchState;
  textMatch: LauncherContentSearchState;
  pastedItems: import("./pasteIntake").PastedItem[];
  results: SearchResult[];
  selectedIndex: number;
  remoteSearchStatus: import("./searchFeedback").RemoteSearchStatus;
  searchError: string;
  appSettings: AToolsSettings;
  searchRunId: number;
  searchSelectAllToken: number;
  userSearchSelection: import("./launcherSearch").SearchSelectionIdentity | null;
  pluginLifecycleNotice: import("./pluginCodeLifecycle").PluginCodeChange | null;
  pluginActivationError: string;
};

type IntakePorts = {
  state: IntakeState;
  tabTargetController: { cancel: () => void };
  mediaSearch: Pick<ReturnType<typeof import("./launcherMediaSearch").createLauncherMediaSearch>, "pin" | "clear" | "cancelIntake">;
  contentSearch: Pick<ReturnType<typeof import("./launcherContentSearch").createLauncherContentSearch>, "clear" | "pin" | "generation">;
  mediaPaste: Pick<ReturnType<typeof import("./launcherMediaPaste").createLauncherMediaPaste>, "handleFiles" | "probe">;
  onQueryChange: (query: string) => Promise<void>;
  setSearchVisible: (visible: boolean) => Promise<void>;
  focusSearch: () => void;
  resetPalette: () => Promise<void>;
  hasTauriRuntime: () => boolean;
  readClipboard: () => Promise<string>;
};

export function createLauncherContentIntakeController(ports: IntakePorts) {
  const { state } = ports;
  let autoClearTimer: ReturnType<typeof setTimeout> | null = null;
  let clipboardPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastClipboardText = "";
  let lastClipboardChangedAt: number | null = null;
  let lastAutoPastedText = "";
  let clipboardBaselineReady = false;
  function onSearchPaste(event: ClipboardEvent) {
    if (state.activePlugin) return false;
    if (event.clipboardData?.files?.length) {
      ports.contentSearch.clear(); ports.mediaSearch.clear(); state.searchRunId += 1;
      state.pastedItems = []; state.results = []; state.query = ""; clearAutoClearTimer();
      if (ports.mediaPaste.handleFiles(event)) return true;
    }
    const text = plainTextPasteForEmptySearch(event, state.query);
    if (text !== null) {
      pinLauncherText(text, false);
      const generation = ports.contentSearch.generation();
      ports.mediaPaste.probe(event, () => state.textMatch.content === text && ports.contentSearch.generation() === generation && state.query === "");
      return true;
    }
    ports.mediaPaste.probe(event);
    return false;
  }

  function pinLauncherMedia(input: LauncherMediaInput) {
    if (!ports.mediaSearch.pin(input)) return;
    ports.tabTargetController.cancel();
    ports.contentSearch.clear(); state.searchRunId += 1; state.userSearchSelection = null;
    state.pluginLifecycleNotice = null; state.pluginActivationError = ""; clearAutoClearTimer();
    state.activePanel = "home"; state.query = ""; ports.focusSearch();
  }

  function onLauncherVisibilityChange() {
    const visible = document.visibilityState !== "hidden";
    void ports.setSearchVisible(visible).catch(() => console.warn("Launcher search visibility update failed."));
    if (visible) return;
    ports.mediaSearch.cancelIntake();
    if (state.mediaMatch.content === null && state.mediaMatch.intakeKind === null) return;
    state.searchRunId += 1; ports.mediaSearch.clear(); state.pastedItems = []; state.query = ""; state.results = [];
    state.selectedIndex = 0; state.remoteSearchStatus = "idle"; state.searchError = "";
  }

  function removeLauncherMedia() {
    ports.mediaSearch.clear(); state.pastedItems = []; void ports.onQueryChange("");
  }

  function pinLauncherText(content: string, trim = true) {
    if (!ports.contentSearch.pin(content, trim)) return;
    ports.tabTargetController.cancel();
    ports.mediaSearch.clear();
    state.searchRunId += 1; state.userSearchSelection = null;
    state.pluginLifecycleNotice = null; state.pluginActivationError = ""; clearAutoClearTimer();
    state.activePanel = "home"; state.query = ""; state.pastedItems = []; ports.focusSearch();
  }

  function restoreLauncherText(selectAll = false) {
    const content = ports.contentSearch.clear();
    if (content === null) return;
    void ports.onQueryChange(content);
    if (selectAll) state.searchSelectAllToken += 1;
    ports.focusSearch();
  }

  function removeLauncherText() {
    ports.contentSearch.clear(); void ports.onQueryChange("");
  }

  function scheduleAutoClearSearch() {
    const delay = autoClearDelayMs(state.appSettings.autoClear);
    if (delay === null || !state.query.trim()) return;
    clearAutoClearTimer();
    const scheduledQuery = state.query;
    autoClearTimer = setTimeout(() => {
      autoClearTimer = null;
      if (state.activePlugin !== null || state.activePanel !== "home" || state.query !== scheduledQuery) return;
      void clearSearchQuery();
    }, delay);
  }

  async function clearSearchQuery() {
    state.searchRunId += 1; ports.contentSearch.clear(); ports.mediaSearch.clear();
    state.query = "";
    state.results = [];
    state.pastedItems = [];
    state.selectedIndex = 0;
    state.remoteSearchStatus = "idle";
    state.searchError = "";
    await ports.resetPalette();
    ports.focusSearch();
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
    if (!ports.hasTauriRuntime() || autoPasteDelayMs(state.appSettings.autoPaste) === null) return;
    try {
      const text = await ports.readClipboard();
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
    if (state.activePlugin !== null || state.activePanel !== "home" || state.textMatch.content !== null || state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null) return;
    const candidate = autoPasteQueryCandidate({
      setting: state.appSettings.autoPaste,
      now,
      clipboardChangedAt: lastClipboardChangedAt,
      clipboardText: lastClipboardText,
      currentQuery: state.query,
      lastAutoPastedText,
    });
    if (!candidate) return;
    lastAutoPastedText = candidate;
    await ports.onQueryChange(candidate);
  }


  return {
    onSearchPaste,
    pinLauncherMedia,
    onLauncherVisibilityChange,
    removeLauncherMedia,
    pinLauncherText,
    restoreLauncherText,
    removeLauncherText,
    scheduleAutoClearSearch,
    clearSearchQuery,
    clearAutoClearTimer,
    startClipboardPolling,
    stopClipboardPolling,
    sampleClipboardForAutoPaste,
    maybeAutoPasteClipboard,
  };
}
