<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import ZToolsImportPanel from "../../src/components/ZToolsImportPanel.svelte";
  import PermissionConfirmDialog from "../../src/components/PermissionConfirmDialog.svelte";
  import { createPermissionQueue } from "../../src/lib/permissionQueue";
  const queue = createPermissionQueue(invoke);
  onMount(() => queue.connect(listen));
</script>

<main style="padding:20px; min-height:100vh; background:var(--bg-primary)">
  <ZToolsImportPanel />
</main>
{#if $queue.items[0]}
  {@const current = $queue.items[0]}
  <PermissionConfirmDialog request={current.request} busy={current.busy} error={current.error}
    displayName={current.displayName} requestContext={current.requestContext} queuedCount={$queue.items.length}
    onallowonce={request => queue.approve(request.id)} onallowremember={request => queue.approve(request.id, true)}
    ondeny={request => queue.deny(request.id)} />
{/if}
