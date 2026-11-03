export type DeepReadTextEncoding = "ascii" | "utf8-bom";
export type DeepReadFile = { bytes: number; content: string; fileName: string; path: string; readOnly: true;
  sha256: string; storedContentBytes: number; storedContentSha256: string; title: string; textEncoding: DeepReadTextEncoding };

const FIXTURE_NAME = "ATools-DeepRead-Reader-Fixture.txt";
const BOOK_TITLE = "ATools DeepRead Reader Fixture";
const STORED_CONTENT_BYTES = 8854;
const STORED_CONTENT_SHA256 = "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0";
const INPUTS: Record<DeepReadTextEncoding, { bytes: number; sha256: string; evidenceField: boolean }> = {
  ascii: { bytes: 8856, sha256: "81f1d61593517a97f8f206e0df298e45bdabeaa99fc99d32009eb3b80c50ac83", evidenceField: false },
  "utf8-bom": { bytes: 8859, sha256: "238396bdcc00c617be26664adeca4c60d72bfa9f2ef9ef074632c73a4cc76052", evidenceField: true },
};

/** Validates the exact selected raw fixture and the unchanged original-reader normalization oracle. */
export function assertDeepReadFixtureEvidence(value: unknown, selectedEncoding?: "utf8-bom"): DeepReadFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("DeepRead fixed input is unavailable");
  const file = value as Record<string, unknown>;
  const encoding: DeepReadTextEncoding = selectedEncoding ?? "ascii";
  const expected = INPUTS[encoding];
  const keys = ["bytes", "content", "fileName", "path", "readOnly", "sha256", "storedContentBytes", "storedContentSha256", "title",
    ...(expected.evidenceField ? ["textEncoding"] : [])];
  if (Object.keys(file).length !== keys.length || keys.some(key => !Object.hasOwn(file, key))
    || file.fileName !== FIXTURE_NAME || file.title !== BOOK_TITLE || file.bytes !== expected.bytes
    || file.sha256 !== expected.sha256 || file.readOnly !== true || file.storedContentBytes !== STORED_CONTENT_BYTES
    || file.storedContentSha256 !== STORED_CONTENT_SHA256 || file.content !== "fixed deterministic multipage text omitted"
    || expected.evidenceField && file.textEncoding !== "utf8-bom"
    || typeof file.path !== "string"
    || !/^\/private\/tmp\/atools-fixture-environment-[A-Za-z0-9_-]+\/home\/Downloads\/ATools-DeepRead-Reader-Fixture\.txt$/.test(file.path)) {
    throw Error("DeepRead file identity differs from the bounded fixture encoding pin");
  }
  return { ...file, textEncoding: encoding } as DeepReadFile;
}
