const CASE_ID = "converted-deepread-source";

/** Selects an opt-in input encoding only for the reviewed DeepRead UI fixture. */
export function validateDeepReadTextEncoding({ caseId, value, executeReviewedPackage, buildOnly,
  workerContractOnly, nativeUiInput, nativeLaunchMode }) {
  if (value === undefined) return "ascii";
  if (value !== "utf8-bom" || caseId !== CASE_ID || executeReviewedPackage !== true
    || buildOnly || workerContractOnly || nativeUiInput || nativeLaunchMode !== "direct") {
    throw Error("DeepRead text encoding requires its explicit direct converted UI case");
  }
  return value;
}

/** Builds native argv without emitting a token for the unchanged default. */
export function deepReadTextEncodingArguments(encoding) {
  if (encoding === "ascii") return [];
  if (encoding === "utf8-bom") return ["--deepread-text-encoding", encoding];
  throw Error("Unknown DeepRead fixture encoding");
}
