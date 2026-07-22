import type { RecommendedCommand } from "./uiState";
import { resultFallbackIconForCode, type ResultFallbackIcon } from "./resultIcons";

export type HomeCommandSectionId = "pinned" | "recent";

export type HomeCommandSection = {
  id: HomeCommandSectionId;
  label: string;
  commands: RecommendedCommand[];
};

export type HomeCommandStatus = {
  title: string;
  detail: string;
  selectedLabel: string;
};

export function homeCommandSections(
  commands: RecommendedCommand[],
  options: {
    pinnedRows: number;
    recentRows: number;
  },
): HomeCommandSection[] {
  const pinnedLimit = rowLimit(options.pinnedRows);
  const recentLimit = rowLimit(options.recentRows);
  const pinned = commands.filter((command) => command.source === "pinned").slice(0, pinnedLimit);
  const recent = commands.filter((command) => command.source !== "pinned").slice(0, recentLimit);
  const sections: HomeCommandSection[] = [];
  if (pinned.length > 0) {
    sections.push({ id: "pinned", label: "固定", commands: pinned });
  }
  sections.push({ id: "recent", label: "最近使用", commands: recent });
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
