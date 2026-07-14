import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const sourceUrl = new URL("src/lib/desktopSmokePluginQueue.ts", root);
const outDir = await mkdtemp(join(root.pathname, ".tmp-desktop-smoke-plugin-queue-"));
const outFile = join(outDir, "desktopSmokePluginQueue.mjs");

try {
  let exists = true;
  try {
    await access(sourceUrl, constants.R_OK);
  } catch {
    exists = false;
  }
  assert.equal(exists, true, "desktop smoke PluginPanel queue identity helper must exist");

  const source = await readFile(sourceUrl, "utf8");
  const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);
  const mod = await import(pathToFileURL(outFile).href);
  assert.equal(typeof mod.desktopSmokePluginQueueActionActive, "function");

  const queued = {
    plugin_id: "timestamp",
    feature_code: "timestamp",
    plugin_path: "/plugins/timestamp",
    main_url: "index.html",
  };
  const other = {
    plugin_id: "calculator",
    feature_code: "calculator",
    plugin_path: "/plugins/calculator",
    main_url: "index.html",
  };
  assert.equal(mod.desktopSmokePluginQueueActionActive(false, queued, [queued], 0), false, "disabled smoke env must not unlock a queue action");
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, queued, [], 0), false, "empty smoke queue must not unlock ordinary PluginPanel props");
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, queued, [queued], -1), false);
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, queued, [queued], 1), false);
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, other, [queued], 0), false, "a non-queue active action must not unlock smoke permissions");
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, other, [queued, other], 0), false, "switching away from the current queued action must revoke smoke props");
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, queued, [queued], 0), true);
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, { ...queued }, [queued], 0), true, "stable action identity may survive serialization/cloning");
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, { ...queued, plugin_path: "/plugins/forged" }, [queued], 0), false);
  assert.equal(mod.desktopSmokePluginQueueActionActive(true, { ...queued, main_url: "other.html" }, [queued], 0), false);

  const appSource = await readFile(new URL("src/App.svelte", root), "utf8");
  assert.match(appSource, /desktopSmokePluginQueueActionActive\(/);
  assert.match(appSource, /const queueActive = desktopSmokePluginQueueActionActive\([\s\S]*?desktopSmokePluginActions,[\s\S]*?desktopSmokePluginIndex/);
  assert.match(appSource, /desktopSmokeExpectedSamples:\s*queueActive \? desktopSmokePluginActions\.length : 0/);
  assert.match(appSource, /desktopSmokeSampleIndex:\s*queueActive \? desktopSmokePluginIndex : 0/);
  assert.match(appSource, /desktopSmokeExternalPlanSample:\s*queueActive \? desktopSmokeActionExternalPlan\(action\) : false/);
  assert.match(appSource, /ondesktopsmokerender:\s*queueActive \? handleDesktopSmokePluginPanelRender : undefined/);
  assert.match(appSource, /ondesktopsmokerender\?: \(\) => void \| Promise<void>;/, "PluginPanel component props must allow ordinary actions to omit the smoke callback");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
