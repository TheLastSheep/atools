<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { FeatureAction } from "../../src/lib/types";
  let { action }: { action: FeatureAction } = $props();
  onMount(() => window.dispatchEvent(new CustomEvent("fixture-plugin-mounted", { detail: action.plugin_id })));
  onDestroy(() => window.dispatchEvent(new CustomEvent("fixture-plugin-destroyed", { detail: action.plugin_id })));
</script>
<section aria-label="隔离插件面板" data-plugin-id={action.plugin_id}>{action.plugin_name}<button type="button">插件内部操作</button></section>
