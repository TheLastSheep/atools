<script lang="ts">
  import {
    searchStatusBarView,
    type SearchStatusBarMode,
    type SearchStatusBarTabAction,
  } from "../lib/searchStatusBar";

  type Props = {
    mode: SearchStatusBarMode;
    count: number;
    selectedIndex: number;
    selectedLabel: string;
    selectedAction?: string;
    titleOverride?: string;
    detailOverride?: string;
    tabAction?: SearchStatusBarTabAction | string;
    tabTargetHint?: string;
    retryOnEnter?: boolean;
    spaceOpenCommand?: boolean;
    actionMenuAvailable?: boolean;
    onactionmenu?: (event: MouseEvent) => void;
    tabTargetFeedback?: string;
    ontargetsettings?: () => void;
  };

  let {
    mode,
    count,
    selectedIndex,
    selectedLabel,
    selectedAction = "",
    titleOverride = "",
    detailOverride = "",
    tabAction = "select",
    tabTargetHint = "",
    retryOnEnter = false,
    spaceOpenCommand = false,
    actionMenuAvailable = false,
    onactionmenu,
    tabTargetFeedback = "",
    ontargetsettings,
  }: Props = $props();

  const view = $derived(searchStatusBarView({
    mode,
    count,
    selectedIndex,
    selectedLabel,
    selectedAction,
    titleOverride,
    detailOverride,
    tabTargetHint,
    retryOnEnter,
    spaceOpenCommand,
    actionMenuAvailable,
    tabAction: tabAction === "target" ? "target" : "select",
  }));
</script>

