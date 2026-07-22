import type { InstalledPlugin } from "./types";

export const PLUGIN_OPEN_REQUESTED_EVENT = "atools-plugin-open-requested";

export type PluginOpenRequest = {
  code: string;
  pluginId: string;
};

export function firstOpenablePluginFeature(plugin: InstalledPlugin | null | undefined): PluginOpenRequest | null {
  if (!plugin?.enabled) return null;
  const feature = plugin.manifest.features?.find((item) => typeof item.code === "string" && item.code.trim().length > 0);
  if (!feature) return null;
  return { code: feature.code, pluginId: plugin.id };
}

export function dispatchPluginOpenRequest(plugin: InstalledPlugin | null | undefined): boolean {
  const request = firstOpenablePluginFeature(plugin);
  if (!request || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent<PluginOpenRequest>(PLUGIN_OPEN_REQUESTED_EVENT, { detail: request }));
  return true;
}
