/** A source-directory recovery opens the official catalog; it never installs. */
export type PluginMarketRequest = {
  source: "official_ztools";
  pluginName: string;
};

export function officialPluginMarketRequest(pluginName: unknown): PluginMarketRequest | null {
  if (typeof pluginName !== "string") return null;
  const name = pluginName.trim();
  if (!name || new TextEncoder().encode(name).length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return { source: "official_ztools", pluginName: name };
}

export function normalizePluginMarketRequest(value: unknown): PluginMarketRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Partial<PluginMarketRequest>;
  return request.source === "official_ztools" ? officialPluginMarketRequest(request.pluginName) : null;
}
