import { permissionDialogOpen } from "./permissionDialogFocus";
import { isEditableKeyboardTarget, isMainSearchKeyboardTarget } from "./keyboardTarget";
import {
  ignoreLauncherKeyboardEvent, isLauncherNavigationTarget, moveResultSelection,
  shouldPassThroughEmptyHomeKey,
} from "./launcherKeyboard";
import { moveHomeGridSelection } from "./homeNavigation";
import { isLauncherFixTextShortcut } from "./launcherMatchContext";
import type { SearchFeedback } from "./searchFeedback";
import type { SearchRetryEnterContext } from "./launcherSearchRetryController";
import type { SearchResult, FeatureAction } from "./types";
import type { RecommendedCommand, ShellPanel } from "./uiState";
import type { LauncherMediaSearchState } from "./launcherMediaSearch";
import type { LauncherContentSearchState } from "./launcherContentSearch";
import type { AToolsSettings } from "./settings";
import type { HomeCommandSection } from "./homeSurface";

interface KeyboardState {
  isHomeSearch: boolean;
  isPasteboardShelfWindow: boolean;
  isPasteboardDialogWindow: boolean;
  mediaMatch: LauncherMediaSearchState;
  textMatch: LauncherContentSearchState;
  query: string;
  activePlugin: FeatureAction | null;
  activePanel: ShellPanel;
  appSettings: Pick<AToolsSettings, "tabKeyFunction" | "spaceOpenCommand">;
  launcherResults: SearchResult[];
  selectedIndex: number;
  selectedRecentIndex: number;
  showHomeRecent: boolean;
  showQueryResults: boolean;
  trimmedQuery: string;
  visibleRecentCommands: RecommendedCommand[];
  homeNavigationSections: HomeCommandSection[];
  homeGridColumns: number;
  searchFeedback: SearchFeedback;
  settingsHeaderMenuOpen: boolean;
  settingsConfirmDialogOpen: boolean;
  mainPushPromoted: boolean;
}

interface KeyboardPorts {
  getState: () => KeyboardState;
  setSelectedIndex: (index: number) => void;
  setSelectedRecentIndex: (index: number) => void;
  setUserSearchSelection: (results: SearchResult[], index: number) => void;
  removeLauncherMedia: () => void;
  pinLauncherText: (text: string) => void;
  restoreLauncherText: (focus?: boolean) => void;
  menuShortcut: (event: KeyboardEvent, item: RecommendedCommand | SearchResult | undefined) => boolean;
  mainPushOwns: (code: string) => boolean;
  requestMainPushEscape: () => void;
  requestPluginEscape: () => boolean;
  onEscape: () => void;
  activateAppShortcut: (event: KeyboardEvent) => boolean;
  hasModal: () => boolean;
  pageResultSelection: (delta: 1 | -1) => boolean;
  focusSearch: () => void;
  activateRecentCommand: () => void;
  onSelect: (index: number) => void;
  focusSearchRetryAction: () => boolean;
  retryFromEnter: (context: SearchRetryEnterContext) => boolean;
  launchTabTarget: () => void;
  focusHomeTarget: (index: number) => boolean;
  activateSpaceCommand: () => void;
}

