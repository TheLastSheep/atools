import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  captureSettingsNativeSources,
  summarizeSettingsNativeSources,
} from "./ztools-settings-native-sources.mjs";

export const LAUNCH_RETURN_SETTINGS_RESOURCE_BYTES = 797_670;
export const LAUNCH_RETURN_MAIN_JAVASCRIPT_BYTES = 603_309;
const TOP_INPUTS = ["build.mjs", "source-manifest.json", "package.json", "package-lock.json"];
const REQUIRED_PATCH_INPUT = "packages/ztools-settings/src/compatibility-patches/native-local-drop.mjs";

function digest(records) {
  const hash = createHash("sha256");
  for (const row of records) hash.update(`${row.path}\0${row.bytes}\0${row.sha256}\0`);
  return hash.digest("hex");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bind every current Settings build and compatibility input to the formal dist provenance. */
export function validateLaunchReturnSettingsInputs(snapshot, provenance) {
  const packageFiles = snapshot?.packageFiles;
  assert.ok(Array.isArray(packageFiles) && packageFiles.length > 0, "Settings package sources are required");
  const paths = packageFiles.map(file => file.path);
  assert.equal(new Set(paths).size, paths.length, "Settings package sources must be unique");
  const expected = packageFiles.filter(file => TOP_INPUTS.some(path => file.path === `packages/ztools-settings/${path}`)
    || file.path.startsWith("packages/ztools-settings/src/") && file.path.endsWith(".mjs")
      && !file.path.endsWith(".test.mjs")).sort((left, right) => left.path.localeCompare(right.path));
  assert.ok(expected.some(file => file.path === REQUIRED_PATCH_INPUT), "Settings native-drop patch input is required");
  assert.ok(expected.some(file => file.path === "packages/ztools-settings/src/source-compatibility.mjs"),
    "Settings source compatibility input is required");
  assert.ok(TOP_INPUTS.every(path => expected.some(file => file.path === `packages/ztools-settings/${path}`)),
    "Settings build metadata inputs are required");
  const claimed = provenance?.build?.localBuildInputs;
  assert.ok(Array.isArray(claimed) && claimed.length === expected.length, "Settings local build input count differs");
  assert.equal(new Set(claimed.map(file => file?.path)).size, claimed.length, "Settings local build inputs are duplicated");
  for (const file of claimed) {
    assert.ok(record(file) && Object.keys(file).length === 3
      && ["path", "bytes", "sha256"].every(key => Object.hasOwn(file, key)), "Settings local build input shape differs");
  }
  assert.deepEqual([...claimed].sort((left, right) => left.path.localeCompare(right.path)), expected,
    "Settings local build inputs differ from current sources or compatibility patches");
  assert.equal(snapshot.bundle?.resourceBytes, LAUNCH_RETURN_SETTINGS_RESOURCE_BYTES,
    "Settings production resource bytes changed from the frozen R68 baseline");
  return { files: expected, fileCount: expected.length, sha256: digest(expected) };
}

async function readProvenance(snapshot) {
  const path = join(snapshot.distRoot, "build-provenance.json");
  const info = await lstat(path, { bigint: true });
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    && await realpath(path) === path, "Settings provenance must be a regular canonical file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.size <= 256n * 1024n && before.dev === info.dev && before.ino === info.ino,
      "Settings provenance changed before reading");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && BigInt(bytes.byteLength) === after.size,
    "Settings provenance changed while reading");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), snapshot.bundle.provenanceSha256,
      "Settings provenance differs from the captured bundle");
    return JSON.parse(bytes.toString("utf8"));
  } finally { await handle.close(); }
}

export async function captureLaunchReturnSettingsSources(root) {
  const snapshot = await captureSettingsNativeSources(root);
  const provenance = await readProvenance(snapshot);
  const localBuildInputs = validateLaunchReturnSettingsInputs(snapshot, provenance);
  return { ...snapshot, localBuildInputs };
}

export function summarizeLaunchReturnSettingsSources(snapshot) {
  if (!snapshot) return null;
  return { ...summarizeSettingsNativeSources(snapshot),
    localBuildInputs: structuredClone(snapshot.localBuildInputs) };
}

export async function assertLaunchReturnSettingsSourcesUnchanged(snapshot) {
  const after = await captureLaunchReturnSettingsSources(snapshot.repositoryRoot);
  assert.deepEqual(summarizeLaunchReturnSettingsSources(after), summarizeLaunchReturnSettingsSources(snapshot),
    "Settings sources, compatibility inputs, or formal dist changed during launch-return acceptance");
  return after;
}

export function launchReturnRendererSourceSha256(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function launchReturnSettingsBuildReceiptMatches(receipt, snapshot, rendererSnapshot) {
  const expected = summarizeLaunchReturnSettingsSources(snapshot);
  const binding = receipt?.launchReturn;
  return record(binding) && Object.keys(binding).length === 4 && binding.registrationSource === "settings-child"
    && binding.sourcesStable === true && expected !== null && rendererSnapshot?.errors?.length === 0
    && binding.rendererSourceSha256 === launchReturnRendererSourceSha256(rendererSnapshot)
    && JSON.stringify(binding.settingsSources) === JSON.stringify(expected);
}
