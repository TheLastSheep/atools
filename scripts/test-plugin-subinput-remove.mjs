import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-subinput-remove-"));
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
  const withSubInput = mod.pluginHostView(action, {
    subInputVisible: true,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
  });
  assert.ok(withSubInput.layoutSlots.includes("subinput"));
  assert.equal(withSubInput.runtimeChips.find((chip) => chip.label === "SubInput")?.value, "已启用");

  const withoutSubInput = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
  });
  assert.equal(withoutSubInput.layoutSlots.includes("subinput"), false);
  assert.equal(withoutSubInput.runtimeChips.find((chip) => chip.label === "SubInput")?.value, "未启用");

  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.match(componentSource, /removeSubInput:\s*function\(\)/, "utools.removeSubInput should be exposed");
  assert.match(componentSource, /__ipc_subinput_remove__/, "removeSubInput should notify the host");
  assert.match(componentSource, /subInputOpts = \{\}/, "host removal should clear SubInput options");
  assert.match(componentSource, /subInputValue = ""/, "host removal should clear SubInput value");
  assert.match(componentSource, /subInputRef\?\.blur\(\)/, "host removal should blur the rendered SubInput");
  assert.doesNotMatch(
    componentSource,
    /removeSubInput:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/,
    "removeSubInput must not silently resolve without removing host input"
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
