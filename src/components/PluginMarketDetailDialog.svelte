<script lang="ts">
  import { pluginMarketDetailFocus } from "../lib/pluginMarketDetailFocus";
  import { marketChecksumLabel, marketOfficialUnsigned, marketPublicKeyTrusted } from "../lib/pluginMarketView";
  import type { PluginMarketCatalog, PluginMarketCatalogPlugin } from "../lib/types";

  type Props = {
    plugin: PluginMarketCatalogPlugin; catalog: PluginMarketCatalog | null; trustedPublicKeys: string;
    returnTo: HTMLElement | null; actionLabel: string; installing: boolean; installAllowed: boolean;
    onclose: () => void; oninstall: () => void;
  };
  let { plugin, catalog, trustedPublicKeys, returnTo, actionLabel, installing, installAllowed, onclose, oninstall }: Props = $props();
  const officialUnsigned = $derived(marketOfficialUnsigned(plugin, catalog));
  const trusted = $derived(marketPublicKeyTrusted(plugin, trustedPublicKeys));
</script>

<dialog id="plugin-market-detail" class="market-detail" aria-modal="true" aria-labelledby="market-detail-title" aria-describedby="market-detail-description"
  tabindex="-1" use:pluginMarketDetailFocus={{ returnTo, close: onclose }}>
  <header>
    <div><p class="eyebrow">插件详情</p><h2 id="market-detail-title">{plugin.name}</h2><p class="version">v{plugin.version} · {plugin.author || "作者未提供"}</p></div>
    <button class="back" data-market-detail-close onclick={onclose}>返回目录 <kbd>Esc</kbd></button>
  </header>
  <div class="detail-body">
    <p id="market-detail-description" class="description">{plugin.description || "目录未提供描述"}</p>
    <section class="source-summary" aria-label="安装来源与信任">
      <strong>{officialUnsigned ? "ZTools 官方来源 · 未签名" : trusted ? "签名公钥已信任" : "来源或签名未信任"}</strong>
      <p>{officialUnsigned ? "安装前会单独确认来源；安装后还需授权启用。" : trusted ? "安装时校验签名，安装后还需授权启用。" : "此来源尚不能安装，请先核对并信任发布者公钥。"}</p>
      <code>{catalog?.source_url}</code>
    </section>
    <dl class="summary">
      <div><dt>插件 ID</dt><dd>{plugin.id}</dd></div>
      <div><dt>下载次数</dt><dd>{plugin.downloads ?? "未提供"}</dd></div>
      <div><dt>市场评分</dt><dd>{plugin.rating ?? "暂无评分"}{plugin.rating_count ? ` · ${plugin.rating_count} 条` : ""}</dd></div>
      <div><dt>更新时间</dt><dd>{plugin.updated_at ?? catalog?.updated_at ?? "未提供"}</dd></div>
      {#if plugin.homepage}<div><dt>主页</dt><dd>{plugin.homepage}</dd></div>{/if}
      {#if plugin.publisher || plugin.publisher_url}<div><dt>发布者</dt><dd>{plugin.publisher ?? "未提供"}{plugin.publisher_url ? ` · ${plugin.publisher_url}` : ""}</dd></div>{/if}
    </dl>
    <details class="verification"><summary>下载与完整性校验信息</summary>
      <dl>
        <div><dt>下载地址</dt><dd>{plugin.download_url ?? plugin.download_resolver_url ?? "安装时解析"}</dd></div>
        <div><dt>SHA-256</dt><dd>{plugin.checksum ?? marketChecksumLabel(plugin)}</dd></div>
        <div><dt>Ed25519 签名</dt><dd>{plugin.signature ?? "未提供签名"}</dd></div>
        <div><dt>公钥</dt><dd>{plugin.public_key ?? "未提供公钥"}</dd></div>
      </dl>
    </details>
  </div>
  <footer><span>安装与插件权限分别确认</span><button class="primary" disabled={installing || !installAllowed} onclick={oninstall}>{installing ? `${actionLabel}中` : actionLabel}</button></footer>
</dialog>

<style>
  .market-detail { position: fixed; inset: 0; margin: auto; box-sizing: border-box; width: min(600px, calc(100vw - 32px)); max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 0; overflow: auto; border: 1px solid var(--settings-control-border, var(--border-strong)); border-radius: 12px; color: var(--text-primary); background: var(--bg-elevated); box-shadow: 0 24px 72px #0003; }
  .market-detail::backdrop { background: #10162250; }
  header, footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 24px; }
  header { border-bottom: 1px solid var(--settings-divider, var(--border)); }
  header > div { min-width: 0; }
  h2 { margin: 4px 0; font-size: 22px; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
  p { margin: 0; line-height: 1.55; }
  .eyebrow, .version, footer span { font-size: 12px; color: var(--text-secondary); }
  .detail-body { padding: 20px 24px 24px; }
  .description { font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .source-summary { margin: 20px 0; padding: 16px; border-left: 3px solid var(--settings-primary, var(--accent)); border-radius: 0 8px 8px 0; background: var(--settings-primary-soft, var(--accent-subtle)); }
  .source-summary strong { font-size: 13px; }
  .source-summary p, .source-summary code { display: block; margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
  dl { display: grid; gap: 12px; margin: 0; font-size: 12px; line-height: 1.5; }
  dl > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; }
  dt { color: var(--text-secondary); } dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  code { overflow-wrap: anywhere; font-family: var(--font-mono); }
  .verification { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--settings-divider, var(--border)); }
  .verification summary { cursor: pointer; color: var(--text-secondary); font-size: 12px; }
  .verification dl { margin-top: 16px; }
  footer { position: sticky; bottom: 0; align-items: center; border-top: 1px solid var(--settings-divider, var(--border)); background: var(--bg-elevated); }
  button { min-height: 36px; flex-shrink: 0; padding: 8px 12px; border: 1px solid var(--settings-control-border, var(--border-strong)); border-radius: 7px; color: inherit; background: var(--settings-control, var(--bg-tertiary)); font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--settings-primary, var(--accent)); background: var(--settings-hover, var(--bg-hover)); }
  button:focus-visible, summary:focus-visible { outline: 2px solid var(--settings-primary, var(--accent)); outline-offset: 3px; }
  button:disabled { opacity: .5; cursor: default; }
  .primary { min-width: 88px; color: var(--accent-foreground, #fff); background: var(--settings-primary, var(--accent)); border-color: var(--settings-primary, var(--accent)); }
  .primary:hover:not(:disabled) { background: var(--settings-primary, var(--accent)); filter: brightness(1.06); }
  kbd { margin-left: 8px; font-family: inherit; font-size: 11px; font-weight: 400; color: var(--text-secondary); }
  @media (max-width: 480px) { .market-detail { width: calc(100vw - 16px); max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } header, footer { padding: 16px; gap: 12px; } header { flex-direction: column; } .detail-body { padding: 16px; } h2 { font-size: 20px; } dl > div { grid-template-columns: 76px minmax(0, 1fr); gap: 8px; } .back { align-self: flex-start; } }
</style>
