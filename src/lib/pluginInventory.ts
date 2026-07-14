import type { InstalledPlugin } from "./types";

export type PluginInventoryRow = {
  id: string;
  name: string;
  versionLabel: string;
  description: string;
  path: string;
  enabled: boolean;
  sourceLabel: "内置" | "导入";
  featureCount: number;
  featurePreview: string;
  searchText: string;
  hasMoreFeatures: boolean;
  updatedAt: string;
};

export type PluginInventoryFeature = {
  code: string;
  label: string;
  explain: string;
};

export type PluginInventoryPermissionRow = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "danger";
};

export type PluginInventoryAction = {
  label: string;
  available: boolean;
  reason: string;
};

export type PluginInventoryOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "desktop";
};

export type PluginInventoryDetail = {
  id: string;
  title: string;
  statusLabel: string;
  versionLabel: string;
  sourceLabel: "内置" | "导入";
  description: string;
  path: string;
  updatedAt: string;
  features: PluginInventoryFeature[];
  permissionRows: PluginInventoryPermissionRow[];
  actions: PluginInventoryAction[];
};

export type PluginInventory = {
  summary: {
    total: number;
    enabled: number;
    disabled: number;
    features: number;
  };
  filteredSummary: {
    total: number;
    enabled: number;
    disabled: number;
    features: number;
  };
  rows: PluginInventoryRow[];
  selectedPlugin: PluginInventoryDetail | null;
  emptyText: string;
};

export type PluginInventoryOptions = {
  selectedPluginId?: string | null;
  query?: string | null;
  status?: "all" | "enabled" | "disabled";
  source?: "all" | "builtin" | "imported";
};

export function pluginInventoryOverviewCards(input: {
  inventory: PluginInventory;
  hasTauriRuntime: boolean;
}): PluginInventoryOverviewCard[] {
  const builtinCount = input.inventory.rows.filter((row) => row.sourceLabel === "内置").length;
  const importedCount = input.inventory.rows.filter((row) => row.sourceLabel === "导入").length;
  const desktopValue = input.hasTauriRuntime ? "" : "桌面端读取";

  return [
    {
      label: "插件库存",
      value: desktopValue || `${input.inventory.summary.total} 个`,
      detail: desktopValue
        ? "已安装插件清单、路径和启用状态需在桌面应用中读取"
        : `${builtinCount} 内置 / ${importedCount} 导入；可在下方查看来源、路径和详情`,
      tone: desktopValue ? "desktop" : input.inventory.summary.total > 0 ? "ready" : "warning",
    },
    {
      label: "启用状态",
      value: desktopValue || `${input.inventory.summary.enabled} 启用 / ${input.inventory.summary.disabled} 停用`,
      detail: desktopValue
        ? "浏览器预览无法切换真实插件启用状态"
        : "已停用插件不会进入主搜索；启停操作只影响本机插件清单",
      tone: desktopValue ? "desktop" : input.inventory.summary.disabled > 0 ? "warning" : "ready",
    },
    {
      label: "Feature 指令",
      value: desktopValue || `${input.inventory.summary.features} 个`,
      detail: desktopValue
        ? "插件 feature 需从桌面运行时清单读取"
        : "Feature 会进入插件列表和所有指令页，用于搜索、别名和固定指令",
      tone: desktopValue ? "desktop" : input.inventory.summary.features > 0 ? "ready" : "warning",
    },
    {
      label: "安装入口",
      value: input.hasTauriRuntime ? "本地安装" : "桌面端安装",
      detail: input.hasTauriRuntime
        ? "可选择包含 plugin.json 的目录安装；远程 ZIP 安装/更新从插件市场目录触发；导入插件可卸载，内置插件可停用"
        : "浏览器预览不会打开目录选择器；远程 ZIP 安装/更新需在桌面插件市场中执行",
      tone: input.hasTauriRuntime ? "warning" : "desktop",
    },
  ];
}

export function pluginInventory(plugins: InstalledPlugin[], options: PluginInventoryOptions = {}): PluginInventory {
  const allRows = plugins.map(pluginInventoryRow);
  const rows = allRows.filter((row) => pluginRowMatches(row, options)).sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  const selectedRow = rows.find((row) => row.id === options.selectedPluginId) ?? rows[0] ?? null;
  const selectedPlugin = selectedRow
    ? pluginInventoryDetail(plugins.find((plugin) => plugin.id === selectedRow.id) ?? null)
    : null;

  return {
    summary: pluginInventorySummary(allRows),
    filteredSummary: pluginInventorySummary(rows),
    rows,
    selectedPlugin,
    emptyText: plugins.length === 0
      ? "暂无已安装插件，可以先使用本地导入。"
      : "没有匹配的插件，调整筛选条件后重试。",
  };
}

function pluginInventorySummary(rows: PluginInventoryRow[]) {
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.enabled).length,
    disabled: rows.filter((row) => !row.enabled).length,
    features: rows.reduce((sum, row) => sum + row.featureCount, 0),
  };
}

function pluginRowMatches(row: PluginInventoryRow, options: PluginInventoryOptions): boolean {
  const status = options.status ?? "all";
  if (status === "enabled" && !row.enabled) return false;
  if (status === "disabled" && row.enabled) return false;

  const source = options.source ?? "all";
  if (source === "builtin" && row.sourceLabel !== "内置") return false;
  if (source === "imported" && row.sourceLabel !== "导入") return false;

  const query = (options.query ?? "").trim().toLowerCase();
  if (!query) return true;
  return [
    row.id,
    row.name,
    row.versionLabel,
    row.description,
    row.path,
    row.sourceLabel,
    row.featurePreview,
    row.searchText,
  ].some((value) => value.toLowerCase().includes(query));
}

