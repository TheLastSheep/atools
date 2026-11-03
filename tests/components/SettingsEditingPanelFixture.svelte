<script lang="ts">
  import type { SettingsMenuId } from "../../src/lib/settingsPages";
  import type { PluginMarketRequest } from "../../src/lib/pluginMarketNavigation";

  let { initialMenu, marketRequest }: { initialMenu: SettingsMenuId; marketRequest: PluginMarketRequest | null } = $props();
</script>

<section aria-label="设置表单夹具" data-menu={initialMenu} data-market-plugin={marketRequest?.pluginName ?? ""}>
  设置表单已加载
</section>
