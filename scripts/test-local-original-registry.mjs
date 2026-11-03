import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { mergeLocalOriginalRegistries, readLocalOriginalRegistry,
  selectLocalOriginalRegistration } from "./lib/local-original-registry.mjs";
import { profilePackageDigest, readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";

function syntheticRegistry() {
  const profile = { caseId: "local-synthetic", sourceKind: "local_full_directory", directorySha256: "a".repeat(64),
    fileCount: 1, verifyDataPersistence: false, pathAccess: "none", runtime: "web", dataAccess: false,
    sourceReviewStatus: "prepared_for_parent_native_fixture_decision" };
  return { schemaVersion: 1, cases: [profile], sourceReview: { "local-synthetic": { staticOnly: true } },
    snapshots: { "local-synthetic": { directorySha256: profile.directorySha256, fileCount: 1,
      files: [{ path: "plugin.json", bytes: 1, sha256: "b".repeat(64) }], directories: [] } } };
}

test("catalog composition preserves all records and rejects cross-catalog shadowing", () => {
  const first = syntheticRegistry();
  assert.equal(mergeLocalOriginalRegistries([first]).cases.length, 1);
  assert.throws(() => mergeLocalOriginalRegistries([first, first]), /Duplicate or invalid/);
  const duplicate = syntheticRegistry();
  duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => mergeLocalOriginalRegistries([duplicate]), /Duplicate or invalid/);
});

test("catalog composition requires matching independently keyed review and witness", () => {
  for (const field of ["snapshots", "sourceReview"]) {
    const missing = syntheticRegistry();
    delete missing[field]["local-synthetic"];
    assert.throws(() => mergeLocalOriginalRegistries([missing]), /lacks an independent/);
    const orphan = syntheticRegistry();
    orphan[field]["local-orphan"] = {};
    assert.throws(() => mergeLocalOriginalRegistries([orphan]), /unregistered witness or source review/);
  }
  assert.throws(() => mergeLocalOriginalRegistries([{ ...syntheticRegistry(), schemaVersion: 2 }]), /Invalid local original/);
});

test("directory persistence is an explicit boolean and requires data permission", () => {
  const registry = syntheticRegistry();
  assert.equal(selectLocalOriginalRegistration(registry, "local-synthetic").profile.verifyDataPersistence, false);
  for (const value of [undefined, null, "false", "true", 0, 1]) {
    const changed = syntheticRegistry();
    changed.cases[0].verifyDataPersistence = value;
    assert.throws(() => selectLocalOriginalRegistration(changed, "local-synthetic"), /Unknown or invalid/);
  }
  const persistence = syntheticRegistry();
  persistence.cases[0].verifyDataPersistence = true;
  assert.throws(() => selectLocalOriginalRegistration(persistence, "local-synthetic"), /Unknown or invalid/);
  persistence.cases[0].dataAccess = true;
  assert.equal(selectLocalOriginalRegistration(persistence, "local-synthetic").profile.verifyDataPersistence, true);
});

test("dialog metadata admits only the reviewed optional save capability without proving runtime use", () => {
  for (const dialogAccess of [undefined, "none", "save"]) {
    const registry = syntheticRegistry();
    registry.cases[0].dialogAccess = dialogAccess;
    const { profile } = selectLocalOriginalRegistration(registry, "local-synthetic");
    assert.equal(profile.dialogAccess, dialogAccess);
    assert.equal(profile.runtime, "web");
    assert.equal(profile.dataAccess, false);
  }
  for (const dialogAccess of [null, false, true, "open", "open_and_save", "all", "SAVE", [], {}]) {
    const registry = syntheticRegistry();
    registry.cases[0].dialogAccess = dialogAccess;
    assert.throws(() => selectLocalOriginalRegistration(registry, "local-synthetic"), /Unknown or invalid/);
  }
});

