<script lang="ts">
  import SettingsLaunchAtLoginControl from "./SettingsLaunchAtLoginControl.svelte";
  import {
    hasTauriRuntime,
    iconFor,
    themeColors,
    themeOptions,
    windowMaterialOptions,
  } from "../lib/settingsPanelTypesAndOptions";

  let {
    activeMenu,
    nativeSettingsRuntime,
    saveState,
    hotkey = $bindable(),
    recordingHotkey,
    showHotkeyQuickActions,
    launchAtLogin = $bindable(),
    launchAtLoginRuntimeState = $bindable(),
    showTrayIcon = $bindable(),
    accessibilityPermission,
    accessibilityPermissionBusy,
    accessibilityPermissionMessage,
    wakeupBlacklist,
    wakeupBlacklistDraft = $bindable(),
    wakeupBlacklistStatus,
    theme = $bindable(),
    primaryColor = $bindable(),
    customColor = $bindable(),
    opacity = $bindable(),
    windowMaterial = $bindable(),
    refreshAccessibilityPermission,
    openAccessibilityPermissionSettings,
    removeWakeupItem,
    addWakeupItem,
    persistSoon,
    hotkeyPresets,
    defaultHotkey,
    startHotkeyRecording,
    toggleHotkeyQuickActions,
    applyHotkeyPreset,
    addCurrentWindowToWakeupBlacklist,
    hotkeyStatusText,
    generalOverview,
  }: Record<string, any> = $props();
</script>