<footer class="search-status-bar" aria-label="搜索状态和快捷键">
  <div class="status-layout">
  <div class="status-copy" class:has-feedback={tabAction === "target" && !!tabTargetFeedback} title={`${view.title} · ${tabAction === "target" && tabTargetFeedback ? tabTargetFeedback : view.detail}`}>
    <span class="status-title">{view.title}</span>
    {#if tabAction === "target" && tabTargetFeedback}
      <span class="status-detail target-feedback" role="status" title={tabTargetFeedback}>{tabTargetFeedback}</span>
    {:else}
      <span class="status-detail">{view.detail}</span>
      <span class="status-position">{view.position}</span>
    {/if}
  </div>

  <div class="status-hints" class:has-target-settings={tabAction === "target" && !!ontargetsettings} aria-label="可用快捷键">
    {#if count > 0}
      <span class="hint compact-navigation"><kbd class="keycap">{mode === "home" ? "↑↓←→" : "↑↓"}</kbd><span>移动</span></span>
    {/if}
    {#each view.hints as hint}
      {#if hint.key === "Tab" && tabAction === "target"}
        <span class="hint target-tab-hint" role="group" aria-label={`Tab：${hint.label}`} title={tabTargetHint || hint.label}>
          <kbd class="keycap">{hint.key}</kbd><span class="full-tab-label">{hint.label}</span><span class="compact-tab-label" aria-hidden="true">目标</span>
        </span>
        {#if ontargetsettings}
          <button type="button" class="target-settings" onclick={ontargetsettings} aria-label="设置 Tab 目标" title="打开 Tab 目标设置">
            <span>设置目标</span>
          </button>
        {/if}
      {:else}
        {#if hint.key === "⇧F10" && actionMenuAvailable && onactionmenu}
          <button type="button" class="action-menu-button" aria-haspopup="menu"
            aria-label={`更多操作：${selectedLabel.trim() || "当前项目"}`} title={`更多操作：${selectedLabel.trim() || "当前项目"}`}
            onmousedown={(event) => event.preventDefault()} onclick={onactionmenu}>
            <kbd class="keycap">{hint.key}</kbd>
            <span class="action-menu-label">{hint.label}</span><span class="action-menu-compact">更多操作</span><span class="action-menu-narrow">操作</span>
          </button>
        {:else}
          <span class="hint" class:paging-hint={hint.key === "PgUp/PgDn"} class:navigation-hint={hint.key.includes("↑") || hint.key === "↓"} class:action-menu-hint={hint.key === "⇧F10"} title={hint.label}>
            <kbd class="keycap">{hint.key}</kbd>
            {#if hint.key === "⇧F10"}
              <span class="action-menu-label">{hint.label}</span><span class="action-menu-compact">更多操作</span>
            {:else}
              <span class:full-tab-label={hint.key === "Tab" && tabAction === "target"}>{hint.label}</span>
            {/if}
            {#if hint.key === "Tab" && tabAction === "target"}<span class="compact-tab-label">目标</span>{/if}
          </span>
        {/if}
      {/if}
    {/each}
  </div>
  </div>
</footer>

<style>
  .target-feedback { color: var(--text-secondary); }
  .action-menu-compact { display: none; }
  .target-tab-hint { min-width: 0; max-width: 144px; }
  .target-tab-hint > .full-tab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .target-settings {
    min-height: 24px;
    flex: 0 0 auto;
    padding: 0 7px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 32%, transparent);
    border-radius: 6px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 84%, transparent);
    cursor: pointer;
    font: inherit;
    font-size: 10.5px;
    font-weight: 700;
    white-space: nowrap;
  }
  .target-settings:hover { color: var(--text-primary); background: var(--bg-primary); }
  .target-settings:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .action-menu-narrow { display: none; }
  .action-menu-button {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 32%, transparent);
    border-radius: 6px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 84%, transparent);
    cursor: pointer;
    font: inherit;
    font-size: 10.5px;
    font-weight: 700;
    white-space: nowrap;
    -webkit-app-region: no-drag;
  }
  .action-menu-button:hover { color: var(--text-primary); background: var(--bg-primary); }
  .action-menu-button:active { background: var(--accent-subtle); }
  .action-menu-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .search-status-bar {
    height: 34px;
    flex: 0 0 34px;
    min-width: 0;
    container: search-status / inline-size;
    border-top: 1px solid var(--border);
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-primary));
    -webkit-app-region: drag;
  }

  .status-layout {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 14px 0 16px;
  }

  .status-copy {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-title {
    flex: 0 0 auto;
    color: var(--text-primary);
    font-size: 11.5px;
    font-weight: 800;
  }

  .status-position { color: var(--text-tertiary); font-size: 11px; font-weight: 600; white-space: nowrap; }
  .status-position, .hint.compact-navigation, .compact-tab-label { display: none; }

  .status-detail {
    min-width: 0;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 11px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-hints {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    -webkit-app-region: no-drag;
  }

  .hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-tertiary);
    font-size: 10.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .keycap {
    min-width: 24px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 28%, transparent);
    border-bottom-color: color-mix(in srgb, var(--text-tertiary) 42%, transparent);
    border-radius: 5px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 84%, transparent);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--text-tertiary) 14%, transparent);
    font-family: inherit;
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
  }

  @container search-status (max-width: 880px) {
    .status-layout {
      gap: 10px;
      padding: 0 10px;
    }

    .status-hints {
      gap: 5px;
    }

    .hint.navigation-hint, .full-tab-label { display: none; }
    .hint.compact-navigation { display: inline-flex; }
    .compact-tab-label { display: inline; }
    .status-hints.has-target-settings .hint.paging-hint { display: none; }
  }

  @container search-status (max-width: 640px) {
    .hint.paging-hint { display: none; }
    .action-menu-label { display: none; }
    .action-menu-compact { display: inline; }
    .status-copy.has-feedback + .status-hints .action-menu-hint { display: none; }
    .status-copy:not(.has-feedback) .status-detail { display: none; }
    .status-position { display: inline; }
    .status-title { display: none; }
  }

  @container search-status (max-width: 520px) {
    .hint.compact-navigation { display: none; }
    .action-menu-hint { display: none; }
    .action-menu-button .keycap, .action-menu-button .action-menu-compact { display: none; }
    .action-menu-button .action-menu-narrow { display: inline; }
    .action-menu-button { padding: 0 7px; }
    .status-copy { gap: 0; }
  }
</style>
