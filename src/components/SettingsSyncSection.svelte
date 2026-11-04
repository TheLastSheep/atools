<script lang="ts">
  let {
    activeMenu,
    webdavEnabled,
    webdavUrl = $bindable(),
    webdavUsername = $bindable(),
    webdavPassword = $bindable(),
    webdavRemotePath = $bindable(),
    webdavSyncSettings = $bindable(),
    webdavSyncPlugins = $bindable(),
    webdavSyncClipboard = $bindable(),
    webdavSyncStatus,
    webdavLastPreview,
    webdavLastRestorePlan,
    webdavLastSettingsRestore,
    webdavLastClipboardRestore,
    webdavLastPluginDataRestore,
    webdavSelectedPluginConflictKeys,
    webdavConfigReady,
    webdavStatusText,
    updateWebdavEnabled,
    persistWebdavConfigChange,
    persistWebdavScopeChange,
    webdavSyncButton,
    webdavPreviewButton,
    webdavRestorePlanButton,
    webdavSettingsRestoreButton,
    webdavClipboardRestoreButton,
    webdavPluginDataRestoreButton,
    webdavPluginDataOverwriteButton,
    webdavPluginDataSelectedOverwriteButton,
    webdavPluginConflicts,
    webdavPluginConflictKey,
    webdavSelectedPluginConflicts,
    toggleWebdavPluginConflict,
    selectAllWebdavPluginConflicts,
    clearSelectedWebdavPluginConflicts,
    webdavStatusRows,
    webdavOverview,
    webdavRemotePreviewRows,
    webdavRemoteRestorePlanRows,
    webdavRemoteSettingsRestoreRows,
    webdavRemoteClipboardRestoreRows,
    webdavRemotePluginDataRestoreRows,
    syncWebdavNow,
    previewWebdavBackup,
    planWebdavRestore,
    restoreWebdavSettings,
    restoreWebdavClipboardHistory,
    restoreWebdavPluginData,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "sync"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>WebDAV 概览</h3>
            <span
              class="state-pill"
              class:enabled={webdavEnabled && webdavConfigReady()}
              class:error={webdavEnabled && !webdavConfigReady()}
            >
              {webdavStatusText()}
            </span>
          </div>
          <div class="inline-status">
            密码或 Token 仅本机保存；检查远端备份只读取 manifest 和文件摘要，不会覆盖本机设置、插件数据或剪贴板历史。
          </div>
          <div class="webdav-overview-grid" aria-label="WebDAV 概览：连接配置、远端目录、同步范围、最近结果">
            {#each webdavOverview() as card}
              <div
                class="webdav-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:desktop={card.tone === "desktop"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>连接配置</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>启用 WebDAV 配置</span>
              <small>配置完整后可作为后续设置、插件数据和剪贴板历史同步入口</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={webdavEnabled && webdavConfigReady()}
                disabled={!webdavConfigReady()}
                aria-label="启用 WebDAV 配置"
                title={webdavConfigReady() ? "启用 WebDAV 配置" : "填写服务器地址和用户名后可启用"}
                onchange={(event) => updateWebdavEnabled(
                  (event.currentTarget as HTMLInputElement).checked,
                  event.currentTarget as HTMLInputElement,
                )}
              />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>服务器地址</span>
              <small>仅支持 http 或 https WebDAV 地址</small>
            </div>
            <input
              class="text-input wide"
              bind:value={webdavUrl}
              placeholder="https://dav.example.com/remote.php/dav/files/user/"
              aria-label="WebDAV 服务器地址"
              oninput={persistWebdavConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>用户名</span>
              <small>账号只保存在本机设置中</small>
            </div>
            <input
              class="text-input wide"
              bind:value={webdavUsername}
              placeholder="username"
              aria-label="WebDAV 用户名"
              oninput={persistWebdavConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>密码 / Token</span>
              <small>建议使用应用专用密码或 token</small>
            </div>
            <input
              class="text-input wide"
              type="password"
              bind:value={webdavPassword}
              placeholder="app password"
              aria-label="WebDAV 密码或 Token"
              oninput={persistWebdavScopeChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>远端目录</span>
              <small>ATools 数据会统一放到该远端目录下</small>
            </div>
            <input
              class="text-input wide"
              bind:value={webdavRemotePath}
              placeholder="/ATools"
              aria-label="WebDAV 远端目录"
              oninput={persistWebdavScopeChange}
            />
          </div>
        </section>

        <section class="setting-group">
          <h3>同步范围</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>同步设置</span>
              <small>通用设置、网页快开、本地启动和命令别名</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={webdavSyncSettings} onchange={persistWebdavScopeChange} />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>同步插件数据</span>
              <small>插件本地数据可能较大；恢复时只追加缺失文档，冲突文档会跳过</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={webdavSyncPlugins} onchange={persistWebdavScopeChange} />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>同步剪贴板历史</span>
              <small>默认关闭；开启前应确认隐私风险</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={webdavSyncClipboard} onchange={persistWebdavScopeChange} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>同步状态</h3>
            <div class="row-actions">
              <button
                class="plain-button"
                onclick={previewWebdavBackup}
                disabled={webdavPreviewButton().disabled}
                title={webdavPreviewButton().reason}
              >
                {webdavPreviewButton().label}
              </button>
              <button
                class="plain-button"
                onclick={planWebdavRestore}
                disabled={webdavRestorePlanButton().disabled}
                title={webdavRestorePlanButton().reason}
              >
                {webdavRestorePlanButton().label}
              </button>
              <button
                class="plain-button"
                onclick={restoreWebdavSettings}
                disabled={webdavSettingsRestoreButton().disabled}
                title={webdavSettingsRestoreButton().reason}
              >
                {webdavSettingsRestoreButton().label}
              </button>
              <button
                class="plain-button"
                onclick={restoreWebdavClipboardHistory}
                disabled={webdavClipboardRestoreButton().disabled}
                title={webdavClipboardRestoreButton().reason}
              >
                {webdavClipboardRestoreButton().label}
              </button>
              <button
                class="plain-button"
                onclick={() => restoreWebdavPluginData()}
                disabled={webdavPluginDataRestoreButton().disabled}
                title={webdavPluginDataRestoreButton().reason}
              >
                {webdavPluginDataRestoreButton().label}
              </button>
              <button
                class="plain-button danger"
                onclick={() => restoreWebdavPluginData("overwrite_conflicts")}
                disabled={webdavPluginDataOverwriteButton().disabled}
                title={webdavPluginDataOverwriteButton().reason}
              >
                {webdavPluginDataOverwriteButton().label}
              </button>
              <button
                class="plain-button danger"
                onclick={() => restoreWebdavPluginData("overwrite_selected_conflicts")}
                disabled={webdavPluginDataSelectedOverwriteButton().disabled}
                title={webdavPluginDataSelectedOverwriteButton().reason}
              >
                {webdavPluginDataSelectedOverwriteButton().label}
              </button>
              <button
                class="plain-button"
                onclick={syncWebdavNow}
                disabled={webdavSyncButton().disabled}
                title={webdavSyncButton().reason}
              >
                {webdavSyncButton().label}
              </button>
            </div>
          </div>
          {#if webdavSyncStatus}
            <div class="inline-status">{webdavSyncStatus}</div>
          {:else}
            <div class="inline-status">
              检查远端备份只读取 manifest 和文件摘要，不会覆盖本机设置、插件数据或剪贴板历史。
            </div>
          {/if}
          <div class="debug-grid">
            {#each webdavStatusRows() as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
          {#if webdavLastPreview}
            <div class="remote-preview">
              <h4>远端备份预览</h4>
              <div class="debug-grid">
                {#each webdavRemotePreviewRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                当前只检查远端备份内容，不会覆盖本机设置、插件数据或剪贴板历史。
              </div>
            </div>
          {/if}
          {#if webdavLastRestorePlan}
            <div class="remote-preview">
              <h4>恢复计划预览</h4>
              <div class="debug-grid">
                {#each webdavRemoteRestorePlanRows() as row}
                  <div class="debug-row" class:warning={row.value.includes("高风险")}>
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                设置项可点击“恢复设置”后确认写入；剪贴板历史可追加导入；插件数据可追加导入，冲突文档会跳过，也可勾选后只覆盖选中冲突。
              </div>
              {#if webdavPluginConflicts().length}
                <div class="webdav-conflict-list">
                  <div class="section-heading compact-heading">
                    <h4>插件数据冲突选择</h4>
                    <div class="row-actions">
                      <button class="plain-button" onclick={selectAllWebdavPluginConflicts}>全选冲突</button>
                      <button class="plain-button" onclick={clearSelectedWebdavPluginConflicts}>清空选择</button>
                    </div>
                  </div>
                  <div class="compact-list">
                    {#each webdavPluginConflicts() as conflict}
                      <label class="webdav-conflict-row">
                        <input
                          type="checkbox"
                          checked={webdavSelectedPluginConflictKeys.includes(webdavPluginConflictKey(conflict))}
                          onchange={(event) => toggleWebdavPluginConflict(conflict, (event.target as HTMLInputElement).checked)}
                        />
                        <span>{conflict.plugin_name || conflict.plugin_id}</span>
                        <code>{conflict.doc_id}</code>
                        <small>{conflict.local_summary} -> {conflict.remote_summary}</small>
                      </label>
                    {/each}
                  </div>
                  <div class="inline-status">
                    已选择 {webdavSelectedPluginConflicts().length} / {webdavPluginConflicts().length} 条冲突；点击“覆盖选中冲突”后只覆盖这些文档。
                  </div>
                </div>
              {/if}
            </div>
          {/if}
          {#if webdavLastSettingsRestore}
            <div class="remote-preview">
              <h4>设置恢复结果</h4>
              <div class="debug-grid">
                {#each webdavRemoteSettingsRestoreRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                已通过现有设置保存链路应用到本机；远端脱敏字段保持本机原值。
              </div>
            </div>
          {/if}
          {#if webdavLastClipboardRestore}
            <div class="remote-preview">
              <h4>剪贴板导入结果</h4>
              <div class="debug-grid">
                {#each webdavRemoteClipboardRestoreRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                只追加导入本机缺失的文本历史；不会清空、覆盖或上传当前系统剪贴板。
              </div>
            </div>
          {/if}
          {#if webdavLastPluginDataRestore}
            <div class="remote-preview">
              <h4>插件数据导入结果</h4>
              <div class="debug-grid">
                {#each webdavRemotePluginDataRestoreRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                追加导入会跳过冲突文档；点击“覆盖冲突数据”并确认后，同 ID 冲突文档会被远端覆盖。
              </div>
            </div>
          {/if}
        </section>
      </div>
    {/if}
