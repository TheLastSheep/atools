import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-runtime-permission-grants-"));
const outFile = join(outDir, "pluginRuntimePermissions.mjs");

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    snapshot() {
      return Object.fromEntries(map.entries());
    },
  };
}

try {
  const sourcePath = new URL("src/lib/pluginRuntimePermissions.ts", root).pathname;
  let source = "";
  try {
    source = await readFile(sourcePath, "utf8");
  } catch {
    assert.fail("pluginRuntimePermissions.ts should provide persistent runtime grant helpers");
  }
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const storage = memoryStorage();

  assert.equal(
    mod.PLUGIN_RUNTIME_PERMISSION_GRANTS_STORAGE_KEY,
    "atools.pluginRuntimePermissionGrants.v1",
    "persistent runtime grants should use a versioned storage key",
  );
  assert.equal(
    mod.PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT,
    "atools-plugin-runtime-permission-grants-updated",
    "persistent runtime grants should expose a shared update event",
  );
  assert.deepEqual(
    mod.pluginRuntimePermissionGrantList("z-user", storage),
    [],
    "missing plugins should start with no persistent runtime grants",
  );

  assert.equal(
    mod.grantPluginRuntimePermission(" z-user ", " clipboard.write ", storage),
    true,
    "valid plugin/permission pairs should be persisted",
  );
  assert.deepEqual(
    mod.pluginRuntimePermissionGrantList("z-user", storage),
    ["clipboard.write"],
    "stored runtime grants should be normalized and readable by plugin",
  );
  assert.equal(
    mod.isPluginRuntimePermissionPersistentlyGranted("z-user", "clipboard.write", storage),
    true,
    "exact stored runtime grants should be allowed",
  );

  assert.equal(
    mod.grantPluginRuntimePermission("z-user", "clipboard.write", storage),
    false,
    "duplicate runtime grants should not rewrite storage",
  );
  assert.deepEqual(
    mod.pluginRuntimePermissionGrantList("z-user", storage),
    ["clipboard.write"],
    "duplicate runtime grants should stay deduplicated",
  );

  assert.equal(
    mod.grantPluginRuntimePermission("z-user", "shell.openExternal", storage),
    true,
    "additional permissions should be appended for the plugin",
  );
  assert.deepEqual(
    mod.pluginRuntimePermissionGrantList("z-user", storage),
    ["clipboard.write", "shell.openExternal"],
    "runtime grants should preserve insertion order",
  );

  assert.equal(
    mod.grantPluginRuntimePermission("", "clipboard.write", storage),
    false,
    "blank plugin ids should be ignored",
  );
  assert.equal(
    mod.grantPluginRuntimePermission("z-user", "", storage),
    false,
    "blank permissions should be ignored",
  );

  mod.clearPluginRuntimePermissionGrants("z-user", storage);
  assert.deepEqual(
    mod.pluginRuntimePermissionGrantList("z-user", storage),
    [],
    "clearing a plugin should remove only that plugin's persistent runtime grants",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
