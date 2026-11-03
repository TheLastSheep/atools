import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataSourceFiles } from "./plugin-data-source-binding.mjs";
import { pluginDialogSourceFiles } from "./plugin-dialog-source-binding.mjs";

/** Selected document identity, bootstrap, bridge and native authorization inputs.
 * This is an evidence boundary, not a complete compiler/dependency closure. */
export async function pluginPageSourceFiles(root) {
  const files = ["scripts/lib/plugin-page-source-binding.mjs", "scripts/test-plugin-page-source-binding.mjs",
    "scripts/probe-plugin-page-navigation-native.mjs", "scripts/test-native-page-navigation-fixture.mjs",
    "tests/components/nativePluginPageNavigationSmoke.ts", "tests/components/nativePluginPageNavigationScenario.ts",
    "tests/components/nativePluginPageNavigationFrameProbe.js",
    "scripts/lib/plugin-bridge-fixture.mjs", "scripts/lib/plugin-worker-fixture.mjs",
    "scripts/test-plugin-browser-worker-bridge.mjs",
    "src/components/PluginPanel.svelte", "src/components/PluginPanelMount.svelte", "src/components/PluginPanelBody.svelte",
    "src/lib/pluginPanelLoadController.ts", "src/lib/pluginPanelLoadRetry.ts", "src/lib/pluginPanelMountLoad.ts",
    "src/lib/pluginPanelDocumentSourceHost.ts",
    "src/lib/pluginPanelFrameMountHost.ts", "src/lib/pluginPanelFrameMount.ts",
    "src/lib/pluginPanelMessageHost.ts", "src/lib/pluginPanelMessageRouter.ts", "src/lib/pluginPanelMessageHandlers.ts",
    "src/lib/pluginPanelActiveResources.ts", "src/lib/pluginPanelSessionLifecycle.ts",
    "src/lib/pluginFrameDocumentIdentity.ts", "src/lib/pluginFrameBootstrap.ts", "src/lib/pluginFrameBootstrapObservation.ts",
    "src/lib/pluginFrameTransport.ts", "src/lib/pluginInvokePolicy.ts", "src/lib/pluginFramePermissionQueue.ts",
    "src/lib/pluginBrowserWorkerBridge.ts", "src/lib/pluginPageRevocation.ts",
    "src/lib/pluginPageDocument.ts", "src/lib/pluginPanelDocumentHost.ts", "src/lib/pluginBridgeTransportBinding.ts",
    "tests/components/plugin-panel-document.test.ts",
    "src/lib/pluginRuntimePreload.ts", "src/lib/pluginResourceHtml.ts", "src/lib/pluginResourceLease.ts",
    "src/lib/pluginInlineModules.ts", "src/lib/pluginHtmlScripts.ts",
    "src/lib/pluginSubInputBridge.ts", "src/lib/pluginLifecycleBridge.ts", "src/lib/pluginHostReopen.ts",
    "src/lib/hostClipboardBridge.ts", "src/lib/hostClipboardController.ts", "src/lib/pluginDataBridge.ts",
    "src/lib/pluginDataController.ts", "src/lib/pluginNativeDialogBridge.ts", "src/lib/pluginDialogsController.ts",
    "src/lib/pluginPathsBridge.ts", "src/lib/pluginPathsController.ts", "src/lib/pluginElectronAdapter.ts",
    "src/lib/pluginNativeImage.ts", "src/lib/pluginNativeImagePath.ts", "src/lib/pluginNativeImageFactories.ts",
    "tests/components/plugin-native-image.test.ts", "tests/components/plugin-native-image-path.test.ts",
    "tests/components/plugin-native-image-consumers.test.ts",
    "tests/components/plugin-native-image-write.test.ts",
    "tests/components/plugin-clipboard-image-preload.test.ts",
    "ZTools-plugins/plugins/clipboard-image-paintbrush/plugin.json",
    "ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js",
    "ZTools-plugins/plugins/ideadock/plugin.json", "ZTools-plugins/plugins/ideadock/preload.js",
    "ZTools-plugins/plugins/device-link/plugin.json", "ZTools-plugins/plugins/device-link/preload/services.js",
    "src-tauri/src/lib.rs", "src-tauri/src/plugin_lifecycle.rs", "src-tauri/src/plugin_code_revision.rs",
    "src-tauri/src/plugin_loopback.rs", "src-tauri/src/plugin_loopback_dialog.rs",
    "src-tauri/src/plugin_loopback_origin.rs", "src-tauri/src/plugin_loopback_origin_tests.rs"];
  // Reuse the existing data and AppKit evidence boundaries rather than allowing
  // the panel collector and this document-specific collector to drift apart.
  files.push(...await pluginDataSourceFiles(root), ...await pluginDialogSourceFiles(root));
  async function visit(directory, includeHtml = false) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file, includeHtml);
      else if (entry.isFile() && (entry.name.endsWith(".rs") || includeHtml && entry.name.endsWith(".html"))) files.push(file);
    }
  }
  await visit("src-tauri/src/plugin_page_runtime", true);
  for (const directory of ["legacy_runtime", "host_runtime", "plugin_asset_protocol"]) {
    await visit(`src-tauri/src/${directory}`);
  }
  return [...new Set(files)].sort();
}
