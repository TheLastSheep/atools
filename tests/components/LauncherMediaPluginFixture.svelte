<script lang="ts">
 import type { FeatureAction } from "../../src/lib/types";
 let {action,onclose}:{action:FeatureAction;onclose:()=>unknown}=$props();
</script>
<section aria-label="媒体插件验收"><output data-testid="media-entry-type">{action.entry_type}</output><output data-testid="media-entry-payload">{JSON.stringify(action.payload)}</output><button onclick={onclose}>关闭媒体插件</button></section>
