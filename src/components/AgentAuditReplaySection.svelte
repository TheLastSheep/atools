<script lang="ts">
  import type { AuditLogEntry } from "../lib/types";
  import {
    auditDetailValue,
    auditFilterOptions,
    auditFilterSummary,
    auditDurationLabel,
    auditPathSummaries,
    auditReplaySummary,
    auditSideEffectDiff,
    auditStatusMeta,
    auditSummaryRows,
    filterAuditEntries,
  } from "../lib/auditView";
  import {
    auditFilterViewLabel,
    removeAuditFilterView,
    saveAuditFilterViews,
    upsertAuditFilterView,
    type SavedAuditFilterView,
  } from "../lib/auditFilterViews";
  import { compact, copyText, filterSelectOptions } from "../lib/agentPanelHelpers";

  type Props = {
    audits: AuditLogEntry[];
    auditTotal: number;
    auditQuery: string;
    auditStatusFilter: string;
    auditToolFilter: string;
    auditClientFilter: string;
    selectedAuditId: string;
    savedAuditFilterViews: SavedAuditFilterView[];
    exportStatus: string;
    busyKey: string;
    reloadAuditsForFilters: () => Promise<void> | void;
    exportAudits: () => Promise<void> | void;
    clearAudits: () => Promise<void> | void;
    loadMoreAudits: () => Promise<void> | void;
    onselectaudit: (id: string) => void;
    onupdatesavedviews: (views: SavedAuditFilterView[]) => void;
    onsetexportstatus: (status: string) => void;
    onsetbusykey: (key: string) => void;
  };

  let {
    audits,
    auditTotal,
    auditQuery = $bindable(""),
    auditStatusFilter = $bindable("all"),
    auditToolFilter = $bindable("all"),
    auditClientFilter = $bindable("all"),
    selectedAuditId,
    savedAuditFilterViews,
    exportStatus,
    busyKey,
    reloadAuditsForFilters,
    exportAudits,
    clearAudits,
    loadMoreAudits,
    onselectaudit,
    onupdatesavedviews,
    onsetexportstatus,
    onsetbusykey,
  }: Props = $props();

  let selectedAuditFilterViewId = $state("");
  let auditFilterViewName = $state("");
  let auditFilterViewStatus = $state("");

  let auditOptions = $derived(auditFilterOptions(audits));
  let auditToolFilterOptions = $derived(filterSelectOptions(auditOptions.toolNames, auditToolFilter));
  let auditClientFilterOptions = $derived(filterSelectOptions(auditOptions.clientIds, auditClientFilter));
  let filteredAudits = $derived(filterAuditEntries(audits, {
    query: auditQuery,
    status: auditStatusFilter,
    toolName: auditToolFilter,
    clientId: auditClientFilter,
  }));
  let auditSummaryText = $derived(auditFilterSummary(audits, filteredAudits, {
    query: auditQuery,
    status: auditStatusFilter,
    toolName: auditToolFilter,
    clientId: auditClientFilter,
  }));

  function currentAuditFilters() {
    return {
      query: auditQuery,
      status: auditStatusFilter,
      toolName: auditToolFilter,
      clientId: auditClientFilter,
    };
  }

  function resetAuditFilters() {
    auditQuery = "";
    auditStatusFilter = "all";
    auditToolFilter = "all";
    auditClientFilter = "all";
    onselectaudit("");
  }

  function saveCurrentAuditFilterView() {
    const views = upsertAuditFilterView(savedAuditFilterViews, {
      id: selectedAuditFilterViewId,
      label: auditFilterViewName,
      filters: currentAuditFilters(),
    });
    onupdatesavedviews(views);
    saveAuditFilterViews(views);
    selectedAuditFilterViewId = views[0]?.id ?? "";
    auditFilterViewName = views[0]?.label ?? "";
    auditFilterViewStatus = views[0] ? `已保存 ${views[0].label}` : "";
  }

  function applyAuditFilterView(view: SavedAuditFilterView) {
    auditQuery = view.filters.query ?? "";
    auditStatusFilter = view.filters.status ?? "all";
    auditToolFilter = view.filters.toolName ?? "all";
    auditClientFilter = view.filters.clientId ?? "all";
    selectedAuditFilterViewId = view.id;
    auditFilterViewName = view.label;
    auditFilterViewStatus = `已应用 ${view.label}`;
    onselectaudit("");
  }

  function deleteAuditFilterView() {
    if (!selectedAuditFilterViewId) return;
    const next = removeAuditFilterView(savedAuditFilterViews, selectedAuditFilterViewId);
    onupdatesavedviews(next);
    saveAuditFilterViews(next);
    selectedAuditFilterViewId = "";
    auditFilterViewName = "";
    auditFilterViewStatus = "已删除筛选视图";
  }

  function selectedAuditFilterView() {
    return savedAuditFilterViews.find((view) => view.id === selectedAuditFilterViewId) ?? null;
  }

  function selectAuditFilterView() {
    const view = selectedAuditFilterView();
    auditFilterViewName = view?.label ?? "";
  }

  async function copyAuditDetail(audit: AuditLogEntry) {
    onsetbusykey(`audit:copy:${audit.id}`);
    try {
      await copyText(JSON.stringify(audit, null, 2));
      onsetexportstatus(`已复制 ${audit.tool_name} 的审计详情`);
    } finally {
      onsetbusykey("");
    }
  }
