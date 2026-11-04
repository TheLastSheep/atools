<script lang="ts">
  import type { LocalLaunchKind } from "../lib/localLaunch";
  import { hasTauriRuntime } from "../lib/settingsPanelTypesAndOptions";

  let {
    activeMenu,
    localLaunchEntries,
    localLaunchStatus,
    webQuickOpenEntries,
    webQuickOpenStatus,
    webQuickOpenDraft,
    webQuickOpenValidation,
    webQuickOpenOverview,
    addWebQuickOpenEntry,
    updateWebQuickOpenEntry,
    removeWebQuickOpenEntry,
    resetWebQuickOpenEntries,
    openWebQuickOpenEditor,
    closeWebQuickOpenEditor,
    updateWebQuickOpenDraft,
    saveWebQuickOpenEditor,
    webQuickOpenTemplateMode,
    applyWebQuickOpenMode,
    webQuickOpenPreviewUrl,
    previewWebQuickOpenEntry,
    localLaunchOverview,
    addLocalLaunchEntry,
    addLocalLaunchEntryFromPicker,
    updateLocalLaunchEntry,
    removeLocalLaunchEntry,
    resetLocalLaunchEntries,
    openLocalLaunchPath,
    revealLocalLaunchPath,
    onLocalLaunchDragOver,
    onLocalLaunchDrop,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "web"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>网页快开概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={addWebQuickOpenEntry}>添加</button>
              <button class="plain-button" onclick={resetWebQuickOpenEntries}>恢复默认</button>
            </div>
          </div>
          <div class="inline-status">{webQuickOpenStatus} · 在主搜索输入 “g rust” 可快速打开网页搜索</div>
          <div class="inline-status">
            名称、关键字和 URL 模板只保存在本机；预览只打开目标 URL，不会上传搜索词或本地配置。
          </div>
          <div class="web-quick-overview-grid" aria-label="网页快开概览：快开入口、搜索模板、固定网址、保存状态">
            {#each webQuickOpenOverview() as card}
              <div
                class="web-quick-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
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
          <h3>快开配置</h3>
          <div class="web-quick-card-grid">
            {#each webQuickOpenEntries as entry}
              <article class="web-quick-card" class:disabled={!entry.enabled}>
                <div class="web-quick-card-head">
                  <label class="toggle compact-toggle">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      aria-label={`${entry.name} 启用状态`}
                      onchange={(event) => updateWebQuickOpenEntry(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                    />
                    <span></span>
                  </label>

                  <div class="web-quick-card-title">
                    <strong>{entry.name}</strong>
                    <small>{webQuickOpenTemplateMode(entry) === "search" ? "搜索模板" : "固定网址"}</small>
                  </div>

                  <span class="web-quick-keyword-chip">{entry.keyword}</span>
                </div>

                <code class="web-quick-preview-url">{webQuickOpenPreviewUrl(entry)}</code>

                <div class="web-quick-card-actions">
                  <button class="plain-button" onclick={() => openWebQuickOpenEditor(entry)}>编辑</button>
                  <button class="plain-button" onclick={() => previewWebQuickOpenEntry(entry)}>预览</button>
                  <button class="plain-button danger" onclick={() => removeWebQuickOpenEntry(entry)}>删除</button>
                </div>
              </article>
            {/each}
          </div>

          {#if webQuickOpenDraft}
            <div class="web-quick-editor-layer">
              <div class="web-quick-editor-panel" role="dialog" aria-modal="true" aria-labelledby="web-quick-editor-title">
                <div class="web-quick-editor-head">
                  <div>
                    <h4 id="web-quick-editor-title">编辑网页快开</h4>
                    <small>调整关键字、打开类型和 URL 模板</small>
                  </div>
                  <button class="plain-button" onclick={closeWebQuickOpenEditor}>关闭</button>
                </div>

                <div class="web-quick-mode-switch" role="group" aria-label="网页快开类型">
                  <button
                    class:active={webQuickOpenTemplateMode(webQuickOpenDraft) === "search"}
                    onclick={() => applyWebQuickOpenMode("search")}
                  >
                    搜索模板
                  </button>
                  <button
                    class:active={webQuickOpenTemplateMode(webQuickOpenDraft) === "direct"}
                    onclick={() => applyWebQuickOpenMode("direct")}
                  >
                    固定网址
                  </button>
                </div>

                <div class="web-quick-editor-fields">
                  <label>
                    <span>名称</span>
                    <input
                      class="text-input"
                      value={webQuickOpenDraft.name}
                      aria-label="编辑快开名称"
                      oninput={(event) => updateWebQuickOpenDraft({ name: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    <span>关键字</span>
                    <input
                      class="text-input keyword-input"
                      value={webQuickOpenDraft.keyword}
                      aria-label="编辑快开关键字"
                      oninput={(event) => updateWebQuickOpenDraft({ keyword: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    <span>URL 模板</span>
                    <input
                      class="text-input web-template-input"
                      value={webQuickOpenDraft.template}
                      aria-label="编辑 URL 模板"
                      oninput={(event) => updateWebQuickOpenDraft({ template: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                </div>

                <div class="web-quick-preview-box">
                  <span>URL 预览</span>
                  <code>{webQuickOpenPreviewUrl(webQuickOpenDraft)}</code>
                </div>

                {#if webQuickOpenValidation}
                  <div class="inline-status error-status">{webQuickOpenValidation}</div>
                {/if}

                <div class="web-quick-editor-actions">
                  <button class="plain-button" onclick={closeWebQuickOpenEditor}>取消</button>
                  <button class="plain-button primary" onclick={saveWebQuickOpenEditor}>保存</button>
                </div>
              </div>
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>使用方式</h3>
          <div class="shortcut-list">
            <div class="shortcut-row">
              <span>关键字 + 空格</span>
              <small>例如输入 “g tauri” 会打开 Google 搜索 tauri</small>
            </div>
            <div class="shortcut-row">
              <span>{`{query}`}</span>
              <small>URL 模板中用 {`{query}`} 作为搜索词占位，系统会自动 URL encode</small>
            </div>
          </div>
        </section>
      </div>
    {:else if activeMenu === "local"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>本地启动概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={() => addLocalLaunchEntryFromPicker("file")} disabled={!hasTauriRuntime()}>添加文件</button>
              <button class="plain-button" onclick={() => addLocalLaunchEntryFromPicker("folder")} disabled={!hasTauriRuntime()}>添加文件夹</button>
              <button class="plain-button" onclick={() => addLocalLaunchEntryFromPicker("app")} disabled={!hasTauriRuntime()}>添加应用</button>
              <button class="plain-button" onclick={addLocalLaunchEntry}>手动添加</button>
              <button class="plain-button" onclick={resetLocalLaunchEntries}>恢复默认</button>
            </div>
          </div>
          <div class="inline-status">{localLaunchStatus} · 在主搜索输入关键字可打开文件、文件夹或应用</div>
          <div class="inline-status">
            名称、关键字、类型和本地路径只保存在本机；打开或定位路径只在桌面端执行。
          </div>
          <div class="local-launch-overview-grid" aria-label="本地启动概览：启动入口、类型分布、桌面能力、保存状态">
            {#each localLaunchOverview() as card}
              <div
                class="local-launch-overview-card"
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
          <h3>启动项配置</h3>
          <div
            class="local-launch-dropzone"
            role="group"
            aria-label="拖拽添加本地启动项"
            ondragover={onLocalLaunchDragOver}
            ondrop={onLocalLaunchDrop}
          >
            <span>拖拽文件或文件夹到这里添加</span>
            <small>桌面端会读取真实路径；浏览器预览仅保留手动编辑和搜索预览</small>
          </div>

          <div class="local-launch-list">
            {#each localLaunchEntries as entry}
              <div class="local-launch-row">
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onchange={(event) => updateLocalLaunchEntry(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                  />
                  <span></span>
                </label>

                <div class="local-launch-fields">
                  <input
                    class="text-input local-name-input"
                    value={entry.name}
                    aria-label="启动项名称"
                    oninput={(event) => updateLocalLaunchEntry(entry.id, { name: (event.target as HTMLInputElement).value })}
                  />
                  <input
                    class="text-input keyword-input"
                    value={entry.keyword}
                    aria-label="启动关键字"
                    oninput={(event) => updateLocalLaunchEntry(entry.id, { keyword: (event.target as HTMLInputElement).value })}
                  />
                  <select
                    class="select-control local-kind-select"
                    value={entry.kind}
                    aria-label="启动项类型"
                    onchange={(event) => updateLocalLaunchEntry(entry.id, { kind: (event.target as HTMLSelectElement).value as LocalLaunchKind })}
                  >
                    <option value="folder">文件夹</option>
                    <option value="file">文件</option>
                    <option value="app">应用</option>
                  </select>
                  <input
                    class="text-input local-path-input"
                    value={entry.path}
                    aria-label="本地路径"
                    oninput={(event) => updateLocalLaunchEntry(entry.id, { path: (event.target as HTMLInputElement).value })}
                  />
                </div>

                <div class="local-launch-actions">
                  <button class="plain-button" onclick={() => openLocalLaunchPath(entry)}>打开</button>
                  <button class="plain-button" onclick={() => revealLocalLaunchPath(entry)}>定位</button>
                  <button class="plain-button danger" onclick={() => removeLocalLaunchEntry(entry)}>删除</button>
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>使用方式</h3>
          <div class="shortcut-list">
            <div class="shortcut-row">
              <span>关键字</span>
              <small>例如输入 “desktop” 会在主搜索中出现 “打开 桌面”</small>
            </div>
            <div class="shortcut-row">
              <span>路径</span>
              <small>支持 `~/Desktop` 这类路径；Tauri 桌面端会在打开时展开为用户目录</small>
            </div>
          </div>
        </section>
      </div>
    {/if}
