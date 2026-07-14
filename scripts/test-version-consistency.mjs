import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const tauriConfig = JSON.parse(
  await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);
const workspaceCargo = await readFile(new URL("Cargo.toml", root), "utf8");
const cargoLock = await readFile(new URL("Cargo.lock", root), "utf8");

const releaseVersion = packageJson.version;
assert.match(releaseVersion, /^\d+\.\d+\.\d+$/, "package version must be SemVer");
assert.equal(
  tauriConfig.version,
  releaseVersion,
  "Tauri bundle version must match package.json",
);

const workspaceVersion = workspaceCargo.match(
  /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];
assert.equal(
  workspaceVersion,
  releaseVersion,
  "Rust workspace version must match package.json",
);

for (const crate of ["atools", "atools-api-shim", "atools-core", "atools-plugin"]) {
  const escapedName = crate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lockedVersion = cargoLock.match(
    new RegExp(`\\[\\[package\\]\\]\\nname = "${escapedName}"\\nversion = "([^"]+)"`),
  )?.[1];
  assert.equal(
    lockedVersion,
    releaseVersion,
    `Cargo.lock version for ${crate} must match package.json`,
  );
}

console.log(`Version consistency verified: ${releaseVersion}`);