test("directory profile gate rejects changed identity, bounds and witness counts", () => {
  const changes = [{ sourceKind: "local_original_archive" }, { directorySha256: "bad" }, { archiveSha256: "a".repeat(64) },
    { fileCount: 0 }, { fileCount: 65 }, { runtime: "wasm" }, { pathAccess: "standard" }, { dataAccess: "true" }];
  for (const changed of changes) {
    const registry = syntheticRegistry();
    Object.assign(registry.cases[0], changed);
    assert.throws(() => selectLocalOriginalRegistration(registry, "local-synthetic"), /Unknown or invalid/);
  }
  const registry = syntheticRegistry();
  registry.snapshots["local-synthetic"].files = [];
  assert.throws(() => selectLocalOriginalRegistration(registry, "local-synthetic"), /Unknown or invalid/);
  assert.throws(() => selectLocalOriginalRegistration(syntheticRegistry(), "unregistered"), /Unknown or invalid/);
});

// An independent digest from JSON metadata: this test reads no original plugin directory or code.
function digestWitness(witness) {
  const hash = createHash("sha256").update(Buffer.from("AToolsLocalTreeV1\0"));
  for (const [kind, records] of [["D", witness.directories], ["F", witness.files]]) {
    let previous = null;
    for (const value of records) {
      const name = Buffer.from(kind === "D" ? value : value.path);
      assert.ok(previous === null || Buffer.compare(previous, name) < 0);
      previous = name;
      const prefix = Buffer.alloc(5);
      prefix.write(kind, 0);
      prefix.writeUInt32BE(name.length, 1);
      hash.update(prefix).update(name);
      if (kind === "F") {
        const size = Buffer.alloc(8);
        size.writeBigUInt64BE(BigInt(value.bytes));
        hash.update(size).update(Buffer.from(value.sha256, "hex"));
      }
    }
  }
  return hash.digest("hex");
}

test("input catalog pins complete independently reconstructable directory witnesses", async () => {
  const registry = JSON.parse(await readFile(new URL("../tests/fixtures/local-original-input-cases.json", import.meta.url), "utf8"));
  assert.equal(registry.cases.length, 2);
  const expected = new Map([
    ["local-uuid-kit", "088f727ad939b8af6063179386245cbfd96f1a227e289cba6bdf8d76ebb70e8c"],
    ["local-ascii-tree", "98b09af12fffd827b88a31f8308273aa9d3840b0ee76fb5f56a67cd2e41fb579"],
  ]);
  for (const profile of registry.cases) {
    const { witness } = selectLocalOriginalRegistration(registry, profile.caseId);
    assert.equal(profile.directorySha256, expected.get(profile.caseId));
    assert.equal(digestWitness(witness), profile.directorySha256);
    assert.equal(witness.files.length, 12);
    assert.equal(witness.files.filter(file => file.path === ".gitignore").length, 1);
    assert.equal(registry.sourceReview[profile.caseId].entryPoints.includes("preload.js"), true);
  }
});

