import type { RecommendedCommand } from "./uiState";
import { resultFallbackIconForCode, type ResultFallbackIcon } from "./resultIcons";

export type HomeCommandSectionId = "pinned" | "recent";

export type HomeCommandSection = {
  id: HomeCommandSectionId;
  label: string;
  commands: RecommendedCommand[];
};

export type HomeCommandSectionView = HomeCommandSection & {
  total: number;
  canExpand: boolean;
  expanded: boolean;
};

export type HomeCommandSectionOptions = {
  pinnedRows: number;
  recentRows: number;
  expandedSections?: readonly HomeCommandSectionId[];
};

export type HomeCommandStatus = {
  title: string;
  detail: string;
  selectedLabel: string;
};

export function homeCommandSections(
  commands: RecommendedCommand[],
  options: HomeCommandSectionOptions,
): HomeCommandSectionView[] {
  const pinnedLimit = rowLimit(options.pinnedRows);
  const recentLimit = rowLimit(options.recentRows);
  const expanded = new Set(options.expandedSections ?? []);
  const pinned = commands.filter((command) => command.source === "pinned");
  const recent = commands.filter((command) => command.source !== "pinned");
  const sections: HomeCommandSectionView[] = [];
  if (pinned.length > 0) {
    sections.push(sectionFor("pinned", "固定", pinned, pinnedLimit, expanded.has("pinned")));
  }
  if (recent.length > 0 || pinned.length === 0) {
    sections.push(sectionFor("recent", "最近使用", recent, recentLimit, expanded.has("recent")));
  }
  return sections;
}

export function homeCommandStatus(
  commands: RecommendedCommand[],
  selectedIndex: number,
  options: HomeCommandSectionOptions,
): HomeCommandStatus {
  return homeCommandStatusForSections(homeCommandSections(commands, options), selectedIndex);
}

export function homeCommandStatusForSections(
  sections: HomeCommandSection[],
  selectedIndex: number,
): HomeCommandStatus {
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

export function selectedHomeCommandIndexAfterSectionChange(
  currentSections: HomeCommandSection[],
  nextSections: HomeCommandSection[],
  selectedIndex: number,
): number {
  const currentCommands = currentSections.flatMap(section => section.commands);
  const nextCommands = nextSections.flatMap(section => section.commands);
  const selected = currentCommands[selectedIndex];
  if (!selected) return clampIndex(selectedIndex, nextCommands.length);

  const sameCommand = (candidate: RecommendedCommand) => candidate.code === selected.code
    && candidate.plugin_id === selected.plugin_id && candidate.panel === selected.panel;
  const retainedIndex = nextCommands.findIndex(sameCommand);
  if (retainedIndex >= 0) return retainedIndex;

  let currentOffset = 0;
  const selectedSection = currentSections.find(section => {
    const containsSelection = selectedIndex >= currentOffset && selectedIndex < currentOffset + section.commands.length;
    currentOffset += section.commands.length;
    return containsSelection;
  });
  const fallbackSection = nextSections.find(section => section.id === selectedSection?.id);
  if (!fallbackSection?.commands.length) return clampIndex(selectedIndex, nextCommands.length);

  let nextOffset = 0;
  for (const section of nextSections) {
    if (section.id === fallbackSection.id) return nextOffset + section.commands.length - 1;
    nextOffset += section.commands.length;
  }
  return clampIndex(selectedIndex, nextCommands.length);
}

export function homeCommandFallbackIcon(command: RecommendedCommand): ResultFallbackIcon {
  if (command.panel) return resultFallbackIconForCode(`system:${command.panel}`);
  return resultFallbackIconForCode(command.code);
}

function rowLimit(rows: number): number {
  return Math.max(1, Math.min(4, rows)) * 9;
}

function sectionFor(
  id: HomeCommandSectionId,
  label: string,
  commands: RecommendedCommand[],
  limit: number,
  requestedExpanded: boolean,
): HomeCommandSectionView {
  const canExpand = commands.length > limit;
  const expanded = canExpand && requestedExpanded;
  return {
    id,
    label,
    commands: expanded ? commands : commands.slice(0, limit),
    total: commands.length,
    canExpand,
    expanded,
  };
}

function clampIndex(index: number, commandCount: number): number {
  if (commandCount === 0) return 0;
  return Math.max(0, Math.min(commandCount - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
}
