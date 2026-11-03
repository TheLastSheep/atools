<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import AToolsMark from "./AToolsMark.svelte";

  type Props = {
    onclose?: () => void;
  };

  let { onclose = () => {} }: Props = $props();

  let showMoreMenu = $state(false);
  let moreMenuStatus = $state("");
  let moreTrigger = $state<HTMLButtonElement>();
  let moreMenu = $state<HTMLDivElement>();
  let menuGeneration = 0;
  let disposed = false;

  async function toggleMoreMenu(event: MouseEvent) {
    event.stopPropagation();
    if (showMoreMenu) {
      closeMoreMenu();
      return;
    }
    moreMenuStatus = "";
    const generation = ++menuGeneration;
    showMoreMenu = true;
    await tick();
    if (!disposed && showMoreMenu && generation === menuGeneration) {
      moreMenu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }
  }

  function closeMoreMenu(returnFocus = false) {
    menuGeneration++;
    showMoreMenu = false;
    if (returnFocus) moreTrigger?.focus();
  }

  function closeAndReturnHome() {
    closeMoreMenu();
    onclose();
  }

  async function copyRuntimeInfo() {
    const generation = menuGeneration;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(runtimeInfoText());
      if (!disposed && showMoreMenu && generation === menuGeneration) moreMenuStatus = "已复制运行信息";
    } catch {
      if (!disposed && showMoreMenu && generation === menuGeneration) moreMenuStatus = "复制失败";
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

  function composing(event: KeyboardEvent) {
    return event.isComposing || event.keyCode === 229;
  }

  function activationKey(key: string) {
    return key === "Enter" || key === " ";
  }

  function onMoreTriggerKeydown(event: KeyboardEvent) {
    if (composing(event) && activationKey(event.key)) event.preventDefault();
  }

  function onMoreTriggerKeyup(event: KeyboardEvent) {
    if (composing(event) && activationKey(event.key)) event.preventDefault();
  }

  function onMoreMenuKeydown(event: KeyboardEvent) {
    if (!showMoreMenu) return;
    if (composing(event)) {
      if (activationKey(event.key)) event.preventDefault();
      return;
    }
    const items = Array.from(moreMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1 + items.length) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (activeIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      items[nextIndex]?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMoreMenu(true);
      return;
    }
    if (event.key === "Tab") {
      // Remove popup actions from the native tab sequence, then resume from its trigger.
      items.forEach((item) => { item.tabIndex = -1; });
      closeMoreMenu();
      moreTrigger?.focus();
    }
  }

  onDestroy(() => {
    disposed = true;
    menuGeneration++;
  });
</script>

<svelte:window onclick={onWindowClick} />

<header class="settings-header">
  <div class="settings-title">
    <AToolsMark size="small" />
    <h1>设置</h1>
  </div>
  <div class="header-actions">
    <button class="return-button" aria-label="回到主搜索" title="回到主搜索" onclick={closeAndReturnHome}>
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m7 4-4 4 4 4M3 8h10" /></svg>
      <span>返回搜索</span>
    </button>
    <div class="more-wrapper">
      <button bind:this={moreTrigger} class="more-btn" aria-label="更多操作" title="更多操作" aria-haspopup="menu"
        aria-expanded={showMoreMenu} aria-controls="settings-more-menu" onclick={toggleMoreMenu}
        onkeydown={onMoreTriggerKeydown} onkeyup={onMoreTriggerKeyup}>
        <span></span><span></span><span></span>
      </button>
    {#if showMoreMenu}
      <div bind:this={moreMenu} class="more-menu" id="settings-more-menu" role="menu" tabindex="-1" aria-label="设置更多操作"
        onkeydown={onMoreMenuKeydown}>
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
  </div>
</header>

<style>
  .settings-header {
    height: 56px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 20px;
    color: var(--text-primary);
    background: var(--bg-primary);
    -webkit-app-region: drag;
  }
  .settings-title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    line-height: 1.25;
    letter-spacing: -.2px;
  }
  .settings-header :global(.atools-mark.small) {
    --mark-size: 30px;
    --mark-radius: 9px;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    -webkit-app-region: no-drag;
  }
  .return-button, .more-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    border-radius: 6px;
    color: var(--text-secondary, #61616d);
    -webkit-app-region: no-drag;
  }
  .return-button {
    gap: 5px;
    padding: 0 9px;
    font-size: 12px;
  }
  .return-button svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .return-button:hover, .more-btn:hover {
    color: var(--text-primary);
    background: var(--accent-subtle, rgba(118, 80, 214, .08));
  }
  button:focus-visible {
    outline: 2px solid var(--accent, #7650d6);
    outline-offset: 2px;
  }
  .more-wrapper {
    position: relative;
    -webkit-app-region: no-drag;
  }
  .more-btn {
    width: 32px;
    gap: 3px;
  }
  .more-btn span {
    width: 3px;
    height: 3px;
    display: block;
    border-radius: 50%;
    background: currentColor;
  }
  .more-menu {
    position: absolute;
    top: 38px;
    right: 12px;
    z-index: 30;
    width: 174px;
    padding: 6px;
    border: 1px solid var(--border-color, rgba(0, 0, 0, .1));
    border-radius: 8px;
    background: var(--bg-primary);
    box-shadow: 0 12px 28px rgba(0, 0, 0, .16);
    -webkit-app-region: no-drag;
  }
  .more-menu-item {
    width: 100%;
    min-height: 42px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 550;
    text-align: left;
  }
  .more-menu-item:hover {
    color: var(--accent);
    background: var(--accent-subtle);
  }
  .more-menu-item:active { background: var(--accent-subtle); }
  .more-status {
    display: block;
    padding: 6px 10px 4px;
    color: var(--text-secondary, #61616d);
    font-size: 11px;
    line-height: 1.3;
  }
  @media (max-width: 540px) {
    .settings-header { padding: 0 14px; }
    .header-actions { gap: 4px; }
  }
</style>
