import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-registered-tools-"));
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
    plugin_id: "ai-tools",
    plugin_name: "AI Tools",
    feature_code: "assistant",
    main_url: "index.html",
    plugin_path: "/plugins/ai-tools",
    expand_height: 420,
    payload: null,
  };
  const view = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
    registeredToolCount: 2,
  });
  const registeredChip = view.runtimeChips.find((chip) => chip.label === "注册工具");
  assert.deepEqual(registeredChip, {
    label: "注册工具",
    value: "2 项",
    detail: "插件运行时注册的工具处理器",
    tone: "ready",
  });

  const defaultView = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
  });
  assert.equal(defaultView.runtimeChips.some((chip) => chip.label === "注册工具"), false);

  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.match(componentSource, /registeredTools =/, "PluginPanel should track registered plugin tools");
  assert.match(componentSource, /registeredToolCount: registeredTools\.length/, "registered tool count should feed host view");
  assert.match(componentSource, /__ipc_register_tool__/, "PluginPanel should handle registerTool messages");
  assert.match(componentSource, /data\.name/, "registered tool messages should include tool names");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
