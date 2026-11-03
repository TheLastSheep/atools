import type { AppShortcutTargetMatch } from "./appShortcutRuntime";
import { appShortcutTargetFromKeyboardEvent } from "./appShortcutRuntime";
import { findHistoryEntry, resolveHistoryOwner } from "./commandHistoryIdentity";
import {
  commandHistoryPayloadFromCode, dispatchCommandHistoryUpdated, recordCommandUse,
  saveCommandHistory,
  type CommandHistoryEntry,
} from "./commandHistory";
import {
  commandAliasPayloadFromCode, type CommandAliasTarget,
} from "./commandAliases";
import { type RecommendedCommand } from "./uiState";
import { launcherSystemSearchActionByCode } from "./launcherSystemSearchActions";
import { localLaunchEntryByCode, type LocalLaunchEntry } from "./localLaunch";
import { buildWebQuickOpenUrl, webQuickOpenEntryByCode, type WebQuickOpenEntry } from "./webQuickOpen";
import { urlFromQuickOpenCode } from "./urlQuickOpen";
import type { PastedItem } from "./pasteIntake";
import type { FeatureAction, SearchResult } from "./types";
import type { LauncherMediaInput } from "./launcherMediaContext";
import type { AToolsSettings } from "./settings";
import type { LauncherPinsContext, LauncherPinSnapshot } from "./launcherPins";
import { isEditableKeyboardTarget, isMainSearchKeyboardTarget } from "./keyboardTarget";
import type { LauncherPendingPluginActivationStore, PendingAwareResultSelect } from "./launcherPendingPluginActivation.svelte";

interface ResultActionState {
  query: string;
  activePlugin: FeatureAction | null;
  commandHistory: CommandHistoryEntry[];
  pluginActivationError: string;
  localLaunchEntries: LocalLaunchEntry[];
  webQuickOpenEntries: WebQuickOpenEntry[];
  featureCatalog: SearchResult[];
  pinnedCommandCodes: string[];
  pinnedSnapshots: LauncherPinSnapshot[];
  pinnedCatalogReady: boolean;
  appSettings: AToolsSettings;
  pastedItems: PastedItem[];
  selectedRecentIndex: number;
  searchRunId: number;
}

