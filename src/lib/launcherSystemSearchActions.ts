import { SYSTEM_ACTIONS, type ShellPanel } from "./uiState";
import type { SettingsMenuId } from "./settingsPages";

export type LauncherSystemDestination =
  | { kind: "panel"; panel: ShellPanel }
  | { kind: "settings-menu"; menu: SettingsMenuId };

export type LauncherSystemSearchAction = {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  destination: LauncherSystemDestination;
};

const panelActions: LauncherSystemSearchAction[] = SYSTEM_ACTIONS.map(action => ({
  id: action.id,
  label: action.label,
  description: action.id === "settings"
    ? "打开通用设置、快捷键和本地服务"
    : action.description,
  aliases: action.aliases ?? [],
  destination: { kind: "panel", panel: action.id },
}));

export const LAUNCHER_SYSTEM_SEARCH_ACTIONS: LauncherSystemSearchAction[] = [
  ...panelActions,
  {
    id: "market",
    label: "插件市场",
    description: "搜索和安装插件",
    aliases: ["market", "marketplace"],
    destination: { kind: "settings-menu", menu: "market" },
  },
];

export function launcherSystemSearchActionByCode(code: string): LauncherSystemSearchAction | null {
  return LAUNCHER_SYSTEM_SEARCH_ACTIONS.find(action => `system:${action.id}` === code) ?? null;
}
