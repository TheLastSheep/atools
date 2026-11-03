import type { InstalledPlugin, PluginMarketCatalog, PluginMarketCatalogPlugin, PluginMarketResolvedDownload } from "./types";
import { marketAction, type MarketConfirm } from "./pluginMarketView";

/** An approval is for this release and source, never for a mutable catalog row. */
export type MarketInstallIntent = Readonly<{
  plugin: Readonly<PluginMarketCatalogPlugin>; sourceKind: PluginMarketCatalog["source_kind"];
  sourceUrl: string; trustedKeys: string; operation: "install" | "update"; actionLabel: string;
  installedVersion: string | null;
}>;

export function createMarketInstallIntent(plugin: PluginMarketCatalogPlugin, catalog: PluginMarketCatalog,
  trustedKeys: string, installed: InstalledPlugin[]): MarketInstallIntent {
  const action = marketAction(plugin, installed);
  return Object.freeze({ plugin: Object.freeze({ ...plugin }), sourceKind: catalog.source_kind,
    sourceUrl: catalog.source_url, trustedKeys, operation: action.operation, actionLabel: action.label,
    installedVersion: installed.find(item => item.id === plugin.id)?.version ?? null });
}

export function retargetMarketInstallIntent(intent: MarketInstallIntent, plugin: PluginMarketCatalogPlugin): MarketInstallIntent {
  return Object.freeze({ ...intent, plugin: Object.freeze({ ...plugin }),
    actionLabel: intent.operation === "install" ? "安装" : intent.installedVersion === plugin.version ? "重装" : "更新" });
}

export function marketInstallConfirmation(intent: MarketInstallIntent, resolved: PluginMarketResolvedDownload,
  officialUnsigned: boolean, previousVersion: string): MarketConfirm {
  const { plugin, actionLabel, sourceUrl } = intent;
  const changed = previousVersion !== plugin.version;
  const versionNotice = changed
    ? `官方发布版本已变化：你选择的是 v${previousVersion}，当前发布版为 v${plugin.version}。本次将${actionLabel} v${plugin.version}，请重新确认。\n\n` : "";
  return { title: changed ? `${actionLabel}插件 · 发布版本已变化` : `${actionLabel}插件`,
    confirmLabel: changed ? `${actionLabel} v${plugin.version}` : actionLabel, tone: "danger",
    message: versionNotice + (officialUnsigned
      ? `${plugin.name} v${plugin.version} 将从 ZTools 官方包服务器 ${actionLabel}。目录来源：${sourceUrl}。该上游包未提供可验证的 SHA-256 或 Ed25519 签名；ATools 会限制为官方 HTTPS 域名、执行压缩包配额与路径穿越检查，但无法证明发布者签名。确认继续？`
      : `${plugin.name} v${plugin.version} 将从 ${resolved.download_url} ${actionLabel}。目录来源：${sourceUrl}。远程插件会下载 ${resolved.package_format.toUpperCase()} 并写入本地插件目录；${plugin.checksum ? "目录 SHA-256 会在解包前校验。" : "目录未提供 SHA-256，将以 Ed25519 签名校验完整性。"}目录 Ed25519 签名会使用本机已 pin 的公钥校验。确认继续？`) };
}
