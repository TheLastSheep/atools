import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Bind native evidence to authorization, transport, AppKit and thin host integration. */
export async function pluginDialogSourceFiles(root) {
  const files = ["scripts/lib/plugin-dialog-source-binding.mjs", "src/lib/pluginNativeDialogBridge.ts",
    "src/lib/pluginDialogsController.ts", "src/lib/pluginDialogBridge.ts", "src/lib/pluginElectronAdapter.ts",
    "src/lib/pluginHostReopen.ts", "src/lib/pluginBridgeCapabilities.ts", "src/lib/pluginInvokePolicy.ts",
    "src/lib/permissionPresentation.ts", "src/lib/permissionDialogFocus.ts", "src/lib/modalFocusOwner.ts",
    "src/lib/settingsConfirmFocus.ts", "src/lib/pluginMarketDetailFocus.ts", "src/components/SettingsConfirmDialog.svelte",
    "src/components/PermissionConfirmDialog.svelte", "src/components/PluginDataNotice.svelte",
    "src/components/PluginPanel.svelte", "src-tauri/src/lib.rs", "src-tauri/src/window.rs",
    "src-tauri/src/plugin_execution_gates.rs", "src-tauri/src/plugin_lifecycle.rs", "src-tauri/src/plugin_lifecycle_permissions.rs", "src-tauri/src/plugin_code_revision.rs",
    "src-tauri/src/plugin_loopback.rs", "src-tauri/src/plugin_loopback_dialog.rs", "src-tauri/src/plugin_loopback_dialog_tests.rs",
    "src-tauri/src/plugin_loopback_origin.rs", "src-tauri/src/plugin_loopback_origin_tests.rs",
    "src-tauri/src/legacy_runtime/mod.rs", "src-tauri/src/legacy_runtime/privacy.rs",
    "src-tauri/src/legacy_runtime/permission_context.rs", "src-tauri/src/agent_tools.rs",
    "src-tauri/src/permission_requests.rs", "src-tauri/src/agent_tools/plugin_grants.rs",
    "src-tauri/src/agent_tools/task_run_pipeline.rs", "src-tauri/src/agent_tools/plugin_execution_snapshot.rs",
    "crates/atools-core/src/agent.rs", "crates/atools-core/src/task_run.rs", "crates/atools-core/src/db.rs", "crates/atools-core/src/db/task_run_claim.rs", "src-tauri/Cargo.toml", "Cargo.lock"];
  async function visit(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file); else if (entry.name.endsWith(".rs")) files.push(file);
    }
  }
  await visit("src-tauri/src/plugin_dialog_runtime");
  return files;
}
