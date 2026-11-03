<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import PluginInventoryDetail from "./PluginInventoryDetail.svelte";
  import PluginInventoryIcon from "./PluginInventoryIcon.svelte";
  import PluginInventoryToolbar from "./PluginInventoryToolbar.svelte";
  import PluginInventoryFeedback from "./PluginInventoryFeedback.svelte";
  import { pluginInventoryFeedback } from "../lib/pluginInventoryFeedback";
  import { pluginInventory, pluginInventoryRowForQuery } from "../lib/pluginInventory";
  import { resolvePluginInventoryOpenIntent } from "../lib/pluginInventoryFeatureSearch";
  import { clampPluginInventoryPage, createPluginInventoryBrowseState,
    pluginInventoryFilterKey, type PluginInventoryBrowseState } from "../lib/pluginInventoryBrowseState";
  import { PluginInventoryController, type PluginInventoryConfirmRequest,
    type PluginInventoryControllerState } from "../lib/pluginInventoryController";
  import { pluginInventoryServices } from "../lib/pluginInventoryServices";
  import { handlePluginInventoryKeydown, observeFocusedPluginInventoryButton, restorePluginInventorySearchFocus,
    type PluginInventoryFocusSnapshot } from "../lib/pluginInventoryKeyboard";
  import { createPluginInventoryFocusPaginationController, navigatePluginInventoryFocusAcrossPage } from "../lib/pluginInventoryFocusPagination";
  import { firstOpenablePluginFeature, PluginOpenController, type PluginOpenState } from "../lib/pluginOpen";
  import type { InstalledPlugin } from "../lib/types";
  import { parseInstalledPluginList } from "../lib/installedPluginBoundary";
  import PluginInventoryViewTabs from "./PluginInventoryViewTabs.svelte";
  import PluginRuntimePanel from "./PluginRuntimePanel.svelte";

  type Props = {
    initialPlugins?: InstalledPlugin[]; query?: string; selectedPluginId?: string | null;
    browseState?: PluginInventoryBrowseState;
    confirm: (options: PluginInventoryConfirmRequest) => Promise<boolean>;
    onpluginsloaded?: (plugins: InstalledPlugin[]) => void; onmarket?: () => void;
  };
  let { initialPlugins = [], query = $bindable(""), selectedPluginId = $bindable<string | null>(null),
    browseState = $bindable(createPluginInventoryBrowseState()),
    confirm, onpluginsloaded, onmarket }: Props = $props();
  let transaction = $state<PluginInventoryControllerState>();
  let catalogue = $state.raw<InstalledPlugin[]>([]);
  let catalogueLoaded = $state(false);
  let opening = $state<PluginOpenState>({ requestId: null, pluginId: null, busy: false, message: "" });
  let panel: HTMLElement;
  let searchInput = $state<HTMLInputElement>();
  let pluginList = $state<HTMLDivElement>();
  let lastListFocus: PluginInventoryFocusSnapshot | null = null;
  let listFocusRevision = $state(0);
  let returnId: string | null = null;
  let previousCommitRevision = 0;
  let visibleDetailId: string | null = null;
  let alive = true;
  const pageSize = 30;
  let runtimeView = $state<"installed" | "running">("installed");
  $effect(() => { runtimeView; untrack(() => { invalidateCrossPageFocus(); opener.cancel(); }); });
  const services = pluginInventoryServices(request => confirm(request));
  const nativeAvailable = services.available();
  const controller = new PluginInventoryController({ ...services,
    async listPlugins() {
      const plugins = parseInstalledPluginList(await services.listPlugins());
      if (alive) { catalogueLoaded = true; onpluginsloaded?.(plugins); }
      return plugins;
    },
  }, value => {
    transaction = value;
    if (catalogue.length !== value.plugins.length || catalogue.some((plugin, index) => plugin !== value.plugins[index])) catalogue = value.plugins;
  }, untrack(() => initialPlugins));
  const opener = new PluginOpenController(value => { opening = value; }, () => {});
  const focusPagination = createPluginInventoryFocusPaginationController();
  const catalogState = $derived(transaction ?? controller.snapshot);
  const inventory = $derived(pluginInventory(catalogue, { query, status: browseState.status, source: browseState.source, selectedPluginId }));
  const recordsById = $derived(new Map(catalogue.map(plugin => [plugin.id, plugin])));
  const pageCount = $derived(Math.max(1, Math.ceil(inventory.rows.length / pageSize)));
  const currentPage = $derived(clampPluginInventoryPage(browseState.page, pageCount));
  const rows = $derived(inventory.rows.slice((currentPage - 1) * pageSize, currentPage * pageSize));
  $effect(() => {
    const visibleIds = rows.map(row => row.id);
    listFocusRevision;
    const snapshot = lastListFocus;
    if (!snapshot || visibleIds.includes(snapshot.pluginId)) return;
    void tick().then(() => {
      if (lastListFocus !== snapshot || Array.from(pluginList?.querySelectorAll<HTMLElement>("[data-plugin-id]") ?? [])
        .some(row => row.dataset.pluginId === snapshot.pluginId)) return;
      restorePluginInventorySearchFocus(searchInput, snapshot);
      if (lastListFocus === snapshot) {
        lastListFocus = null;
        listFocusRevision += 1;
      }
    });
  });
  const selected = $derived(selectedPluginId && inventory.selectedPlugin?.id === selectedPluginId ? inventory.selectedPlugin : null);
  const selectedRecord = $derived(selected ? recordsById.get(selected.id) : undefined);
  const busy = $derived(catalogState.busy !== "idle");
  const recovery = $derived(Boolean(catalogState.refreshError));
  const feedback = $derived(pluginInventoryFeedback(catalogState, opening.message));
  const localLocked = $derived(busy || recovery || opening.busy);
  const locked = $derived(localLocked || !nativeAvailable);
  let previousFilterKey = pluginInventoryFilterKey(query, browseState.status, browseState.source);
  $effect(() => {
    const nextFilterKey = pluginInventoryFilterKey(query, browseState.status, browseState.source);
    if (nextFilterKey !== previousFilterKey) {
      previousFilterKey = nextFilterKey;
      untrack(() => { invalidateCrossPageFocus(); browseState.page = 1; opener.cancel(); });
    }
  });
  $effect(() => {
    catalogue;
    untrack(invalidateCrossPageFocus);
  });
  $effect(() => {
    if (!catalogueLoaded) return;
    const nextPage = clampPluginInventoryPage(browseState.page, pageCount);
    if (nextPage !== browseState.page) untrack(() => { browseState.page = nextPage; });
  });
  $effect(() => { selectedPluginId; untrack(() => opener.cancel()); });
  $effect(() => {
    const action = catalogState.committedAction;
    const changed = catalogState.commitRevision !== previousCommitRevision;
    if (action && changed && (action.kind === "install" || action.kind === "update") && catalogState.plugins.some(plugin => plugin.id === action.pluginId)) {
      untrack(() => {
        query = ""; browseState.status = "all"; browseState.source = "all"; selectedPluginId = action.pluginId; returnId = action.pluginId;
      });
    }
    previousCommitRevision = catalogState.commitRevision;
    if (action?.kind === "uninstall" && !catalogState.plugins.some(plugin => plugin.id === action.pluginId)) {
      untrack(() => { if (selectedPluginId === action.pluginId) { selectedPluginId = null; void tick().then(() => searchInput?.focus()); } });
    }
  });
  $effect(() => {
    const nextId = selected?.id ?? null;
    if (!nextId && visibleDetailId) {
      const previousId = visibleDetailId;
      untrack(() => { if (selectedPluginId === previousId) { selectedPluginId = null; void tick().then(() => searchInput?.focus()); } });
    }
    visibleDetailId = nextId;
  });
  onMount(() => {
    if (initialPlugins.length > 0) catalogueLoaded = true;
    void controller.refresh();
    return () => { alive = false; invalidateCrossPageFocus(); opener.cancel(); controller.dispose(); };
  });

  function openPlugin(pluginId: string, code?: string) {
    if (locked) return;
    opener.open(recordsById.get(pluginId), code);
  }
  function openInventoryRow(renderedRow: (typeof inventory.rows)[number]) {
    if (locked) return;
    const currentPlugin = catalogue.find(plugin => plugin.id === renderedRow.id);
    if (!currentPlugin) return;
    const currentRow = pluginInventoryRowForQuery(currentPlugin, {
      query, status: browseState.status, source: browseState.source,
    });
    if (!currentRow) return;
    const intent = resolvePluginInventoryOpenIntent(
      renderedRow.queryFeatureTarget, currentRow.queryFeatureTarget, currentPlugin.enabled,
    );
    if (intent) opener.open(currentPlugin, intent.code);
  }
  function enablePlugin(pluginId: string) {
    if (locked) return;
    return recordsById.get(pluginId)?.source_kind === "builtin"
      ? controller.toggle(pluginId, true)
      : controller.authorize(pluginId);
  }
  function showDetail(pluginId: string) {
    invalidateCrossPageFocus(); opener.cancel(); returnId = pluginId; lastListFocus = null; listFocusRevision += 1; selectedPluginId = pluginId;
  }
  function captureListFocus(event: FocusEvent) {
    const origin = event.target;
    if (!(origin instanceof HTMLElement) || !pluginList?.contains(origin)) return;
    const row = origin.closest<HTMLElement>("[data-plugin-id]");
    if (!row?.dataset.pluginId) return;
    const pendingTarget = focusPagination.pendingTargetPluginId;
    if (pendingTarget && row.dataset.pluginId !== pendingTarget) invalidateCrossPageFocus();
    lastListFocus = { pluginId: row.dataset.pluginId, element: origin };
    listFocusRevision += 1;
  }
  function releaseListFocus(event: FocusEvent) {
    const next = event.relatedTarget;
    const expectedRowDetach = next === document.body && event.target instanceof HTMLElement
      && !event.target.isConnected && focusPagination.pendingTargetPluginId !== null;
    if (next instanceof Node && !pluginList?.contains(next) && !expectedRowDetach) invalidateCrossPageFocus();
    if (!(next instanceof Node) || pluginList?.contains(next)) return;
    lastListFocus = null;
    listFocusRevision += 1;
  }
  function inventoryKeyboard(node: HTMLDivElement) {
    const onKeydown = (event: KeyboardEvent) => handlePluginInventoryKeydown(event, node, beginCrossPageFocus);
    const stopObservingResize = observeFocusedPluginInventoryButton(node);
    node.addEventListener("keydown", onKeydown);
    return { destroy: () => { node.removeEventListener("keydown", onKeydown); stopObservingResize(); } };
  }
  function invalidateCrossPageFocus() {
    focusPagination.invalidate();
  }
  function beginCrossPageFocus(direction: "next" | "previous", originPluginId: string, originButton: HTMLButtonElement): boolean {
    return navigatePluginInventoryFocusAcrossPage({
      controller: focusPagination, direction, originPluginId, originButton,
      rows: inventory.rows, currentPage, pageCount, pageSize,
      setPage: page => { browseState.page = page; },
      afterRender: tick,
      getCurrentPage: () => currentPage,
      getVisiblePluginIds: () => rows.map(row => row.id),
      getList: () => pluginList,
      getActiveElement: () => document.activeElement,
    });
  }
  function refreshInventory() {
    invalidateCrossPageFocus();
    return controller.refresh();
  }
  function retryInventoryList() {
    invalidateCrossPageFocus();
    return controller.retryList();
  }
  function changePage(page: number) {
    invalidateCrossPageFocus();
    opener.cancel();
    browseState.page = page;
  }
  async function backToList() {
    const returnFocusOwner = document.activeElement;
    opener.cancel(); selectedPluginId = null;
    await tick();
    if (document.activeElement !== document.body && document.activeElement !== returnFocusOwner) return;
    const target = Array.from(panel.querySelectorAll<HTMLButtonElement>("[data-plugin-detail-id]"))
      .find(button => button.dataset.pluginDetailId === returnId);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    } else searchInput?.focus({ preventScroll: true });
  }
  function resetFilters() { query = ""; browseState.status = "all"; browseState.source = "all"; selectedPluginId = null; searchInput?.focus(); }
