import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-install-open-"));

try {
  const helperPath = new URL("src/lib/pluginOpen.ts", root).pathname;
  const helperSource = await readFile(helperPath, "utf8");
  const transformed = await transformWithEsbuild(helperSource, helperPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  const outFile = join(outDir, "pluginOpen.mjs");
  await writeFile(outFile, transformed.code);
  const helper = await import(pathToFileURL(outFile).href);

  const plugin = {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    path: "/tmp/demo",
    enabled: true,
    manifest: { features: [{ code: "demo:open", explain: "open" }] },
    created_at: "",
    updated_at: "",
  };
  assert.deepEqual(helper.firstOpenablePluginFeature(plugin), { code: "demo:open", pluginId: "demo" });
  assert.equal(helper.firstOpenablePluginFeature({ ...plugin, enabled: false }), null);
  assert.equal(helper.firstOpenablePluginFeature({ ...plugin, manifest: { features: [] } }), null);

  const [app, settingsPanel, importPanel] = await Promise.all([
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
    readFile(new URL("src/components/ZToolsImportPanel.svelte", root), "utf8"),
  ]);

  assert.match(app, /window\.addEventListener\(PLUGIN_OPEN_REQUESTED_EVENT, onPluginOpenRequested\)/);
  assert.match(app, /void activateFeature\(request\.code\)/);
  assert.match(settingsPanel, /recentlyInstalledPlugin = plugin/);
  assert.match(settingsPanel, /recentlyInstalledPlugin = installedPlugin \? null : updated/);
  assert.match(settingsPanel, /onclick=\{openRecentlyInstalledPlugin\}>立即打开<\/button>/);
  assert.match(importPanel, /const importedIds = new Set\(report\.imported\)/);
  assert.match(importPanel, /onclick=\{\(\) => openImportedPlugin\(row\.path\)\}>立即打开<\/button>/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
