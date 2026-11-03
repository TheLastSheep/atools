<script lang="ts">
  import { onMount } from "svelte";
  import type { MainPushState } from "../../src/lib/launcherMainPush";
  let { onupdate }: { onupdate: (state: MainPushState) => void } = $props();
  onMount(() => {
    const receive = (event: Event) => onupdate((event as CustomEvent<MainPushState>).detail);
    window.addEventListener("fixture-main-push-layout", receive);
    return () => window.removeEventListener("fixture-main-push-layout", receive);
  });
  export function owns() { return false; }
  export async function select() {}
  export async function enterGroup() {}
  export async function requestEscape() {}
  export async function closePromoted() {}
</script>
<div data-testid="main-push-layout-host"></div>
