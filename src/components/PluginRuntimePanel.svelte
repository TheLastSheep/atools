<script lang="ts">
  import { onMount } from "svelte";
  import type { InstalledPlugin } from "../lib/types";
  import { sameRuntimeSession, type RuntimeKind, type RuntimePhase, type RuntimeSession } from "../lib/pluginRuntimeInventory";
  import { createPluginRuntimeInventoryLoader, type PluginRuntimeInventoryLoaderState,
    type PluginRuntimeStopResult } from "../lib/pluginRuntimeInventoryLoader";

  type Props = { plugins: InstalledPlugin[]; query?: string };
  let { plugins, query = $bindable("") }: Props = $props();
  const loader = createPluginRuntimeInventoryLoader();
  let inventoryState = $state<PluginRuntimeInventoryLoaderState>(loader.snapshot());
  let pendingRows = $state<RuntimeSession[]>([]);
  let failedRows = $state<Array<{ key: string; row: RuntimeSession }>>([]);

  const names = $derived(new Map(plugins.map(plugin => [plugin.id,
    plugin.manifest.title?.trim() || plugin.name || plugin.id])));
  const visibleRows = $derived.by(() => {
    const rows = [...inventoryState.sessions];
    for (const pending of pendingRows) if (!rows.some(row => sameRuntimeSession(row, pending))) rows.push(pending);
    for (const failed of failedRows) if (!rows.some(row => sameRuntimeSession(row, failed.row))) rows.push(failed.row);
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter(row => !needle || [names.get(row.pluginId) ?? row.pluginId, row.pluginId,
      kindLabel(row.kind), phaseLabel(row.phase), row.windowLabel ?? ""].some(value => value.toLocaleLowerCase().includes(needle)))
      .sort((left, right) => left.id.localeCompare(right.id) || (left.codeRevision ?? "").localeCompare(right.codeRevision ?? ""));
  });
  const unavailableKinds = $derived(inventoryState.coverage.filter(item => !item.available));
  const coverageIncomplete = $derived(inventoryState.phase === "ready" && (inventoryState.truncated || unavailableKinds.length > 0));

  function rowKey(row: RuntimeSession) {
    return JSON.stringify([row.id, row.pluginId, row.instanceId, row.windowLabel, row.codeRevision]);
  }
  function isPending(row: RuntimeSession) { return pendingRows.some(item => rowKey(item) === rowKey(row)); }
  function stopFailure(row: RuntimeSession) { return failedRows.some(item => item.key === rowKey(row)); }
  function canStop(row: RuntimeSession) {
    try { return loader.canStop(row); } catch { return false; }
  }
  function syncState() {
    const next = loader.snapshot();
    inventoryState = next;
    if (next.phase === "ready" && !next.truncated) {
      failedRows = failedRows.filter(item => {
        const coverage = next.coverage.find(entry => entry.kind === item.row.kind);
        return coverage?.available !== true || next.sessions.some(row => sameRuntimeSession(row, item.row));
      });
    }
  }
  async function stopSession(row: RuntimeSession) {
    const captured = row;
    const key = rowKey(captured);
    if (isPending(captured) || stopFailure(captured) || !canStop(captured)) return;
    pendingRows = [...pendingRows, captured];
    let result: PluginRuntimeStopResult = "failed";
    try { result = await loader.stop(captured); } catch { result = "failed"; }
    if (result === "failed") failedRows = [...failedRows.filter(item => item.key !== key), { key, row: captured }];
    if (result === "stopped") failedRows = failedRows.filter(item => item.key !== key);
    pendingRows = pendingRows.filter(item => rowKey(item) !== key);
  }
  function refresh() { void loader.refresh().catch(() => {}); }

  onMount(() => {
    const unsubscribe = loader.subscribe(syncState);
    syncState();
    refresh();
    return () => { unsubscribe(); loader.dispose(); };
  });

  function kindLabel(kind: RuntimeKind) {
    return ({ background: "驻留会话", main_push: "搜索会话", legacy_node: "Node 会话", browser_window: "插件窗口",
      foreground: "前台会话", detached: "分离窗口", sidecar: "后台进程", quickjs: "QuickJS 会话" } satisfies Record<RuntimeKind, string>)[kind];
  }
  function phaseLabel(phase: RuntimePhase) {
    return ({ starting: "启动中", ready: "运行中", stopping: "正在退出", cleanup_failed: "退出未确认", unknown: "状态未知" } satisfies Record<RuntimePhase, string>)[phase];
  }
  function evidenceLabel(row: RuntimeSession) {
    return ({ admission: "受控会话", node_owner: "会话记录", native_window: "窗口会话", renderer_view: "界面视图" } as const)[row.evidence];
  }
  function windowLabel(row: RuntimeSession) {
    if (row.windowLabel === null) return "无窗口";
    if (row.windowLabel === "main") return "主窗口";
    if (row.windowLabel === "plugin-detach") return "分离窗口";
    return "插件窗口";
  }
  function revisionLabel(row: RuntimeSession) {
    return row.codeRevision ? "载入版本已记录" : "载入版本未记录";
  }