</script>

<section class="inventory" bind:this={panel} aria-label="已安装插件">
  <header class="inventory-header">
    <div class="inventory-heading"><h3>已安装插件 <span class="count">{inventory.summary.total}</span></h3><p>{inventory.summary.enabled} 个已启用</p></div>
    <div class="toolbar">
      {#if runtimeView === "installed"}
      <button disabled={busy || opening.busy || !nativeAvailable} onclick={refreshInventory} aria-label="刷新插件列表">刷新</button>
      <button class="primary" disabled={locked} onclick={() => controller.install()}>安装本地插件</button>
      {/if}
    </div>
  </header>
  <PluginInventoryFeedback {feedback} {nativeAvailable} readDisabled={busy || opening.busy}
    onretry={retryInventoryList} />

  <PluginInventoryViewTabs bind:value={runtimeView} />
  {#if runtimeView === "running"}
    <PluginRuntimePanel plugins={catalogue} bind:query />
  {:else if selected && selectedRecord}
    {#key selected.id}
      <PluginInventoryDetail detail={selected} enabled={selectedRecord.enabled} {locked} opening={opening.busy}
        builtin={selectedRecord.source_kind === "builtin"}
        {localLocked} readDisabled={busy || opening.busy || !nativeAvailable}
        retry={opening.pluginId === selected.id && Boolean(opening.message)}
        onback={backToList} onopen={code => openPlugin(selected!.id, code)}
        onauthorize={() => enablePlugin(selected!.id)} ondisable={() => controller.toggle(selected!.id, false)}
        onreveal={() => controller.reveal(selected!.id)} onupdate={() => controller.update(selected!.id)} onuninstall={() => controller.uninstall(selected!.id)} />
    {/key}
  {:else}
    <PluginInventoryToolbar bind:query bind:status={browseState.status} bind:source={browseState.source}
      bind:searchInput resultCount={inventory.rows.length} resultCountReady={catalogueLoaded && !busy && !recovery} {onmarket} />
    <div class="plugin-list" bind:this={pluginList} role="list" aria-label="插件列表" aria-busy={busy}
      tabindex="-1" use:inventoryKeyboard onfocusin={captureListFocus} onfocusout={releaseListFocus}>
      {#each rows as row (row.id)}
        {@const record = recordsById.get(row.id)}
        <article class="plugin-row" role="listitem" data-plugin-id={row.id}>
          <button class="plugin-identity" data-plugin-detail-id={row.id} onclick={() => showDetail(row.id)} aria-label={`查看 ${row.name} 详情`}>
            {#key `${row.id}\u0000${record?.source_kind ?? ""}\u0000${record?.inventory_logo_path ?? ""}`}
              <PluginInventoryIcon pluginId={row.id} name={row.name} sourceKind={record?.source_kind} logoPath={record?.inventory_logo_path} />
            {/key}
            <span class="plugin-copy"><strong>{row.name}</strong><span class="meta"><span class:enabled={row.enabled}>{row.enabled ? "已启用" : "已停用"}</span><span>{row.sourceLabel}</span><span>{row.featureCount} 个功能</span></span><small>{row.featurePreview}</small></span>
          </button>
          <div class="row-action">
            {#if firstOpenablePluginFeature(record)}{@const targetKey = row.queryFeatureTarget ? `${row.queryFeatureTarget.code}\u0000${row.queryFeatureTarget.label}` : "generic"}
              {#key targetKey}<button class="feature-open" disabled={locked}
                aria-label={row.queryFeatureTarget ? `打开 ${row.name} 的功能：${row.queryFeatureTarget.label}` : `打开 ${row.name}`}
                title={row.queryFeatureTarget ? `打开功能：${row.queryFeatureTarget.label}` : undefined}
                data-feature-code={row.queryFeatureTarget?.code}
                onclick={() => openInventoryRow(row)}><span>{opening.busy && opening.pluginId === row.id ? "正在打开…" : row.queryFeatureTarget ? `打开「${row.queryFeatureTarget.label}」` : "打开"}</span></button>{/key}
            {:else if !row.enabled}<button disabled={locked} aria-label={`${record?.source_kind === "builtin" ? "启用" : "授权启用"} ${row.name}`}
              onclick={() => enablePlugin(row.id)}>{record?.source_kind === "builtin" ? "启用" : "授权启用"}</button>
              {#if row.queryFeatureTarget}<small class="target-hint">启用后可打开「{row.queryFeatureTarget.label}」</small>{/if}
            {:else}<span class="muted">无打开入口</span>{/if}
          </div>
        </article>
      {/each}
      {#if rows.length === 0}<div class="empty"><strong>{busy ? "正在读取插件…" : "没有找到插件"}</strong><p>{inventory.emptyText}</p>
        {#if query || browseState.status !== "all" || browseState.source !== "all"}<button onclick={resetFilters}>清除筛选</button>{/if}</div>{/if}
    </div>
    {#if pageCount > 1}<nav class="pagination" aria-label="插件分页">
      <button disabled={currentPage === 1} onclick={() => changePage(currentPage - 1)}>上一页</button>
      <span>{currentPage} / {pageCount} · {inventory.rows.length} 个</span>
      <button disabled={currentPage === pageCount} onclick={() => changePage(currentPage + 1)}>下一页</button>
    </nav>{/if}
  {/if}
</section>

<style>
  .inventory {
    min-width: 0;
    color: inherit;
    font-size: 13px;
  }
  .inventory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 18px;
    letter-spacing: -.4px;
    font-weight: 650;
  }
  .inventory-header p {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--settings-text-secondary, #61616d);
  }
  .inventory-heading { min-width: 0; }
  .count {
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--settings-control, #fafafd);
    color: var(--settings-text-secondary, #61616d);
    font-size: 11px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    justify-content: flex-end;
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
  button:focus-visible {
    outline: 2px solid var(--settings-primary, #7650d6);
    outline-offset: 2px;
  }
  .primary {
    background: var(--settings-primary, #7650d6);
    color: #fff;
    border-color: transparent;
  }
  .primary:hover:not(:disabled) {
    background: var(--settings-primary, #7650d6);
    color: #fff;
    filter: brightness(1.07);
  }
  .plugin-list {
    border-top: 1px solid var(--settings-control-border, #e3e3e9);
  }
  .plugin-row {
    display: flex;
    gap: 10px;
    align-items: center;
    border-bottom: 1px solid var(--settings-control-border, #e3e3e9);
    padding: 12px 0;
  }
  .plugin-identity {
    min-width: 0;
    flex: 1;
    scroll-margin-block: 6px;
    display: flex;
    align-items: center;
    gap: 11px;
    border: 0;
    padding: 2px;
    text-align: left;
    background: none;
  }
  .plugin-identity:hover:not(:disabled) {
    background: none;
  }
  .plugin-identity:hover strong {
    color: var(--settings-primary, #7650d6);
  }
  .plugin-copy {
    display: grid;
    min-width: 0;
    gap: 5px;
  }
  .plugin-copy strong {
    font-size: 13px;
    line-height: 1.35;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    gap: 9px;
    flex-wrap: wrap;
    font-size: 10px;
    color: var(--settings-text-secondary, #61616d);
  }
  .meta .enabled {
    color: var(--settings-primary, #7650d6);
  }
  .plugin-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--settings-text-secondary, #61616d);
    font-size: 11px;
  }
  .row-action {
    flex: 0 0 auto;
  }
  .row-action button {
    min-width: 52px;
  }
  .row-action button.feature-open {
    max-width: min(42vw, 260px);
    min-width: 52px;
  }
  .feature-open span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .target-hint {
    display: block;
    max-width: min(42vw, 260px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--settings-text-secondary, #61616d);
    font-size: 10px;
  }
  .muted {
    font-size: 10px;
    color: var(--settings-text-secondary, #61616d);
  }
  .empty {
    text-align: center;
    padding: 36px 12px;
  }
  .empty p {
    font-size: 12px;
    color: var(--settings-text-secondary, #61616d);
  }
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 16px;
    font-size: 11px;
    color: var(--settings-text-secondary, #61616d);
  }
  @media (max-width: 540px) {
    .inventory-header { gap: 8px; }
    .toolbar { gap: 6px; }
    .toolbar button { padding-inline: 10px; }
    .plugin-row {
      gap: 7px;
    }
    .plugin-identity {
      gap: 8px;
    }
    .row-action button {
      padding-inline: 9px;
    }
    .row-action button.feature-open,
    .target-hint {
      max-width: 46vw;
    }
  }
</style>
