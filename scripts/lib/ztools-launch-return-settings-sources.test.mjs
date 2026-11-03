import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertLaunchReturnSettingsSourcesUnchanged, captureLaunchReturnSettingsSources,
  launchReturnRendererSourceSha256, launchReturnSettingsBuildReceiptMatches,
  summarizeLaunchReturnSettingsSources, validateLaunchReturnSettingsInputs,
} from "./ztools-launch-return-settings-sources.mjs";

function fixture() {
  const paths = ["build.mjs", "source-manifest.json", "package.json", "package-lock.json",
    "src/source-compatibility.mjs", "src/compatibility-patches/native-local-drop.mjs", "src/hostBridgeEntry.ts"];
  const packageFiles = paths.map(path => ({ path: `packages/ztools-settings/${path}`, bytes: 20, sha256: "a".repeat(64) }));
  const snapshot = { packageFiles, bundle: { resourceBytes: 797_670 } };
  const localBuildInputs = packageFiles.filter(file => !file.path.endsWith(".ts"));
  return { snapshot, provenance: { build: { localBuildInputs } } };
}

test("binds all Settings build and compatibility inputs to the formal distribution", () => {
  const { snapshot, provenance } = fixture();
  const result = validateLaunchReturnSettingsInputs(snapshot, provenance);
  assert.equal(result.fileCount, 6);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  for (const mutate of [
    value => { value.provenance.build.localBuildInputs.pop(); },
    value => { value.provenance.build.localBuildInputs[0] = { ...value.provenance.build.localBuildInputs[0], sha256: "b".repeat(64) }; },
    value => { value.provenance.build.localBuildInputs[0].extra = true; },
    value => { value.provenance.build.localBuildInputs.push(value.provenance.build.localBuildInputs[0]); },
    value => { value.snapshot.packageFiles = value.snapshot.packageFiles.filter(file => !file.path.endsWith("native-local-drop.mjs")); },
    value => { value.snapshot.packageFiles.push({ path: "packages/ztools-settings/src/new-dependency.mjs", bytes: 1, sha256: "c".repeat(64) }); },
    value => { value.snapshot.bundle.resourceBytes += 1; },
  ]) {
    const sample = fixture(); mutate(sample);
    assert.throws(() => validateLaunchReturnSettingsInputs(sample.snapshot, sample.provenance));
  }
});

test("captures the unchanged formal Settings bundle, source compatibility and complete patch inputs", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const before = await captureLaunchReturnSettingsSources(root);
  assert.equal(before.bundle.resourceBytes, 797_670);
  assert.ok(before.packageFiles.some(file => file.path.endsWith("/src/source-compatibility.mjs")));
  assert.ok(before.localBuildInputs.files.some(file => file.path.endsWith("/compatibility-patches/native-local-drop.mjs")));
  assert.deepEqual(summarizeLaunchReturnSettingsSources(await assertLaunchReturnSettingsSourcesUnchanged(before)),
    summarizeLaunchReturnSettingsSources(before));
  const renderer = { packageFiles: { "runner.mjs": "a".repeat(64) }, distFiles: {}, upstream: {}, errors: [] };
  const receipt = { launchReturn: { registrationSource: "settings-child", sourcesStable: true,
    settingsSources: summarizeLaunchReturnSettingsSources(before), rendererSourceSha256: launchReturnRendererSourceSha256(renderer) } };
  assert.equal(launchReturnSettingsBuildReceiptMatches(receipt, before, renderer), true);
  assert.equal(launchReturnSettingsBuildReceiptMatches({}, before, renderer), false, "old R66 receipts do not bind this registration");
  assert.equal(launchReturnSettingsBuildReceiptMatches(receipt, before, { ...renderer, errors: ["incomplete"] }), false);
  assert.equal(launchReturnSettingsBuildReceiptMatches(receipt, before, { ...renderer, packageFiles: {} }), false);
  receipt.launchReturn.settingsSources.localBuildInputs.sha256 = "0".repeat(64);
  assert.equal(launchReturnSettingsBuildReceiptMatches(receipt, before, renderer), false);
});
