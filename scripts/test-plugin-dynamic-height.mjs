import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-dynamic-height-"));
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
    requestedHeight: 420,
  });
  const heightChip = view.runtimeChips.find((chip) => chip.label === "动态高度");
  assert.deepEqual(heightChip, {
    label: "动态高度",
    value: "420 px",
    detail: "插件请求的运行视图高度",
    tone: "ready",
  });

  const clampedView = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
    requestedHeight: 1200,
  });
  const clampedChip = clampedView.runtimeChips.find((chip) => chip.label === "动态高度");
  assert.equal(clampedChip?.value, "900 px");

  const defaultView = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
  });
  assert.equal(defaultView.runtimeChips.some((chip) => chip.label === "动态高度"), false);

  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.match(componentSource, /requestedPluginHeight =/, "PluginPanel should track dynamic height requests");
  assert.match(componentSource, /requestedHeight: requestedPluginHeight/, "dynamic height should feed host view");
  assert.match(componentSource, /__ipc_plugin_height__/, "PluginPanel should handle plugin height messages");
  assert.match(componentSource, /function _setPluginHeight\(height\)/, "bridge should normalize plugin height requests");
  assert.match(componentSource, /setExpendHeight: function\(height\)/, "uTools typo-compatible height API should exist");
  assert.match(componentSource, /setExpandHeight: function\(height\)/, "normalized height API alias should exist");
  assert.match(componentSource, /Math\.max\(120, Math\.min\(900/, "height requests should be clamped to a safe host range");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