interface ResultActionPorts {
  state: ResultActionState;
  pendingPluginActivation: LauncherPendingPluginActivationStore;
  activateFeature: (code: string, payload?: unknown, options?: {
    expectedPluginId?: string; textContent?: string; mediaContent?: LauncherMediaInput;
    isCancelled?: () => boolean; onOwnerValidated?: () => void; onCommitted?: () => void;
    pendingPluginActivation?: import("./launcherPendingPluginActivation.svelte").PendingPluginActivation;
  }) => Promise<unknown>;
  expectedLauncherPluginId: (target: CommandAliasTarget | null) => string | undefined;
  activateTextQuickAction: (item: SearchResult) => Promise<void>;
  activatePastedResult: (item: SearchResult) => Promise<void>;
  scheduleAutoClearSearch: () => void;
  focusSearch: () => void;
  hasTauriRuntime: () => boolean;
  openLocalLaunchEntry: (entry: LocalLaunchEntry) => Promise<void>;
  openLocalAppPath: (path: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  platform: () => string;
  getResults: () => SearchResult[];
  ownsMainPush: (code: string) => boolean;
  selectMainPush: (code: string) => Promise<void>;
  getContentContext: (item: SearchResult) =>
    | { kind: "media"; value: LauncherMediaInput; isCancelled: () => boolean }
    | { kind: "text"; value: string; accepts: boolean; isCancelled: () => boolean }
    | { kind: "none" };
  captureReturnContext: (index: number) => { searchRunAtSelection: number; context: ReturnType<typeof import("./launcherReturnContext").createLauncherReturnContextSnapshot> | null };
  captureReturnContextIfCurrent: (context: ReturnActionContext, item: SearchResult) => void;
  pinnedLauncherCommands: (context: LauncherPinsContext) => RecommendedCommand[];
  reconcileLauncherPins: (context: LauncherPinsContext) => { codes: string[]; snapshots: LauncherPinSnapshot[] };
  persistLauncherPins: (result: { codes: string[]; snapshots: LauncherPinSnapshot[] }) => void;
}

type ReturnActionContext = ReturnType<ResultActionPorts["captureReturnContext"]>;

export function createLauncherResultActionsController(ports: ResultActionPorts) {
  const state = ports.state;

  async function activateWebQuickOpen(item: SearchResult, sourceQuery = state.query) {
    const entry = webQuickOpenEntryByCode(item.code, state.webQuickOpenEntries);
    if (!entry) return;
    const input = sourceQuery.trim();
    const queryText = input.toLowerCase().startsWith(entry.keyword.toLowerCase())
      ? input.slice(entry.keyword.length).trim() : "";
    await ports.openUrl(buildWebQuickOpenUrl(entry, queryText));
    ports.scheduleAutoClearSearch();
  }

  async function activateLocalLaunch(item: SearchResult) {
    const entry = localLaunchEntryByCode(item.code, state.localLaunchEntries);
    if (entry) await ports.openLocalLaunchEntry(entry);
  }

  async function activateLocalApp(item: SearchResult) {
    await ports.openLocalAppPath(item.code.slice("local-app:".length) || item.explain);
  }

  async function activateUrlQuickOpen(item: SearchResult) {
    const url = urlFromQuickOpenCode(item.code) ?? item.explain;
    if (!url) return;
    await ports.openUrl(url);
    ports.scheduleAutoClearSearch();
  }

  function historyEntryToSearchResult(entry: CommandHistoryEntry): SearchResult {
    return { code: entry.code, plugin_id: entry.plugin_id, plugin_name: entry.plugin_name,
      label: entry.label, icon: entry.icon || null, explain: entry.explain, score: 90, match_type: "exact" };
  }

  function fallbackHistoryResult(payload: { code: string; input: string }): SearchResult {
    return { code: payload.code, plugin_id: "command-history", plugin_name: "最近使用",
      label: payload.input || payload.code, icon: null, explain: payload.input, score: 90, match_type: "exact" };
  }

  function rememberCommandResult(result: SearchResult, input: string) {
    const nextHistory = recordCommandUse(state.commandHistory, result, input);
    if (nextHistory.length === state.commandHistory.length && nextHistory.every((entry, index) => entry === state.commandHistory[index])) return;
    state.commandHistory = nextHistory;
    saveCommandHistory(nextHistory);
    dispatchCommandHistoryUpdated(nextHistory);
  }

  async function activateHistoryPayload(payload: { code: string; input: string; plugin_id?: string }, selectedIndex?: number) {
    let entry = findHistoryEntry(state.commandHistory, payload.code, payload.plugin_id);
    const nonPluginCode = /^(web:|local:|local-app:|system:|url:|text:|paste-clipboard$|clipboard$)/.test(payload.code);
    const reservedShortcutCode = payload.code.startsWith("system:") || payload.code === "paste-clipboard" || payload.code === "clipboard";
    let expectedPluginId: string | undefined;
    if (!nonPluginCode || (reservedShortcutCode && payload.plugin_id !== undefined)) {
      const owner = resolveHistoryOwner(payload, state.commandHistory, state.featureCatalog);
      if (owner.status !== "resolved") {
        state.pluginActivationError = owner.status === "ambiguous"
          ? "此历史功能存在多个来源，请从当前搜索结果中选择。"
          : "此历史功能已不可用，请启用对应插件后重试。";
        return;
      }
      expectedPluginId = reservedShortcutCode
        ? ports.expectedLauncherPluginId({ code: payload.code, label: entry?.label ?? payload.code, explain: entry?.explain ?? payload.input, plugin_id: owner.plugin_id, plugin_name: entry?.plugin_name ?? owner.plugin_id })
        : owner.plugin_id;
      if (expectedPluginId) entry = findHistoryEntry(state.commandHistory, payload.code, expectedPluginId);
    }
    const rememberExactEntry = () => {
      if (entry) rememberCommandResult(historyEntryToSearchResult(entry), payload.input || entry.input);
    };
    if (reservedShortcutCode && expectedPluginId) {
      const activationEntry = entry;
      const returnContext = selectedIndex === undefined ? null : ports.captureReturnContext(selectedIndex);
      const searchRunId = state.searchRunId;
      const pendingAttempt = ports.pendingPluginActivation.begin({
        pluginId: expectedPluginId, code: payload.code, label: activationEntry?.label ?? payload.code,
        query: state.query, searchRunId,
      });
      await ports.activateFeature(payload.code, null, {
        expectedPluginId, pendingPluginActivation: pendingAttempt,
        isCancelled: () => state.searchRunId !== searchRunId || !ports.pendingPluginActivation.isCurrent(pendingAttempt),
        onOwnerValidated: rememberExactEntry,
        onCommitted: () => {
          if (returnContext && activationEntry) {
            ports.captureReturnContextIfCurrent(returnContext, historyEntryToSearchResult(activationEntry));
          }
        },
      });
      return;
    }
    if (payload.code.startsWith("web:")) {
      rememberExactEntry();
      await activateWebQuickOpen({ ...(entry ? historyEntryToSearchResult(entry) : fallbackHistoryResult(payload)), code: payload.code }, payload.input);
    } else if (payload.code.startsWith("local:") || (payload.code.startsWith("system:") && !expectedPluginId)) {
      rememberExactEntry();
      await ports.activateFeature(payload.code);
    } else if (payload.code.startsWith("local-app:")) {
      rememberExactEntry();
      await ports.openLocalAppPath(payload.code.slice("local-app:".length));
    } else if (payload.code.startsWith("url:")) {
      rememberExactEntry();
      const url = urlFromQuickOpenCode(payload.code);
      if (url) { await ports.openUrl(url); ports.scheduleAutoClearSearch(); }
    } else {
      await ports.activateFeature(payload.code, null, { expectedPluginId, onOwnerValidated: rememberExactEntry });
    }
  }

  function aliasTargetForCode(code: string): CommandAliasTarget | null {
    if (code.startsWith("system:")) {
      const action = launcherSystemSearchActionByCode(code);
      return action ? { code, label: action.label, explain: action.description, plugin_id: "system", plugin_name: "ATools" } : null;
    }
    if (code.startsWith("local:")) {
      const entry = localLaunchEntryByCode(code, state.localLaunchEntries);
      return entry ? { code, label: `打开 ${entry.name}`, explain: `${entry.kind} · ${entry.path}`, plugin_id: "local-launch", plugin_name: "本地启动" } : null;
    }
    if (code.startsWith("web:")) {
      const entry = webQuickOpenEntryByCode(code, state.webQuickOpenEntries);
      return entry ? { code, label: entry.name, explain: `输入 ${entry.keyword} 关键词快速打开`, plugin_id: "web-quick-open", plugin_name: "网页快开" } : null;
    }
    if (code.startsWith("url:")) {
      const url = urlFromQuickOpenCode(code);
      return url ? { code, label: `打开链接 ${url}`, explain: url, plugin_id: "url-quick-open", plugin_name: "链接快开" } : null;
    }
    return null;
  }

  function aliasTargetToSearchResult(target: CommandAliasTarget): SearchResult {
    return { code: target.code, plugin_id: target.plugin_id, plugin_name: target.plugin_name,
      label: target.label, icon: null, explain: target.explain, score: 90, match_type: "alias" };
  }

  async function activateHistoryCommand(item: SearchResult, selectedIndex?: number) {
    const payload = commandHistoryPayloadFromCode(item.code);
    if (payload) await activateHistoryPayload(payload, selectedIndex);
  }

  async function activateCommandAlias(item: SearchResult) {
    const payload = commandAliasPayloadFromCode(item.code);
    if (!payload) return;
    const target = aliasTargetForCode(payload.targetCode);
    if (target) rememberCommandResult(aliasTargetToSearchResult(target), payload.alias || state.query);
    await ports.activateFeature(payload.targetCode, null, { expectedPluginId: ports.expectedLauncherPluginId(target) });
  }

  async function onSelect(index: number) {
    const item = ports.getResults()[index];
    if (!item) return;
    const context = ports.getContentContext(item);
    const isMainPush = ports.ownsMainPush(item.code);
    const reservedShortcutCode = item.code.startsWith("system:") || item.code === "paste-clipboard" || item.code === "clipboard";
    const expectedReservedPluginId = reservedShortcutCode ? ports.expectedLauncherPluginId(item) : undefined;
    const pending = ports.pendingPluginActivation.current;
    const isPlainPluginOpen = context.kind === "none" && !item.code.startsWith("history:") && !item.code.startsWith("alias:")
      && (!reservedShortcutCode || Boolean(expectedReservedPluginId))
      && !isMainPush
      && !/^(web:|local:|local-app:|paste:|url:|text:)/.test(item.code);
    if (isPlainPluginOpen && pending?.pluginId === item.plugin_id && pending.code === item.code
      && pending.query === state.query && pending.searchRunId === state.searchRunId) return;
    ports.pendingPluginActivation.cancel();
    if (isMainPush) { await ports.selectMainPush(item.code); return; }
    if (context.kind === "media") {
      if (item.plugin_id === "paste" && item.code.startsWith("paste:") && item.match_type !== "files" && item.match_type !== "img") {
        await ports.activatePastedResult(item); return;
      }
      await ports.activateFeature(item.code, null, { expectedPluginId: item.plugin_id,
        mediaContent: context.value, isCancelled: context.isCancelled });
      return;
    }
    if (context.kind === "text") {
      if (!context.accepts) return;
      await ports.activateFeature(item.code, context.value, { expectedPluginId: item.plugin_id,
        textContent: context.value, isCancelled: context.isCancelled });
      return;
    }
    const input = state.query;
    if (item.code.startsWith("history:")) return await activateHistoryCommand(item, index);
    if (item.code.startsWith("alias:")) return await activateCommandAlias(item);
    if (reservedShortcutCode && !expectedReservedPluginId) {
      rememberCommandResult(item, input); await ports.activateFeature(item.code); return;
    }
    if (item.code.startsWith("web:")) { rememberCommandResult(item, input); await activateWebQuickOpen(item); return; }
    if (item.code.startsWith("local:")) { rememberCommandResult(item, input); await activateLocalLaunch(item); return; }
    if (item.code.startsWith("local-app:")) { rememberCommandResult(item, input); await activateLocalApp(item); return; }
    if (item.code.startsWith("paste:")) { rememberCommandResult(item, input); await ports.activatePastedResult(item); return; }
    if (item.code.startsWith("url:")) { rememberCommandResult(item, input); await activateUrlQuickOpen(item); return; }
    if (item.code.startsWith("text:")) { rememberCommandResult(item, input); await ports.activateTextQuickAction(item); return; }
    const returnContext = ports.captureReturnContext(index);
    const searchRunId = state.searchRunId;
    const pendingAttempt = ports.pendingPluginActivation.begin({
      pluginId: item.plugin_id,
      code: item.code,
      label: item.label,
      query: input,
      searchRunId,
    });
    await ports.activateFeature(item.code, null, {
      expectedPluginId: item.plugin_id,
      pendingPluginActivation: pendingAttempt,
      isCancelled: () => state.searchRunId !== searchRunId || !ports.pendingPluginActivation.isCurrent(pendingAttempt),
      onOwnerValidated: () => rememberCommandResult(item, input),
      onCommitted: () => ports.captureReturnContextIfCurrent(returnContext, item),
    });
  }

  function pinnedCommandOptions() { return ports.pinnedLauncherCommands(launcherPinsContext()); }
  function launcherPinsContext() {
    return { codes: state.pinnedCommandCodes, catalog: state.featureCatalog, snapshots: state.pinnedSnapshots,
      catalogReady: state.pinnedCatalogReady, resolveLocal: aliasTargetForCode };
  }
  function syncPinnedCommands() {
    const next = ports.reconcileLauncherPins(launcherPinsContext());
    state.pinnedCommandCodes = next.codes; state.pinnedSnapshots = next.snapshots;
    ports.persistLauncherPins(next);
  }

  function hotkeyPlatform() {
    const platform = ports.platform().toLowerCase();
    return platform.includes("mac") ? "mac" : platform.includes("win") ? "windows" : "linux";
  }
  function availableAppShortcutTargetCodes() {
    return state.appSettings.appShortcuts.map(entry => entry.targetCode)
      .filter((code, index, codes) => codes.indexOf(code) === index)
      .filter(code => Boolean(aliasTargetForCode(code)));
  }
  function maybeActivateAppShortcut(event: KeyboardEvent) {
    if (state.activePlugin !== null) return false;
    const match = appShortcutTargetFromKeyboardEvent(event, state.appSettings.appShortcuts, {
      platform: hotkeyPlatform(), availableTargetCodes: availableAppShortcutTargetCodes(),
      editableTarget: isEditableKeyboardTarget(event.target) && !isMainSearchKeyboardTarget(event.target),
    });
    if (!match) return false;
    event.preventDefault(); event.stopPropagation(); void activateAppShortcut(match); return true;
  }
  async function activateAppShortcut(match: AppShortcutTargetMatch) {
    const target = aliasTargetForCode(match.targetCode);
    if (target) rememberCommandResult(aliasTargetToSearchResult(target), match.shortcut);
    await ports.activateFeature(match.targetCode, null, { expectedPluginId: ports.expectedLauncherPluginId(target) });
    ports.focusSearch();
  }

  Object.defineProperty(onSelect, "pendingPluginActivation", {
    get: () => ports.pendingPluginActivation.current,
  });
  return { onSelect: onSelect as PendingAwareResultSelect, aliasTargetForCode, aliasTargetToSearchResult, rememberCommandResult,
    activateHistoryPayload, pinnedCommandOptions, launcherPinsContext, syncPinnedCommands,
    maybeActivateAppShortcut };
}
