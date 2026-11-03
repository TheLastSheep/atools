<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { PluginMarketController } from "../lib/pluginMarketController";
  import { presentPluginInstallProblem } from "../lib/pluginInstallProblem";
  import { acquirePluginMarketSession } from "../lib/pluginMarketSession";
  import PluginMarketSourceAction from "./PluginMarketSourceAction.svelte";
  import PluginMarketTargetNotice from "./PluginMarketTargetNotice.svelte";
  import PluginMarketDetailDialog from "./PluginMarketDetailDialog.svelte";
  import PluginInstallProblemNotice from "./PluginInstallProblemNotice.svelte";
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";
import { firstOpenablePluginFeature, PluginOpenController, type PluginOpenState } from "../lib/pluginOpen";
  import { pluginMarketStatus, pluginMarketOverviewCards } from "../lib/pluginMarketStatus";
  import { marketAction, marketInstallAllowed, marketOfficialUnsigned, marketProgressLabel, marketPublicKeyTrusted,
    visibleMarketPlugins, type MarketConfirm, type PluginMarketProgress } from "../lib/pluginMarketView";
  import type { InstalledPlugin } from "../lib/types";

  type Props = {
    custom: boolean; url: string; trustedPublicKeys: string; marketRequest?: PluginMarketRequest | null;
    visible?: boolean;
    sharedSession?: boolean;
    confirm: (request: MarketConfirm) => Promise<boolean>;
    onRequestHandled?: (request: PluginMarketRequest) => void;
    onInstalled?: (plugin: InstalledPlugin, installed: InstalledPlugin[], operation: "install" | "update") => void;
    onOpenCommitted?: (pluginId: string) => void;
    onManageInstalled?: (pluginId: string) => void;
  };
  let { custom, url, trustedPublicKeys, marketRequest = null, visible = true, sharedSession = false, confirm, onRequestHandled, onInstalled, onOpenCommitted, onManageInstalled }: Props = $props();
  const hasRuntime = () => typeof window !== "undefined"
    && typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === "function";
  const dependencies = { invoke, hasRuntime, confirm: (request: MarketConfirm) => confirm(request),
    onInstalled: (plugin: InstalledPlugin, installed: InstalledPlugin[], operation: "install" | "update") => onInstalled?.(plugin, installed, operation) };
  const session = untrack(() => sharedSession) ? acquirePluginMarketSession(dependencies) : null;
  const controller = session?.controller ?? new PluginMarketController(dependencies);
  let marketState = $state(controller.state);
  let openState = $state<PluginOpenState>({ requestId: null, pluginId: null, busy: false, message: "" });
  const pluginOpen = new PluginOpenController(
    (state) => { openState = state; },
    (pluginId) => {
      if (controller.state.recentlyInstalled?.id === pluginId) controller.clearRecentlyInstalled();
      onOpenCommitted?.(pluginId);
    },
  );
  let handledRequest: PluginMarketRequest | null = null;
  let previousRecentPluginId: string | null = null;
  let detailId = $state<string | null>(null);
  let detailReturnTo = $state.raw<HTMLElement | null>(null);
  $effect(() => {
    const preferences = { custom, url, trustedPublicKeys };
    const request = marketRequest;
    const active = visible;
    untrack(() => {
      if (!active) { controller.leave(); return; }
      controller.configure(preferences, request);
      if (request && request !== handledRequest) { handledRequest = request; onRequestHandled?.(request); }
    });
  });
  onMount(() => {
    let cancelled = false;
    let stopEvents: (() => void) | undefined;
    const stopState = controller.subscribe(value => { marketState = value; });
    if (!session && hasRuntime()) void listen<PluginMarketProgress>("plugin-market-progress", event => controller.handleProgress(event.payload))
      .then(stop => { if (cancelled) stop(); else stopEvents = stop; }).catch(() => {});
    return () => { cancelled = true; pluginOpen.cancel(); stopState(); stopEvents?.(); if (session) session.release(); else controller.dispose(); };
  });
  const rows = $derived(visibleMarketPlugins(marketState.catalog?.plugins ?? [], marketState.target, marketState.query));
  const selected = $derived(rows.find(plugin => plugin.id === marketState.selectedId) ?? null);
  const recentlyInstalled = $derived(marketState.installed.find(plugin => plugin.id === marketState.recentlyInstalled?.id) ?? marketState.recentlyInstalled);
  const installProblem = $derived(marketState.installFailure
    ? presentPluginInstallProblem(marketState.installFailure, "market-install") : null);
  $effect(() => {
    const active = visible;
    const currentRecentPluginId = recentlyInstalled?.id ?? null;
    if (!active || currentRecentPluginId !== previousRecentPluginId) pluginOpen.cancel();
    previousRecentPluginId = active ? currentRecentPluginId : null;
    if (!active || !selected) detailId = null;
  });
  const status = $derived(pluginMarketStatus({ installedPluginCount: marketState.installed.length, hasTauriRuntime: hasRuntime(),
    customMarketEnabled: custom, customMarketUrl: url, activeSourceUrl: marketState.sourceUrl,
    activeSourceKind: marketState.catalog?.source_kind, remoteCatalogLoaded: Boolean(marketState.catalog),
    remotePluginCount: marketState.catalog?.plugins.length ?? 0,
    remoteRatedPluginCount: marketState.catalog?.plugins.filter(plugin => plugin.rating || plugin.rating_count).length ?? 0,
    remoteSignedPluginCount: marketState.catalog?.plugins.filter(plugin => plugin.signature && plugin.public_key).length ?? 0,
    remoteTrustedPluginCount: marketState.catalog?.plugins.filter(plugin => marketPublicKeyTrusted(plugin, trustedPublicKeys)).length ?? 0 }));

  function openInstalled() {
    pluginOpen.open(recentlyInstalled);
  }
  function openDetail(id: string, returnTo: HTMLElement) {
    detailReturnTo = returnTo;
    controller.select(id);
    detailId = id;
  }
  function installFromDetail(id: string) {
    // Release native modality before the separate installation confirmation opens.
    detailId = null;
    void controller.install(id);
  }
