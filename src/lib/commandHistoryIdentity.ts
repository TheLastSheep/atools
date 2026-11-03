import type { CommandHistoryEntry, CommandHistoryPayload } from "./commandHistory";
import type { SearchResult } from "./types";

export type CommandIdentity = { plugin_id: string; code: string };
export type HistoryOwnerResolution =
  | { status: "resolved"; plugin_id: string }
  | { status: "missing" | "ambiguous" };

export function commandIdentityKey(identity: CommandIdentity): string {
  return JSON.stringify([identity.plugin_id, identity.code]);
}

export function sameCommandIdentity(left: CommandIdentity, right: CommandIdentity): boolean {
  return left.code === right.code && left.plugin_id === right.plugin_id;
}

export function findHistoryEntry(
  history: CommandHistoryEntry[],
  code: string,
  pluginId?: string,
): CommandHistoryEntry | undefined {
  return history.find((entry) => entry.code === code && (!pluginId || entry.plugin_id === pluginId));
}

/** Resolve legacy history payloads only when the live catalog gives code one unambiguous owner. */
export function resolveHistoryOwner(
  payload: CommandHistoryPayload,
  history: CommandHistoryEntry[],
  catalog: SearchResult[],
): HistoryOwnerResolution {
  if (payload.plugin_id) {
    return findHistoryEntry(history, payload.code, payload.plugin_id)
      ? { status: "resolved", plugin_id: payload.plugin_id }
      : { status: "missing" };
  }

  const owners = [...new Set(catalog.filter((item) => item.code === payload.code).map((item) => item.plugin_id))];
  if (owners.length === 1) return { status: "resolved", plugin_id: owners[0] };
  return owners.length > 1 ? { status: "ambiguous" } : { status: "missing" };
}

export function resolveHistoryRemovalOwner(
  code: string,
  suppliedPluginId: string | undefined,
  history: CommandHistoryEntry[],
): string | null {
  if (suppliedPluginId) return findHistoryEntry(history, code, suppliedPluginId) ? suppliedPluginId : null;
  const owners = [...new Set(history.filter((entry) => entry.code === code).map((entry) => entry.plugin_id))];
  return owners.length === 1 ? owners[0] : null;
}
