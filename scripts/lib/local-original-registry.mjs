import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const registryUrls = [
  new URL("../../tests/fixtures/local-original-plugin-cases.json", import.meta.url),
  new URL("../../tests/fixtures/local-original-input-cases.json", import.meta.url),
  new URL("../../tests/fixtures/local-plain-text-cases.json", import.meta.url),
  new URL("../../tests/fixtures/local-subnet-calculator-cases.json", import.meta.url),
  new URL("../../tests/fixtures/local-original-mybatis-cases.json", import.meta.url),
  new URL("../../tests/fixtures/local-original-random-data-cases.json", import.meta.url),
  new URL("../../tests/fixtures/local-original-image-stitch-cases.json", import.meta.url),
];
const sourceReviewStatus = "prepared_for_parent_native_fixture_decision";
const IMAGE_STITCH_HEAD_DIRECTORY_SHA256 = "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee";

function imageStitchWitnessMatches(witness) {
  if (!witness || !Array.isArray(witness.files) || !Array.isArray(witness.directories)
    || Object.keys(witness).sort().join(",") !== "directories,directorySha256,expandedBytes,fileCount,files"
    || witness.files.length !== 5 || witness.fileCount !== 5 || witness.expandedBytes !== 42462
    || witness.directorySha256 !== IMAGE_STITCH_HEAD_DIRECTORY_SHA256 || witness.directories.length !== 0) return false;
  const hash = createHash("sha256").update(Buffer.from("AToolsLocalTreeV1\0", "utf8"));
  let previous = null;
  for (const file of witness.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || Object.keys(file).sort().join(",") !== "bytes,path,sha256"
      || typeof file.path !== "string" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
    const name = Buffer.from(file.path, "utf8");
    if (previous && Buffer.compare(previous, name) >= 0) return false;
    previous = name;
    const prefix = Buffer.alloc(5); prefix[0] = 0x46; prefix.writeUInt32BE(name.length, 1);
    const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(file.bytes));
    hash.update(prefix).update(name).update(size).update(Buffer.from(file.sha256, "hex"));
  }
  return hash.digest("hex") === IMAGE_STITCH_HEAD_DIRECTORY_SHA256
    && witness.files.reduce((total, file) => total + file.bytes, 0) === witness.expandedBytes;
}

/** Compose reviewed directory catalogs without allowing an earlier record to shadow a later case. */
export function mergeLocalOriginalRegistries(registries) {
  const cases = [];
  const snapshots = Object.create(null);
  const sourceReview = Object.create(null);
  const ids = new Set();
  for (const registry of registries) {
    if (registry?.schemaVersion !== 1 || !Array.isArray(registry.cases)
      || !registry.snapshots || typeof registry.snapshots !== "object" || Array.isArray(registry.snapshots)
      || !registry.sourceReview || typeof registry.sourceReview !== "object" || Array.isArray(registry.sourceReview)) {
      throw Error("Invalid local original package registry");
    }
    if (registry.cases.some(profile => profile?.caseId === "local-image-stitch-head")
      && (registry.repository !== "ZTools-plugins" || registry.commit !== "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
        || registry.packagePath !== "plugins/image-stitch" || registry.packageTree !== "629b6c70b86f28d8f775ced7202bfc2de9b244d5")) {
      throw Error("Invalid local original Image Stitch HEAD catalog provenance");
    }
    for (const profile of registry.cases) {
      const id = profile?.caseId;
      if (typeof id !== "string" || !/^local-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) {
        throw Error("Duplicate or invalid local original package case ID");
      }
      if (!Object.hasOwn(registry.snapshots, id) || !Object.hasOwn(registry.sourceReview, id)) {
        throw Error("Local original package case lacks an independent witness or source review");
      }
      ids.add(id);
      cases.push(profile);
      snapshots[id] = registry.snapshots[id];
      sourceReview[id] = registry.sourceReview[id];
    }
    if ([...Object.keys(registry.snapshots), ...Object.keys(registry.sourceReview)].some(id => !registry.cases.some(profile => profile.caseId === id))) {
      throw Error("Local original package registry contains an unregistered witness or source review");
    }
  }
  return { schemaVersion: 1, cases, snapshots, sourceReview };
}

