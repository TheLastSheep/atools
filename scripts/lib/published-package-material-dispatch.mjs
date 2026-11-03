import { createHash } from "node:crypto";
import { verifyLocalOriginalFixture } from "./local-plugin-fixture.mjs";
import { readHeadCalculationPaper, verifyHeadCalculationPaperFixture, HEAD_CASE_ID } from "./head-calculation-paper-fixture.mjs";
import { readHeadMybatisPackage, verifyHeadMybatisFixture, MYBATIS_HEAD_CASE_ID } from "./head-mybatis-fixture.mjs";
import { readHeadRandomDataPackage, verifyHeadRandomDataFixture, RANDOM_DATA_HEAD_CASE_ID } from "./head-random-data-fixture.mjs";
import { readHeadImageStitchPackage, verifyHeadImageStitchFixture, IMAGE_STITCH_HEAD_CASE_ID } from "./head-image-stitch-fixture.mjs";
import { verifyLocalOriginalArchiveFixture } from "./local-original-archive-fixture.mjs";
import { readVerifiedPublishedPluginFixture } from "./published-plugin-fixture.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const headPackages = [
  { caseId: HEAD_CASE_ID, packagePath: "calculation-paper", read: readHeadCalculationPaper, verify: verifyHeadCalculationPaperFixture },
  { caseId: MYBATIS_HEAD_CASE_ID, packagePath: "mybatis-sql-formatter", read: readHeadMybatisPackage, verify: verifyHeadMybatisFixture },
  { caseId: RANDOM_DATA_HEAD_CASE_ID, packagePath: "random-data", read: readHeadRandomDataPackage, verify: verifyHeadRandomDataFixture },
  { caseId: IMAGE_STITCH_HEAD_CASE_ID, packagePath: "image-stitch", read: readHeadImageStitchPackage, verify: verifyHeadImageStitchFixture },
];

/** Keeps source-witness and material-verification routing in one package-boundary adapter. */
export function createPackageMaterialDispatcher(providers) {
  const registeredHeadPackages = providers.headPackages ?? headPackages;
  const findHeadPackage = profile => registeredHeadPackages.find(candidate => candidate.caseId === profile?.caseId);

  async function verify(fixture, profile, expected) {
    const head = findHeadPackage(profile);
    if (head) return providers.verifyHead(head.caseId, fixture, profile);
    if (profile.sourceKind === "local_full_directory") return providers.verifyLocal(fixture, profile);
    if (profile.sourceKind === "local_original_archive") return providers.verifyArchive(fixture, profile);
    return providers.verifyPublished(fixture, expected);
  }

  function sourceWitness(profile) {
    const head = findHeadPackage(profile);
    if (!head) return [];
    const source = head.read();
    return [...source.files].map(([relative, bytes]) => [
      `HEAD/${source.commit}/plugins/${head.packagePath}/${relative}`,
      sha256(bytes),
    ]);
  }

  return { verify, sourceWitness };
}

const dispatcher = createPackageMaterialDispatcher({
  verifyHead: async (caseId, fixture, profile) => {
    const head = headPackages.find(candidate => candidate.caseId === caseId);
    if (!head) throw Error("Unknown pinned HEAD package material case");
    return head.verify(fixture, profile);
  },
  verifyLocal: verifyLocalOriginalFixture,
  verifyArchive: verifyLocalOriginalArchiveFixture,
  verifyPublished: readVerifiedPublishedPluginFixture,
});

export const verifyPublishedPackageMaterial = dispatcher.verify;
export const packageMaterialSourceWitness = dispatcher.sourceWitness;
export const PINNED_HEAD_PACKAGE_CASES = headPackages.map(({ caseId, packagePath }) => ({ caseId, packagePath }));
