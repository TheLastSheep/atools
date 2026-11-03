<script lang="ts">
  import type { SettingsMenuId } from "../../src/lib/settingsPages";
  import type { PluginMarketRequest } from "../../src/lib/pluginMarketNavigation";
  let { initialMenu = "general", marketRequest = null }: {
    initialMenu?: SettingsMenuId;
    marketRequest?: PluginMarketRequest | null;
  } = $props();
</script>

<section aria-label="市场导航接入夹具">
  <span data-menu>{initialMenu}</span>
  <span data-source>{marketRequest?.source ?? ""}</span>
  <span data-plugin>{marketRequest?.pluginName ?? ""}</span>
</section>
