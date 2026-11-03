import { commandHistoryPayloadFromCode } from "./commandHistory";
import { resolveHistoryOwner } from "./commandHistoryIdentity";
import { commandAliasPayloadFromCode } from "./commandAliases";
import { dispatchPinnedCommandCodes, savePinnedCommandCodes, togglePinnedCommandCode } from "./pinnedCommands";
import { resolveLauncherPin, type LauncherPinsContext } from "./launcherPins";
import type { RecommendedCommand } from "./uiState";
import type { SearchResult } from "./types";

export type LauncherActionTarget = Pick<RecommendedCommand, "code" | "label" | "source" | "panel"> & { plugin_id?: string };
export type LauncherActionIdentity = Pick<RecommendedCommand, "code" | "label"> & {
  plugin_id?: string;
  panel?: RecommendedCommand["panel"];
};

export function launcherActionCode(item: LauncherActionIdentity): string | null {
  if (item.panel) return `system:${item.panel}`;
  if (item.code.startsWith("history:")) return commandHistoryPayloadFromCode(item.code)?.code ?? null;
  if (item.code.startsWith("alias:")) return commandAliasPayloadFromCode(item.code)?.targetCode ?? null;
  if (/^(text:|paste:)/.test(item.code)) return null;
  return item.code;
}

export function resolveLauncherAction(item: LauncherActionIdentity, context: LauncherPinsContext): SearchResult | null {
  const code = launcherActionCode(item);
  if (!code) return null;
  const command = resolveLauncherPin(code, context);
  if (!command) return null;
  let expectedPluginId = item.plugin_id;
  if (item.code.startsWith("alias:")) {
    // Alias rows identify the alias wrapper; activation targets the resolved builtin/local command.
    expectedPluginId = command.plugin_id;
  }
  if (item.code.startsWith("history:")) {
    const payload = commandHistoryPayloadFromCode(item.code);
    if (!payload) return null;
    const owner = resolveHistoryOwner(payload, [], context.catalog);
    if (owner.status === "resolved") expectedPluginId = owner.plugin_id;
    else if (!payload.plugin_id) return null;
    else expectedPluginId = payload.plugin_id;
  }
  // A search refresh must not retarget a menu to a different plugin sharing a code.
  if (expectedPluginId && command.plugin_id !== expectedPluginId) return null;
  return { ...command, plugin_id: command.plugin_id || "system", plugin_name: command.plugin_name || "ATools",
    icon: "icon" in command ? command.icon as string | null : null, score: 0, match_type: "exact" };
}

export function toggleLauncherPin(codes: string[], code: string): void {
  const next = togglePinnedCommandCode(codes, code);
  savePinnedCommandCodes(next);
  dispatchPinnedCommandCodes(next);
}

export function isLauncherMenuShortcut(event: KeyboardEvent): boolean {
  return !event.isComposing && event.keyCode !== 229 && !event.metaKey && !event.ctrlKey && !event.altKey
    && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey));
}
