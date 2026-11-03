import { launcherActionCode, resolveLauncherAction } from "./launcherCommandActions";
import {
  commandHistoryPayloadFromCode, dispatchCommandHistoryUpdated, removeCommandHistoryEntry,
  saveCommandHistory, type CommandHistoryEntry,
} from "./commandHistory";
import { resolveHistoryRemovalOwner } from "./commandHistoryIdentity";
import type { RecommendedCommand, ShellPanel } from "./uiState";
import type { CommandAliasTarget } from "./commandAliases";
import type { FeatureAction, SearchResult } from "./types";
import type { AToolsSettings } from "./settings";
import type { LauncherPinsContext } from "./launcherPins";
import type { SettingsMenuId } from "./settingsPages";
import type { LauncherSystemDestination } from "./launcherSystemSearchActions";
import type { PluginMarketRequest } from "./pluginMarketNavigation";
import type { LauncherPendingPluginActivationStore } from "./launcherPendingPluginActivation.svelte";

interface NavigationState {
  activePlugin: FeatureAction | null;
  activePanel: ShellPanel;
  appSettings: AToolsSettings;
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  selectedRecentIndex: number;
  settingsMenuTarget: SettingsMenuId;
  pluginMarketRequest: PluginMarketRequest | null;
  commandHistory: CommandHistoryEntry[];
  visibleRecentCommands: RecommendedCommand[];
}

interface NavigationPorts {
  state: NavigationState;
  pendingPluginActivation: LauncherPendingPluginActivationStore;
  clearReturnContext: () => void;
  closePromoted: () => Promise<void>;
  returnPluginToSearch: () => Promise<void>;
  refreshFeatureCatalog: (force?: boolean) => Promise<void>;
  hasTauriRuntime: () => boolean;
  resetPalette: () => Promise<void>;
  focusSearch: () => void;
  cancelTabTarget: () => void;
  onQueryChange: (query: string) => Promise<void>;
  activateFeature: (code: string, payload?: unknown, options?: { expectedPluginId?: string; onOwnerValidated?: () => void }) => Promise<unknown>;
  expectedPluginId: (target: CommandAliasTarget | null) => string | undefined;
  rememberCommandResult: (result: SearchResult, input: string) => void;
  activateHistoryPayload: (payload: { code: string; input: string; plugin_id?: string }) => Promise<void>;
  launcherPinsContext: () => LauncherPinsContext;
  copyText: (text: string) => Promise<void>;
  openHideMainWindow: () => Promise<void>;
  hasContentContext: () => boolean;
  clearContentContext: () => void;
  cancelMediaIntake: () => void;
  advanceSearchRun: () => void;
  clearSearchContexts: () => void;
  defaultWindowHeight: () => number;
  expandPalette: (height: number) => Promise<void>;
  normalizePluginMarketRequest: (request: PluginMarketRequest) => PluginMarketRequest | null;
}

