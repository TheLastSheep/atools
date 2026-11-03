<script lang="ts">
  import { onMount } from "svelte";
  import { ignoreLauncherKeyboardEvent } from "../lib/launcherKeyboard";
  import type { PluginInventoryDetail } from "../lib/pluginInventory";
  import { clearPluginRuntimePermissionGrants, pluginRuntimePermissionGrantList,
    PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT } from "../lib/pluginRuntimePermissions";

  type Props = {
    detail: PluginInventoryDetail; enabled: boolean; locked: boolean; localLocked: boolean;
    opening: boolean; readDisabled: boolean; retry?: boolean; builtin?: boolean;
    onback: () => void; onopen: (code?: string) => void; onauthorize: () => void;
    ondisable: () => void; onreveal: () => void; onupdate: () => void; onuninstall: () => void;
  };
  let { detail, enabled, locked, localLocked, opening, readDisabled, retry = false, builtin = false, onback, onopen, onauthorize, ondisable, onreveal, onupdate, onuninstall }: Props = $props();
  let heading: HTMLHeadingElement;
  let root: HTMLElement;
  let featurePage = $state(1);
  let grants = $state<string[]>([]);
  let grantMessage = $state("");
  const pageSize = 20;
  const featurePages = $derived(Math.max(1, Math.ceil(detail.features.length / pageSize)));
  const currentFeaturePage = $derived(Math.min(featurePage, featurePages));
  const features = $derived(detail.features.slice((currentFeaturePage - 1) * pageSize, currentFeaturePage * pageSize));
  const canUpdate = $derived(detail.actions.some(action => action.label === "更新插件" && action.available));
  const canUninstall = $derived(detail.actions.some(action => action.label === "卸载插件" && action.available));
  const managementReason = $derived(detail.actions.find(action => action.label === "更新插件" && !action.available)?.reason
    || "插件来源待确认，刷新后管理");

  onMount(() => {
    heading.focus();
    const readGrants = () => { grants = pluginRuntimePermissionGrantList(detail.id); };
    readGrants();
    window.addEventListener(PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, readGrants);
    window.addEventListener("keydown", handleDetailKeydown, true);
    return () => {
      window.removeEventListener(PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, readGrants);
      window.removeEventListener("keydown", handleDetailKeydown, true);
    };
  });
  function clearGrants() {
    const cleared = clearPluginRuntimePermissionGrants(detail.id);
    grants = pluginRuntimePermissionGrantList(detail.id);
    grantMessage = cleared ? "已清除插件运行时授权" : "未能清除授权，请重试";
  }
  function handleDetailKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || ignoreLauncherKeyboardEvent(event)
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof Node) || !root.contains(target)) return;
    if (target instanceof Element && target.closest('[role="dialog"], dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    onback();
  }
</script>

<section bind:this={root} class="plugin-detail" aria-label="插件详情">
  <button class="back" onclick={onback}>← 返回插件列表</button>
  <header>
    <div class="identity"><h3 bind:this={heading} tabindex="-1">{detail.title}</h3>
      <p><span class:enabled>{detail.statusLabel}</span><span>{detail.sourceLabel}</span><span>v{detail.versionLabel}</span></p>
    </div>
    {#if enabled && detail.features.some(feature => feature.code.trim())}
      <button class="primary" disabled={locked || opening} aria-busy={opening} onclick={() => onopen()}>{opening ? "正在打开…" : retry ? "重试打开" : "立即打开"}</button>
    {:else if !enabled}
      <button class="primary" disabled={locked || opening} onclick={onauthorize}>{builtin ? "启用" : "授权启用"}</button>
    {/if}
  </header>
  <p class="description">{detail.description}</p>

  <section class="features" aria-label="插件功能">
    <h4>功能 <small>{detail.features.length}</small></h4>
    {#each features as feature, index (`${feature.code}-${index}`)}
      <div class="feature-row" data-feature-code={feature.code}>
        <div><strong>{feature.label}</strong><small>{feature.explain || feature.code}</small></div>
        {#if enabled && feature.code.trim()}
          <button disabled={locked || opening} data-feature-code={feature.code} aria-label={`打开功能 ${feature.label}`} onclick={() => onopen(feature.code)}>打开</button>
        {/if}
      </div>
    {/each}
    {#if !detail.features.length}<p class="muted">该插件没有可直接打开的功能。</p>{/if}
    {#if !enabled && detail.features.length}<p class="muted">授权启用后可打开功能，也可在主搜索中查找。</p>{/if}
    {#if featurePages > 1}
      <nav class="pagination" aria-label="功能分页">
        <button disabled={currentFeaturePage === 1} onclick={() => featurePage = currentFeaturePage - 1}>上一页功能</button>
        <span>{currentFeaturePage} / {featurePages}</span>
        <button disabled={currentFeaturePage === featurePages} onclick={() => featurePage = currentFeaturePage + 1}>下一页功能</button>
      </nav>
    {/if}
  </section>

  <details class="audit"><summary>插件权限</summary>
    <p class="muted">插件声明与已确认的运行时授权。Agent 工具授权在 Agent / MCP 中管理。</p>
    <dl>{#each detail.permissionRows as row}<div><dt>{row.label}</dt><dd>{row.value}<small>{row.detail}</small></dd></div>{/each}</dl>
    <div class="grant-row"><div><strong>持久运行时授权</strong><p>{grants.join(" / ") || "暂无持久授权"}</p></div>
      <button disabled={localLocked || grants.length === 0} onclick={clearGrants}>清除授权</button></div>
    {#if grantMessage}<p role="status">{grantMessage}</p>{/if}
  </details>
  <details class="metadata"><summary>安装信息</summary>
    <dl><div><dt>插件标识</dt><dd><code>{detail.id}</code></dd></div>
      <div><dt>插件目录</dt><dd><code>{detail.path}</code></dd></div>
      <div><dt>更新时间</dt><dd>{detail.updatedAt}</dd></div></dl>
    <button onclick={onreveal} disabled={readDisabled}>打开目录</button>
  </details>
  <footer aria-label="插件管理操作">
    {#if enabled}<button disabled={locked || opening} onclick={ondisable}>停用插件</button>{/if}
    {#if canUpdate}<button disabled={locked || opening} onclick={onupdate}>更新插件</button>{/if}
    {#if canUninstall}<button class="danger" disabled={locked || opening} onclick={onuninstall}>卸载插件</button>{/if}
    {#if !canUpdate && !canUninstall}<span class="muted">{managementReason}</span>{/if}
  </footer>
</section>

<style>
  .plugin-detail {
    min-width: 0;
    display: grid;
    gap: 18px;
  }
  button {
    min-height: 34px;
    padding: 6px 12px;
    border-radius: 7px;
    border: 1px solid var(--settings-control-border, #d9d9e0);
    background: var(--settings-control, #fafafd);
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--settings-hover, #efedf8);
    border-color: var(--settings-primary, #7650d6);
  }
  button:disabled {
    opacity: .48;
    cursor: default;
  }
  button:focus-visible, summary:focus-visible {
    outline: 2px solid var(--settings-primary, #7650d6);
    outline-offset: 3px;
  }
  .back {
    justify-self: start;
    padding-left: 0;
    border: 0;
    background: none;
    color: var(--settings-text-secondary, #61616d);
  }
  header {
    display: flex;
    gap: 16px;
    align-items: start;
    justify-content: space-between;
  }
  .identity {
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: 21px;
    font-weight: 650;
    letter-spacing: -.45px;
    overflow-wrap: anywhere;
  }
  h3:focus {
    outline: none;
  }
  .identity p {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin: 9px 0 0;
    color: var(--settings-text-secondary, #61616d);
    font-size: 11px;
  }
  .identity .enabled {
    color: var(--settings-primary, #7650d6);
  }
  .primary {
    color: #fff;
    background: var(--settings-primary, #7650d6);
    border-color: transparent;
    flex: 0 0 auto;
  }
  .primary:hover:not(:disabled) {
    color: #fff;
    background: var(--settings-primary, #7650d6);
    filter: brightness(1.07);
  }
  .description {
    margin: 0;
    line-height: 1.65;
    color: var(--settings-text-secondary, #61616d);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  h4 {
    margin: 0 0 10px;
    font-size: 13px;
  }
  h4 small {
    margin-left: 5px;
    font-weight: 400;
    color: var(--settings-text-secondary, #61616d);
  }
  .features {
    padding-top: 17px;
    border-top: 1px solid var(--settings-control-border, #e3e3e9);
  }
  .feature-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid var(--settings-control-border, #e3e3e9);
  }
  .feature-row > div {
    min-width: 0;
  }
  .feature-row strong {
    font-size: 13px;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .feature-row small {
    display: block;
    margin-top: 4px;
    color: var(--settings-text-secondary, #61616d);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .feature-row button {
    flex: 0 0 auto;
  }
  .muted {
    font-size: 11px;
    line-height: 1.6;
    color: var(--settings-text-secondary, #61616d);
  }
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    margin-top: 12px;
    font-size: 11px;
  }
  details {
    border: 1px solid var(--settings-control-border, #e3e3e9);
    border-radius: 8px;
    padding: 12px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    font-weight: 550;
  }
  dl {
    margin: 14px 0;
  }
  dl > div {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    padding: 8px 0;
  }
  dt {
    color: var(--settings-text-secondary, #61616d);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  dd small {
    display: block;
    font-size: 11px;
    color: var(--settings-text-secondary, #61616d);
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .grant-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: start;
    gap: 10px;
  }
  .grant-row > div {
    min-width: 0;
    flex: 1 1 140px;
  }
  .grant-row p {
    margin-bottom: 0;
    overflow-wrap: anywhere;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .danger {
    color: #bd424b;
  }
  @media (max-width: 480px) {
    header {
      flex-wrap: wrap;
      gap: 12px;
    }
    dl > div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .plugin-detail {
      gap: 14px;
    }
  }
</style>
