import { pluginFeatureSourceFiles } from "./plugin-feature-source-binding.mjs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Selected data-path inputs shared by both native verification wrappers. */
export async function pluginDataSourceFiles(root) {
  const files = [...pluginFeatureSourceFiles, "scripts/lib/plugin-data-source-binding.mjs", "src/lib/pluginDataBridge.ts", "src/lib/pluginDataController.ts",
    "src/lib/pluginDynamicFeatures.ts", "tests/components/plugin-dynamic-features.test.ts",
    "crates/atools-core/tests/plugin_dynamic_feature_tests.rs", "crates/atools-core/src/db/feature_catalog.rs",
    "crates/atools-api-shim/src/handler.rs", "crates/atools-api-shim/src/handler/dynamic_features.rs",
    "crates/atools-api-shim/tests/feature_catalog_tests.rs",
    "crates/atools-core/src/capability.rs", "crates/atools-core/src/capability/database_catalog.rs",
    "crates/atools-core/tests/dynamic_capability_discovery_tests.rs",
    "src/lib/pluginLocalStorage.ts", "src/lib/pluginWebStorageRelay.ts",
    "tests/components/plugin-local-storage.test.ts", "tests/components/plugin-web-storage-relay.test.ts",
    "tests/components/plugin-data-bridge.test.ts", "crates/atools-core/tests/plugin_web_storage_tests.rs",
    "src/lib/pluginHostReopen.ts", "src/components/PluginDataNotice.svelte", "src/components/PermissionConfirmDialog.svelte",
    "src/lib/permissionPresentation.ts", "src/lib/permissionQueue.ts", "src-tauri/src/permission_requests.rs",
    "src-tauri/src/legacy_runtime/permission_context.rs", "src-tauri/src/agent_tools.rs", "src-tauri/src/agent_tools/task_run_pipeline.rs",
    "src-tauri/src/legacy_runtime/privacy.rs", "src-tauri/src/legacy_runtime/mod.rs", "src-tauri/src/plugin_lifecycle_permissions.rs",
    "src-tauri/src/agent_tools/plugin_execution_snapshot.rs", "src-tauri/src/plugin_loopback.rs",
    "crates/atools-core/src/db.rs", "crates/atools-core/Cargo.toml", "Cargo.lock"];
  for (const directory of ["src-tauri/src/plugin_data_runtime", "crates/atools-core/src/db"]) {
    for (const name of await readdir(join(root, directory))) {
      if (name.endsWith(".rs") && (directory.includes("plugin_data_runtime") || name.startsWith("plugin_data") || name.startsWith("plugin_web_storage") || name.startsWith("plugin_dynamic_features"))) files.push(`${directory}/${name}`);
    }
  }
  return files;
}
