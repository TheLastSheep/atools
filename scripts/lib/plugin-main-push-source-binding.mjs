import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Selected MainPush inputs; this list is not a compiler/dependency closure. */
export async function mainPushSourceFiles(root) {
  const files = [
    "scripts/lib/plugin-main-push-source-binding.mjs", "scripts/probe-main-push-native.mjs",
    "src-tauri/src/plugin_main_push.rs", "src-tauri/src/legacy_runtime/desktop_smoke.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_main_push.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_main_push_evidence.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_main_push_progress.rs",
    "src-tauri/src/desktop_smoke.rs",
    "crates/atools-core/tests/main_push_catalog_tests.rs", "crates/atools-core/tests/plugin_platform_manifest_tests.rs",
    "crates/atools-core/tests/models_tests.rs", "crates/atools-core/tests/capability_tests.rs",
    "crates/atools-core/tests/roadmap_convergence_tests.rs", "crates/atools-api-shim/tests/handler_tests.rs",
    "src-tauri/src/agent_tools/plugin_execution_snapshot_tests.rs",
    "src/lib/permissionQueue.ts", "tests/components/permission-queue.test.ts",
    "tests/components/permission-nested-queue.test.ts",
    "tests/fixtures/main-push-native/plugin.json", "tests/fixtures/main-push-native/index.html",
    "tests/fixtures/main-push-native/fixture.js",
  ];
  for (const [directory, accepts] of [
    ["src/lib", name => /^(pluginMainPush|launcherMainPush).*\.ts$/.test(name)],
    ["src/components", name => /^LauncherMainPush.*\.svelte$/.test(name)],
    ["tests/components", name => /(?:MainPush|main-push).*\.(?:ts|js|html|svelte)$/.test(name)],
    ["scripts", name => /^(?:test-.*main-push|probe-main-push).*\.mjs$/.test(name)],
    ["scripts/lib", name => /main-push.*\.mjs$/.test(name)],
  ]) {
    for (const name of await readdir(join(root, directory))) if (accepts(name)) files.push(`${directory}/${name}`);
  }
  async function rust(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) await rust(`${directory}/${entry.name}`);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(`${directory}/${entry.name}`);
    }
  }
  await rust("src-tauri/src/plugin_main_push");
  return [...new Set(files)].sort();
}
