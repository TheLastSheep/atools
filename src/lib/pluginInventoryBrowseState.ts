export type PluginInventoryStatusFilter = "all" | "enabled" | "disabled";
export type PluginInventorySourceFilter = "all" | "builtin" | "imported";

export type PluginInventoryBrowseState = {
  status: PluginInventoryStatusFilter;
  source: PluginInventorySourceFilter;
  page: number;
};

export function createPluginInventoryBrowseState(): PluginInventoryBrowseState {
  return { status: "all", source: "all", page: 1 };
}

export function pluginInventoryFilterKey(
  query: string,
  status: PluginInventoryStatusFilter,
  source: PluginInventorySourceFilter,
): string {
  return JSON.stringify([query, status, source]);
}

export function clampPluginInventoryPage(page: number, pageCount: number): number {
  const lastPage = Math.max(1, Math.floor(pageCount));
  return Math.min(lastPage, Math.max(1, Math.floor(page) || 1));
}
