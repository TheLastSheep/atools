import { resultGroupKey } from "./resultPresentation";
import type { RecommendedCommand, ShellPanel } from "./uiState";
import type { FeatureAction, SearchResult } from "./types";

export const LAUNCHER_LAYOUT = {
  fallbackWindowHeight: 600, settingsWindowHeight: 600, agentWindowHeight: 760,
  searchOnlyWindowHeight: 72, shellBorderHeight: 2, searchBarHeight: 58,
  homeMinWindowHeight: 280, homePanelVerticalPadding: 22, homeContentBorderHeight: 1,
  homeCapabilityRailHeight: 53, homeSectionHeaderHeight: 22, homeSectionGap: 6, recentGridColumns: 9,
  recentTileHeight: 86, recentRowGap: 0, resultsMinHeight: 112, resultsMaxHeight: 420,
  resultsVerticalPadding: 12, searchStatusBarHeight: 34, resultRowHeight: 54,
  resultGroupHeaderHeight: 24, resultGroupGap: 4,
} as const;

export interface LauncherLayoutState {
  activePlugin: FeatureAction | null;
  activePanel: ShellPanel;
  pluginLifecycleNotice: unknown;
  showQueryResults: boolean;
  showHomeRecent: boolean;
  showTabTargetStatus: boolean;
  queryResultsWindowHeight: number;
  homeRecentWindowHeight: number;
  defaultWindowHeight: number;
}

export function getShellContentHeight(state: LauncherLayoutState) {
  if (state.activePlugin) return state.activePlugin.expand_height;
  if (state.activePanel === "agent") return LAUNCHER_LAYOUT.agentWindowHeight;
  if (state.activePanel === "settings" || state.activePanel === "plugins") return LAUNCHER_LAYOUT.settingsWindowHeight;
  if (state.activePanel !== "home") return state.defaultWindowHeight;
  if (state.showQueryResults) return state.queryResultsWindowHeight;
  if (state.showHomeRecent) return state.homeRecentWindowHeight;
  if (state.showTabTargetStatus) return LAUNCHER_LAYOUT.searchOnlyWindowHeight + LAUNCHER_LAYOUT.searchStatusBarHeight;
  return LAUNCHER_LAYOUT.searchOnlyWindowHeight;
}

export function getShellHeight(state: LauncherLayoutState) {
  return getShellContentHeight(state) + (state.pluginLifecycleNotice ? 52 : 0);
}

export function homeCommandRowCapacity(rows: number) {
  return Math.max(1, Math.min(4, rows)) * LAUNCHER_LAYOUT.recentGridColumns;
}

export function homeWindowHeightFor(commands: RecommendedCommand[]) {
  const { recentGridColumns: columns } = LAUNCHER_LAYOUT;
  let pinnedCount = 0;
  let recentCount = 0;
  for (const command of commands) {
    if (command.source === "pinned") pinnedCount += 1;
    else recentCount += 1;
  }
  const pinnedRows = pinnedCount ? Math.ceil(pinnedCount / columns) : 0;
  const recentRows = recentCount ? Math.ceil(recentCount / columns) : 0;
  const rows = pinnedRows + recentRows;
  const sections = Number(pinnedCount > 0) + Number(recentCount > 0);
  const measured = LAUNCHER_LAYOUT.searchBarHeight + LAUNCHER_LAYOUT.homePanelVerticalPadding
    + LAUNCHER_LAYOUT.homeCapabilityRailHeight
    + sections * LAUNCHER_LAYOUT.homeSectionHeaderHeight + Math.max(0, sections - 1) * LAUNCHER_LAYOUT.homeSectionGap
    + rows * LAUNCHER_LAYOUT.recentTileHeight + Math.max(0, rows - 1) * LAUNCHER_LAYOUT.recentRowGap
    + LAUNCHER_LAYOUT.searchStatusBarHeight + LAUNCHER_LAYOUT.shellBorderHeight
    + LAUNCHER_LAYOUT.homeContentBorderHeight;
  return Math.max(LAUNCHER_LAYOUT.homeMinWindowHeight, measured);
}

export function resultGroupCount(items: SearchResult[]) {
  if (!items.length) return 1;
  return new Set(items.map(resultGroupKey)).size;
}

export function resultsWindowHeightFor(items: SearchResult[]) {
  const groups = resultGroupCount(items);
  const listHeight = Math.min(LAUNCHER_LAYOUT.resultsMaxHeight, Math.max(LAUNCHER_LAYOUT.resultsMinHeight,
    LAUNCHER_LAYOUT.resultsVerticalPadding + items.length * LAUNCHER_LAYOUT.resultRowHeight
    + groups * LAUNCHER_LAYOUT.resultGroupHeaderHeight + Math.max(0, groups - 1) * LAUNCHER_LAYOUT.resultGroupGap));
  return LAUNCHER_LAYOUT.searchBarHeight + listHeight + LAUNCHER_LAYOUT.searchStatusBarHeight + LAUNCHER_LAYOUT.shellBorderHeight;
}

export function textQuickActionKind(code: string) {
  try {
    const payload = JSON.parse(decodeURIComponent(code.slice("text:".length))) as { kind?: unknown };
    return typeof payload.kind === "string" ? payload.kind : "";
  } catch { return ""; }
}

export function resultActionLabel(result: SearchResult | null) {
  if (!result) return "";
  const code = result.code;
  if (["web:", "url:", "local:", "local-app:"].some(prefix => code.startsWith(prefix))) return "打开";
  if (code.startsWith("text:")) {
    const kind = textQuickActionKind(code);
    return kind === "path-open" ? "打开" : kind === "path-reveal" ? "定位" : "复制";
  }
  if (code.startsWith("paste:open:")) return "打开";
  if (code.startsWith("paste:reveal:")) return "定位";
  return code.startsWith("paste:") ? "处理" : "执行";
}
