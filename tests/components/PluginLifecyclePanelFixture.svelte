<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { FeatureAction } from "../../src/lib/types";
  import type { PluginPanelMountExports, PluginPanelMountProps } from "../../src/lib/pluginPanelMount";

  type Props = {
    action: FeatureAction | null;
    panelProps?: PluginPanelMountProps | null;
    oninstance?: (instance: PluginPanelMountExports | null) => void;
  };

  let { action, panelProps, oninstance }: Props = $props();

  $effect(() => {
    if (!oninstance) return;
    oninstance({ requestEscape: () => panelProps?.onescape() });
    return () => oninstance(null);
  });

  const activeAction = $derived(panelProps?.action ?? action ?? null);
  const activePluginId = $derived(activeAction?.plugin_id ?? null);

  $effect(() => {
    const pluginId = activePluginId;
    if (!pluginId) return;
    window.dispatchEvent(new CustomEvent("fixture-plugin-mounted", { detail: pluginId }));
    return () => {
      window.dispatchEvent(new CustomEvent("fixture-plugin-destroyed", { detail: pluginId }));
    };
  });
</script>
{#if activeAction}
  <section aria-label="隔离插件面板" data-plugin-id={activeAction.plugin_id}>{activeAction.plugin_name}<button type="button">插件内部操作</button></section>
{/if}