test("JSON-only profile readers agree on the exact case set including HEAD-pinned calculation paper", async () => {
  const registry = await readLocalOriginalRegistry();
  const expectedCaseIds = [
    "local-ascii-tree", "local-calculation-paper", "local-calculation-paper-head", "local-content-workbench",
    "local-cron", "local-developer-codec-tools", "local-image-stitch-head", "local-json-editor",
    "local-mybatis-sql-formatter-head", "local-plain-text", "local-random-data-head", "local-subnet-calculator", "local-uuid-kit",
  ];
  assert.deepEqual(registry.cases.map(item => item.caseId).sort(), expectedCaseIds);
  for (const caseId of ["local-uuid-kit", "local-ascii-tree", "local-json-editor", "local-content-workbench",
    "local-calculation-paper-head", "local-mybatis-sql-formatter-head"]) {
    const { profile } = selectLocalOriginalRegistration(registry, caseId);
    assert.deepEqual(await readPublishedPluginProfile(caseId), profile);
    assert.equal(profilePackageDigest(profile), profile.directorySha256);
  }
  const headProfile = selectLocalOriginalRegistration(registry, "local-calculation-paper-head").profile;
  const headWitness = registry.snapshots[headProfile.caseId];
  assert.equal(headProfile.sourceCommit, "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d");
  assert.equal(headProfile.sourceTree, "81da0c4397c3190c9ed9d88e49f3b974b4fa32a4");
  assert.equal(headProfile.directorySha256, "56de9c81fed8f4db2c4b90583ca8c56ab0f22e67b5e8edf3153a6b8e992397ba");
  assert.equal(digestWitness(headWitness), headProfile.directorySha256);
  assert.equal(headWitness.files.length, 8);
  const mybatis = selectLocalOriginalRegistration(registry, "local-mybatis-sql-formatter-head").profile;
  const mybatisWitness = registry.snapshots[mybatis.caseId];
  assert.equal(mybatis.sourceCommit, "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d");
  assert.equal(mybatis.sourceTree, "c456e308df68a1806772fb7f31edfa95d37f31e0");
  assert.equal(mybatis.directorySha256, "963a5779f37670bbc40a36574dee5a482e1d68f5727ae544c02772172f70b581");
  assert.equal(digestWitness(mybatisWitness), mybatis.directorySha256);
  assert.equal(mybatisWitness.files.length, 5);
  assert.equal(mybatis.runtime, "web"); assert.equal(mybatis.dataAccess, false); assert.equal(mybatis.pathAccess, "none");
  const driftedMybatis = structuredClone(registry);
  driftedMybatis.cases.find(item => item.caseId === mybatis.caseId).runtime = "node";
  assert.throws(() => selectLocalOriginalRegistration(driftedMybatis, mybatis.caseId), /Unknown or invalid/);
  const uuid = await readPublishedPluginProfile("local-uuid-kit");
  assert.equal(uuid.runtime, "web");
  assert.equal(uuid.dataAccess, false);
  assert.equal(uuid.pathAccess, "none");
  assert.equal(uuid.dialogAccess, undefined);
  assert.equal(uuid.sourceReview, "output/legacy-node-2026-10-17/local-original-input-source-review-v2.json");
  const ascii = await readPublishedPluginProfile("local-ascii-tree");
  assert.equal(ascii.runtime, "node");
  assert.equal(ascii.dataAccess, true);
  assert.equal(ascii.verifyDataPersistence, true);
  assert.equal(ascii.pathAccess, "none");
  assert.equal(ascii.dialogAccess, "save");
  assert.equal(ascii.sourceReview, uuid.sourceReview);
  const randomData = await readPublishedPluginProfile("local-random-data-head");
  const randomDataRegistration = selectLocalOriginalRegistration(registry, randomData.caseId);
  assert.equal(randomData.sourceCommit, "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d");
  assert.equal(randomData.sourceTree, "113232c852e07d88dce1e6ba69f3be51ead0f154");
  assert.equal(randomData.directorySha256, "6c62e8d69ff009636fe948694554722556799b4c5721dc865caf637bbaf02c95");
  assert.equal(randomData.fileCount, 7); assert.equal(randomData.runtime, "web");
  assert.equal(randomData.dataAccess, true); assert.equal(randomData.verifyDataPersistence, true);
  assert.equal(randomData.pathAccess, "none"); assert.equal(randomData.dialogAccess, "none");
  assert.equal(randomDataRegistration.witness.expandedBytes, 77313);
  const driftedRandomData = structuredClone(registry);
  driftedRandomData.cases.find(item => item.caseId === randomData.caseId).dataAccess = false;
  assert.throws(() => selectLocalOriginalRegistration(driftedRandomData, randomData.caseId), /Unknown or invalid/);
  assert.deepEqual(await readPublishedPluginProfile(randomData.caseId), randomData);
  const imageStitch = selectLocalOriginalRegistration(registry, "local-image-stitch-head");
  assert.equal(imageStitch.profile.sourceCommit, "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d");
  assert.equal(imageStitch.profile.sourceTree, "629b6c70b86f28d8f775ced7202bfc2de9b244d5");
  assert.equal(imageStitch.profile.directorySha256, "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee");
  assert.equal(imageStitch.profile.fileCount, 5);
  assert.equal(imageStitch.profile.dialogAccess, "open_and_save");
  assert.equal(digestWitness(imageStitch.witness), imageStitch.profile.directorySha256);
  assert.deepEqual(await readPublishedPluginProfile(imageStitch.profile.caseId), imageStitch.profile);
  const driftedImageStitchProfile = structuredClone(registry);
  driftedImageStitchProfile.cases.find(item => item.caseId === imageStitch.profile.caseId).sourceTree = "0".repeat(40);
  assert.throws(() => selectLocalOriginalRegistration(driftedImageStitchProfile, imageStitch.profile.caseId), /Unknown or invalid/);
  const driftedImageStitchWitness = structuredClone(registry);
  driftedImageStitchWitness.snapshots[imageStitch.profile.caseId].files[0].sha256 = "0".repeat(64);
  assert.throws(() => selectLocalOriginalRegistration(driftedImageStitchWitness, imageStitch.profile.caseId), /Unknown or invalid/);
});

