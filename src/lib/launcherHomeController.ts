import { invoke } from "@tauri-apps/api/core";
import type { AToolsSettings } from "./settings";
import type { CommandAliasEntry, CommandAliasTarget } from "./commandAliases";
import {
  commandHistoryListsEqual,
  filterCommandHistoryByAvailability,
  refreshCommandHistoryMetadata,
  saveCommandHistory,
  dispatchCommandHistoryUpdated,
  type CommandHistoryEntry,
} from "./commandHistory";
import { RECOMMENDED_COMMANDS, type RecommendedCommand } from "./uiState";
import { LAUNCHER_SYSTEM_SEARCH_ACTIONS } from "./launcherSystemSearchActions";
import { commandAliasResultsForQuery } from "./commandAliases";
import { includeLocalLaunchSearch } from "./searchBehavior";
import { localLaunchResultsForQuery, type LocalLaunchEntry } from "./localLaunch";
import { webQuickOpenResultsForQuery, type WebQuickOpenEntry } from "./webQuickOpen";
import { commandHistoryResultsForQuery } from "./commandHistory";
import { textQuickActionResultsForQuery } from "./textQuickActions";
import { urlQuickOpenResultsForQuery, urlFromQuickOpenCode } from "./urlQuickOpen";
import { searchMatchForQuery, sortSearchMatches } from "./searchMatch";
import type { SearchResult } from "./types";

type HomeState = {
  availableFeatureCodesReady: boolean;
  commandHistory: CommandHistoryEntry[];
  featureCatalog: SearchResult[];
  pinnedCatalogReady: boolean;
  availableFeatureIdentities: Set<string>;
  featureCatalogRunId: number;
  featureCatalogRetryCount: number;
  featureCatalogRetryTimer: ReturnType<typeof setTimeout> | null;
  commandAliases: CommandAliasEntry[];
  localLaunchEntries: LocalLaunchEntry[];
  webQuickOpenEntries: WebQuickOpenEntry[];
  appSettings: AToolsSettings;
  mediaMatch: { content: unknown | null };
  textMatch: { content: unknown | null };
  searchRunId: number;
};

type HomePorts = {
  state: HomeState;
  contentSearch: { refresh: () => void };
  mediaSearch: { cancelIntake: () => void; refresh: () => void };
  syncPinnedCommands: () => void;
  aliasTargetForCode: (code: string) => CommandAliasTarget | null;
};

export function createLauncherHomeController(ports: HomePorts) {
  const { state } = ports;
  function localResultsForQuery(value: string): SearchResult[] {
    return [
      ...systemResultsForQuery(value),
      ...commandAliasResultsForQuery(value, state.commandAliases, ports.aliasTargetForCode),
      ...urlQuickOpenResultsForQuery(value),
      ...commandHistoryResultsForQuery(value, availableCommandHistory()),
      ...textQuickActionResultsForQuery(value),
      ...(includeLocalLaunchSearch(state.appSettings) ? localLaunchResultsForQuery(value, state.localLaunchEntries) : []),
      ...webQuickOpenResultsForQuery(value, state.webQuickOpenEntries),
    ].sort((a, b) => b.score - a.score);
  }

  function availableCommandHistory() {
    if (!state.availableFeatureCodesReady) return state.commandHistory;
    return filterCommandHistoryByAvailability(state.commandHistory, isCommandHistoryEntryAvailable);
  }

  function recommendedCommandsForHome(): RecommendedCommand[] {
    if (!state.availableFeatureCodesReady) {
      return RECOMMENDED_COMMANDS.filter((command) => Boolean(command.panel));
    }
    const catalogByCode = new Map(state.featureCatalog.map((result) => [result.code, result]));
    return RECOMMENDED_COMMANDS.flatMap((command) => {
      if (command.panel) return [command];
      const feature = catalogByCode.get(command.code);
      if (!feature) return [];
      return [{
        ...command,
        label: feature.label || command.label,
        explain: feature.explain || command.explain,
        icon: feature.icon,
      }];
    });
  }

  async function refreshFeatureCatalog(authoritative = false): Promise<boolean> {
    ports.mediaSearch.cancelIntake();
    if (state.mediaMatch.content !== null) { state.searchRunId += 1; ports.mediaSearch.refresh(); }
    if (state.textMatch.content !== null) { state.searchRunId += 1; ports.contentSearch.refresh(); }
    const runId = ++state.featureCatalogRunId;
    try {
      const catalog = await invoke<SearchResult[]>("feature_catalog");
      if (runId !== state.featureCatalogRunId) return false;
      state.featureCatalog = catalog;
      state.pinnedCatalogReady = authoritative || catalog.length > 0;
      ports.syncPinnedCommands();
      state.availableFeatureIdentities = new Set(catalog.map((feature) => JSON.stringify([feature.plugin_id, feature.code])));
      state.availableFeatureCodesReady = true;
      if (!authoritative && catalog.length === 0 && state.featureCatalogRetryCount < 8) {
        state.featureCatalogRetryCount += 1;
        clearFeatureCatalogRetry();
        state.featureCatalogRetryTimer = setTimeout(() => {
          state.featureCatalogRetryTimer = null;
          void refreshFeatureCatalog();
        }, 250);
      } else if (catalog.length > 0) {
        state.featureCatalogRetryCount = 0;
        clearFeatureCatalogRetry();
      }
      const nextHistory = refreshCommandHistoryMetadata(state.commandHistory, catalog);
      if (!commandHistoryListsEqual(nextHistory, state.commandHistory)) {
        state.commandHistory = nextHistory;
        saveCommandHistory(nextHistory);
        dispatchCommandHistoryUpdated(nextHistory);
      }
      return true;
    } catch (error) {
      console.debug("Feature catalog unavailable:", error);
      return false;
    }
  }

  function clearFeatureCatalogRetry() {
    if (!state.featureCatalogRetryTimer) return;
    clearTimeout(state.featureCatalogRetryTimer);
    state.featureCatalogRetryTimer = null;
  }

  function isCommandHistoryEntryAvailable(entry: CommandHistoryEntry) {
    if (entry.code.startsWith("url:")) return Boolean(urlFromQuickOpenCode(entry.code));
    if (entry.code.startsWith("local-app:")) return true;
    if (entry.code.startsWith("system:") || entry.code.startsWith("local:") || entry.code.startsWith("web:")) {
      return Boolean(ports.aliasTargetForCode(entry.code));
    }
    return state.availableFeatureIdentities.has(JSON.stringify([entry.plugin_id, entry.code]));
  }

  function systemResultsForQuery(value: string): SearchResult[] {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return [];
    const forceSystem = normalized.startsWith(">");
    const queryText = forceSystem ? normalized.slice(1).trim() : normalized;
    if (forceSystem && !queryText) {
      return LAUNCHER_SYSTEM_SEARCH_ACTIONS.map((action, index) => ({
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
    return sortSearchMatches(LAUNCHER_SYSTEM_SEARCH_ACTIONS
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




  return {
    localResultsForQuery,
    availableCommandHistory,
    recommendedCommandsForHome,
    refreshFeatureCatalog,
    clearFeatureCatalogRetry,
    isCommandHistoryEntryAvailable,
    systemResultsForQuery,
  };
}
