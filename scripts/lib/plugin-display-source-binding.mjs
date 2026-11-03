import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Selected display compatibility inputs, not a compiler dependency closure. */
export async function pluginDisplaySourceFiles(root) {
  const directory = "src-tauri/src/plugin_display_runtime";
  return [
    ...(await readdir(join(root, directory))).filter(name => name.endsWith(".rs")).sort().map(name => `${directory}/${name}`),
    "scripts/lib/plugin-display-source-binding.mjs", "src/lib/pluginDisplayBridge.ts", "src/lib/pluginDisplayController.ts",
    "src/lib/pluginPanelLoadRetry.ts", "src/lib/pluginHostView.ts", "src/lib/pluginFrameFocus.ts", "src/components/PluginPanelLoadFailure.svelte",
    "src/lib/pluginDisplayPermission.ts", "src/lib/pluginHostReopen.ts", "src/lib/pluginPageDocument.ts",
    "tests/components/plugin-display-bridge.test.ts", "tests/components/plugin-display-controller.test.ts",
    "tests/components/plugin-display-original.test.ts", "tests/components/originalDisplayFixture.ts",
    "tests/components/display-permission-integration.test.ts", "crates/atools-core/tests/display_permission_scope_tests.rs",
    "tests/components/plugin-panel-load-retry.test.ts", "tests/components/plugin-frame-focus.test.ts", "tests/components/plugin-dialog-load-failure.test.ts",
    "tests/components/plugin-feature-label-app.test.ts", "tests/components/plugin-panel-load-retry-browser.html",
    "tests/components/pluginPanelLoadRetryBrowserFixture.ts", "scripts/test-plugin-panel-load-retry-browser.mjs",
    "src-tauri/src/legacy_runtime/desktop_smoke_activation_observation.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_activation_observation_tests.rs",
    "scripts/lib/native-activation-observation.mjs", "scripts/test-native-activation-observation.mjs",
  ];
}
