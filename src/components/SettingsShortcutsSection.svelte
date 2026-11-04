<script lang="ts">
  import LauncherTabTargetPicker from "./LauncherTabTargetPicker.svelte";
  import { shortcutTabs } from "../lib/settingsPages";
  import { tabKeyOptions } from "../lib/settingsPanelTypesAndOptions";

  let {
    activeMenu,
    activeShortcutTab = $bindable(),
    hotkey = $bindable(),
    recordingHotkey,
    appShortcuts,
    appShortcutStatus,
    spaceOpenCommand = $bindable(),
    tabKeyFunction = $bindable(),
    tabTarget = $bindable(),
    commandAliases,
    commandAliasStatus,
    persistSoon,
    startHotkeyRecording,
    hotkeyStatusText,
    addCommandAlias,
    updateCommandAlias,
    removeCommandAlias,
    resetCommandAliases,
    addAppShortcut,
    updateAppShortcut,
    removeAppShortcut,
    shortcutSaveText,
    shortcutHasProblem,
    aliasTargetOptions,
    aliasTargetSummary,
    shortcutBuiltIns,
    customAppShortcutRows,
    shortcutOverview,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "shortcuts"}
      {@const shortcutSummary = shortcutOverview()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>快捷键</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={() => addAppShortcut()}>添加快捷键</button>
              <button class="plain-button" onclick={() => addCommandAlias()}>添加映射</button>
            </div>
          </div>
          <div class="inline-status">
            对齐 ZTools 的快捷键页结构：全局快捷键、应用快捷键和指令别名分开管理；自定义应用快捷键已本地保存。
          </div>
          <div class="shortcut-tab-bar" role="tablist" aria-label="快捷键分类">
            {#each shortcutTabs() as tab}
              <button
                class="shortcut-tab"
                class:active={activeShortcutTab === tab.id}
                role="tab"
                aria-selected={activeShortcutTab === tab.id}
                onclick={() => activeShortcutTab = tab.id}
              >
                <span>{tab.label}</span>
                <small>{tab.description}</small>
              </button>
            {/each}
          </div>
          <div class="shortcut-summary-grid">
            {#each shortcutSummary.cards as card}
              <div class="shortcut-summary-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        {#if activeShortcutTab === "global"}
          <section class="setting-group">
            <h3>全局快捷键</h3>
            <div class="setting-item">
              <div class="setting-label">
                <span>呼出快捷键</span>
                <small>全局快捷键会立即保存并重新注册</small>
              </div>
              <div class="setting-control">
                <input
                  class="hotkey-input"
                  class:recording={recordingHotkey}
                  bind:value={hotkey}
                  readonly
                  aria-label="呼出快捷键"
                  title={hotkeyStatusText()}
                  onclick={startHotkeyRecording}
                />
                <span class="meta-pill" class:active={recordingHotkey} class:error={shortcutHasProblem()}>{hotkeyStatusText()}</span>
              </div>
            </div>
            <div class="setting-item">
              <div class="setting-label">
                <span>冲突/保存状态</span>
                <small>热键注册失败会显示为保存失败，不再静默成功</small>
              </div>
              <span class="state-pill" class:error={shortcutHasProblem()}>{shortcutSaveText()}</span>
            </div>
            <div class="empty-box">{shortcutSummary.emptyStates.global}</div>
          </section>
        {:else if activeShortcutTab === "app"}
          <section class="setting-group">
            <div class="section-heading">
              <h3>应用快捷键</h3>
              <div class="row-actions">
                <button class="plain-button" onclick={() => addAppShortcut()}>添加</button>
                <span class="meta-pill">{shortcutBuiltIns().length} 内置 / {appShortcuts.length} 自定义</span>
              </div>
            </div>
            {#if appShortcuts.length === 0}
              <div class="empty-box">{shortcutSummary.emptyStates.app}</div>
            {:else}
              <div class="inline-status">{appShortcutStatus}</div>
              <div class="shortcut-card-list custom-shortcut-list">
                {#each customAppShortcutRows() as row}
                  <div class="shortcut-card-row app-shortcut-row">
                    <label class="toggle">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onchange={(event) => updateAppShortcut(row.id, { enabled: (event.target as HTMLInputElement).checked })}
                      />
                      <span></span>
                    </label>
                    <input
                      class="text-input shortcut-edit-input"
                      value={row.shortcut}
                      aria-label="应用快捷键"
                      oninput={(event) => updateAppShortcut(row.id, { shortcut: (event.target as HTMLInputElement).value })}
                    />
                    <div class="setting-label">
                      <select
                        class="select-control"
                        value={row.targetCode}
                        aria-label="快捷键目标"
                        onchange={(event) => updateAppShortcut(row.id, { targetCode: (event.target as HTMLSelectElement).value })}
                      >
                        {#each aliasTargetOptions() as target}
                          <option value={target.code}>{target.label}</option>
                        {/each}
                      </select>
                      <small>{row.targetDetail}{row.conflictLabel === "无冲突" ? "" : ` · ${row.conflictLabel}`}</small>
                    </div>
                    <div class="row-actions">
                      <span
                        class="meta-pill"
                        class:error={["无效", "重复", "冲突", "目标缺失"].includes(row.statusLabel)}
                        class:pending={!row.enabled}
                      >{row.statusLabel}</span>
                      <button class="plain-button danger" onclick={() => removeAppShortcut(row.id)}>删除</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            <div class="setting-item">
              <div class="setting-label">
                <span>空格打开指令</span>
                <small>和主搜索键盘行为联动</small>
              </div>
              <label class="toggle">
                <input type="checkbox" bind:checked={spaceOpenCommand} onchange={persistSoon} />
                <span></span>
              </label>
            </div>
            <div class="setting-item">
              <div class="setting-label">
                <span>Tab 功能</span>
                <small>设置 Tab 键用于切换选中项，或直接进入指定指令</small>
              </div>
              <select class="select-control" bind:value={tabKeyFunction} onchange={persistSoon}>
                {#each tabKeyOptions as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>
            {#if tabKeyFunction === "target-command"}
              <LauncherTabTargetPicker value={tabTarget} onchange={(value) => { tabTarget = value; persistSoon(); }} />
            {/if}
            <div class="shortcut-card-list">
              {#each shortcutBuiltIns() as row}
                <div class="shortcut-card-row">
                  <div class="shortcut-key-display">{row.shortcut}</div>
                  <div class="setting-label">
                    <span>{row.target}</span>
                    <small>{row.scope}{row.configurable ? " · 可在本页配置行为" : " · 随主程序生效"}</small>
                  </div>
                  <span class="meta-pill">{row.configurable ? "可配置" : "内置"}</span>
                </div>
              {/each}
            </div>
          </section>
        {:else if activeShortcutTab === "alias"}
          <section class="setting-group">
            <div class="section-heading">
              <h3>指令别名</h3>
              <div class="row-actions">
                <button class="plain-button" onclick={() => addCommandAlias()}>添加映射</button>
                <button class="plain-button danger" onclick={resetCommandAliases} disabled={commandAliases.length === 0}>清空别名</button>
              </div>
            </div>
            <div class="inline-status">{commandAliasStatus} · 可绑定 {aliasTargetOptions().length} 个系统命令、本地启动或网页快开目标</div>
            {#if commandAliases.length === 0}
              <div class="empty-box">{shortcutSummary.emptyStates.alias}</div>
            {:else}
              <div class="shortcut-card-list">
                {#each commandAliases as entry}
                  <div class="shortcut-card-row alias-shortcut-row">
                    <div class="shortcut-key-display">{entry.alias}</div>
                    <div class="setting-label">
                      <span>{entry.enabled ? "已启用" : "已停用"}</span>
                      <small>{aliasTargetSummary(entry.targetCode)}</small>
                    </div>
                    <div class="row-actions">
                      <label class="toggle">
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          onchange={(event) => updateCommandAlias(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                        />
                        <span></span>
                      </label>
                      <button class="plain-button danger" onclick={() => removeCommandAlias(entry.id)}>删除</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
      </div>
    {/if}
