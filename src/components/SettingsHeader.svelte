<script lang="ts">
  import ZMark from "./ZMark.svelte";

  type Props = {
    onclose?: () => void;
  };

  let { onclose = () => {} }: Props = $props();

  let showMoreMenu = $state(false);
  let moreMenuStatus = $state("");

  function toggleMoreMenu(event: MouseEvent) {
    event.stopPropagation();
    moreMenuStatus = "";
    showMoreMenu = !showMoreMenu;
  }

  function closeMoreMenu() {
    showMoreMenu = false;
  }

  function closeAndReturnHome() {
    showMoreMenu = false;
    onclose();
  }

  async function copyRuntimeInfo() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(runtimeInfoText());
      moreMenuStatus = "已复制运行信息";
    } catch {
      moreMenuStatus = "复制失败";
    }
  }

  function runtimeInfoText() {
    return [
      "ATools 3.0",
      `URL: ${location.href}`,
      `Platform: ${navigator.platform || "unknown"}`,
      `User Agent: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
  }

  function onWindowClick() {
    if (!showMoreMenu) return;
    closeMoreMenu();
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (!showMoreMenu || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    closeMoreMenu();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<header class="settings-header">
  <div class="tab active-tab">
    <ZMark size="small" />
    <span>设置</span>
  </div>

  <div class="tab secondary-tab">
    <span>设置</span>
    <button class="tab-close" aria-label="关闭设置" title="关闭设置" onclick={onclose}>×</button>
  </div>

  <div class="spacer"></div>

  <div class="more-wrapper">
    <button
      class="more-btn"
      aria-label="更多操作"
      title="更多操作"
      aria-haspopup="menu"
      aria-expanded={showMoreMenu}
      aria-controls="settings-more-menu"
      onclick={toggleMoreMenu}
    >
      <span></span>
      <span></span>
      <span></span>
    </button>
    {#if showMoreMenu}
      <div class="more-menu" id="settings-more-menu" role="menu" aria-label="设置更多操作">
        <button class="more-menu-item" role="menuitem" onclick={closeAndReturnHome}>回到主搜索</button>
        <button
          class="more-menu-item"
          role="menuitem"
          onclick={(event) => {
            event.stopPropagation();
            void copyRuntimeInfo();
          }}
        >
          复制运行信息
        </button>
        {#if moreMenuStatus}
          <span class="more-status" aria-live="polite">{moreMenuStatus}</span>
        {/if}
      </div>
    {/if}
  </div>
  <ZMark size="large" label="设置" />
</header>

<style>
  .settings-header {
    height: 94px;
    display: flex;
    align-items: flex-start;
    gap: 0;
    padding: 20px 22px 0;
    color: var(--text-primary);
    background: var(--bg-primary);
    -webkit-app-region: drag;
  }

  .tab {
    height: 72px;
    display: inline-flex;
    align-items: center;
    gap: 14px;
    padding: 0 24px;
    color: #303236;
    font-size: 26px;
    font-weight: 700;
    line-height: 1;
    -webkit-app-region: no-drag;
  }

  .active-tab {
    min-width: 196px;
    border-radius: 36px 0 0 36px;
    background: rgba(0, 0, 0, 0.08);
    clip-path: polygon(0 0, 100% 0, calc(100% - 28px) 100%, 0 100%);
  }

  .secondary-tab {
    min-width: 154px;
    margin-left: -28px;
    padding-left: 42px;
    border-radius: 0 36px 36px 0;
    color: rgba(48, 50, 54, 0.62);
    background: rgba(0, 0, 0, 0.035);
    font-weight: 650;
  }

  .tab-close {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 0;
    border-radius: 50%;
    color: rgba(48, 50, 54, 0.46);
    font-size: 30px;
    font-weight: 300;
    line-height: 1;
    -webkit-app-region: no-drag;
  }

  .tab-close:hover {
    color: rgba(48, 50, 54, 0.8);
    background: rgba(0, 0, 0, 0.08);
  }

  .spacer {
    flex: 1;
  }

  .more-wrapper {
    position: relative;
    height: 72px;
    margin: 0 12px 0 0;
    -webkit-app-region: no-drag;
  }

  .more-btn {
    width: 32px;
    height: 72px;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    color: rgba(48, 50, 54, 0.32);
    -webkit-app-region: no-drag;
  }

  .more-btn span {
    width: 5px;
    height: 5px;
    display: block;
    border-radius: 50%;
    background: currentColor;
  }

  .more-btn:hover {
    color: rgba(48, 50, 54, 0.56);
  }

  .more-menu {
    position: absolute;
    top: 64px;
    right: 12px;
    z-index: 30;
    width: 174px;
    padding: 6px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-primary) 96%, white);
    box-shadow: 0 16px 32px rgba(0, 0, 0, 0.16);
    -webkit-app-region: no-drag;
  }

  .more-menu-item {
    width: 100%;
    min-height: 42px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    border-radius: 6px;
    color: #303236;
    font-size: 13px;
    font-weight: 650;
    text-align: left;
  }

  .more-menu-item:hover {
    color: var(--accent);
    background: var(--accent-subtle);
  }

  .more-status {
    display: block;
    padding: 6px 10px 4px;
    color: rgba(48, 50, 54, 0.58);
    font-size: 11px;
    line-height: 1.3;
  }

  @media (prefers-color-scheme: dark) {
    .tab {
      color: #f2f3f5;
    }

    .active-tab {
      background: rgba(255, 255, 255, 0.12);
    }

    .secondary-tab {
      color: rgba(242, 243, 245, 0.58);
      background: rgba(255, 255, 255, 0.07);
    }

    .tab-close,
    .more-btn {
      color: rgba(242, 243, 245, 0.48);
    }

    .more-menu {
      border-color: rgba(255, 255, 255, 0.12);
      background: rgba(48, 49, 51, 0.98);
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.32);
    }

    .more-menu-item {
      color: #f2f3f5;
    }

    .more-status {
      color: rgba(242, 243, 245, 0.58);
    }
  }
</style>
