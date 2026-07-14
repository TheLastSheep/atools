import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-dynamic-features-"));
const outFile = join(outDir, "pluginHostView.mjs");

try {
  const bridgeSourcePath = new URL("src/lib/pluginBridgeCapabilities.ts", root).pathname;
  const bridgeSource = await readFile(bridgeSourcePath, "utf8");
  const bridgeTransformed = await transformWithEsbuild(bridgeSource, bridgeSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "pluginBridgeCapabilities"), bridgeTransformed.code);

  const sourcePath = new URL("src/lib/pluginHostView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const action = {
    plugin_id: "timestamp",
    plugin_name: "时间戳",
    feature_code: "timestamp",
    main_url: "index.html",
    plugin_path: "/plugins/timestamp",
    expand_height: 420,
    payload: null,
  };
  const view = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
    dynamicFeatureCount: 2,
  });
  const dynamicChip = view.runtimeChips.find((chip) => chip.label === "动态指令");
  assert.deepEqual(dynamicChip, {
    label: "动态指令",
    value: "2 项",
    detail: "插件运行时注册的临时 feature",
    tone: "ready",
  });

  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.doesNotMatch(componentSource, /setFeature:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/);
  assert.doesNotMatch(componentSource, /removeFeature:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/);
  assert.match(componentSource, /__atools_dynamic_features__/);
  assert.match(componentSource, /__ipc_dynamic_feature__/);
  assert.match(componentSource, /function _normalizeDynamicFeature/);
  assert.match(componentSource, /setFeature: function\(features\)/);
  assert.match(componentSource, /removeFeature: function\(features\)/);
  assert.match(componentSource, /getFeatures: function\(\)/);
  assert.match(componentSource, /dynamicFeatures =/);
  assert.match(componentSource, /dynamicFeatureCount: dynamicFeatures\.length/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