/** Per-window keyboard policy. State is read at event time so Svelte runes stay the source of truth. */
export function createLauncherKeyboardController(ports: KeyboardPorts) {
  function onKeyDown(event: KeyboardEvent) {
    if (ignoreLauncherKeyboardEvent(event) || permissionDialogOpen()) return;
    const state = ports.getState();
    if (state.isPasteboardShelfWindow || state.isPasteboardDialogWindow) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const mainTarget = isMainSearchKeyboardTarget(event.target);
    if (state.isHomeSearch && (state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null)
      && !state.query && plain && mainTarget && (event.key === "Backspace" || event.key === "Delete")) {
      event.preventDefault(); ports.removeLauncherMedia(); return;
    }
    if (state.isHomeSearch && isLauncherFixTextShortcut(event) && state.query.trim()) {
      event.preventDefault(); ports.pinLauncherText(state.query); return;
    }
    if (state.isHomeSearch && state.textMatch.content !== null && !state.query && plain && mainTarget
      && (event.key === "Backspace" || event.key === "Delete")) {
      event.preventDefault(); ports.restoreLauncherText(true); return;
    }
    const selected = state.showHomeRecent
      ? state.visibleRecentCommands[state.selectedRecentIndex]
      : state.launcherResults[state.selectedIndex];
    if (!ports.mainPushOwns(state.launcherResults[state.selectedIndex]?.code ?? "") && ports.menuShortcut(event, selected)) return;
    if (event.key === "Escape") {
      if (state.activePlugin && (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) return;
      if (state.settingsHeaderMenuOpen || state.settingsConfirmDialogOpen) return;
      if (state.activePanel !== "home" && state.activePlugin === null && isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      if (state.activePlugin && state.mainPushPromoted) ports.requestMainPushEscape();
      else if (state.activePlugin && ports.requestPluginEscape()) return;
      else ports.onEscape();
      return;
    }
    if (ports.activateAppShortcut(event)) return;
    if (state.isHomeSearch && mainTarget
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
      const input = event.target as HTMLInputElement;
      if (input.selectionStart !== null && input.selectionEnd !== null
        && input.selectionStart !== input.selectionEnd) return;
    }
    if (!state.isHomeSearch || event.metaKey || event.ctrlKey || event.altKey || !isLauncherNavigationTarget(event.target)) return;
    if (shouldPassThroughEmptyHomeKey(event, {
      isHomeSearch: state.isHomeSearch, emptyQuery: state.trimmedQuery.length === 0,
      hasSelectableRows: state.showHomeRecent ? state.visibleRecentCommands.length > 0 : state.launcherResults.length > 0,
      hasTextOrMediaContext: state.textMatch.content !== null || state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null,
      modalOpen: state.settingsHeaderMenuOpen || state.settingsConfirmDialogOpen,
    }) && !ports.hasModal()) return;
    if ((event.key === "PageDown" || event.key === "PageUp") && !event.shiftKey && state.showQueryResults && !ports.hasModal()) {
      if (ports.pageResultSelection(event.key === "PageDown" ? 1 : -1)) { event.preventDefault(); ports.focusSearch(); }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (state.showHomeRecent && state.visibleRecentCommands.length) {
        ports.setSelectedRecentIndex(moveHomeGridSelection(state.homeNavigationSections, state.selectedRecentIndex, "down", state.homeGridColumns));
      } else if (state.launcherResults.length) {
        const index = moveResultSelection(state.launcherResults, state.selectedIndex, 1);
        ports.setSelectedIndex(index); ports.setUserSearchSelection(state.launcherResults, index);
      }
      ports.focusSearch();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (state.showHomeRecent && state.visibleRecentCommands.length) {
        ports.setSelectedRecentIndex(moveHomeGridSelection(state.homeNavigationSections, state.selectedRecentIndex, "up", state.homeGridColumns));
      } else {
        const index = moveResultSelection(state.launcherResults, state.selectedIndex, -1);
        ports.setSelectedIndex(index);
        if (state.launcherResults.length) ports.setUserSearchSelection(state.launcherResults, index);
      }
      ports.focusSearch();
    } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && state.showHomeRecent && state.visibleRecentCommands.length) {
      event.preventDefault();
      ports.setSelectedRecentIndex(moveHomeGridSelection(state.homeNavigationSections, state.selectedRecentIndex,
        event.key === "ArrowRight" ? "right" : "left", state.homeGridColumns));
      ports.focusSearch();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (state.showHomeRecent && state.visibleRecentCommands.length) ports.activateRecentCommand();
      else if (state.launcherResults.length) ports.onSelect(state.selectedIndex);
      else ports.retryFromEnter({
        key: event.key, isMainSearchFocused: mainTarget, isComposing: event.isComposing,
        keyCode: event.keyCode, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
        altKey: event.altKey, shiftKey: event.shiftKey,
      });
    } else if (event.key === "Tab") {
      if (state.appSettings.tabKeyFunction === "target-command" && !event.shiftKey) {
        if (!mainTarget || state.textMatch.content !== null || state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null) return;
        event.preventDefault(); ports.launchTabTarget(); return;
      }
      const retryActionAvailable = state.isHomeSearch && state.trimmedQuery.length > 0
        && state.textMatch.content === null && state.mediaMatch.content === null && state.mediaMatch.intakeKind === null
        && !state.settingsHeaderMenuOpen && !state.settingsConfirmDialogOpen && !ports.hasModal()
        && state.searchFeedback.mode === "strip" && state.searchFeedback.retryOnPointer === true;
      const tabCanReachRetry = mainTarget && retryActionAvailable
        && !event.metaKey && !event.ctrlKey && !event.altKey
        && (event.shiftKey || state.appSettings.tabKeyFunction === "navigate");
      if (tabCanReachRetry && ports.focusSearchRetryAction()) {
        event.preventDefault();
        return;
      }
      if (state.appSettings.tabKeyFunction === "navigate" && mainTarget
        && (state.showHomeRecent ? state.visibleRecentCommands.length : state.launcherResults.length) === 0) return;
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && mainTarget && state.showHomeRecent
        && state.visibleRecentCommands.length) {
        if (ports.focusHomeTarget(state.selectedRecentIndex)) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (state.showHomeRecent && state.visibleRecentCommands.length) {
        ports.setSelectedRecentIndex(nextIndex(state.selectedRecentIndex, state.visibleRecentCommands.length, event.shiftKey ? -1 : 1));
      } else if (state.launcherResults.length) {
        const index = moveResultSelection(state.launcherResults, state.selectedIndex, event.shiftKey ? -1 : 1, true);
        ports.setSelectedIndex(index); ports.setUserSearchSelection(state.launcherResults, index);
      }
      ports.focusSearch();
    } else if (event.key === " " && state.showHomeRecent && state.trimmedQuery.length === 0) {
      event.preventDefault(); if (state.appSettings.spaceOpenCommand) ports.activateSpaceCommand();
    }
  }
  return { onKeyDown };
}

function nextIndex(current: number, length: number, delta: number) {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}
