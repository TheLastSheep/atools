import { createHash } from "node:crypto";
import { pluginDisplaySourceFiles } from "./plugin-display-source-binding.mjs";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { launcherSourceFiles } from "./launcher-source-binding.mjs";
import { pluginPathsSourceFiles } from "./plugin-paths-source-binding.mjs";
import { pluginPageSourceFiles } from "./plugin-page-source-binding.mjs";
import { pluginNodeSourceFiles } from "./plugin-node-source-binding.mjs";
import { mainPushSourceFiles } from "./plugin-main-push-source-binding.mjs";

export async function fingerprintFile(file) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}

/** Explicit selected inputs, not a complete compiler/dependency closure. */
export async function capturePanelSources(root) {
  const files = ["Cargo.toml", "Cargo.lock", "resources/node-runtime/pin.json",
    "src/lib/pluginOpen.ts", "src/components/SettingsPanel.svelte", "src/components/PluginOpenStatus.svelte",
    "src/components/SystemPanel.svelte", "src/components/PluginInventoryPanel.svelte",
    "src/components/PluginInventoryDetail.svelte", "src/lib/pluginInventory.ts", "src/lib/pluginInventoryBrowseState.ts",
    "src/lib/pluginInventoryController.ts", "src/lib/pluginInventoryServices.ts", "src/lib/pluginInventoryFeatureSearch.ts",
    "src/components/PluginInventoryToolbar.svelte", "src/components/PluginInventoryFeedback.svelte",
    "src/lib/pluginInventoryFeedback.ts", "tests/components/plugin-inventory-feedback.test.ts",
    "tests/components/settings-header.test.ts", "tests/components/plugin-market-enable-open.test.ts",
    "scripts/test-plugin-inventory-browser.mjs", "scripts/test-plugin-inventory-query-performance.mjs",
    "scripts/test-plugin-inventory.mjs", "scripts/test-plugin-inventory-overview.mjs",
    "tests/components/plugin-inventory-feature-search.test.ts", "tests/components/plugin-inventory-query-open.test.ts",
    "tests/components/pluginInventoryBrowserFixture.ts",
    "src/lib/installedPluginBoundary.ts",
    "src/styles/settings-responsive.css", "src/components/PluginMarketPanel.svelte",
    "src/components/ZToolsImportPanel.svelte", "src/lib/pluginBrowserWindowBridge.ts", "src/lib/pluginBrowserWorkerBridge.ts",
    "src/lib/pluginWorkerShutdown.ts", "src/lib/pluginWorkerDocumentLifecycle.ts",
    "src/lib/pluginFrameFocus.ts", "tests/components/plugin-frame-focus.test.ts",
    "tests/components/plugin-frame-focus-app.test.ts",
    "src/lib/desktopBrowserWindowIsolationProbe.ts", "src/lib/hostedBrowserWindowRpc.ts",
    "tests/components/pluginHostedIpcProductionFixture.ts", "scripts/lib/plugin-bridge-fixture.mjs",
    "scripts/test-desktop-browser-window-isolation-probe.mjs", "scripts/test-plugin-browser-window-sync-handle.mjs",
    "scripts/test-plugin-open-outcome-browser.mjs", "scripts/lib/plugin-open-outcome-preview.mjs",
    "scripts/lib/static-browser-fixture.mjs", "scripts/test-home-grid-browser.mjs",
    "tests/components/homeGridBrowserFixture.ts", "tests/components/home-grid-browser.html",
    "tests/components/home-grid-navigation.test.ts", "tests/components/home-panel-selection-viewport.test.ts",
    "tests/components/pluginOpenOutcomeBrowserFixture.ts",
    "tests/components/plugin-open-outcome-browser.html", "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
    "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
    "scripts/lib/native-browser-window-package.mjs", "scripts/probe-plugin-browser-window-native.mjs",
    "scripts/lib/native-window-geometry-originals.mjs", "tests/components/nativePluginWindowGeometryOperations.js",
    "ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js", "ZTools-plugins/plugins/english-typing-practice/preload.js",
    "scripts/lib/native-web-storage-package.mjs", "scripts/probe-plugin-web-storage-native.mjs",
    "scripts/lib/native-child-node-package.mjs", "scripts/probe-plugin-child-node-native.mjs",
    "scripts/lib/native-child-node-package.test.mjs", "tests/components/native-child-node-fixture.test.ts",
    "tests/components/nativePluginChildNodeSmoke.ts", "tests/components/nativePluginChildNodeScenario.ts",
    "tests/components/nativePluginChildNodeFrameProbe.js",
    "src/lib/pluginElectronWebFrame.ts", "tests/components/plugin-electron-web-frame.test.ts",
    "src-tauri/src/legacy_runtime/desktop_smoke_child_node_privacy.rs",
    "ZTools-plugins/plugins/english-typing-practice/preload-app.js",
    "scripts/test-native-web-storage-fixture.mjs", "tests/components/nativePluginWebStorageSmoke.ts",
    "tests/components/nativePluginWebStorageScenario.ts", "tests/components/nativePluginWebStorageFrameProbe.js",
    "ZTools-plugins/plugins/stickercan/theme-manager.js", "ZTools-plugins/plugins/stickercan/ui-manager.js",
    "scripts/test-native-browser-window-fixture.mjs",
    "tests/components/nativePluginBrowserWindowSmoke.ts", "tests/components/nativePluginBrowserWindowScenario.ts",
    "tests/components/nativePluginBrowserWindowFrameProbe.js",
    "tests/components/nativePluginHostedIpcOperations.js", "tests/components/native-hosted-ipc-fixture.test.ts",
    "tests/components/pluginHostedMenuLifecycleFixture.ts", "tests/components/plugin-hosted-menu-lifecycle.test.ts",
    "tests/components/native-menu-diagnostic.test.ts",
    "tests/components/plugin-browser-window-preload.test.ts", "tests/components/plugin-runtime-additional-preload.test.ts",
    "ZTools-plugins/plugins/pomodoro-timer/page/index/js/contextMenuWindow.js",
    "ZTools-plugins/plugins/pomodoro-timer/page/contextMenu/contextMenu.html",
    "ZTools-plugins/plugins/pomodoro-timer/base/js/preload.js", "ZTools-plugins/plugins/pomodoro-timer/base/css/color.css",
    "ZTools-plugins/plugins/pomodoro-timer/page/index/js/tipsWindow.js",
    "scripts/benchmark-plugin-panel-native.mjs", "scripts/probe-plugin-panel-native.mjs",
    "scripts/lib/native-panel-cli-options.mjs", "scripts/test-native-smoke-build-profile.mjs",
    "scripts/test-native-panel-cli-options.mjs",
    "scripts/lib/native-panel-source-binding.mjs", "scripts/lib/native-smoke-process.mjs",
    "scripts/lib/native-process-resource-sampler.mjs", "scripts/test-native-process-resource-sampler.mjs",
    "scripts/lib/native-smoke-app-bundle.mjs",
    "scripts/test-native-panel-fixture-flags.mjs", "scripts/test-native-smoke-app-bundle.mjs",
    "scripts/test-published-plugin-native-launch.mjs",
    "scripts/lib/native-panel-escape-timeline.mjs", "scripts/lib/native-panel-escape-timeline.d.mts",
    "scripts/test-native-panel-escape-timeline.mjs",
    "scripts/native-dialog-acceptance-control.applescript",
    "scripts/control-native-dialog-acceptance.mjs", "scripts/test-native-dialog-control-scope.mjs",
    "scripts/run-native-dialog-applescript-acceptance.mjs", "scripts/test-native-dialog-applescript-acceptance.mjs",
    "scripts/lib/native-smoke-descendants.mjs", "scripts/lib/legacy-node-environment.mjs",
    "scripts/lib/published-plugin-launchservices-observer.mjs", "scripts/lib/published-plugin-launchservices-processes.mjs",
    "scripts/lib/published-plugin-launchservices-cleanup-scope.mjs",
    "scripts/lib/published-plugin-launchservices-codec.mjs",
    "tests/components/nativePluginPanelSmoke.ts", "tests/components/nativePluginPanelScenario.ts",
    "tests/components/nativePluginFrameProbe.js", "src/App.svelte", "src/components/PluginPanel.svelte",
    "tests/components/nativePanelWindowEvidence.ts", "tests/components/nativePanelEscapeMeasurement.ts",
    "tests/components/nativePanelPermissionGate.ts", "tests/components/nativeOriginalInventoryScenario.ts",
    "scripts/probe-plugin-dialog-native.mjs", "tests/components/nativePluginDialogSmoke.ts",
    "tests/components/nativePluginDialogScenario.ts", "tests/components/nativePluginDialogFrameOperations.js",
    "tests/components/native-dialog-console-observation.test.ts",
    "src/components/ResultRow.svelte", "src/components/ResultsList.svelte", "src/lib/resultPresentation.ts",
    "src/styles/global.css", "src/lib/pluginResourceHtml.ts", "src/lib/pluginResourceLease.ts", "src/lib/pluginLifecycleBridge.ts",
    "src/lib/pluginRuntimePreload.ts", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json",
    "src-tauri/src/lib.rs", "src-tauri/src/commands.rs", "src-tauri/src/plugin_resources.rs",
    "src-tauri/src/plugin_lifecycle.rs", "src-tauri/src/plugin_code_revision.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke.rs", "src-tauri/src/legacy_runtime/desktop_smoke_panel.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_grants.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_stage.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_stage_tests.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_startup_receipts.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_artifact.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_artifact_tests.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window_contract.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window_contract_tests.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_entry.rs",
    "tests/components/nativePluginImageToolboxSmoke.ts", "tests/components/nativeImageToolboxReportListener.ts", "tests/components/nativeImageToolboxReportListener.test.ts",
    "tests/components/nativeImageToolboxPageProbe.ts", "tests/components/nativeImageToolboxPageProbe.test.ts",
    "tests/components/nativeImageToolboxChildCheckpoints.ts", "tests/components/nativeImageToolboxChildCheckpoints.test.ts",
    "scripts/lib/image-toolbox-native-fixture.mjs", "scripts/lib/image-toolbox-native-fixture.test.mjs",
    "scripts/lib/native-image-toolbox-evidence.mjs", "scripts/lib/native-image-toolbox-evidence.test.mjs",
    "scripts/lib/image-toolbox-csp-checkpoint.mjs", "scripts/lib/image-toolbox-csp-checkpoint.test.mjs",
    "ZTools-plugins/plugins/calculation-paper/logo.png",
    "scripts/lib/head-calculation-paper-fixture.mjs", "scripts/test-head-calculation-paper-fixture.mjs", "scripts/test-head-calculation-paper-operations.mjs",
    "scripts/lib/head-local-package-fixture.mjs", "scripts/lib/head-file-tree-fixture.mjs", "scripts/test-head-file-tree-fixture.mjs",
    "scripts/lib/head-developer-codec-tools-fixture.mjs", "scripts/test-head-developer-codec-tools-fixture.mjs",
    "src/lib/desktopSmokePluginPanelActivation.ts", "tests/components/desktop-smoke-plugin-panel-activation.test.ts",
    "tests/fixtures/head-file-tree-cases.json", "tests/fixtures/head-developer-codec-tools-cases.json",
    "tests/components/nativeOriginalDeveloperCodecToolsHeadFrameOperations.js",
    "tests/components/nativeOriginalDeveloperCodecToolsHeadScenario.ts", "tests/components/nativePluginDeveloperCodecToolsSmoke.ts",
    "tests/components/nativeOriginalFileTreeHeadFrameOperations.js",
    "tests/components/nativeOriginalFileTreeHeadScenario.ts", "tests/components/nativeFileTreeFrameProbe.ts",
    "tests/components/nativeFileTreeFrameProbe.test.ts", "tests/components/nativePluginFileTreeHeadSmoke.ts",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_fixture_setup.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_file_tree_head.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_fixture_state.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_developer_codec_tools_head.rs",
    "tests/components/nativeOriginalCalculationHeadScenario.ts", "tests/components/nativeOriginalCalculationHeadFrameOperations.js",
    "src-tauri/src/legacy_runtime/desktop_smoke_inventory_logo.rs", "tests/components/nativePluginInventoryLogoSmoke.ts",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_consumer.rs", "tests/components/nativePluginPasteboardProSmoke.ts",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_consumer_audit.rs",
    "scripts/lib/pasteboard-pro-consumer-fixture.mjs", "ZTools-plugins/plugins/pasteboard-pro/preload.js",
    "ZTools-plugins/plugins/calculation-paper/logo.png", "ZTools-plugins/plugins/pasteboard-pro/logo.png",
    "src/lib/pluginNativeImageTransformProvider.ts",
    "src-tauri/src/legacy_runtime/native_image.rs", "src-tauri/src/legacy_runtime/native_image_request.rs",
    "src-tauri/src/legacy_runtime/native_image_session.rs", "src-tauri/src/legacy_runtime/native_image_worker.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_perf.rs", "src-tauri/examples/legacy_node_desktop_smoke.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_foreground.rs",
    "src-tauri/examples/support/native_fixture_restoration.rs",
    "src-tauri/examples/support/native_fixture_launchservices.rs",
    "src-tauri/examples/support/native_fixture_launchservices/guard.rs",
    "src-tauri/examples/support/native_fixture_launchservices/lifecycle.rs",
    "src-tauri/examples/support/native_fixture_launchservices/process.rs",
    "src-tauri/examples/support/native_fixture_launchservices/protocol.rs",
    "src-tauri/examples/support/native_fixture_launchservices/stdio.rs",
    "scripts/probe-local-original-plugin-native.mjs", "scripts/test-local-original-native-args.mjs",
    "scripts/control-native-editor-input.py",
    "src/lib/pluginInventoryKeyboard.ts", "tests/components/plugin-inventory-keyboard.test.ts",
    "src/lib/pluginInventoryFocusPagination.ts", "tests/components/plugin-inventory-focus-pagination.test.ts",
    "tests/components/pluginInventoryKeyboardBrowserFixture.ts", "scripts/test-plugin-inventory-keyboard-browser.mjs",
    "scripts/lib/paintbrush-node-save-fixture.mjs", "scripts/lib/paintbrush-probe-resource-journal.mjs",
    "svelte.config.js", "package.json", "pnpm-lock.yaml",
    "src-tauri/src/plugin_inventory.rs", "src-tauri/src/legacy_runtime/session_tests.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_dialog.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_panel_dialog_privacy.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_catalog_fixture.rs",
    "src-tauri/src/legacy_runtime/mod.rs", "src-tauri/src/legacy_runtime/commands.rs",
    "src-tauri/src/legacy_runtime/sessions.rs", "src-tauri/src/legacy_runtime/intents.rs",
    "src-tauri/src/legacy_runtime/types.rs", "src-tauri/src/legacy_runtime/node_startup_diagnostic.rs",
    "src-tauri/src/legacy_runtime/native_node_startup_fixture.rs",
    "src-tauri/src/legacy_runtime/native_node_startup_fixture_tests.rs",
    "src-tauri/src/legacy_runtime/native_image_startup_measurement.rs",
    "src-tauri/src/agent_tools.rs", "src-tauri/src/agent_tools/task_run_pipeline.rs",
    "src-tauri/src/agent_tools/source_build_failure_observation.rs",
    "src-tauri/src/agent_tools/node_startup_error_observation.rs", "src-tauri/src/agent_tools/tool_executor.rs",
    "crates/atools-core/src/task_run.rs",
    "crates/atools-plugin/src/package_resolution/mod.rs", "crates/atools-plugin/src/package_resolution/paths.rs",
    "crates/atools-plugin/src/sidecar/process_loop.rs"];
  const protocol = "src-tauri/src/plugin_asset_protocol";
  for (const file of await readdir(join(root, protocol))) if (file.endsWith(".rs")) files.push(`${protocol}/${file}`);
  async function nativeImageRustFiles(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await nativeImageRustFiles(absolute, relativePath);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(relativePath);
    }
  }
  await nativeImageRustFiles(join(root, "src-tauri/src/legacy_runtime/native_image"), "src-tauri/src/legacy_runtime/native_image");
  async function imageToolboxPluginFiles(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await imageToolboxPluginFiles(absolute, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Unsupported Image-Toolbox source entry: ${relativePath}`);
    }
  }
  await imageToolboxPluginFiles(join(root, "ZTools-plugins/plugins/Image-Toolbox"), "ZTools-plugins/plugins/Image-Toolbox");
  for (const file of await readdir(join(root,"src/lib")))
    if((file.startsWith("pluginBrowserWindow")||file.startsWith("pluginHostedIpc"))&&file.endsWith(".ts"))files.push(`src/lib/${file}`);
  for (const file of await readdir(join(root,"tests/components")))
    if (/^(plugin-hosted-ipc|plugin-browser-window-preload|plugin-runtime-additional|native-hosted-ipc|plugin-inventory-browse-state|plugin-inventory-market-roundtrip-app).*\.test\.ts$/.test(file)) files.push(`tests/components/${file}`);
  files.push(...await pluginDisplaySourceFiles(root));
  files.push(...launcherSourceFiles);
  files.push(...await pluginPathsSourceFiles(root));
  files.push(...await pluginPageSourceFiles(root));
  files.push(...await pluginNodeSourceFiles(root));
  files.push(...await mainPushSourceFiles(root));
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async file => [file, await fingerprintFile(join(root, file))])));
}

export async function capturePanelArtifacts(fixture) {
  return Object.fromEntries(await Promise.all(Object.entries({ panelJavaScript: join(fixture.bundle, "panel.js"),
    panelCss: fixture.css, nativeExecutable: fixture.executable,
    ...(fixture.appBundle ? { nativeApplicationInfo: fixture.appBundle.plistPath } : {})
  }).map(async ([name, file]) => [name, await fingerprintFile(file)])));
}

export const fingerprintsEqual = (before, after) => JSON.stringify(before) === JSON.stringify(after);
