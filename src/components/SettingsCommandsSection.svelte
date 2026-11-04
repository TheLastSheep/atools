<script lang="ts">
  import type { CommandCenterStatusFilter } from "../lib/settingsPages";

  let {
    activeMenu,
    commandAliases,
    commandAliasStatus,
    commandCenterQuery = $bindable(),
    commandCenterSourceFilter = $bindable(),
    commandCenterStatusFilter = $bindable(),
    addCommandAlias,
    updateCommandAlias,
    removeCommandAlias,
    resetCommandAliases,
    toggleCommandCenterPinned,
    commandCenterTargetToggleLabel,
    canToggleCommandCenterTarget,
    toggleCommandCenterTarget,
    aliasTargetOptions,
    aliasTargetSummary,
    commandCenterSummary,
    commandCenterPinnedCount,
    commandCenterFilteredRows,
    commandCenterSourceDetail,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "commands"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>所有指令</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={() => addCommandAlias()}>添加别名</button>
              <button class="plain-button danger" onclick={resetCommandAliases} disabled={commandAliases.length === 0}>清空别名</button>
            </div>
          </div>
          <div class="inline-status">{commandAliasStatus} · 在主搜索输入别名会直接映射到目标指令</div>

          <div class="command-center-summary-grid">
            <div class="command-summary-card">
              <span>可绑定指令</span>
              <strong>{commandCenterSummary().totalTargets}</strong>
              <small>{commandCenterSummary().enabledTargets} 个启用</small>
            </div>
            <div class="command-summary-card">
              <span>指令别名</span>
              <strong>{commandCenterSummary().aliasCount}</strong>
              <small>{commandCenterSummary().enabledAliasCount} 个启用</small>
            </div>
            <div class="command-summary-card">
              <span>固定指令</span>
              <strong>{commandCenterPinnedCount()}</strong>
              <small>显示在主搜索首页</small>
            </div>
            <div class="command-summary-card">
              <span>来源分组</span>
              <strong>{commandCenterSummary().groups.filter((group: { count: number }) => group.count > 0).length}</strong>
              <small>系统 / 本地 / 网页</small>
            </div>
          </div>

          <div class="command-center-shell">
            <aside class="command-source-list" aria-label="指令来源">
              <button
                class:active={commandCenterSourceFilter === "all"}
                onclick={() => commandCenterSourceFilter = "all"}
              >
                <span>全部来源</span>
                <small>{commandCenterSummary().enabledTargets}/{commandCenterSummary().totalTargets} 启用</small>
              </button>
              {#each commandCenterSummary().groups.filter((group: { count: number }) => group.count > 0) as group}
                <button
                  class:active={commandCenterSourceFilter === group.id}
                  onclick={() => commandCenterSourceFilter = group.id}
                >
                  <span>{group.label}</span>
                  <small>{commandCenterSourceDetail(group)}</small>
                </button>
              {/each}
            </aside>

            <div class="command-center-main">
              <div class="command-filter-bar">
                <input
                  class="text-input command-search-input"
                  value={commandCenterQuery}
                  placeholder="搜索名称、路径、code 或别名"
                  aria-label="搜索所有指令"
                  oninput={(event) => commandCenterQuery = (event.target as HTMLInputElement).value}
                />
                <select
                  class="select-control compact"
                  value={commandCenterStatusFilter}
                  aria-label="指令状态"
                  onchange={(event) => commandCenterStatusFilter = (event.target as HTMLSelectElement).value as CommandCenterStatusFilter}
                >
                  <option value="all">全部状态</option>
                  <option value="enabled">仅启用</option>
                  <option value="disabled">仅停用</option>
                </select>
              </div>

              <div class="command-target-list">
                {#if commandCenterFilteredRows().length === 0}
                  <div class="empty-box">没有匹配的指令；可以切换来源、状态或清空搜索。</div>
                {:else}
                  {#each commandCenterFilteredRows() as row}
                    <div class="command-target-row" class:disabled={!row.enabled}>
                      <div class="command-target-icon">{row.sourceLabel.slice(0, 1)}</div>
                      <div class="command-target-body">
                        <div class="command-target-title">
                          <strong>{row.label}</strong>
                          <span class="meta-pill" class:active={row.enabled}>{row.statusLabel}</span>
                          {#if row.pinned}
                            <span class="meta-pill active">{row.pinStatusLabel}</span>
                          {/if}
                        </div>
                        <small>{row.explain || row.code}</small>
                        <div class="command-target-meta">
                          <code>{row.code}</code>
                          <span>{row.aliasLabel}</span>
                          <span>{row.aliasHint}</span>
                        </div>
                        {#if row.aliasPreview.length > 0}
                          <div class="command-alias-preview" aria-label={`${row.label} 已配置别名`}>
                            {#each row.aliasPreview as alias}
                              <span>{alias}</span>
                            {/each}
                          </div>
                        {/if}
                      </div>
                      <div class="row-actions">
                        <button class="plain-button" onclick={() => toggleCommandCenterPinned(row)}>{row.pinLabel}</button>
                        <button
                          class="plain-button"
                          title={canToggleCommandCenterTarget(row) ? `${commandCenterTargetToggleLabel(row)} ${row.label}` : "系统指令不可停用"}
                          disabled={!canToggleCommandCenterTarget(row)}
                          onclick={() => toggleCommandCenterTarget(row)}
                        >{commandCenterTargetToggleLabel(row)}</button>
                        <button class="plain-button" onclick={() => addCommandAlias(row.code)}>{row.aliasActionLabel}</button>
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>指令别名</h3>
            <span class="meta-pill">{commandAliases.length} 个</span>
          </div>

          {#if commandAliases.length === 0}
            <div class="empty-box">暂无自定义别名，可以先添加一个短词映射到系统命令、本地启动或网页快开。</div>
          {:else}
            <div class="alias-list">
              {#each commandAliases as entry}
                <div class="alias-row">
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onchange={(event) => updateCommandAlias(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                    />
                    <span></span>
                  </label>

                  <div class="alias-fields">
                    <input
                      class="text-input alias-input"
                      value={entry.alias}
                      aria-label="别名"
                      oninput={(event) => updateCommandAlias(entry.id, { alias: (event.target as HTMLInputElement).value })}
                    />
                    <select
                      class="select-control alias-target-select"
                      value={entry.targetCode}
                      aria-label="别名目标"
                      onchange={(event) => updateCommandAlias(entry.id, { targetCode: (event.target as HTMLSelectElement).value })}
                    >
                      {#each aliasTargetOptions() as target}
                        <option value={target.code}>{target.label}</option>
                      {/each}
                    </select>
                    <small>{aliasTargetSummary(entry.targetCode)}</small>
                  </div>

                  <button class="plain-button danger" onclick={() => removeCommandAlias(entry.id)}>删除</button>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
