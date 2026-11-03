import type { InstalledPlugin, PluginMarketCatalog, PluginMarketCatalogPlugin } from "./types";
import { isOfficialZtoolsMarketSource } from "./pluginMarketStatus";

export const DEFAULT_ZTOOLS_MARKET_URL = "https://z-tools.top/api/market";
export type MarketPreferences = { custom: boolean; url: string; trustedPublicKeys: string };
export type MarketConfirm = {
  title: string; message: string; confirmLabel?: string; tone?: "default" | "danger";
};
export type PluginMarketProgress = {
  plugin_id?: string | null; operation: string; operation_id?: string | null;
  stage: string; downloaded_bytes: number; total_bytes?: number | null;
  percent?: number | null; attempt: number; max_attempts: number; message: string;
};

export function preferredMarketUrl(preferences: Pick<MarketPreferences, "custom" | "url">): string {
  return preferences.custom && preferences.url.trim() ? preferences.url.trim() : DEFAULT_ZTOOLS_MARKET_URL;
}

export function marketPublicKeyTrusted(plugin: PluginMarketCatalogPlugin, trustedKeys: string): boolean {
  const key = plugin.public_key?.trim();
  return Boolean(key && trustedKeys.split(/\s+/).includes(key));
}

type MarketSource = Pick<PluginMarketCatalog, "source_kind" | "source_url"> | null;
export function marketOfficialUnsigned(plugin: PluginMarketCatalogPlugin, source: MarketSource): boolean {
  return !plugin.signature?.trim() && !plugin.public_key?.trim() && plugin.trust_policy === "official_ztools_confirm"
    && source?.source_kind === "ztools" && isOfficialZtoolsMarketSource(source.source_url);
}

export function marketInstallAllowed(plugin: PluginMarketCatalogPlugin, trustedKeys: string, source: MarketSource): boolean {
  if (plugin.signature?.trim() || plugin.public_key?.trim())
    return Boolean(plugin.signature?.trim() && plugin.public_key?.trim() && marketPublicKeyTrusted(plugin, trustedKeys));
  return marketOfficialUnsigned(plugin, source);
}

export function marketAction(plugin: PluginMarketCatalogPlugin, installed: InstalledPlugin[]) {
  const existing = installed.find(item => item.id === plugin.id);
  return { operation: existing ? "update" as const : "install" as const,
    label: existing ? existing.version === plugin.version ? "重装" : "更新" : "安装" };
}

/** An import recovery target is an exact manifest ID, never a fuzzy title search. */
export function visibleMarketPlugins(plugins: PluginMarketCatalogPlugin[], target: string | null, query: string) {
  if (target) return plugins.filter(plugin => plugin.id === target);
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return plugins;
  return plugins.filter(plugin => [plugin.id, plugin.name, plugin.description, plugin.author, plugin.category]
    .some(value => value?.toLocaleLowerCase().includes(needle)));
}

export function marketChecksumLabel(plugin: PluginMarketCatalogPlugin) {
  return plugin.checksum ? "提供 SHA-256（安装时校验）" : "未提供 SHA-256";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function marketProgressLabel(progress: PluginMarketProgress | null) {
  if (!progress) return "等待开始";
  const percent = typeof progress.percent === "number" ? ` · ${Math.round(progress.percent)}%` : "";
  const total = progress.total_bytes ? ` / ${formatBytes(progress.total_bytes)}` : "";
  const attempt = progress.max_attempts > 1 ? ` · 第 ${progress.attempt}/${progress.max_attempts} 次` : "";
  return `${progress.message}${percent} · ${formatBytes(progress.downloaded_bytes)}${total}${attempt}`;
}
