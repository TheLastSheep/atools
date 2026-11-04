<script lang="ts">
  import { auditDataOverview } from "../lib/auditView";
  import {
    AUDIT_KEEP_LATEST,
    AUDIT_RETENTION_DAYS,
    hasTauriRuntime,
  } from "../lib/settingsPanelTypesAndOptions";

  let {
    activeMenu,
    dataLoading,
    dataStatus,
    auditArchiveBusy,
    auditPruneBusy,
    installedPlugins,
    pluginDataSummary,
    recentAudits,
    clipboardHistory,
    commandHistory,
    refreshDataPage,
    exportSettings,
    exportCommandHistory,
    clearCommandHistory,
    removeCommandHistoryItem,
    exportClipboardHistory,
    clearClipboardHistory,
    resetSettings,
    exportAudits,
    archiveAudits,
    clearAudits,
    pruneAuditEntries,
    exportPluginData,
    clearPluginData,
    commandHistoryDetail,
    commandHistoryRowDetail,
    dataOverview,
    dataAuditRetentionRows,
  }: Record<string, any> = $props();

  let dataAuditOverview = $derived(auditDataOverview(recentAudits));
</script>

    {#if activeMenu === "data"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>我的数据</h3>
            <button class="plain-button" onclick={refreshDataPage} disabled={dataLoading}>刷新</button>
          </div>
          {#if dataStatus}
            <div class="inline-status">{dataStatus}</div>
          {/if}
          <div class="data-overview-grid" aria-label="数据概览">
            {#each dataOverview() as card}
              <div class="data-overview-card" class:desktop={card.tone === "desktop"} class:private={card.tone === "private"}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
          <div class="inline-status">
            本地隐私边界：设置、最近使用、剪贴板历史、审计记录和插件数据默认保存在本机；Agent 只能通过授权工具读取，并写入本地审计。
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>设置数据</span>
              <small>导出当前设置，或恢复默认设置</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportSettings}>导出</button>
              <button class="plain-button danger" onclick={resetSettings}>恢复默认</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>最近使用历史</span>
              <small>{commandHistoryDetail()}</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportCommandHistory}>导出</button>
              <button class="plain-button danger" onclick={clearCommandHistory} disabled={commandHistory.length === 0}>清空</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>剪贴板历史</span>
              <small>最近 {clipboardHistory.length} 条；仅本地保存，供 Agent 搜索剪贴板历史</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportClipboardHistory} disabled={!hasTauriRuntime() || clipboardHistory.length === 0}>导出</button>
              <button class="plain-button danger" onclick={clearClipboardHistory} disabled={!hasTauriRuntime() || clipboardHistory.length === 0}>清空</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>审计数据</span>
              <small>最近 {recentAudits.length} 条；可复制或归档最多 1000 条 JSONL；保留策略为 {AUDIT_RETENTION_DAYS} 天 / 最新 {AUDIT_KEEP_LATEST} 条</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportAudits} disabled={!hasTauriRuntime()}>导出</button>
              <button class="plain-button" onclick={archiveAudits} disabled={!hasTauriRuntime() || auditArchiveBusy}>归档到文件</button>
              <button class="plain-button" onclick={pruneAuditEntries} disabled={!hasTauriRuntime() || auditPruneBusy}>清理旧记录</button>
              <button class="plain-button danger" onclick={clearAudits} disabled={!hasTauriRuntime()}>清空</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>插件数据</span>
              <small>{installedPlugins.length} 个插件；按插件读取本地数据文档</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportPluginData} disabled={installedPlugins.length === 0}>导出</button>
              <button class="plain-button danger" onclick={clearPluginData} disabled={installedPlugins.length === 0}>清空</button>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>审计保留策略</h3>
            <button class="plain-button" onclick={pruneAuditEntries} disabled={!hasTauriRuntime() || auditPruneBusy}>按策略清理</button>
          </div>
          <div class="compact-list">
            {#each dataAuditRetentionRows() as row}
              <div class="data-row compact">
                <div class="setting-label">
                  <span>{row.label}</span>
                  <small>{row.detail}</small>
                </div>
                <span
                  class="meta-pill"
                  class:active={row.tone === "private"}
                  class:pending={row.tone === "warning"}
                >
                  {row.value}
                </span>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>审计数据概览</h3>
            <span class="meta-pill">{dataAuditOverview.totalLabel}</span>
          </div>
          {#if recentAudits.length === 0}
            <div class="empty-box">暂无审计记录；Agent 或 MCP 调用工具后会在本地留下可回放记录</div>
          {:else}
            <div class="overview-columns">
              <div class="overview-block">
                <h4>状态分布</h4>
                <div class="compact-list">
                  {#each dataAuditOverview.statusRows as row}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>按权限和执行结果归类</small>
                      </div>
                      <span
                        class="meta-pill"
                        class:active={row.tone === "success"}
                        class:denied={row.tone === "denied"}
                        class:error={row.tone === "error"}
                        class:pending={row.tone === "pending"}
                      >
                        {row.value}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
              <div class="overview-block">
                <h4>高频工具</h4>
                <div class="compact-list">
                  {#each dataAuditOverview.toolRows as row}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>最近审计记录中的调用次数</small>
                      </div>
                      <span class="meta-pill">{row.value}</span>
                    </div>
                  {/each}
                </div>
              </div>
              <div class="overview-block">
                <h4>客户端</h4>
                <div class="compact-list">
                  {#each dataAuditOverview.clientRows as row}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>最近审计记录中的来源客户端</small>
                      </div>
                      <span class="meta-pill">{row.value}</span>
                    </div>
                  {/each}
                </div>
              </div>
            </div>
            <div class="overview-block">
              <h4>最近记录</h4>
              <div class="compact-list">
                {#each dataAuditOverview.recentRows as row}
                  <div class="data-row">
                    <div class="setting-label">
                      <span>{row.label}</span>
                      <small>{row.detail}</small>
                    </div>
                    <div class="overview-row-meta">
                      <span
                        class="meta-pill"
                        class:active={row.tone === "success"}
                        class:denied={row.tone === "denied"}
                        class:error={row.tone === "error"}
                        class:pending={row.tone === "pending"}
                      >
                        {row.value}
                      </span>
                      {#if row.meta}
                        <code class="mono-value">{row.meta}</code>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
            <div class="overview-block">
              <h4>异常记录</h4>
              {#if dataAuditOverview.errorRows.length === 0}
                <div class="empty-box">暂无拒绝或失败记录</div>
              {:else}
                <div class="compact-list">
                  {#each dataAuditOverview.errorRows as row}
                    <div class="data-row">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>{row.meta}</small>
                      </div>
                      <div class="audit-error-meta">
                        <span class="meta-pill" class:denied={row.tone === "denied"} class:error={row.tone === "error"}>{row.value}</span>
                        <code class="mono-value">{row.detail}</code>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>剪贴板历史明细</h3>
          {#if clipboardHistory.length === 0}
            <div class="empty-box">暂无剪贴板历史；Agent 调用 search_clipboard 后会记录当前文本剪贴板</div>
          {:else}
            <div class="compact-list">
              {#each clipboardHistory.slice(0, 12) as entry}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{entry.text}</span>
                    <small>{entry.last_copied_at} · {entry.used_count} 次 · {entry.id}</small>
                  </div>
                  <span class="meta-pill">text</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>插件数据概览</h3>
          {#if pluginDataSummary.length === 0}
            <div class="empty-box">暂无插件数据</div>
          {:else}
            <div class="compact-list">
              {#each pluginDataSummary as item}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{item.plugin.name}</span>
                    <small>{item.plugin.id}{item.error ? ` · ${item.error}` : ""}</small>
                  </div>
                  <span class="meta-pill">{item.documents} 条</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>最近使用明细</h3>
          {#if commandHistory.length === 0}
            <div class="empty-box">暂无最近使用历史</div>
          {:else}
            <div class="compact-list">
              {#each commandHistory.slice(0, 12) as entry}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{entry.label}</span>
                    <small>{commandHistoryRowDetail(entry)}</small>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill">{entry.code}</span>
                    <button class="plain-button danger" onclick={() => removeCommandHistoryItem(entry)}>删除</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