export function createLauncherNavigationController(ports: NavigationPorts) {
  const state = ports.state;

  async function onEscape() {
    ports.cancelTabTarget();
    if (ports.pendingPluginActivation.cancel()) { ports.focusSearch(); return; }
    if (state.activePlugin) {
      if (state.appSettings.pluginEscapeToSearch) await ports.returnPluginToSearch();
      return;
    }
    if (state.activePanel !== "home") {
      state.activePanel = "home";
      if (ports.hasTauriRuntime()) void ports.refreshFeatureCatalog(true);
      await ports.resetPalette(); ports.focusSearch(); return;
    }
    if (ports.hasContentContext()) {
      if (!state.query) ports.clearContentContext();
      await ports.onQueryChange(""); return;
    }
    if (state.query) {
      ports.advanceSearchRun(); state.query = ""; state.results = []; state.selectedIndex = 0;
      await ports.resetPalette(); ports.focusSearch(); return;
    }
    ports.cancelMediaIntake();
    await ports.openHideMainWindow();
  }

  async function onPanelChange(panel: ShellPanel) {
    ports.pendingPluginActivation.cancel();
    if (panel !== state.activePanel) ports.cancelTabTarget();
    ports.advanceSearchRun(); ports.clearSearchContexts();
    state.activePanel = panel;
    if (panel !== "home") {
      state.query = ""; state.results = []; state.selectedIndex = 0; state.selectedRecentIndex = 0;
      const height = panel === "agent" || panel === "results" ? 760
        : panel === "settings" || panel === "plugins" ? 600 : ports.defaultWindowHeight();
      await ports.expandPalette(height);
    } else {
      if (ports.hasTauriRuntime()) void ports.refreshFeatureCatalog(true);
      await ports.resetPalette(); ports.focusSearch();
    }
  }

  async function onHomeCommand(command: string) { await ports.onQueryChange(command); }

  async function openSettingsMenu(menu: SettingsMenuId) {
    if (menu !== "market") state.pluginMarketRequest = null;
    state.settingsMenuTarget = menu;
    await onPanelChange("settings");
  }

  async function openPluginMarket(request: PluginMarketRequest) {
    const target = ports.normalizePluginMarketRequest(request);
    if (!target) return;
    state.pluginMarketRequest = target;
    await openSettingsMenu("market");
  }

  async function onHomePanelChange(panel: ShellPanel) {
    if (panel === "settings") { state.pluginMarketRequest = null; state.settingsMenuTarget = "general"; }
    await onPanelChange(panel);
  }

  function onRecentSelectionChange(index: number, returnFocusToSearch = true) {
    state.selectedRecentIndex = Math.max(0, Math.min(state.visibleRecentCommands.length - 1, index));
    if (returnFocusToSearch) ports.focusSearch();
  }

  async function activateRecentCommand(index = state.selectedRecentIndex) {
    const command = state.visibleRecentCommands[index];
    if (!command) return;
    if (command.source === "history") {
      await ports.activateHistoryPayload({ code: command.code, input: command.input ?? command.label, plugin_id: command.plugin_id });
    } else if (command.source === "pinned") {
      const target = resolveLauncherAction(command, ports.launcherPinsContext());
      if (target) await ports.activateFeature(target.code, null, {
        expectedPluginId: ports.expectedPluginId(target), onOwnerValidated: () => ports.rememberCommandResult(target, command.label),
      });
    } else if (command.panel) await onPanelChange(command.panel);
    else { await onHomeCommand(command.label); ports.focusSearch(); }
  }

  function removeRecentCommand(command: Pick<RecommendedCommand, "source" | "code" | "plugin_id">) {
    const code = launcherActionCode({ ...command, label: "" });
    if (!code || (command.source !== "history" && !command.code.startsWith("history:"))) return;
    const payload = command.code.startsWith("history:") ? commandHistoryPayloadFromCode(command.code) : null;
    const owner = resolveHistoryRemovalOwner(code, payload?.plugin_id ?? command.plugin_id, state.commandHistory);
    if (!owner) return;
    const next = removeCommandHistoryEntry(state.commandHistory, code, owner);
    if (next.length === state.commandHistory.length) return;
    state.commandHistory = next; saveCommandHistory(next); dispatchCommandHistoryUpdated(next);
    state.selectedRecentIndex = Math.max(0, Math.min(state.selectedRecentIndex, state.visibleRecentCommands.length - 1));
    if (state.query.trim()) void ports.onQueryChange(state.query);
    ports.focusSearch();
  }

  async function activateSystemDestination(destination: LauncherSystemDestination) {
    if (destination.kind === "settings-menu") {
      await openSettingsMenu(destination.menu);
      return;
    }
    if (destination.panel !== "home") await onPanelChange(destination.panel);
  }

  async function handlePluginSettingsRedirect(menu: "shortcuts" | "ai", detail?: Record<string, unknown>) {
    ports.clearReturnContext(); await ports.closePromoted(); state.activePlugin = null;
    if (menu === "shortcuts") {
      const label = typeof detail?.cmdLabel === "string" ? detail.cmdLabel.trim() : "";
      if (detail?.autocopy === true && label) {
        try { await ports.copyText(label); } catch (error) { console.warn("[PluginPanel] redirectHotKeySetting autocopy failed:", error); }
      }
      await openSettingsMenu("shortcuts");
    } else await openSettingsMenu("ai");
    return true;
  }

  return { onEscape, onPanelChange, onHomeCommand, openSettingsMenu, openPluginMarket,
    onHomePanelChange, onRecentSelectionChange, activateRecentCommand, removeRecentCommand,
    activateSystemDestination, handlePluginSettingsRedirect };
}
