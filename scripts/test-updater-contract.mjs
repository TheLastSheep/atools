import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cargo = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
const lib = await readFile(new URL("src-tauri/src/lib.rs", root), "utf8");
const config = JSON.parse(
  await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);
const capability = JSON.parse(
  await readFile(new URL("src-tauri/capabilities/default.json", root), "utf8"),
);

assert.match(cargo, /tauri-plugin-updater\s*=\s*"2\.10(?:\.\d+)?"/);
assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
assert.match(lib, /\.manage\(updater::UpdateCoordinator::default\(\)\)/);
assert.match(lib, /updater::check_app_update/);
assert.match(lib, /updater::install_app_update/);
assert.match(lib, /updater::get_app_update_status/);
assert.doesNotMatch(lib, /updater:default|updater:allow-/);
assert.equal(config.bundle.createUpdaterArtifacts, true);
assert.deepEqual(config.plugins.updater.endpoints, [
  "https://github.com/TheLastSheep/atools/releases/latest/download/latest.json",
]);
assert.equal(typeof config.plugins.updater.pubkey, "string");
assert.ok(config.plugins.updater.pubkey.trim().length >= 40);
assert.doesNotMatch(
  config.plugins.updater.pubkey,
  /placeholder|public.key|unconfigured/i,
);
assert.equal(
  config.plugins.updater.dangerousInsecureTransportProtocol,
  undefined,
);
assert.ok(
  !capability.permissions.some((permission) =>
    String(
      typeof permission === "string" ? permission : permission.identifier,
    ).startsWith("updater:"),
  ),
);

console.log("updater contract tests passed");
