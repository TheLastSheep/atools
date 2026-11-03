import assert from "node:assert/strict";
import { deepReadTextEncodingArguments, validateDeepReadTextEncoding } from "./lib/deepread-text-encoding.mjs";

const base = { caseId: "converted-deepread-source", executeReviewedPackage: true, buildOnly: false,
  workerContractOnly: false, nativeUiInput: false, nativeLaunchMode: "direct" };
assert.equal(validateDeepReadTextEncoding({ ...base, value: undefined }), "ascii");
assert.equal(validateDeepReadTextEncoding({ ...base, value: "utf8-bom" }), "utf8-bom");
assert.deepEqual(deepReadTextEncodingArguments("ascii"), []);
assert.deepEqual(deepReadTextEncodingArguments("utf8-bom"), ["--deepread-text-encoding", "utf8-bom"]);
assert.throws(() => deepReadTextEncodingArguments("other"));
for (const invalid of [
  { ...base, value: "ascii" }, { ...base, value: "UTF8-BOM" }, { ...base, value: "utf8" },
  { ...base, caseId: "converted-tetris-source", value: "utf8-bom" },
  { ...base, executeReviewedPackage: false, value: "utf8-bom" },
  { ...base, buildOnly: true, value: "utf8-bom" },
  { ...base, workerContractOnly: true, value: "utf8-bom" },
  { ...base, nativeUiInput: true, value: "utf8-bom" },
  { ...base, nativeLaunchMode: "launchservices", value: "utf8-bom" },
]) assert.throws(() => validateDeepReadTextEncoding(invalid));
console.log("DeepRead explicit text encoding contract passed");
