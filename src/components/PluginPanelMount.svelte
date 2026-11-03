<script lang="ts">
  import { mount, unmount, type Component } from "svelte";
  import type { FeatureAction } from "../lib/types";
  import type { PluginPanelMountExports, PluginPanelMountProps } from "../lib/pluginPanelMount";
  import { settlePluginPanelLoad } from "../lib/pluginPanelMountLoad";

  type Props = {
    action: FeatureAction | null;
    panelProps: PluginPanelMountProps | null;
    oninstance: (instance: PluginPanelMountExports | null) => void;
  };
  let { action, panelProps, oninstance }: Props = $props();
  let host: HTMLDivElement | null = $state(null);
  let instance: PluginPanelMountExports | null = null;
  let loadToken = 0;

  function destroy() {
    if (!instance) return;
    unmount(instance);
    instance = null;
    oninstance(null);
  }

  $effect(() => {
    const target = host;
    const currentAction = action;
    const currentProps = panelProps;
    const token = ++loadToken;
    if (!target || !currentAction || !currentProps) { destroy(); return; }
    let disposed = false;
    void settlePluginPanelLoad(
      () => import("./PluginPanel.svelte"),
      () => !disposed && token === loadToken && action === currentAction && host === target && panelProps === currentProps,
      module => {
        destroy();
        instance = mount(module.default as Component<PluginPanelMountProps, PluginPanelMountExports>, {
          target, props: currentProps,
        });
        oninstance(instance);
      },
      error => {
        currentProps.onloaderror?.(error);
        console.warn("[PluginPanel] failed to lazy-load plugin panel:", error);
      },
    );
    return () => {
      disposed = true;
      if (token === loadToken) destroy();
    };
  });
</script>

<div class="plugin-panel-host" bind:this={host}></div>

<style>
  .plugin-panel-host {
    display: flex;
    height: 100%;
    min-height: 0;
  }
</style>
