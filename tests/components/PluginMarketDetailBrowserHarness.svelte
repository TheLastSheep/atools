<script lang="ts">
  import { onDestroy } from "svelte";
  import PluginMarketPanel from "../../src/components/PluginMarketPanel.svelte";
  import SettingsConfirmDialog from "../../src/components/SettingsConfirmDialog.svelte";
  import PermissionPromptHost from "../../src/components/PermissionPromptHost.svelte";
  import ShellFrame from "../../src/components/ShellFrame.svelte";
  import type { createPermissionHarnessBackend } from "./permissionHarnessBackend";
  import type { MarketConfirm } from "../../src/lib/pluginMarketView";

  let { recordConfirmation, permissionBackend }: { recordConfirmation: (request: MarketConfirm) => void;
    permissionBackend: ReturnType<typeof createPermissionHarnessBackend> } = $props();
  let confirmation = $state<(MarketConfirm & { resolve: (answer: boolean) => void }) | null>(null);
  function confirm(request: MarketConfirm) {
    recordConfirmation(request);
    confirmation?.resolve(false);
    return new Promise<boolean>(resolve => { confirmation = { ...request, resolve }; });
  }
  function answer(value: boolean) {
    const pending = confirmation;
    confirmation = null;
    pending?.resolve(value);
  }
  onDestroy(() => answer(false));
</script>

{#snippet emptySearch()}{/snippet}
<ShellFrame activePanel="settings" expanded contentVisible searchVisible={false} search={emptySearch}>
<div class="fixture-shell">
  <PluginMarketPanel custom={false} url="" trustedPublicKeys="" {confirm} />
  {#if confirmation}
    <SettingsConfirmDialog title={confirmation.title} message={confirmation.message}
      confirmLabel={confirmation.confirmLabel} tone={confirmation.tone} onconfirm={() => answer(true)} oncancel={() => answer(false)} />
  {/if}
</div>
</ShellFrame>

<PermissionPromptHost invoke={permissionBackend.invoke} listen={permissionBackend.listen} />

<style>
  .fixture-shell { position: relative; height: 100%; min-width: 0; overflow: hidden;
    --settings-text-primary: var(--text-primary); --settings-text-secondary: var(--text-secondary);
    --settings-surface: var(--bg-primary); --settings-control: var(--bg-elevated);
    --settings-control-border: var(--border-strong); --settings-divider: var(--border);
    --settings-primary: var(--accent); --settings-primary-soft: var(--accent-subtle); --settings-hover: var(--bg-hover); }
</style>
