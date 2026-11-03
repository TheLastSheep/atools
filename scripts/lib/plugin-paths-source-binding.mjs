import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Explicit path metadata, permission and lifetime inputs shared by native evidence wrappers. */
export async function pluginPathsSourceFiles(root) {
  const files = ["scripts/lib/plugin-paths-source-binding.mjs", "src/lib/pluginPathsBridge.ts",
    "src/lib/pluginPathsController.ts", "src/lib/pluginElectronAdapter.ts", "src/lib/pluginInvokePolicy.ts",
    "src/lib/pluginHostReopen.ts", "src/lib/pluginNativeImagePath.ts", "src/lib/permissionPresentation.ts", "src/components/PluginDataNotice.svelte",
    "src-tauri/src/lib.rs", "src-tauri/src/plugin_lifecycle.rs", "src-tauri/src/plugin_lifecycle_permissions.rs",
    "src-tauri/src/agent_tools.rs", "src-tauri/src/agent_tools/task_run_pipeline.rs",
    "src-tauri/src/legacy_runtime/privacy.rs", "src-tauri/src/legacy_runtime/permission_context.rs",
    "crates/atools-core/src/config.rs", "src-tauri/src/plugin_code_revision.rs", "crates/atools-core/src/agent.rs"];
  for (const file of await readdir(join(root, "src-tauri/src/plugin_system_paths"))) {
    if (file.endsWith(".rs")) files.push(`src-tauri/src/plugin_system_paths/${file}`);
  }
  return files;
}
