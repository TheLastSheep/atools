import type { RecommendedCommand } from "./uiState";
import { resultFallbackIconForCode, type ResultFallbackIcon } from "./resultIcons";

export type HomeSurfaceSection = "quick-actions" | "recent";

export type HomeCommandSectionId = "pinned" | "recent";

export type HomeCommandSection = {
  id: HomeCommandSectionId;
  label: string;
  commands: RecommendedCommand[];
  empty?: boolean;
  emptyActionLabel?: string;
};

export type HomeCommandStatus = {
  title: string;
  detail: string;
  selectedLabel: string;
};

export type HomeSearchOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "primary" | "normal" | "muted";
};

export type HomeSearchOverviewOptions = {
  pinnedRows: number;
  recentRows: number;
  localAppSearch: boolean;
  localLaunchSearch: boolean;
  commandAliasCount?: number;
  localLaunchCount?: number;
  webQuickOpenCount?: number;
};

export type HomeQuickAction = RecommendedCommand & {
  panel: NonNullable<RecommendedCommand["panel"]>;
  tone: "primary" | "normal";
  icon: "download" | "plugins" | "agent" | "settings";
  ariaLabel: string;
};

const QUICK_ACTIONS: HomeQuickAction[] = [
  {
    code: "home:import-ztools",
    label: "导入 ZTools 插件",
    explain: "导入",
    panel: "import",
    source: "recommended",
    tone: "primary",
    icon: "download",
    ariaLabel: "打开导入 ZTools 插件",
  },
  {
    code: "home:plugin-manager",
    label: "插件管理",
    explain: "管理",
    panel: "plugins",
    source: "recommended",
    tone: "normal",
    icon: "plugins",
    ariaLabel: "打开插件管理",
  },
  {
    code: "home:agent-mcp",
    label: "Agent / MCP",
    explain: "Agent",
    panel: "agent",
    source: "recommended",
    tone: "normal",
    icon: "agent",
    ariaLabel: "打开Agent / MCP",
  },
  {
    code: "home:settings",
    label: "设置",
    explain: "设置",
    panel: "settings",
    source: "recommended",
    tone: "normal",
    icon: "settings",
    ariaLabel: "打开设置",
  },
];

export function homeQuickActions(): HomeQuickAction[] {
  return QUICK_ACTIONS.map((action) => ({ ...action }));
}

export function homeSurfaceSections(options: {
  recentCount: number;
  showQuickActions: boolean;
}): HomeSurfaceSection[] {
  const sections: HomeSurfaceSection[] = [];
  if (options.showQuickActions) sections.push("quick-actions");
  sections.push("recent");
  return sections;
}

export function homeSearchOverviewCards(
  commands: RecommendedCommand[],
  options: HomeSearchOverviewOptions,
): HomeSearchOverviewCard[] {
  const sections = homeCommandSections(commands, options);
  const pinnedCount = sections.find((section) => section.id === "pinned")?.commands.length ?? 0;
  const recentCount = sections.find((section) => section.id === "recent")?.commands.filter((command) => command.source === "history").length ?? 0;
  const aliasCount = Math.max(0, options.commandAliasCount ?? 0);
  const localLaunchCount = Math.max(0, options.localLaunchCount ?? 0);
  const webQuickOpenCount = Math.max(0, options.webQuickOpenCount ?? 0);
  const sourceLabels = [
    "内置",
    "文本",
    "最近",
    ...(aliasCount > 0 ? [`别名 ${aliasCount}`] : []),
    ...(options.localLaunchSearch ? [`本地启动 ${localLaunchCount}`] : []),
    ...(webQuickOpenCount > 0 ? [`网页快开 ${webQuickOpenCount}`] : []),
    ...(options.localAppSearch ? ["本地应用"] : []),
  ];

  return [
    {
      label: "可搜来源",
      value: `${sourceLabels.length} 类`,
      detail: compactSourceDetail(sourceLabels),
      tone: "primary",
    },
    {
      label: "固定指令",
      value: `${pinnedCount} 项`,
      detail: `固定栏 ${rowLimit(options.pinnedRows) / 9} 行，优先展示`,
      tone: pinnedCount > 0 ? "normal" : "muted",
    },
    {
      label: "最近历史",
      value: `${recentCount} 项`,
      detail: recentCount > 0 ? "键盘方向键可直接选择" : "首次使用时显示推荐指令",
      tone: recentCount > 0 ? "normal" : "muted",
    },
    {
      label: "首屏入口",
      value: `${QUICK_ACTIONS.length} 个`,
      detail: "导入 / 插件 / Agent / 设置",
      tone: "normal",
    },
  ];
}

export function homeCommandSections(
  commands: RecommendedCommand[],
  options: {
    pinnedRows: number;
    recentRows: number;
    showPinnedEmpty?: boolean;
  },
): HomeCommandSection[] {
  const pinnedLimit = rowLimit(options.pinnedRows);
  const recentLimit = rowLimit(options.recentRows);
  const pinned = commands.filter((command) => command.source === "pinned").slice(0, pinnedLimit);
  const recent = commands.filter((command) => command.source !== "pinned").slice(0, recentLimit);
  const sections: HomeCommandSection[] = [];
  if (pinned.length > 0) {
    sections.push({ id: "pinned", label: "固定", commands: pinned, empty: false });
  } else if (options.showPinnedEmpty) {
    sections.push({
      id: "pinned",
      label: "固定",
      commands: [],
      empty: true,
      emptyActionLabel: "管理固定指令",
    });
  }
  sections.push({ id: "recent", label: "最近使用", commands: recent, empty: false });
  return sections;
}

export function homeCommandStatus(
  commands: RecommendedCommand[],
  selectedIndex: number,
  options: {
    pinnedRows: number;
    recentRows: number;
  },
): HomeCommandStatus {
  const sections = homeCommandSections(commands, options);
  const normalizedIndex = Math.max(0, selectedIndex);
  let offset = 0;
  for (const section of sections) {
    const sectionCount = section.commands.length;
    if (normalizedIndex < offset + sectionCount) {
      const sectionIndex = normalizedIndex - offset;
      const selected = section.commands[sectionIndex];
      const selectedLabel = selected?.label ?? "";
      return {
        title: section.label,
        detail: sectionCount > 0
          ? `${sectionIndex + 1} / ${sectionCount}${selectedLabel ? ` · ${selectedLabel}` : ""}`
          : "0 项最近使用",
        selectedLabel,
      };
    }
    offset += sectionCount;
  }

  return {
    title: "最近使用",
    detail: "0 项最近使用",
    selectedLabel: "",
  };
}

export function homeCommandFallbackIcon(command: RecommendedCommand): ResultFallbackIcon {
  if (command.panel || command.code.startsWith("system:")) return "system";
  return resultFallbackIconForCode(command.code);
}

function rowLimit(rows: number): number {
  return Math.max(1, Math.min(4, rows)) * 9;
}

function compactSourceDetail(sourceLabels: string[]): string {
  const priority = sourceLabels.filter((label) => label !== "最近" && label !== "本地应用");
  const detail = priority.join("/");
  return detail.length <= 28 ? detail : priority.slice(0, 4).join("/");
}
