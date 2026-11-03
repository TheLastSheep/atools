import { HEAD_CASE_ID } from "./head-calculation-paper-fixture.mjs";
import { MYBATIS_HEAD_CASE_ID } from "./head-mybatis-fixture.mjs";
import { RANDOM_DATA_HEAD_CASE_ID } from "./head-random-data-fixture.mjs";
import { IMAGE_STITCH_HEAD_CASE_ID } from "./head-image-stitch-fixture.mjs";

/** Routes fixed Git-HEAD cases through their pinned readers; only other registered cases use local-source adapters. */
export async function prepareLocalNativeFixture(caseId, temporaryParent, providers) {
  if (caseId === HEAD_CASE_ID) return providers.prepareCalculation(await providers.readProfile(caseId), temporaryParent);
  if (caseId === MYBATIS_HEAD_CASE_ID) return providers.prepareMybatis(await providers.readProfile(caseId), temporaryParent);
  if (caseId === RANDOM_DATA_HEAD_CASE_ID) return providers.prepareRandomData(await providers.readProfile(caseId), temporaryParent);
  if (caseId === IMAGE_STITCH_HEAD_CASE_ID) return providers.prepareImageStitch(await providers.readProfile(caseId), temporaryParent);
  if (caseId === "local-my-calculator-zpx") return providers.prepareArchive(caseId, temporaryParent);
  return providers.prepareGeneric(caseId, temporaryParent);
}
