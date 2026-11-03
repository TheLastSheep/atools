<script lang="ts">
  type Props = { onmarket?: () => void; onmanage: () => void };
  let { onmarket, onmanage }: Props = $props();
</script>

<section class="home-empty" aria-labelledby="home-empty-title">
  <div class="home-empty-heading">
    <span class="home-empty-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2M8 10.8h5.6M10.8 8v5.6" />
      </svg>
    </span>
    <h2 id="home-empty-title">从搜索开始</h2>
  </div>
  <p>搜索应用或指令，也可以粘贴内容快速查找。</p>
  <div class="home-empty-actions">
    {#if onmarket}
      <button class="market-action" type="button" onclick={onmarket}>浏览插件市场</button>
    {/if}
    <button class="manage-action" type="button" onclick={onmanage}>管理插件</button>
  </div>
</section>

<style>
  .home-empty {
    box-sizing: border-box;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 4px 8px;
    color: var(--text-primary);
    text-align: center;
  }
  .home-empty-heading { display: flex; align-items: center; justify-content: center; gap: 8px; }
  .home-empty-mark {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    color: var(--accent);
    background: var(--accent-subtle);
  }
  svg { width: 16px; height: 16px; }
  h2 { margin: 0; font-size: 14px; font-weight: 700; line-height: 1.3; }
  p {
    max-width: 100%;
    margin: 0;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 16px;
  }
  .home-empty-actions { display: flex; max-width: 100%; flex-wrap: wrap; justify-content: center; gap: 4px; }
  button {
    box-sizing: border-box;
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 7px;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 80ms ease;
  }
  button:active { transform: scale(0.98); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .market-action { color: var(--accent-foreground); background: var(--accent); }
  .market-action:hover { filter: brightness(0.94); }
  .manage-action { color: var(--text-primary); border-color: var(--border); background: var(--bg-secondary); }
  .manage-action:hover { background: var(--bg-hover); }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
