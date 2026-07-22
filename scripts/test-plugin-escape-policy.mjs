import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-escape-policy-"));
try {
  const settingsPath = new URL("src/lib/settings.ts", root).pathname;
  const settingsSource = await readFile(settingsPath, "utf8");
  const transformed = await transformWithEsbuild(settingsSource, settingsPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  const outFile = join(outDir, "settings.mjs");
  await writeFile(outFile, transformed.code);
  const settings = await import(pathToFileURL(outFile).href);

  assert.equal(settings.DEFAULT_ATOOLS_SETTINGS.pluginEscapeToSearch, true);
  assert.equal(settings.normalizeSettings({}).pluginEscapeToSearch, true);
  assert.equal(settings.normalizeSettings({ pluginEscapeToSearch: false }).pluginEscapeToSearch, false);

  const [app, panel, settingsPanel] = await Promise.all([
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  ]);

  assert.match(app, /if \(!appSettings\.pluginEscapeToSearch\) return;/);
  assert.match(app, /onescape: onEscape/);
  assert.match(panel, /window\.parent\.postMessage\(\{ __ipc_plugin_escape__: true \}/);
  assert.match(panel, /if \(event\.defaultPrevented === true\) return;/);
  assert.match(panel, /if \(data\.__ipc_plugin_escape__\)/);
  assert.match(panel, /Promise\.resolve\(onescape\?\.\(\)\)/);
  assert.match(settingsPanel, /<span>ESC 退出插件<\/span>/);
  assert.match(settingsPanel, /bind:checked=\{pluginEscapeToSearch\}/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
