import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { InstalledPlugin } from "./types";
import type { PluginInventoryConfirmRequest, PluginInventoryServices } from "./pluginInventoryController";

/** Keep catalogue management on the same native commands and human capability pipeline. */
export function pluginInventoryServices(
  confirm: (request: PluginInventoryConfirmRequest) => Promise<boolean>,
): PluginInventoryServices {
  return {
    available: () => typeof window !== "undefined"
      && typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === "function",
    listPlugins: () => invoke<InstalledPlugin[]>("list_plugins"),
    async chooseDirectory(title) {
      const selected = await open({ directory: true, multiple: false, title });
      return Array.isArray(selected) ? selected[0] ?? null : selected;
    },
    installDirectory: path => invoke<InstalledPlugin>("install_plugin", { path }),
    updateDirectory: (pluginId, path) => invoke<InstalledPlugin>("update_plugin_from_path", { pluginId, path }),
    togglePlugin: (pluginId, enabled) => invoke<void>("toggle_plugin", { pluginId, enabled }),
    authorizePlugin: pluginId => invoke<InstalledPlugin>("authorize_plugin_permissions", { pluginId }),
    uninstallPlugin: pluginId => invoke<void>("uninstall_plugin", { pluginId }),
    async revealPath(path) {
      await invoke("call_agent_tool", {
        name: "open_or_reveal_path", arguments: { path, reveal: true }, clientId: "atools-ui", confirmed: true,
      });
    },
    confirm,
  };
}
