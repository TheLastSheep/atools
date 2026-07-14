import assert from "node:assert/strict";
import {
  assertVersionContract,
  evaluateVersionContract,
  readVersionContract,
  RELEASE_MANIFEST_ENDPOINT,
  RELEASE_REPOSITORY,
} from "./version-contract.mjs";

const root = new URL("../", import.meta.url);
const current = await readVersionContract(root);
const result = assertVersionContract(current);
assert.equal(RELEASE_REPOSITORY, "TheLastSheep/atools");
assert.equal(
  RELEASE_MANIFEST_ENDPOINT,
  "https://github.com/TheLastSheep/atools/releases/latest/download/latest.json",
);

const mismatch = evaluateVersionContract({
  ...current,
  tauriConfig: { ...current.tauriConfig, version: "9.9.9" },
  expectedVersion: "3.0.0",
});
assert.match(mismatch.errors.join("\n"), /Tauri bundle version/);

const prerelease = evaluateVersionContract({
  ...current,
  packageJson: { ...current.packageJson, version: "3.0.0-rc.1" },
});
assert.match(prerelease.errors.join("\n"), /stable SemVer/);

console.log(`Version consistency verified: ${result.version}`);
