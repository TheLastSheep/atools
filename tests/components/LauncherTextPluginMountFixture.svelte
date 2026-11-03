<script lang="ts">
  import type { FeatureAction } from "../../src/lib/types";
  import type { PluginPanelMountExports, PluginPanelMountProps } from "../../src/lib/pluginPanelMount";
  import LauncherTextPluginFixture from "./LauncherTextPluginFixture.svelte";

  type Props = {
    action: FeatureAction | null;
    panelProps: PluginPanelMountProps | null;
    oninstance: (instance: PluginPanelMountExports | null) => void;
  };

  let { action, panelProps, oninstance }: Props = $props();

  $effect(() => {
    oninstance({ requestEscape: () => panelProps?.onescape() });
    return () => oninstance(null);
  });
</script>

{#if action && panelProps}
  <LauncherTextPluginFixture action={panelProps.action} onclose={panelProps.onclose} />
{/if}
