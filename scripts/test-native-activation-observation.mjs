import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { activationObservationEnvironment } from "./lib/native-activation-observation.mjs";
import { pluginDisplaySourceFiles } from "./lib/plugin-display-source-binding.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const stagedBundleId = "dev.atools.fixture.dialog.0123456789abcdef0123456789abcdef";
const privateVariables = ["ATOOLS_PANEL_ACTIVATION_OBSERVATION", "ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID"];

const disabled = activationObservationEnvironment({
  environment: {
    PATH: "/fixture/bin",
    ATOOLS_PANEL_ACTIVATION_OBSERVATION: "observe",
    ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID: "ambient-bundle-id",
  },
});
assert.equal(disabled.enabled, false);
assert.equal(disabled.reportScope, null);
assert.equal(disabled.environment.PATH, "/fixture/bin");
for (const key of privateVariables) assert.equal(Object.hasOwn(disabled.environment, key), false, `${key} leaked while disabled`);

const enabled = activationObservationEnvironment({
  environment: { PATH: "/fixture/bin", ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID: "ambient-bundle-id" },
  requestedMode: "observe",
  nativeUiInput: true,
  stagedBundleId,
});
assert.deepEqual(Object.keys(enabled.environment).filter(key => key.startsWith("ATOOLS_PANEL_ACTIVATION_")), privateVariables);
assert.equal(enabled.environment.ATOOLS_PANEL_ACTIVATION_OBSERVATION, "observe");
assert.equal(enabled.environment.ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID, stagedBundleId);
assert.match(enabled.reportScope, /Read-only window activation observation only/);
assert.doesNotMatch(enabled.reportScope, /editor input acceptance/i);

for (const requestedMode of ["", "Observe", "observe ", "true", "off"]) {
  assert.throws(() => activationObservationEnvironment({ requestedMode, nativeUiInput: true, stagedBundleId }), /exact observe mode/);
}
assert.throws(() => activationObservationEnvironment({ requestedMode: "observe", nativeUiInput: false, stagedBundleId }), /native editor fixture mode/);
for (const invalidBundleId of [undefined, "dev.atools.fixture.dialog." + "A".repeat(32), "dev.atools.fixture.dialog." + "0".repeat(31), "dev.atools.fixture.dialog." + "0".repeat(33), "dev.atools.fixture.dialog." + "0".repeat(32) + ".extra", "ambient-bundle-id"]) {
  assert.throws(() => activationObservationEnvironment({ requestedMode: "observe", nativeUiInput: true, stagedBundleId: invalidBundleId }), /exact staged bundle identity/);
}

const sourceFiles = await pluginDisplaySourceFiles(root);
for (const file of sourceFiles) {
  await access(resolve(root, file));
}
const probeSource = await readFile(resolve(root, "scripts/probe-published-plugin-native.mjs"), "utf8");
assert.match(probeSource, /activationObservationEnvironment\(/, "native probe must use the isolated environment helper");
assert.match(probeSource, /activationObservationScope = activation\.reportScope/);
console.log(JSON.stringify({ scenarios: 14, sourceBindings: sourceFiles.length, status: "passed" }));
