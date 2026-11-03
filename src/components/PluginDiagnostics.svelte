<script lang="ts">
  import type { PluginHostRuntimeChip, PluginHostView } from "../lib/pluginHostView";
  type Props = { chips: PluginHostRuntimeChip[]; identity?: PluginHostView["diagnostics"]; expanded?: boolean };
  let { chips, identity, expanded = false }: Props = $props();
</script>

<details class="plugin-diagnostics" open={expanded}>
  <summary><span>插件信息</span><small class:error={chips[0]?.tone === "error"}>{chips[0]?.value ?? ""}</small></summary>
  <div class="plugin-runtime-strip" aria-label="插件运行状态">
    {#each chips as chip}
      <div class="runtime-chip" class:ready={chip.tone === "ready"} class:warning={chip.tone === "warning"} class:error={chip.tone === "error"} class:muted={chip.tone === "muted"}>
        <span>{chip.label}</span>
        <strong>{chip.value}</strong>
        <small>{chip.detail}</small>
      </div>
    {/each}
  </div>
  {#if identity}
    <dl class="diagnostic-identity">
      <div><dt>功能标识</dt><dd data-plugin-feature-code>{identity.featureCode}</dd></div>
      <div><dt>插件标识</dt><dd data-plugin-source>{identity.source}</dd></div>
    </dl>
  {/if}
</details>

<style>
  .plugin-diagnostics { flex-shrink: 0; border-bottom: 1px solid var(--border); }
  summary { min-height: 28px; display: flex; align-items: center; gap: 8px; padding: 4px 12px; cursor: pointer; color: var(--text-secondary); font-size: 11px; }
  summary::before { content: "›"; font-size: 16px; line-height: 1; }
  details[open] > summary::before { transform: rotate(90deg); }
  summary:hover { background: var(--bg-hover); }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  summary small { margin-left: auto; color: var(--text-tertiary); font-size: 10px; }
  summary small.error { color: var(--danger); }
  summary::-webkit-details-marker { display: none; }
  .diagnostic-identity { display: grid; gap: 4px; margin: 0; padding: 8px 12px; color: var(--text-secondary); font-size: 11px; }
  .diagnostic-identity div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
  .diagnostic-identity dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text-primary); font-family: var(--font-mono); user-select: text; }
  .plugin-runtime-strip {
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 7px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-secondary) 58%, var(--bg-primary));
  }

  .runtime-chip {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 1px 7px;
    align-items: baseline;
    padding: 5px 8px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 18%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--bg-primary) 80%, transparent);
  }

  .runtime-chip.ready {
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    background: color-mix(in srgb, var(--accent-subtle) 44%, var(--bg-primary));
  }

  .runtime-chip.warning {
    border-color: color-mix(in srgb, #d97706 34%, transparent);
    background: color-mix(in srgb, #f59e0b 10%, var(--bg-primary));
  }

  .runtime-chip.error {
    border-color: color-mix(in srgb, var(--danger) 36%, transparent);
    background: color-mix(in srgb, var(--danger) 9%, var(--bg-primary));
  }

  .runtime-chip.muted {
    background: color-mix(in srgb, var(--bg-secondary) 54%, transparent);
  }

  .runtime-chip span,
  .runtime-chip strong,
  .runtime-chip small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-chip span {
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 800;
  }

  .runtime-chip strong {
    color: var(--text-primary);
    font-size: 11.5px;
    font-weight: 850;
  }

  .runtime-chip small {
    grid-column: 1 / -1;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 650;
  }

  @media (max-width: 560px) { .plugin-runtime-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
