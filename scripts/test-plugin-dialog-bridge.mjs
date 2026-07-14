import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";
import { desktopSmokeEnv } from "./smoke-tauri-desktop.mjs";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-dialog-bridge-"));
const outFile = join(outDir, "pluginDialogBridge.mjs");

try {
  const sourcePath = new URL("src/lib/pluginDialogBridge.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  assert.equal(typeof mod.normalizeDialogBridgeOptions, "function");
  assert.equal(typeof mod.pluginDialogSmokeGuardEnabled, "function");
  assert.equal(typeof mod.dialogSmokeGuardError, "function");

  assert.deepEqual(mod.normalizeDialogBridgeOptions(null), {});
  assert.deepEqual(mod.normalizeDialogBridgeOptions("folder"), {});
  assert.deepEqual(mod.normalizeDialogBridgeOptions(["not", "options"]), {});
  assert.deepEqual(
    mod.normalizeDialogBridgeOptions({ directory: true, multiple: false }),
    { directory: true, multiple: false }
  );

  assert.equal(mod.pluginDialogSmokeGuardEnabled({ VITE_ATOOLS_DESKTOP_SMOKE: "1" }), true);
  assert.equal(mod.pluginDialogSmokeGuardEnabled({ VITE_ATOOLS_DESKTOP_SMOKE: "true" }), true);
  assert.equal(mod.pluginDialogSmokeGuardEnabled({ VITE_ATOOLS_DESKTOP_SMOKE: "yes" }), true);
  assert.equal(mod.pluginDialogSmokeGuardEnabled({ VITE_ATOOLS_DESKTOP_SMOKE: "0" }), false);
  assert.equal(mod.pluginDialogSmokeGuardEnabled({}), false);
  assert.match(mod.dialogSmokeGuardError("showOpenDialog"), /showOpenDialog/);
  assert.match(mod.dialogSmokeGuardError("showOpenDialog"), /desktop smoke/);
  assert.match(mod.dialogSmokeGuardError("showOpenDialog"), /interactive/);

  const smokeEnv = desktopSmokeEnv({ ATOOLS_DESKTOP_SMOKE: "0" });
  assert.equal(smokeEnv.ATOOLS_DESKTOP_SMOKE, "1");
  assert.equal(smokeEnv.VITE_ATOOLS_DESKTOP_SMOKE, "1");

  const pluginPanel = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.match(pluginPanel, /pluginDialogSmokeGuardEnabled\(\)/);
  assert.match(pluginPanel, /dialogSmokeGuardError\("showOpenDialog"\)/);
  assert.match(pluginPanel, /dialogSmokeGuardError\("showSaveDialog"\)/);
  assert.match(pluginPanel, /openDialog\(normalizeDialogBridgeOptions\(args\.options\)\)/);
  assert.match(pluginPanel, /saveDialog\(normalizeDialogBridgeOptions\(args\.options\)\)/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
