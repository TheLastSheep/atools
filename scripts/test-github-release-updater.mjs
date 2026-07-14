import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseVerifierArguments,
  UPDATER_RELEASE_VERIFIED_PREFIX,
  validateUpdaterManifest,
} from "./verify-github-release-updater.mjs";

const manifest = {
  version: "3.0.0",
  notes: "ATools 3.0 stable",
  pub_date: "2026-07-14T00:00:00Z",
  platforms: {
    "darwin-aarch64": {
      signature: "RWQAA-valid-aarch64-signature",
      url: "https://github.com/TheLastSheep/atools/releases/download/v3.0.0/ATools.aarch64.app.tar.gz",
    },
    "darwin-x86_64": {
      signature: "RWQAA-valid-x64-signature",
      url: "https://github.com/TheLastSheep/atools/releases/download/v3.0.0/ATools.x64.app.tar.gz",
    },
  },
};
const assets = [
  "latest.json",
  "ATools.aarch64.app.tar.gz",
  "ATools.aarch64.app.tar.gz.sig",
  "ATools.x64.app.tar.gz",
  "ATools.x64.app.tar.gz.sig",
  "ATools_3.0.0_aarch64.dmg",
  "ATools_3.0.0_x64.dmg",
];

function verify(value = manifest, options = {}) {
  return validateUpdaterManifest({
    manifest: value,
    version: options.version ?? "3.0.0",
    tag: options.tag ?? "v3.0.0",
    assets: options.assets ?? assets,
  });
}

const verified = verify();
assert.equal(verified.version, "3.0.0");
assert.deepEqual(Object.keys(verified.platforms), ["darwin-aarch64", "darwin-x86_64"]);

const missingPlatform = structuredClone(manifest);
delete missingPlatform.platforms["darwin-x86_64"];
assert.throws(() => verify(missingPlatform), /darwin-x86_64/);

const emptySignature = structuredClone(manifest);
emptySignature.platforms["darwin-aarch64"].signature = "  ";
assert.throws(() => verify(emptySignature), /signature/);

const insecureUrl = structuredClone(manifest);
insecureUrl.platforms["darwin-aarch64"].url = insecureUrl.platforms["darwin-aarch64"].url.replace("https:", "http:");
assert.throws(() => verify(insecureUrl), /HTTPS/);

const wrongRepository = structuredClone(manifest);
wrongRepository.platforms["darwin-aarch64"].url = wrongRepository.platforms["darwin-aarch64"].url.replace("TheLastSheep", "harris");
assert.throws(() => verify(wrongRepository), /repository|TheLastSheep/);

const wrongManifestVersion = structuredClone(manifest);
wrongManifestVersion.version = "3.0.1";
assert.throws(() => verify(wrongManifestVersion), /manifest version/);
assert.throws(() => verify(manifest, { tag: "v3.0.1" }), /tag version/);

const wrongAssetTag = structuredClone(manifest);
wrongAssetTag.platforms["darwin-aarch64"].url = wrongAssetTag.platforms["darwin-aarch64"].url.replace("v3.0.0", "v2.9.9");
assert.throws(() => verify(wrongAssetTag), /tag|repository/);

const duplicateUrl = structuredClone(manifest);
duplicateUrl.platforms["darwin-x86_64"].url = duplicateUrl.platforms["darwin-aarch64"].url;
assert.throws(() => verify(duplicateUrl), /duplicate/);

assert.throws(
  () => verify(manifest, { assets: assets.filter((asset) => asset !== "ATools.x64.app.tar.gz") }),
  /not present in Release assets/,
);

assert.deepEqual(
  parseVerifierArguments([
    "--manifest", "latest.json",
    "--version", "3.0.0",
    "--tag", "v3.0.0",
    "--asset", "one.tar.gz",
    "--asset", "two.tar.gz",
  ]),
  {
    assets: ["one.tar.gz", "two.tar.gz"],
    manifest: "latest.json",
    version: "3.0.0",
    tag: "v3.0.0",
  },
);
assert.throws(() => parseVerifierArguments(["--manifest", "latest.json"]), /--version/);

const tempRoot = mkdtempSync(join(tmpdir(), "atools-updater-verifier-"));
try {
  const manifestPath = join(tempRoot, "latest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = execFileSync(process.execPath, [
    new URL("verify-github-release-updater.mjs", import.meta.url).pathname,
    "--manifest", manifestPath,
    "--version", "3.0.0",
    "--tag", "v3.0.0",
    ...assets.flatMap((asset) => ["--asset", asset]),
  ], { encoding: "utf8" });
  assert.match(output, new RegExp(`^${UPDATER_RELEASE_VERIFIED_PREFIX}`));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("GitHub updater release manifest verified");
