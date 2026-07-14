import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const tauriConfig = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const capability = JSON.parse(
  await readFile(new URL("src-tauri/capabilities/default.json", root), "utf8"),
);
const libSource = await readFile(new URL("src-tauri/src/lib.rs", root), "utf8");
const builtinSource = await readFile(new URL("src-tauri/src/builtin_plugins.rs", root), "utf8");

assert.equal(
  tauriConfig.bundle.resources?.["../resources/plugins/builtin/"],
  "plugins/builtin",
  "the active builtin plugins must be copied into Tauri's resource directory",
);

const fsScope = capability.permissions.find(
  (permission) => permission && typeof permission === "object" && permission.identifier === "fs:scope",
);
assert.ok(fsScope, "the desktop capability should define a filesystem scope");
assert.ok(
  fsScope.allow.some((entry) => entry.path === "$RESOURCE/**"),
  "PluginPanel must be allowed to read bundled plugin HTML from the resource directory",
);

assert.match(
  libSource,
  /resolve\("plugins\/builtin", tauri::path::BaseDirectory::Resource\)/,
  "startup should resolve builtin plugins through Tauri's resource path API",
);
assert.match(
  libSource,
  /load_builtin_plugins\([\s\S]*builtin_plugins_dir/,
  "startup should pass the resolved resource path to the builtin loader",
);
assert.ok(
  builtinSource.indexOf("candidates.push(resource_builtin_dir)")
    < builtinSource.indexOf('p.join("resources/plugins/builtin")'),
  "the builtin loader must prefer packaged resources over source-tree fallbacks",
);

const builtinRoot = new URL("resources/plugins/builtin/", root);
const pluginDirectories = (await readdir(builtinRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.ok(pluginDirectories.length > 0, "at least one active builtin plugin should be bundled");

for (const directory of pluginDirectories) {
  const pluginRoot = new URL(`${directory}/`, builtinRoot);
  const manifest = JSON.parse(await readFile(new URL("plugin.json", pluginRoot), "utf8"));
  const main = manifest.main || "index.html";
  assert.ok((await stat(new URL(main, pluginRoot))).isFile(), `${directory} main file should exist`);
}
