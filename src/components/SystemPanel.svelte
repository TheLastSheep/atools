<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import AgentPanel from "./AgentPanel.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import ZToolsImportPanel from "./ZToolsImportPanel.svelte";
  import type { InstalledPlugin } from "../lib/types";
  import type { SettingsMenuId } from "../lib/settingsPages";
  import type { ShellPanel } from "../lib/uiState";

  type Props = {
    panel: ShellPanel;
    settingsMenu?: SettingsMenuId;
    onpanelchange: (panel: ShellPanel) => void;
  };

  let { panel, settingsMenu = "general", onpanelchange }: Props = $props();
  let plugins: InstalledPlugin[] = $state([]);
  let loadingPlugins = $state(false);
  let pluginError = $state("");
  let busyPluginId = $state("");

  onMount(() => {
    if (panel === "plugins") {
      refreshPlugins();
    }
  });

  $effect(() => {
    if (panel === "plugins") {
      refreshPlugins();
    }
  });

  function hasTauriRuntime() {
    const runtime = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    return typeof runtime?.invoke === "function";
  }

  async function refreshPlugins() {
    pluginError = "";
    if (!hasTauriRuntime()) {
      plugins = [];
      pluginError = "Tauri 运行时未连接，已安装插件需在桌面应用中查看";
      loadingPlugins = false;
      return;
    }
    loadingPlugins = true;
    try {
      plugins = await invoke<InstalledPlugin[]>("list_plugins");
    } catch (e) {
      pluginError = hasTauriRuntime() ? String(e) : "Tauri 运行时未连接，已安装插件需在桌面应用中查看";
    } finally {
      loadingPlugins = false;
    }
  }

  async function togglePlugin(plugin: InstalledPlugin) {
    if (!hasTauriRuntime()) {
      pluginError = "浏览器预览模式无法启停插件";
      return;
    }
    busyPluginId = plugin.id;
    try {
      await invoke("toggle_plugin", {
        pluginId: plugin.id,
        enabled: !plugin.enabled,
      });
      await refreshPlugins();
    } finally {
      busyPluginId = "";
    }
  }
</script>

<section class="system-panel" class:settings-shell={panel === "settings"}>
  {#if panel === "settings"}
    <SettingsPanel initialMenu={settingsMenu} />
  {:else if panel === "import"}
    <ZToolsImportPanel />
  {:else if panel === "agent"}
    <AgentPanel onclose={() => onpanelchange("home")} />
  {:else if panel === "results"}
    <AgentPanel view="results" onclose={() => onpanelchange("home")} />
  {:else if panel === "plugins"}
    <div class="system-head">
      <div>
        <h2>插件管理</h2>
        <p>查看已安装插件，控制启用状态。</p>
      </div>
      <button onclick={refreshPlugins} disabled={loadingPlugins}>刷新</button>
    </div>

    {#if pluginError}
      <div class="error">{pluginError}</div>
    {/if}

    {#if loadingPlugins && plugins.length === 0}
      <div class="empty">正在读取插件</div>
    {:else if plugins.length === 0}
      <div class="empty">还没有安装插件，可以先导入 ZTools 插件。</div>
    {:else}
      <div class="plugin-list">
        {#each plugins as plugin}
          <article class="plugin-row">
            <div class="plugin-main">
              <strong>{plugin.manifest.description ? plugin.name : plugin.name}</strong>
              <p>{plugin.version || "0.0.0"} · {plugin.manifest.features?.length ?? 0} features</p>
              <small>{plugin.path}</small>
            </div>
            <button
              class:enabled={plugin.enabled}
              disabled={busyPluginId === plugin.id}
              onclick={() => togglePlugin(plugin)}
            >
              {plugin.enabled ? "已启用" : "已停用"}
            </button>
          </article>
        {/each}
      </div>
    {/if}
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

  .system-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    margin-bottom: 4px;
    font-size: 15px;
    line-height: 1.3;
  }

  p,
  small,
  .empty {
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.45;
  }

  button {
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 7px 11px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font-size: 12px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-hover);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .error,
  .empty {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    background: var(--bg-secondary);
  }

  .error {
    color: #ff9b9b;
  }

  .plugin-list {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .plugin-row {
    min-height: 58px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 11px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
  }

  .plugin-row:last-child {
    border-bottom: 0;
  }

  .plugin-main {
    min-width: 0;
  }

  strong {
    display: block;
    overflow: hidden;
    margin-bottom: 3px;
    font-size: 13px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    display: block;
    overflow: hidden;
    margin-top: 3px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button.enabled {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
    color: var(--accent);
  }
</style>
