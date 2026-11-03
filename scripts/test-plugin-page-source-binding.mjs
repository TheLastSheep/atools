import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginPageSourceFiles } from "./lib/plugin-page-source-binding.mjs";
import { capturePanelSources, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const selected = await pluginPageSourceFiles(root);
assert.deepEqual(selected, [...new Set(selected)].sort(), "Document inputs must be unique and deterministic");
const expected = ["scripts/lib/plugin-page-source-binding.mjs", "scripts/test-plugin-page-source-binding.mjs",
  "src/components/PluginPanelMount.svelte", "src/components/PluginPanelBody.svelte",
  "src/lib/pluginPanelLoadController.ts", "src/lib/pluginPanelLoadRetry.ts", "src/lib/pluginPanelMountLoad.ts",
  "src/lib/pluginPanelDocumentSourceHost.ts",
  "src/lib/pluginPanelFrameMountHost.ts", "src/lib/pluginPanelFrameMount.ts", "src/lib/pluginPanelMessageHost.ts",
  "src/lib/pluginPanelMessageRouter.ts", "src/lib/pluginPanelMessageHandlers.ts",
  "src/lib/pluginPanelActiveResources.ts", "src/lib/pluginPanelSessionLifecycle.ts",
  "src/lib/pluginFrameDocumentIdentity.ts", "src/lib/pluginFrameBootstrap.ts", "src/lib/pluginFrameBootstrapObservation.ts", "src/lib/pluginFrameTransport.ts",
  "src/lib/pluginPageDocument.ts", "src/lib/pluginPanelDocumentHost.ts", "src/lib/pluginBridgeTransportBinding.ts",
  "tests/components/plugin-panel-document.test.ts",
  "src/lib/pluginFramePermissionQueue.ts", "src/lib/pluginInvokePolicy.ts", "src/lib/pluginSubInputBridge.ts",
  "src/lib/pluginInlineModules.ts", "src/lib/pluginHtmlScripts.ts",
  "src/lib/hostClipboardBridge.ts", "src/lib/pluginDataBridge.ts", "src/lib/pluginNativeDialogBridge.ts",
  "src/lib/pluginElectronAdapter.ts", "src/lib/pluginNativeImageFactories.ts", "src/lib/pluginNativeImagePath.ts",
  "tests/components/plugin-native-image-path.test.ts", "tests/components/plugin-native-image-consumers.test.ts",
  "tests/components/plugin-native-image-write.test.ts",
  "src/lib/pluginLocalStorage.ts", "src/lib/pluginWebStorageRelay.ts",
  "crates/atools-core/src/db/plugin_web_storage.rs", "crates/atools-core/tests/plugin_web_storage_tests.rs",
  "src/lib/pluginPathsBridge.ts", "src/lib/pluginRuntimePreload.ts", "src-tauri/src/plugin_page_runtime/bootstrap.html",
  "src-tauri/src/plugin_page_runtime/commands.rs", "src-tauri/src/plugin_page_runtime/binding.rs",
  "src-tauri/src/plugin_page_runtime/registry.rs", "src-tauri/src/plugin_page_runtime/protocol.rs",
  "src-tauri/src/plugin_loopback_origin.rs", "src-tauri/src/plugin_asset_protocol/page_assets.rs"];
for (const runtime of ["legacy_runtime", "host_runtime", "plugin_data_runtime", "plugin_dialog_runtime"]) {
  for (const name of ["mod", "commands", "sessions", "privacy", "document_tests"]) expected.push(`src-tauri/src/${runtime}/${name}.rs`);
}
for (const file of expected) assert.ok(selected.includes(file), `Missing selected document input: ${file}`);
const actual = await capturePanelSources(root);
for (const file of [
  "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_artifact_tests.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window_contract.rs",
]) {
  assert.match(actual[file]?.sha256 ?? "", /^[0-9a-f]{64}$/, `Native Image-Toolbox evidence must hash ${file}`);
}
for (const file of selected) {
  assert.match(actual[file]?.sha256 ?? "", /^[0-9a-f]{64}$/, `Panel evidence must hash ${file}`);
  assert.ok(actual[file].bytes > 0, `Panel evidence must include source bytes: ${file}`);
}

// Mutate only a synthetic selected tree: no source, native binary or GUI changes.
const scratch = await mkdtemp("/private/tmp/atools-page-source-binding-");
try {
  await Promise.all(Object.keys(actual).map(async file => {
    await mkdir(dirname(join(scratch, file)), { recursive: true });
    await writeFile(join(scratch, file), `synthetic selected input: ${file}\n`);
  }));
  const before = await capturePanelSources(scratch);
  const mutations = ["src-tauri/src/plugin_page_runtime/bootstrap.html", "src-tauri/src/legacy_runtime/sessions.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_artifact_tests.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_window_contract.rs",
    "scripts/lib/plugin-page-source-binding.mjs", "src/lib/pluginFrameDocumentIdentity.ts",
    "src/lib/pluginPanelLoadController.ts", "src/lib/pluginPanelLoadRetry.ts", "src/lib/pluginPanelMountLoad.ts",
    "src/lib/pluginPanelDocumentSourceHost.ts",
    "src/lib/pluginPanelFrameMountHost.ts", "src/lib/pluginPanelFrameMount.ts", "src/lib/pluginPanelMessageHost.ts",
    "src/lib/pluginPanelMessageRouter.ts", "src/lib/pluginPanelMessageHandlers.ts",
    "src/lib/pluginPanelActiveResources.ts", "src/lib/pluginPanelSessionLifecycle.ts",
    "src/components/PluginPanelMount.svelte", "src/components/PluginPanelBody.svelte",
    "src/lib/pluginFrameBootstrapObservation.ts", "tests/components/plugin-panel-document.test.ts",
    "src/lib/pluginNativeImagePath.ts", "tests/components/plugin-native-image-consumers.test.ts",
    "tests/components/plugin-native-image-write.test.ts",
    "crates/atools-core/src/db/plugin_web_storage.rs", "src/lib/pluginLocalStorage.ts",
    "src/lib/pluginInlineModules.ts", "src/lib/pluginHtmlScripts.ts"];
  await Promise.all(mutations.map(file => writeFile(join(scratch, file), "changed selected source\n")));
  const after = await capturePanelSources(scratch);
  assert.equal(fingerprintsEqual(before, after), false, "Document source changes must invalidate native evidence");
  assert.deepEqual(Object.keys(after).filter(file => !fingerprintsEqual(before[file], after[file])).sort(), mutations.sort());
  await writeFile(join(scratch, "unselected-output.txt"), "not part of the selected evidence boundary");
  assert.ok(fingerprintsEqual(after, await capturePanelSources(scratch)), "Unselected output is outside this evidence boundary");
  const nested = "src-tauri/src/plugin_page_runtime/nested/new_document_guard.rs";
  await mkdir(dirname(join(scratch, nested)), { recursive: true });
  await writeFile(join(scratch, nested), "synthetic nested source\n");
  assert.ok((await pluginPageSourceFiles(scratch)).includes(nested), "New nested document source must be selected");
  assert.ok((await capturePanelSources(scratch))[nested], "Panel evidence must include recursive document modules");
  console.log(`Plugin page source binding passed: ${selected.length} unique document inputs; native panel coverage, mutation detection and recursive modules verified`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
