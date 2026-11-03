<script lang="ts">
  import type { FeatureAction } from "../../src/lib/types";
  let { action, onclose }: { action: FeatureAction; onclose: () => unknown } = $props();
</script>
<section aria-label="文本插件验收">
  <output data-testid="content-entry-type">{(action as FeatureAction & { entry_type?: string }).entry_type}</output>
  <output data-testid="content-entry-payload">{String(action.payload)}</output>
  <button onclick={onclose}>关闭文本插件</button>
</section>
