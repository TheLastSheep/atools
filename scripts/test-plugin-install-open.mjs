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

  assert.deepEqual(helper.exactOpenablePluginFeature(plugin, "demo:open"), { code: "demo:open", pluginId: "demo" });
  assert.equal(helper.exactOpenablePluginFeature(plugin, "another-owner:open"), null);
  assert.equal(helper.exactOpenablePluginFeature({ ...plugin, enabled: false }, "demo:open"), null);
  // Actual App handshake, installed inventory, market and import flows have
  // behavioral Svelte/browser coverage; implementation text is not that proof.
} finally {
  await rm(outDir, { recursive: true, force: true });
}