{#if activeMenu === "general"}
      {@const generalSummary = generalOverview()}
        <section class="setting-group">
          <div class="section-heading">
            <h3>通用设置概览</h3>
            <span class="state-pill">{saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存"}</span>
          </div>
          <div class="inline-status">
            本页设置保存在本机；热键、开机启动和托盘显示会在桌面端同步到系统能力。
          </div>
          <div class="general-overview-grid" aria-label="通用设置概览：呼出快捷键、系统入口、搜索来源、暂缓能力">
            {#each generalSummary as card}
              <div
                class="general-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>
        <fieldset class="settings-fieldset" oninput={persistSoon} onchange={persistSoon}>
        <section class="setting-group">
          <h3>基础设置</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>呼出快捷键</span>
              <small>设置全局快捷键来呼出应用</small>
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
              <div class="quick-actions-wrapper">
                <button
                  class="icon-button"
                  class:active={showHotkeyQuickActions}
                  aria-label="快捷设置"
                  title="快捷设置"
                  onclick={toggleHotkeyQuickActions}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">{@html iconFor("settings")}</svg>
                </button>
                {#if showHotkeyQuickActions}
                  <div class="quick-actions-dropdown">
                    {#each hotkeyPresets() as preset}
                      <button
                        class="quick-actions-item"
                        class:active={hotkey === preset.value}
                        onclick={() => applyHotkeyPreset(preset.value)}
                      >
                        <span>{preset.label}</span>
                        <small>{preset.value} · {preset.description}</small>
                      </button>
                    {/each}
                    <button class="quick-actions-item reset" onclick={() => applyHotkeyPreset(defaultHotkey())}>
                      <span>重置</span>
                      <small>恢复为默认快捷键 {defaultHotkey()}</small>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>开机自动启动</span>
              <small>登录系统时自动启动应用</small>
            </div>
            {#if nativeSettingsRuntime}
              <SettingsLaunchAtLoginControl
                onStateChange={(enabled) => { launchAtLoginRuntimeState = enabled; }}
              />
            {:else}
              <label class="toggle">
                <input type="checkbox" bind:checked={launchAtLogin} />
                <span></span>
              </label>
            {/if}
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>显示托盘图标</span>
              <small>在系统托盘中显示应用图标</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={showTrayIcon} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>辅助功能权限</span>
              <small>仅快捷粘贴和模拟按键需要；未授权不会影响搜索、插件和剪贴板历史</small>
              {#if accessibilityPermissionMessage}
                <small>{accessibilityPermissionMessage}</small>
              {/if}
            </div>
            <div class="row-actions">
              <span
                class="state-pill"
                class:enabled={accessibilityPermission?.trusted === true}
                class:error={accessibilityPermission?.supported === true && accessibilityPermission?.trusted === false}
              >
                {accessibilityPermissionBusy
                  ? "检测中"
                  : accessibilityPermission?.supported === false
                    ? "当前系统无需授权"
                    : accessibilityPermission?.trusted
                      ? "已授权"
                      : accessibilityPermission
                        ? "未授权"
                        : "待检测"}
              </span>
              {#if accessibilityPermission?.supported !== false}
                <button
                  class="plain-button"
                  onclick={openAccessibilityPermissionSettings}
                  disabled={accessibilityPermissionBusy || !hasTauriRuntime()}
                >
                  打开系统设置
                </button>
                <button
                  class="plain-button"
                  onclick={refreshAccessibilityPermission}
                  disabled={accessibilityPermissionBusy || !hasTauriRuntime()}
                >
                  重新检测
                </button>
              {/if}
            </div>
          </div>

          <div class="setting-item blocked-row">
            <div class="blocked-main">
              <div class="blocked-head">
                <div class="setting-label">
                  <span>唤醒黑名单</span>
                  <small>前台应用命中黑名单时，全局快捷键不会唤醒主窗口</small>
                </div>
                <button
                  class="plain-button"
                  onclick={addCurrentWindowToWakeupBlacklist}
                  disabled={!hasTauriRuntime()}
                  title={hasTauriRuntime() ? "读取当前前台应用并加入黑名单" : "需在桌面应用中使用"}
                >
                  添加当前窗口
                </button>
              </div>
              <div class="inline-form">
                <input
                  class="text-input"
                  value={wakeupBlacklistDraft}
                  placeholder="应用名，例如 Terminal"
                  aria-label="唤醒黑名单应用名"
                  oninput={(event) => wakeupBlacklistDraft = (event.target as HTMLInputElement).value}
                  onkeydown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addWakeupItem();
                    }
                  }}
                />
                <button class="plain-button" onclick={addWakeupItem} disabled={!wakeupBlacklistDraft.trim()}>添加</button>
              </div>
              {#if wakeupBlacklistStatus}
                <div class="inline-status compact-status">{wakeupBlacklistStatus}</div>
              {/if}
              {#if wakeupBlacklist.length > 0}
                <div class="tag-list">
                  {#each wakeupBlacklist as app, i}
                    <span class="tag">
                      {app}
                      <button aria-label={`移除 ${app}`} onclick={() => removeWakeupItem(i)}>×</button>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </section>

        <section class="setting-group">
          <h3>外观</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>主题设置</span>
              <small>选择应用的主题外观</small>
            </div>
            <select class="select-control" bind:value={theme}>
              {#each themeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>主题色</span>
              <small>自定义应用的主色调</small>
            </div>
            <div class="color-control">
              {#each themeColors as color}
                <button
                  class="color-dot"
                  class:active={primaryColor === color.value}
                  style={`--dot-color: ${color.hex}`}
                  aria-label={color.label}
                  title={color.label}
                  onclick={() => { primaryColor = color.value; persistSoon(); }}
                ></button>
              {/each}
              <button
                class="color-dot custom"
                class:active={primaryColor === "custom"}
                style={`--dot-color: ${customColor}`}
                aria-label="自定义"
                title="自定义"
                onclick={() => { primaryColor = "custom"; persistSoon(); }}
              ></button>
              {#if primaryColor === "custom"}
                <input
                  class="color-picker-input"
                  type="color"
                  bind:value={customColor}
                  aria-label="自定义主题色"
                  oninput={persistSoon}
                />
              {/if}
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>窗口不透明度</span>
              <small>调整窗口的透明度</small>
            </div>
            <div class="range-control">
              <input type="range" min="0.3" max="1" step="0.01" bind:value={opacity} aria-label="窗口不透明度" />
              <output>{Math.round(opacity * 100)}%</output>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>窗口材质</span>
              <small>系统材质尚未接入原生窗口，暂不启用</small>
            </div>
            <select class="select-control" bind:value={windowMaterial} disabled>
              {#each windowMaterialOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>
        </section>
        </fieldset>
{/if}
