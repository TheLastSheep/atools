<script lang="ts">
  export type PluginInventoryView = "installed" | "running";
  type Props = { value?: PluginInventoryView };

  let { value = $bindable<PluginInventoryView>("installed") }: Props = $props();
</script>

<div class="view-tabs" role="group" aria-label="插件视图">
  <button type="button" aria-pressed={value === "installed"} onclick={() => value = "installed"}>
    全部插件
  </button>
  <button type="button" aria-pressed={value === "running"} onclick={() => value = "running"}>
    运行会话
  </button>
</div>

<style>
  .view-tabs {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--settings-control-border, #d9d9e0);
    border-radius: 8px;
    background: var(--settings-control, #fafafd);
  }

  button {
    min-height: 28px;
    padding: 5px 10px;
    border: 0;
    border-radius: 6px;
    color: var(--settings-text-secondary, #61616d);
    background: transparent;
    font: inherit;
    font-size: 11px;
    font-weight: 550;
    line-height: 1.3;
    white-space: nowrap;
    cursor: pointer;
    transition: color 120ms ease, background-color 120ms ease;
  }

  button:hover {
    color: inherit;
    background: var(--settings-hover, #efedf8);
  }

  button[aria-pressed="true"] {
    color: var(--settings-primary, #7650d6);
    background: var(--settings-primary-soft, color-mix(in srgb, var(--settings-primary, #7650d6) 12%, white));
  }

  button:focus-visible {
    outline: 2px solid var(--settings-primary, #7650d6);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
  }
</style>
