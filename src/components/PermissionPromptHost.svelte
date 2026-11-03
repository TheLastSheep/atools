<script lang="ts">
  import { onMount } from "svelte";
  import PermissionConfirmDialog from "./PermissionConfirmDialog.svelte";
  import { createPermissionQueue, type PermissionEventListen } from "../lib/permissionQueue";
  import type { PermissionApprovalInvoke } from "../lib/permissionApproval";

  type Props = { invoke: PermissionApprovalInvoke; listen: PermissionEventListen; enabled?: boolean };
  let { invoke, listen, enabled = true }: Props = $props();
  const queue = createPermissionQueue(<T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args));
  let active = $derived($queue.items[0] ?? null);
  onMount(() => { if (enabled) return queue.connect(listen); });
  export function refresh() { return enabled ? queue.refresh() : Promise.resolve(); }
</script>

{#if active}
  {#key active.request.id}
    <PermissionConfirmDialog request={active.request} busy={active.busy} error={active.error} displayName={active.displayName} requestContext={active.requestContext}
      queuedCount={$queue.items.length}
      onallowonce={(request) => queue.approve(request.id)}
      onallowremember={(request) => queue.approve(request.id, true)}
      ondeny={(request) => queue.deny(request.id)} />
  {/key}
{/if}

{#if $queue.feedback && !active}
  <aside class="permission-feedback" role="alert">
    <div><strong>任务未完成</strong><p>{$queue.feedback.error}</p></div>
    <button onclick={() => queue.clearFeedback()}>关闭</button>
  </aside>
{/if}

<style>
  .permission-feedback { position: fixed; z-index: 50; inset: auto 16px 16px; display: flex; align-items: flex-start; gap: 16px; padding: 16px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-elevated); color: var(--text-primary); box-shadow: 0 8px 32px #0002; }
  strong { font-size: 13px; }
  p { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
  button { margin-left: auto; padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-tertiary); color: var(--text-primary); white-space: nowrap; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