function pluginInventoryRow(plugin: InstalledPlugin): PluginInventoryRow {
  const features = plugin.manifest.features ?? [];
  const previewItems = features.slice(0, 3).map((feature) => {
    if (feature.label === "") return feature.code;
    return feature.label || feature.explain || feature.code;
  });
  return {
    id: plugin.id,
    name: plugin.name || plugin.id,
    versionLabel: plugin.version || "0.0.0",
    description: plugin.manifest.description || "暂无描述",
    path: plugin.path,
    enabled: plugin.enabled,
    sourceLabel: builtinPluginPath(plugin.path) ? "内置" : "导入",
    featureCount: features.length,
    featurePreview: previewItems.join(" / ") || "暂无 feature",
    searchText: features.map((feature) => [
      feature.code,
      feature.label ?? "",
      feature.explain,
    ].join(" ")).join(" "),
    hasMoreFeatures: features.length > previewItems.length,
    updatedAt: plugin.updated_at || plugin.created_at || "未知",
  };
}

function pluginInventoryDetail(plugin: InstalledPlugin | null): PluginInventoryDetail | null {
  if (!plugin) return null;
  const row = pluginInventoryRow(plugin);
  const imported = row.sourceLabel === "导入";
  return {
    id: row.id,
    title: row.name,
    statusLabel: row.enabled ? "已启用" : "已停用",
    versionLabel: row.versionLabel,
    sourceLabel: row.sourceLabel,
    description: row.description,
    path: row.path,
    updatedAt: row.updatedAt,
    features: (plugin.manifest.features ?? []).map((feature) => ({
      code: feature.code,
      label: feature.label || feature.explain || feature.code,
      explain: feature.explain,
    })),
    permissionRows: pluginInventoryPermissionRows(plugin, row),
    actions: [
      { label: "打开目录", available: true, reason: "在 Finder 中定位插件目录" },
      ...(!row.enabled && imported ? [{
        label: "授权启用",
        available: true,
        reason: "确认 manifest 权限后启用插件并同步 Agent tools 白名单",
      }] satisfies PluginInventoryAction[] : []),
      {
        label: "更新插件",
        available: imported,
        reason: imported
          ? "选择本地目录更新同一插件"
          : "内置插件随应用更新，不能从设置页替换",
      },
      {
        label: "卸载插件",
        available: imported,
        reason: imported
          ? "删除插件本体、指令索引和插件数据"
          : "内置插件不可卸载，可停用以隐藏指令",
      },
      { label: "插件权限", available: true, reason: "查看 manifest 声明的本地能力和 Agent tools" },
    ],
  };
}

function pluginInventoryPermissionRows(plugin: InstalledPlugin, row: PluginInventoryRow): PluginInventoryPermissionRow[] {
  const main = manifestString(plugin.manifest.main);
  const preload = manifestString(plugin.manifest.preload);
  const setting = manifestRecord(plugin.manifest.pluginSetting);
  const height = manifestNumber(setting.height);
  const single = setting.single === true;
  const entryDetails = [
    main ? `main: ${main}` : "",
    preload ? `preload: ${preload}` : "",
    height > 0 ? `窗口高度 ${height}px` : "",
    single ? "单例运行" : "",
  ].filter(Boolean);
  const entryValue = main && preload
    ? "main + preload"
    : main
      ? "main"
      : preload
        ? "preload"
        : "未声明";

  const featureCount = plugin.manifest.features?.length ?? 0;
  const commandCount = pluginFeatureCommandCount(plugin.manifest.features ?? []);
  const toolNames = pluginToolNames(plugin.manifest.tools);
  const permissions = pluginPermissionNames(plugin.manifest.permissions);

  return [
    {
      label: "运行入口",
      value: entryValue,
      detail: entryDetails.join("；") || "未声明 main/preload；可能只提供数据或 Agent 能力",
      tone: entryValue === "未声明" ? "warning" : "ready",
    },
    {
      label: "Feature 指令",
      value: `${featureCount} 个 feature / ${commandCount} 条匹配`,
      detail: "Feature 会进入主搜索和插件详情；命令匹配只来自本地 manifest",
      tone: featureCount > 0 ? "ready" : "warning",
    },
    {
      label: "Agent Tools",
      value: `${toolNames.length} 个`,
      detail: toolNames.length > 0
        ? `${toolNames.join(" / ")}；默认关闭，需在 Agent/MCP 白名单启用`
        : "未声明 Agent tools；不会进入 MCP 工具白名单",
      tone: toolNames.length > 0 ? "warning" : "normal",
    },
    {
      label: "运行时权限",
      value: permissions.length > 0 ? `${permissions.length} 项` : "未声明",
      detail: permissions.length > 0
        ? permissions.join(" / ")
        : "未声明 permissions；授权启用后敏感 bridge API 会被运行时拦截",
      tone: permissions.length > 0 ? "warning" : "danger",
    },
    {
      label: "本地数据边界",
      value: "本机插件目录",
      detail: `插件文件位于 ${row.path}；插件数据、启停状态和工具白名单只保存在本机`,
      tone: "normal",
    },
  ];
}

function manifestString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function manifestNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function manifestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function pluginFeatureCommandCount(features: NonNullable<InstalledPlugin["manifest"]["features"]>): number {
  return features.reduce((sum, feature) => {
    const cmds = (feature as { cmds?: unknown }).cmds;
    if (Array.isArray(cmds)) return sum + cmds.length;
    if (typeof cmds === "string") return sum + 1;
    return sum;
  }, 0);
}

function pluginToolNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value);
}

function pluginPermissionNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function builtinPluginPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/resources/plugins/")
    || normalized.includes("/builtin")
    || normalized.includes("/builtins/");
}
