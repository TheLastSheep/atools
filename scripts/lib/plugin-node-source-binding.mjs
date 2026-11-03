import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { reviewedNodePageSources } from "./native-node-page-package.mjs";

/** Selected Node bridge, analyzer and acceptance inputs; not a compiler closure. */
export async function pluginNodeSourceFiles(root) {
  const files = ["scripts/lib/plugin-node-source-binding.mjs", "scripts/lib/native-node-page-package.mjs",
    "scripts/lib/native-node-page-package.test.mjs", "scripts/probe-plugin-panel-node-page-native.mjs",
    "scripts/test-plugin-browser-bytes.mjs", "src/lib/browserBuffer.ts", "src/lib/pluginPreload.ts",
    "src/lib/pluginSourceAnalysis.ts", "src/lib/pluginLegacyNodeEnvironment.ts",
    "src/lib/pluginRuntimePreload.ts", "crates/atools-plugin/src/loader.rs",
    "src/lib/pluginNodeSelectedPreload.ts", "tests/components/plugin-child-node-selection.test.ts",
    "src-tauri/src/legacy_runtime/mod.rs", "src-tauri/src/legacy_runtime/commands.rs",
    "src-tauri/src/legacy_runtime/sessions.rs", "src-tauri/src/legacy_runtime/types.rs",
    "src-tauri/src/legacy_runtime/intents.rs", "src-tauri/src/legacy_runtime/node_selected_entry.rs",
    "src-tauri/src/legacy_runtime/node_selected_entry_tests.rs",
    "crates/atools-plugin/src/package_resolution/page_requirements/module_classification.rs",
    "crates/atools-plugin/tests/selected_preload_inspection_tests.rs",
    "crates/atools-plugin/tests/page_requirements_tests.rs",
    "crates/atools-plugin/tests/legacy_node_page_anchor_tests.rs",
    "crates/atools-plugin/tests/legacy_node_bounded_png_path_tests.rs",
    "tests/components/browser-buffer.test.ts", "tests/components/plugin-runtime-preload.test.ts"];
  for (const entry of await readdir(join(root, "src/lib"))) {
    if ((entry.startsWith("nodeModule") || entry.startsWith("nodeBuffer")) && entry.endsWith(".ts")) files.push(`src/lib/${entry}`);
  }
  for (const entry of await readdir(join(root, "tests/components"))) {
    if (entry.startsWith("nativePluginNodePage") || entry.startsWith("node-module-")) files.push(`tests/components/${entry}`);
  }
  for (const directory of ["crates/atools-plugin/src/legacy_node", "crates/atools-plugin/src/package_resolution"]) {
    for (const entry of await readdir(join(root, directory))) {
      if (entry.endsWith(".rs") || entry.endsWith(".cjs")) files.push(`${directory}/${entry}`);
    }
  }
  for (const info of Object.values(reviewedNodePageSources)) {
    for (const file of ["plugin.json", ...Object.keys(info.files)]) files.push(`ZTools-plugins/plugins/${info.id}/${file}`);
  }
  return [...new Set(files)].sort();
}
