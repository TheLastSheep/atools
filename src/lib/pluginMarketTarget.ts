import type { PluginMarketCatalog, PluginMarketCatalogPlugin } from "./types";
import { DEFAULT_ZTOOLS_MARKET_URL } from "./pluginMarketView";
import { isOfficialZtoolsMarketSource } from "./pluginMarketStatus";

export type MarketTargetState = {
  id: string;
  status: "loading" | "available" | "not_found" | "unsupported_platform" | "error";
  version?: string;
  name?: string;
  error?: string;
};
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function needsOfficialMarketPreflight(source: Pick<PluginMarketCatalog, "source_kind" | "source_url">): boolean {
  return source.source_kind === "ztools" && isOfficialZtoolsMarketSource(source.source_url);
}

/** A recovery asks for one release, without loading the aggregate market first. */
export async function readOfficialMarketTarget(invoke: Invoke, id: string): Promise<{
  catalog: PluginMarketCatalog;
  target: MarketTargetState;
}> {
  const raw = await invoke<unknown>("fetch_official_plugin_target", { pluginId: id });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("发布信息格式无效");
  const result = raw as Record<string, unknown>;
  if (result.plugin_id !== id || result.source_url !== DEFAULT_ZTOOLS_MARKET_URL || result.source_kind !== "ztools")
    throw new Error("发布信息的插件身份或来源不匹配");
  if (!["available", "not_found", "unsupported_platform"].includes(String(result.status)))
    throw new Error("发布信息状态无效");
  const status = result.status as "available" | "not_found" | "unsupported_platform";
  let plugin: PluginMarketCatalogPlugin | null = null;
  if (status === "available") {
    const value = result.plugin as PluginMarketCatalogPlugin | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || value.id !== id
      || typeof value.version !== "string" || !value.version.trim() || typeof value.name !== "string")
      throw new Error("发布信息缺少匹配的插件或版本");
    plugin = value;
  } else if (result.plugin !== null) throw new Error("不可用的发布信息包含矛盾的插件记录");
  return {
    catalog: { source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", plugins: plugin ? [plugin] : [] },
    target: { id, status, ...(plugin ? { version: plugin.version, name: plugin.name } : {}) },
  };
}

export function marketTargetStatus(target: MarketTargetState): string {
  switch (target.status) {
    case "loading": return "正在查询官方发布信息";
    case "available": return `已按插件 ID 核对官方发布信息 · v${target.version}`;
    case "not_found": return "官方暂未返回该插件的发布信息";
    case "unsupported_platform": return "官方发布版不支持当前系统";
    case "error": return "官方发布信息查询失败，可重试";
  }
}