/** Pure profile gate, also used by synthetic tests; it grants no filesystem or runtime authority. */
export function selectLocalOriginalRegistration(registry, caseId) {
  const profile = registry.cases.find(entry => entry.caseId === caseId);
  const witness = registry.snapshots?.[caseId];
  const approvedMybatisHead = profile?.caseId === "local-mybatis-sql-formatter-head"
    && profile.id === "mybatis-sql-formatter" && profile.version === "1.0.0"
    && profile.runtime === "web" && profile.dataAccess === false && profile.pathAccess === "none"
    && profile.sourceCommit === "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
    && profile.sourceTree === "c456e308df68a1806772fb7f31edfa95d37f31e0"
    && profile.directorySha256 === "963a5779f37670bbc40a36574dee5a482e1d68f5727ae544c02772172f70b581"
    && profile.featureCode === "format-sql-log";
  const approvedRandomDataHead = profile?.caseId === "local-random-data-head"
    && profile.id === "random-data" && profile.version === "1.2.0"
    && profile.runtime === "web" && profile.dataAccess === true && profile.verifyDataPersistence === true
    && profile.pathAccess === "none" && profile.dialogAccess === "none"
    && profile.sourceCommit === "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
    && profile.sourceTree === "113232c852e07d88dce1e6ba69f3be51ead0f154"
    && profile.directorySha256 === "6c62e8d69ff009636fe948694554722556799b4c5721dc865caf637bbaf02c95"
    && profile.featureCode === "randomDataSettings" && profile.searchQuery === "随机数据设置";
  const approvedImageStitchHead = profile?.caseId === "local-image-stitch-head"
    && profile.id === "image-stitch" && profile.version === "1.0.0"
    && profile.sourcePath === "ZTools-plugins/plugins/image-stitch"
    && profile.sourceCommit === "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
    && profile.sourceTree === "629b6c70b86f28d8f775ced7202bfc2de9b244d5"
    && profile.directorySha256 === "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee"
    && profile.fileCount === 5 && profile.featureCode === "image-stitch-files"
    && profile.searchQuery === "拼接图片" && profile.title === "图片拼接"
    && profile.sourceReview === "output/legacy-node-2026-10-21/local-image-stitch-head-source-review-v1.json"
    && profile.frameOperations === "tests/components/nativeOriginalImageStitchFrameOperations.js"
    && profile.runtime === "web" && profile.dataAccess === true && profile.verifyDataPersistence === false
    && profile.dialogAccess === "open_and_save" && profile.pathAccess === "none";
  const approvedStandardPaths = profile?.caseId === "local-plain-text" && profile.id === "plain-text"
    && profile.version === "1.0.2" && profile.runtime === "node" && profile.dataAccess === true
    && profile.verifyDataPersistence === true && profile.sourcePath === "ZTools-plugins/plugins/plain-text"
    && profile.directorySha256 === "cac445cf31c918e213dcc0d1dde206e5bcc3514957c46088307e88e48601fda2";
  if (!profile || (profile.caseId === "local-mybatis-sql-formatter-head" && !approvedMybatisHead)
    || (profile.caseId === "local-random-data-head" && !approvedRandomDataHead)
    || (profile.caseId === "local-image-stitch-head" && (!approvedImageStitchHead || !imageStitchWitnessMatches(witness)))
    || profile.sourceKind !== "local_full_directory" || !/^[a-f0-9]{64}$/.test(profile.directorySha256)
    || profile.archiveSha256 !== undefined
    || !Number.isSafeInteger(profile.fileCount) || profile.fileCount < 1 || profile.fileCount > 64
    || typeof profile.verifyDataPersistence !== "boolean"
    || (profile.verifyDataPersistence && profile.dataAccess !== true)
    || (!([undefined, "none", "save"].includes(profile.dialogAccess))
      && !(profile.caseId === "local-image-stitch-head" && approvedImageStitchHead))
    || !(profile.pathAccess === "none" || profile.pathAccess === "standard" && approvedStandardPaths)
    || !["web", "node"].includes(profile.runtime)
    || typeof profile.dataAccess !== "boolean" || !witness
    || witness.fileCount !== profile.fileCount || witness.directorySha256 !== profile.directorySha256
    || !Array.isArray(witness.files) || witness.files.length !== profile.fileCount || !Array.isArray(witness.directories)
    || profile.sourceReviewStatus !== sourceReviewStatus) {
    throw Error(`Unknown or invalid local original package profile: ${caseId}`);
  }
  return { profile: Object.freeze(profile), witness, sourceReview: registry.sourceReview?.[caseId] };
}

export async function readLocalOriginalRegistry() {
  const registries = await Promise.all(registryUrls.map(async url => JSON.parse(await readFile(url, "utf8"))));
  return mergeLocalOriginalRegistries(registries);
}
