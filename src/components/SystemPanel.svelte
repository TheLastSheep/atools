<script lang="ts">
  import AgentPanel from "./AgentPanel.svelte";
  import SettingsEditingGate from "./SettingsEditingGate.svelte";
  import ZToolsImportPanel from "./ZToolsImportPanel.svelte";
  import type { SettingsMenuId } from "../lib/settingsPages";
  import type { ShellPanel } from "../lib/uiState";
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";

  type Props = {
    panel: ShellPanel;
    settingsMenu?: SettingsMenuId;
    marketRequest?: PluginMarketRequest | null;
    onmarketrequest?: (request: PluginMarketRequest) => void;
    onpanelchange: (panel: ShellPanel) => void;
  };

  let { panel, settingsMenu = "general", marketRequest = null, onmarketrequest, onpanelchange }: Props = $props();
</script>

<section class="system-panel" class:settings-shell={panel === "settings" || panel === "plugins"} class:import-shell={panel === "import"}>
  {#if panel === "settings" || panel === "plugins"}
    <SettingsEditingGate initialMenu={panel === "plugins" ? "plugins" : settingsMenu} {marketRequest} />
  {:else if panel === "import"}
    <ZToolsImportPanel {onmarketrequest} />
  {:else if panel === "agent"}
    <AgentPanel onclose={() => onpanelchange("home")} />
  {:else if panel === "results"}
    <AgentPanel view="results" onclose={() => onpanelchange("home")} />
  {/if}
</section>

<style>
  .system-panel {
    min-height: 320px;
    padding: 18px;
  }

  .system-panel.settings-shell {
    min-height: 0;
    height: 100%;
    padding: 0;
  }

  .system-panel.import-shell {
    min-height: 0;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
  }

</style>