test("Image Stitch raw catalog provenance is checked before composition drops its top-level fields", async () => {
  const rawUrl = new URL("../tests/fixtures/local-original-image-stitch-cases.json", import.meta.url);
  const raw = JSON.parse(await readFile(rawUrl, "utf8"));
  const merged = mergeLocalOriginalRegistries([raw]);
  const selected = selectLocalOriginalRegistration(merged, "local-image-stitch-head");
  assert.equal(selected.profile.directorySha256, "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee");
  assert.equal(digestWitness(selected.witness), selected.profile.directorySha256);
  for (const [field, changed] of [["repository", "other-repo"], ["commit", "0".repeat(40)],
    ["packagePath", "plugins/other"], ["packageTree", "0".repeat(40)]]) {
    const drifted = structuredClone(raw); drifted[field] = changed;
    assert.throws(() => mergeLocalOriginalRegistries([drifted]), /Image Stitch HEAD catalog provenance/);
  }
});

test("plain and subnet have independent semantic catalogs with reconstructable complete tree witnesses", async () => {
  for (const [caseId, count, bytes] of [["local-plain-text", 7, 928976], ["local-subnet-calculator", 4, 17973]]) {
    const registry = JSON.parse(await readFile(new URL(`../tests/fixtures/${caseId}-cases.json`, import.meta.url), "utf8"));
    assert.equal(registry.cases.length, 1);
    const { profile, witness, sourceReview } = selectLocalOriginalRegistration(registry, caseId);
    assert.equal(digestWitness(witness), profile.directorySha256); assert.equal(witness.fileCount, count);
    assert.equal(witness.files.reduce((sum, file) => sum + file.bytes, 0), bytes);
    assert.deepEqual(await readPublishedPluginProfile(caseId), profile);
    assert.ok(sourceReview.riskBoundary.includes("clipboard"));
  }
});

test("only exact reviewed plain identity may request standard metadata; subnet remains Web without data", async () => {
  const registry = await readLocalOriginalRegistry();
  const plain = selectLocalOriginalRegistration(registry, "local-plain-text").profile;
  assert.equal(plain.pathAccess, "standard"); assert.equal(plain.runtime, "node"); assert.equal(plain.dataAccess, true);
  assert.equal(plain.verifyDataPersistence, true);
  for (const changed of [{ id: "other" }, { version: "1.0.3" }, { runtime: "web" }, { dataAccess: false },
    { verifyDataPersistence: false }, { sourcePath: "other" }, { directorySha256: "a".repeat(64) }]) {
    const clone = structuredClone(registry); Object.assign(clone.cases.find(item => item.caseId === plain.caseId), changed);
    assert.throws(() => selectLocalOriginalRegistration(clone, plain.caseId), /Unknown or invalid/);
  }
  const subnet = selectLocalOriginalRegistration(registry, "local-subnet-calculator").profile;
  assert.equal(subnet.runtime, "web"); assert.equal(subnet.pathAccess, "none"); assert.equal(subnet.dataAccess, false);
  assert.equal(subnet.verifyDataPersistence, false);
});