</script>

<section class="agent-section audit-section">
  <div class="section-title">
    <h3>审计回放</h3>
    <div class="row-actions">
      <button disabled={busyKey === "audit:filter"} onclick={reloadAuditsForFilters}>刷新</button>
      <button disabled={busyKey === "audit:export"} onclick={exportAudits}>导出</button>
      <button disabled={busyKey === "audit:clear"} onclick={clearAudits}>清空</button>
    </div>
  </div>
  {#if exportStatus}
    <div class="empty">{exportStatus}</div>
  {/if}
  {#if audits.length === 0}
    <div class="empty">暂无记录</div>
  {/if}
  <div class="audit-filters">
    <label class="audit-search">
      <span>搜索</span>
      <input type="search" bind:value={auditQuery} placeholder="工具、客户端、路径、错误、参数" />
    </label>
    <label>
      <span>状态</span>
      <select bind:value={auditStatusFilter}>
        <option value="all">全部 ({auditOptions.statusCounts.all})</option>
        <option value="success">成功 ({auditOptions.statusCounts.success})</option>
        <option value="denied">拒绝 ({auditOptions.statusCounts.denied})</option>
        <option value="error">失败 ({auditOptions.statusCounts.error})</option>
        <option value="pending">待确认 ({auditOptions.statusCounts.pending})</option>
        <option value="unknown">未知 ({auditOptions.statusCounts.unknown})</option>
      </select>
    </label>
    <label>
      <span>工具</span>
      <select bind:value={auditToolFilter}>
        <option value="all">全部工具</option>
        {#each auditToolFilterOptions as toolName}
          <option value={toolName}>{toolName}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>客户端</span>
      <select bind:value={auditClientFilter}>
        <option value="all">全部客户端</option>
        {#each auditClientFilterOptions as clientId}
          <option value={clientId}>{clientId}</option>
        {/each}
      </select>
    </label>
    <button onclick={resetAuditFilters}>重置</button>
  </div>
  <div class="audit-filter-views">
    <label>
      <span>筛选视图</span>
      <select bind:value={selectedAuditFilterViewId} onchange={selectAuditFilterView}>
        <option value="">已保存视图</option>
        {#each savedAuditFilterViews as view}
          <option value={view.id}>{view.label}</option>
        {/each}
      </select>
    </label>
    <label class="audit-filter-view-name">
      <span>名称</span>
      <input bind:value={auditFilterViewName} placeholder={auditFilterViewLabel(currentAuditFilters())} />
    </label>
    <button onclick={saveCurrentAuditFilterView}>保存视图</button>
    <button disabled={!selectedAuditFilterViewId} onclick={() => {
      const view = selectedAuditFilterView();
      if (view) applyAuditFilterView(view);
    }}>应用</button>
    <button disabled={!selectedAuditFilterViewId} onclick={deleteAuditFilterView}>删除</button>
  </div>
  {#if auditFilterViewStatus}
    <div class="audit-filter-summary">{auditFilterViewStatus}</div>
  {/if}
  <div class="audit-filter-summary">{auditSummaryText} · 已加载 {audits.length} / {auditTotal} 条</div>
  {#if audits.length > 0 && filteredAudits.length === 0}
    <div class="empty">没有匹配的审计记录</div>
  {/if}
  {#if filteredAudits.length > 0}
    <div class="audit-list">
      {#each filteredAudits as audit}
        {@const statusMeta = auditStatusMeta(audit)}
        <button
          class:selected={selectedAuditId === audit.id}
          class="audit-row"
          onclick={() => onselectaudit(selectedAuditId === audit.id ? "" : audit.id)}
        >
          <div class="audit-meta">
            <strong>{audit.tool_name}</strong>
            <span class={`status-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
            <time>{audit.timestamp}</time>
          </div>
          <div class="audit-json">{compact(audit.input)}</div>
          <div class="audit-json">{audit.error ?? compact(audit.output)}</div>
        </button>
      {/each}
    </div>
  {/if}
  {#if audits.length < auditTotal}
    <button
      class="load-more-button"
      disabled={busyKey === "audit:load-more"}
      onclick={loadMoreAudits}
    >{busyKey === "audit:load-more" ? "加载中" : "加载更多"}</button>
  {/if}
  {#each filteredAudits.filter((audit) => audit.id === selectedAuditId) as audit}
    {@const statusMeta = auditStatusMeta(audit)}
    {@const replay = auditReplaySummary(audit)}
    {@const sideEffectDiff = auditSideEffectDiff(audit)}
    {@const paths = auditPathSummaries(audit)}
    <article class="audit-detail">
      <div class="audit-detail-head">
        <div>
          <strong>{audit.tool_name}</strong>
          <p>{audit.client_id}</p>
        </div>
        <div class="audit-stats">
          <span class={`status-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
          <span>{auditDurationLabel(audit.duration_ms)}</span>
          <time>{audit.timestamp}</time>
          <button
            disabled={busyKey === `audit:copy:${audit.id}`}
            onclick={() => copyAuditDetail(audit)}
          >复制详情</button>
        </div>
      </div>
      <div class="audit-summary-grid">
        {#each auditSummaryRows(audit) as row}
          <div class="audit-summary-cell">
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        {/each}
      </div>
      <section class="detail-block replay-block">
        <h4>回放摘要</h4>
        <div class="replay-summary-grid">
          <div>
            <span>权限结果</span>
            <strong>{replay.permissionLabel}</strong>
          </div>
          <div>
            <span>执行模式</span>
            <strong>{replay.executionMode}</strong>
          </div>
          <div>
            <span>本地副作用</span>
            <strong>{replay.sideEffectLabel}</strong>
          </div>
        </div>
        <ol class="replay-steps">
          {#each replay.steps as step}
            <li class={step.tone}>
              <span>{step.label}</span>
              <strong>{step.detail}</strong>
            </li>
          {/each}
        </ol>
      </section>
      {#if sideEffectDiff.rows.length > 0}
        <section class="detail-block">
          <h4>副作用 diff</h4>
          <div class="side-effect-summary">{sideEffectDiff.summary}</div>
          <div class="side-effect-diff-list">
            {#each sideEffectDiff.rows as row}
              <div class={`side-effect-diff-row ${row.tone}`}>
                <span>{row.action}</span>
                <code>{row.before || "—"}</code>
                <strong>→</strong>
                <code>{row.after || "—"}</code>
                <em>{row.status}</em>
                <small>{row.detail}</small>
              </div>
            {/each}
          </div>
        </section>
      {/if}
      {#if replay.pathChanges.length > 0}
        <section class="detail-block">
          <h4>路径副作用</h4>
          <div class="path-change-list">
            {#each replay.pathChanges as change}
              <div class="path-change-row">
                <span>{change.action}</span>
                <code>{change.source || "—"}</code>
                <strong>→</strong>
                <code>{change.target || "—"}</code>
                <em>{change.status}</em>
              </div>
            {/each}
          </div>
        </section>
      {/if}
      {#if paths.length > 0}
        <section class="detail-block">
          <h4>涉及路径</h4>
          <div class="path-chip-list">
            {#each paths as path}
              <code>{path}</code>
            {/each}
          </div>
        </section>
      {/if}
      <div class="audit-detail-grid">
        <section class="detail-block">
          <h4>输入参数</h4>
          <pre>{auditDetailValue(audit.input, "无输入")}</pre>
        </section>
        <section class="detail-block">
          <h4>输出结果</h4>
          <pre>{auditDetailValue(audit.output, "无输出")}</pre>
        </section>
        <section class="detail-block">
          <h4>错误信息</h4>
          <pre>{auditDetailValue(audit.error, "无错误")}</pre>
        </section>
      </div>
    </article>
  {/each}
</section>
