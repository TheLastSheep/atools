import type { FeatureAction } from "./types";
import type { invoke as tauriInvoke } from "@tauri-apps/api/core";

type Invoke = typeof tauriInvoke;

export type DetachedPluginRequest =
  | { kind: "handoff"; handoffId: string }
  | { kind: "legacy"; featureCode: string; pluginId?: string };

/** The detached URL carries only the opaque claim ID, never plugin payload data. */
export function parseDetachedPluginRequest(hash: string, isDetachWindow: boolean): DetachedPluginRequest | null {
  if (!isDetachWindow) return null;
  const query = hash.split("?")[1];
  if (query === undefined) return null;
  const params = new URLSearchParams(query);
  if (params.has("handoff")) return { kind: "handoff", handoffId: params.get("handoff") ?? "" };
  const featureCode = params.get("feature_code")?.trim();
  if (!featureCode) return null;
  const pluginId = params.get("plugin_id")?.trim();
  return { kind: "legacy", featureCode, ...(pluginId ? { pluginId } : {}) };
}

/** Tauri validates and stores the complete action before creating the handoff URL. */
export function pluginDetachOpenArgs(action: FeatureAction) {
  return {
    featureCode: action.feature_code,
    pluginId: action.plugin_id,
    payload: action.payload,
    ...(action.entry_type ? { entryType: action.entry_type } : {}),
  };
}

/** The bridge owns the request identity needed to revoke a late native open. */
export function createLauncherPluginDetachBridge(invoke: Invoke, routeHash = "") {
  return {
    isPluginDetachWindow: routeHash.startsWith("#/plugin-detach"),
    openPluginDetachAction: async (
      action: FeatureAction,
      isCurrent: () => boolean = () => true,
    ): Promise<boolean> => {
      const requestId = crypto.randomUUID();
      try {
        await invoke<void>("open_plugin_detach_window", { ...pluginDetachOpenArgs(action), requestId });
      } catch (error) {
        if (!isCurrent()) {
          await cancelStaleOpen(invoke, requestId);
          return false;
        }
        if (isHandoffSuperseded(error)) return false;
        throw error;
      }
      if (isCurrent()) return true;
      await cancelStaleOpen(invoke, requestId);
      return false;
    },
    claimPluginDetachAction: (handoffId: string) =>
      invoke<FeatureAction>("claim_plugin_detach_action", { handoffId }),
  };
}

async function cancelStaleOpen(invoke: Invoke, requestId: string) {
  try {
    await invoke<void>("cancel_plugin_detach_open", { requestId });
  } catch (error) {
    console.warn("Stale detached plugin open cleanup failed; native window removal is unconfirmed.", requestId, error);
  }
}

function isHandoffSuperseded(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("PLUGIN_HANDOFF_SUPERSEDED");
}