</script>

<div class="market-panel" aria-label="插件市场">
  <section class="market-header">
    <div><h2>插件市场</h2><p>查找发布版，在确认来源与权限后安装。</p></div>
    <button onclick={() => controller.refresh()} disabled={marketState.loading}>{marketState.target ? "刷新发布信息" : "刷新目录"}</button>
  </section>

  {#if marketState.officialOverride}
    <section class="recovery-card" aria-label="官方发布版查找">
      <strong>{marketState.target ? `查找官方发布版：${marketState.target}` : "本次查看 ZTools 官方目录"}</strong>
      <p>本次临时使用官方来源，你保存的市场设置保持不变。安装需要单独确认。</p>
      <div class="actions">
        {#if marketState.target}<button onclick={() => controller.clearTarget()}>查看官方目录</button>{/if}
        <button onclick={() => controller.restoreSource()}>恢复我的来源</button>
      </div>
    </section>
  {/if}

  <div class="source-line"><span>本次来源</span><code>{marketState.sourceUrl}</code>
    <PluginMarketSourceAction sourceUrl={marketState.sourceUrl} runtime={hasRuntime()}
      callCapability={(name, arguments_) => invoke("call_agent_tool", { name, arguments: arguments_, clientId: "atools-ui", confirmed: true })} /></div>
  <p class="catalog-note">{marketState.target ? "按插件 ID 查询官方最新发布信息，安装仍需单独确认。" : "仅搜索本次接口返回的条目，未返回的条目不在此列表中。"}</p>
  <div class="market-status" role="status">{marketState.status}</div>
  {#if installProblem}<PluginInstallProblemNotice problem={installProblem} />{/if}
  {#if marketState.progress}<div class="market-status" aria-label="下载进度">下载进度：{marketProgressLabel(marketState.progress)}</div>{/if}
  {#if marketState.pendingId}
    <div class="actions"><span>{marketState.operationId ? "安装任务进行中" : "正在检查发布信息或等待确认"}</span>
      {#if marketState.operationId}<button onclick={() => controller.cancel()}>取消下载</button>{/if}</div>
  {:else if marketState.retry && !["error", "not_found"].includes(marketState.installTarget?.status ?? "")}<button onclick={() => controller.retry()}>重试（重新确认原来源）</button>{/if}
  {#if marketState.installTarget}
    <PluginMarketTargetNotice target={marketState.installTarget} retry={() => void controller.retry()}
      retryLabel="重新检查并确认" busy={Boolean(marketState.pendingId)} installCheck />
  {/if}
  {#if firstOpenablePluginFeature(recentlyInstalled)}
    {#if openState.message}<div class="market-status" role="status">{openState.message}</div>{/if}
    <button onclick={openInstalled} disabled={openState.busy} aria-busy={openState.busy}>{openState.busy ? "正在打开…" : openState.message ? "重试打开" : "立即打开"}</button>
  {:else if marketState.recentlyInstalled && onManageInstalled}
    <div class="actions"><span>安装已完成。请在插件管理中查看权限并授权启用。</span>
      <button onclick={() => marketState.recentlyInstalled && onManageInstalled?.(marketState.recentlyInstalled.id)}>查看并启用</button></div>
  {/if}

  <section aria-label="远程目录">
    <div class="list-heading"><h3>{marketState.target ? "查询结果" : "本次目录"}</h3><span>{rows.length} / {marketState.catalog?.plugins.length ?? 0} 个条目</span></div>
    {#if !marketState.target}
      <label class="search-label">搜索本次目录
        <input type="search" aria-label="搜索本次目录" value={marketState.query} oninput={event => controller.setQuery(event.currentTarget.value)} placeholder="名称、ID、描述或作者" />
      </label>
    {/if}
    {#if marketState.loading}<div class="empty-box">正在读取目录…</div>
    {:else if marketState.targetLookup}
      <PluginMarketTargetNotice target={marketState.targetLookup} retry={() => void controller.refresh()} />
    {:else if marketState.target && marketState.catalog && rows.length === 0}
      <div class="empty-box" aria-label="未找到目标插件">本次返回的目录没有 ID 为「{marketState.target}」的插件。尚不能确认官方是否有对应发布包。可清除目标查看本次目录，或刷新重试。</div>
    {:else if marketState.catalog && rows.length === 0}<div class="empty-box">本次目录没有匹配的条目。</div>{/if}
    <div class="plugin-market-catalog-list">
      {#each rows as plugin (plugin.id)}
        {@const action = marketAction(plugin, marketState.installed)}
        <article class="plugin-row">
          <div class="plugin-copy"><h4>{plugin.name}<span>v{plugin.version}</span></h4><code>{plugin.id}</code>
            <p>{plugin.description || "目录未提供描述"}</p>
            <div class="metadata">
              {#if plugin.author}<span>{plugin.author}</span>{/if}
              <span>{plugin.rating ? `评分 ${plugin.rating}` : "暂无评分"}{plugin.rating_count ? ` · ${plugin.rating_count} 条` : ""}</span>
              {#if plugin.downloads}<span>{plugin.downloads} 次下载</span>{/if}
              <span>{marketOfficialUnsigned(plugin, marketState.catalog) ? "官方源 · 未签名" : marketPublicKeyTrusted(plugin, trustedPublicKeys) ? "公钥已 pin" : "来源或签名未信任"}</span>
            </div>
          </div>
          <div class="actions"><button aria-haspopup="dialog" aria-controls="plugin-market-detail"
            onclick={event => openDetail(plugin.id, event.currentTarget)}>详情</button>
            <button class="primary" onclick={() => controller.install(plugin.id)}
              disabled={marketState.loading || Boolean(marketState.pendingId) || !marketInstallAllowed(plugin, trustedPublicKeys, marketState.catalog)}
              title={marketInstallAllowed(plugin, trustedPublicKeys, marketState.catalog) ? `${action.label} ${plugin.name}` : "该来源没有受信签名，不能安装"}>
              {marketState.pendingId === plugin.id ? `${action.label}中` : action.label}</button></div>
        </article>
      {/each}
    </div>
  </section>

  <details class="market-overview"><summary>插件市场概览与本地替代入口</summary>
    <p>{status.summary}</p><div class="plugin-market-overview-grid">
      {#each pluginMarketOverviewCards(status) as card}<div class="plugin-market-overview-card"><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small></div>{/each}
    </div>
    <h3>本地替代入口</h3>{#each status.localCapabilities as item}<p>{item.label} · {item.description}（{item.available ? "可用" : "桌面端"}）</p>{/each}
    <h3>远程能力</h3>{#each status.remoteCapabilities as item}<p>{item.label} · {item.description}（{item.available ? "可用" : "未接入"}）</p>{/each}
  </details>
</div>

{#if visible && selected && detailId === selected.id}
  <PluginMarketDetailDialog plugin={selected} catalog={marketState.catalog} {trustedPublicKeys} returnTo={detailReturnTo}
    actionLabel={marketAction(selected, marketState.installed).label} installing={Boolean(marketState.pendingId)}
    installAllowed={!marketState.loading && marketInstallAllowed(selected, trustedPublicKeys, marketState.catalog)}
    onclose={() => detailId = null} oninstall={() => installFromDetail(selected.id)} />
{/if}

<style>
  .market-panel { height: 100%; overflow: auto; padding: 28px 30px 40px; color: var(--text-primary); background: var(--bg-primary); scrollbar-gutter: stable; }
  .market-header, .list-heading, .source-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { font-size: 24px; margin: 0 0 6px; } h3 { font-size: 17px; margin: 20px 0 12px; } h4 { font-size: 16px; margin: 0 0 4px; }
  p { color: var(--text-secondary); font-size: 13px; line-height: 1.5; margin: 6px 0; }
  button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--border-strong); border-radius: 7px; color: inherit; background: var(--bg-elevated); font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-hover); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .5; } button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-foreground); }
  .recovery-card { margin: 20px 0 16px; padding: 16px; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 10px; background: var(--accent-subtle); }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
  .source-line { justify-content: flex-start; margin-top: 18px; flex-wrap: wrap; font-size: 12px; } .source-line code { flex: 1; }
  code { overflow-wrap: anywhere; font-size: 12px; } .catalog-note { font-size: 12px; } .market-status { margin: 12px 0; font-size: 13px; line-height: 1.5; }
  .list-heading span, .metadata { font-size: 12px; color: var(--text-secondary); }
  .search-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; margin: 12px 0 16px; }
  input { min-height: 40px; width: 100%; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-elevated); color: inherit; font-size: 14px; }
  .plugin-row { display: flex; gap: 16px; justify-content: space-between; align-items: center; padding: 18px 0; border-bottom: 1px solid var(--border); }
  .plugin-copy { min-width: 0; flex: 1; } .plugin-copy h4 span { font-size: 12px; font-weight: 400; margin-left: 8px; color: var(--text-secondary); }
  .metadata { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; } .empty-box { padding: 24px 16px; border: 1px dashed var(--border-strong); border-radius: 8px; line-height: 1.6; font-size: 13px; }
  .market-overview { margin-top: 22px; padding: 16px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-elevated); }
  summary { cursor: pointer; font-size: 13px; font-weight: 600; } .plugin-market-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
  .plugin-market-overview-card { padding: 12px; border-radius: 8px; border: 1px solid var(--border-strong); font-size: 12px; } .plugin-market-overview-card strong { display: block; margin: 6px 0; font-size: 18px; } small { color: var(--text-secondary); line-height: 1.4; }
  @media (max-width: 700px) { .market-panel { padding: 20px 18px 32px; } .plugin-row { align-items: flex-start; flex-direction: column; gap: 12px; } .market-header { align-items: flex-start; } }
</style>