</script>

<section class="runtime-panel" aria-label="运行会话">
  <div class="runtime-toolbar">
    <label class="search">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.2" /><path d="m10 10 3.5 3.5" /></svg>
      <input bind:value={query} aria-label="搜索运行会话" placeholder="搜索插件或会话" />
    </label>
    <div class="summary">
      <span>{visibleRows.length} 个可见会话</span>
      <button type="button" class="refresh" disabled={inventoryState.phase === "loading"} onclick={refresh}>
        {inventoryState.phase === "loading" ? "读取中…" : "刷新"}
      </button>
    </div>
  </div>

  {#if inventoryState.phase === "error"}
    <p class="notice error" role="alert">
      {inventoryState.staleNative ? "运行状态读取失败；上次原生状态已过期，本页仅保留当前窗口会话。" : "运行状态读取失败；本页仅显示当前窗口会话。"}
    </p>
  {/if}
  {#if inventoryState.localError}
    <p class="notice error" role="alert">当前窗口会话状态无法读取，显示内容可能不完整。</p>
  {/if}
  {#if coverageIncomplete}
    <p class="notice warning" role="status">
      部分运行状态不可用，列表可能不完整。{#if unavailableKinds.length > 0}暂不可读取：{unavailableKinds.map(item => kindLabel(item.kind)).join("、")}。{/if}{#if inventoryState.truncated}会话列表已截断。{/if}
    </p>
  {/if}
  {#if inventoryState.phase === "loading" && visibleRows.length > 0}
    <p class="sr-only" role="status" aria-live="polite">正在读取运行会话</p>
  {/if}

  <div class="runtime-list" role="list" aria-label="插件运行会话" aria-busy={inventoryState.phase === "loading"}>
    {#each visibleRows as row (`${rowKey(row)}`)}
      {@const pluginName = names.get(row.pluginId) ?? row.pluginId}
      {@const pending = isPending(row)}
      {@const failed = stopFailure(row)}
      {@const stoppable = canStop(row)}
      <article class="runtime-row" role="listitem" data-runtime-kind={row.kind}>
        <div class="identity">
          <div class="title-line">
            <strong>{pluginName}</strong>
            <span class="kind">{kindLabel(row.kind)}</span>
            <span class="phase" class:ready={row.phase === "ready" && !pending && !failed}
              class:pending class:error={failed || row.phase === "cleanup_failed"}>
              {pending ? "正在退出…" : failed ? "退出未确认" : phaseLabel(row.phase)}
            </span>
          </div>
          <div class="meta">
            {#if !names.has(row.pluginId)}<span>{row.pluginId}</span>{/if}
            <span>{windowLabel(row)}</span><span>{revisionLabel(row)}</span>
            <span>{evidenceLabel(row)}</span>
          </div>
          {#if failed}<p class="row-error" role="alert">退出未确认，请刷新查看</p>{/if}
        </div>
        <div class="row-action">
          {#if pending}
            <button type="button" disabled aria-label={`正在停止 ${pluginName}`}>正在停止…</button>
          {:else if stoppable && !failed}
            <button type="button" aria-label={`停止 ${pluginName}`} onclick={() => { void stopSession(row); }}>停止</button>
          {/if}
        </div>
      </article>
    {/each}
    {#if visibleRows.length === 0}
      <div class="empty" role="status" aria-live="polite">
        <strong>{inventoryState.phase === "loading" ? "正在读取运行会话…" : query.trim() ? "没有匹配的运行会话" : inventoryState.phase === "error" ? "暂时没有可确认的会话" : "当前没有可显示的运行会话"}</strong>
        <p>{inventoryState.phase === "error" ? "刷新后可重新读取状态。" : "插件启动后，运行状态会显示在这里。"}</p>
      </div>
    {/if}
  </div>
</section>

<style>
  .runtime-panel { --runtime-warning: #805500; --runtime-error: #b42318; min-width: 0; color: inherit; font-size: 13px; }
  .runtime-toolbar { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 10px; margin-bottom: 8px; }
  .search { position: relative; min-width: 0; }
  .search svg { position: absolute; top: 10px; left: 10px; width: 14px; height: 14px; stroke: var(--settings-text-secondary, #61616d); stroke-width: 1.4; stroke-linecap: round; pointer-events: none; }
  input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 6px 9px 6px 30px; border: 1px solid var(--settings-control-border, #d9d9e0); border-radius: 6px; color: inherit; background: var(--settings-control, #fafafd); font: inherit; font-size: 12px; }
  button { min-height: 30px; padding: 5px 10px; border: 1px solid var(--settings-control-border, #d9d9e0); border-radius: 6px; color: inherit; background: var(--settings-control, #fafafd); font: inherit; font-size: 11px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--settings-primary, #7650d6); background: var(--settings-hover, #efedf8); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--settings-primary, #7650d6); outline-offset: 2px; }
  .summary { display: flex; align-items: center; justify-content: flex-end; gap: 10px; color: var(--settings-text-secondary, #61616d); font-size: 11px; white-space: nowrap; }
  .refresh { color: var(--settings-primary, #7650d6); }
  .notice { margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--settings-control-border, #d9d9e0); border-radius: 6px; font-size: 11px; line-height: 1.45; }
  .notice.error, .row-error { color: var(--runtime-error); border-color: color-mix(in srgb, var(--runtime-error) 28%, var(--settings-control-border, #d9d9e0)); background: color-mix(in srgb, var(--runtime-error) 6%, var(--settings-control, #fafafd)); }
  .notice.warning { color: var(--runtime-warning); border-color: color-mix(in srgb, var(--runtime-warning) 32%, var(--settings-control-border, #d9d9e0)); background: color-mix(in srgb, var(--runtime-warning) 7%, var(--settings-control, #fafafd)); }
  .runtime-list { border-top: 1px solid var(--settings-control-border, #e3e3e9); }
  .runtime-row { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 11px 0; border-bottom: 1px solid var(--settings-control-border, #e3e3e9); }
  .identity { flex: 1; min-width: 0; }
  .title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .title-line strong { min-width: 0; max-width: 100%; overflow-wrap: anywhere; font-size: 13px; font-weight: 580; line-height: 1.35; }
  .kind, .phase { display: inline-flex; align-items: center; min-height: 20px; padding: 2px 6px; border: 1px solid var(--settings-control-border, #d9d9e0); border-radius: 999px; color: var(--settings-text-secondary, #61616d); font-size: 10px; line-height: 1.2; white-space: nowrap; }
  .phase.ready { color: var(--settings-primary, #7650d6); border-color: color-mix(in srgb, var(--settings-primary, #7650d6) 30%, var(--settings-control-border, #d9d9e0)); background: var(--settings-primary-soft, #f1edfa); }
  .phase.pending { color: var(--runtime-warning); border-color: color-mix(in srgb, var(--runtime-warning) 32%, var(--settings-control-border, #d9d9e0)); }
  .phase.error { color: var(--runtime-error); border-color: color-mix(in srgb, var(--runtime-error) 28%, var(--settings-control-border, #d9d9e0)); }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; color: var(--settings-text-secondary, #61616d); font-size: 10px; line-height: 1.4; overflow-wrap: anywhere; }
  .row-error { width: fit-content; margin: 5px 0 0; padding: 3px 6px; border: 1px solid color-mix(in srgb, var(--runtime-error) 28%, var(--settings-control-border, #d9d9e0)); border-radius: 5px; font-size: 10px; }
  .row-action { flex: 0 0 auto; }
  .empty { padding: 30px 12px; text-align: center; }
  .empty strong { font-size: 12px; font-weight: 550; }
  .empty p { margin: 5px 0 0; color: var(--settings-text-secondary, #61616d); font-size: 11px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  :global(:root[data-atools-theme='dark']) .runtime-panel { --runtime-warning: #f5cf84; --runtime-error: #ffaba5; }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-atools-theme='light'])) .runtime-panel { --runtime-warning: #f5cf84; --runtime-error: #ffaba5; }
  }
  @media (max-width: 540px) {
    .runtime-toolbar { grid-template-columns: 1fr; gap: 6px; }
    .summary { justify-content: space-between; }
    .runtime-row { align-items: flex-start; gap: 6px; }
    .row-action button { padding-inline: 8px; }
  }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
