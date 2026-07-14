import { pathToFileURL } from "node:url";

import {
  assertRepositoryVersions,
  normalizeStableReleaseTag,
} from "./version-contract.mjs";

export async function validateReleaseTag(tag, root = new URL("../", import.meta.url)) {
  const version = normalizeStableReleaseTag(tag);
  await assertRepositoryVersions(root, version);
  return { version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tag = process.argv[2];
    if (!tag || process.argv.length !== 3) {
      throw new Error("Usage: node scripts/validate-release-tag.mjs vX.Y.Z");
    }
    const result = await validateReleaseTag(tag);
    console.log(`ATOOLS_RELEASE_TAG_VALIDATED ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
