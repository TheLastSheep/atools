export const MANIFEST_LIMITS = {
  rawBytes: 262_144,
  featureCount: 1_000,
  featureCodeBytes: 256,
  identityStringBytes: 256,
  manifestPathBytes: 4_096,
  identityJsonBytes: 270_336,
  metadataJsonBytes: 1_048_576,
} as const;
export type ManifestSelection = "root" | "public";
export type ManifestRuntime = "web" | "node";
export type ManifestDifference = "id" | "version" | "main" | "preload" | "runtime" | "featureCodes";
export type ManifestIdentity = {
  id: string;
  version: string;
  main: string;
  preload: string | null;
  runtime: ManifestRuntime;
  featureCodes: string[];
};
export type ManifestCandidate =
  | { selection: ManifestSelection; status: "valid"; manifestSha256: string; identity: ManifestIdentity }
  | { selection: ManifestSelection; status: "missing" | "invalid"; code: "manifest_missing" | "manifest_invalid" };
export type SourceManifestMetadata = {
  manifestSelection: ManifestSelection | null;
  manifestSha256: string | null;
  manifestIdentity: ManifestIdentity | null;
  manifestCandidates: [ManifestCandidate, ManifestCandidate];
  manifestDifferences: ManifestDifference[];
};
export type ParsedSourceManifestMetadata = { kind: "legacy" } | { kind: "current"; value: SourceManifestMetadata };

const metadataKeys = ["manifestSelection", "manifestSha256", "manifestIdentity", "manifestCandidates", "manifestDifferences"] as const;
const differenceOrder: ManifestDifference[] = ["id", "version", "main", "preload", "runtime", "featureCodes"];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}
function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
// Rust char::is_whitespace uses Unicode White_Space; unlike String.trim(), it excludes FEFF.
const rustWhitespace = /\p{White_Space}/u;
export function hasRustTrimContent(value: string): boolean {
  for (const character of value) {
    if (!rustWhitespace.test(character)) return true;
  }
  return false;
}
function text(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximumBytes && utf8Bytes(value) <= maximumBytes
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && (allowEmpty || hasRustTrimContent(value));
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validIdentity(value: unknown): value is ManifestIdentity {
  if (!record(value) || !exactKeys(value, ["id", "version", "main", "preload", "runtime", "featureCodes"])) return false;
  const fieldsValid = text(value.id, MANIFEST_LIMITS.identityStringBytes) && text(value.version, MANIFEST_LIMITS.identityStringBytes)
    && text(value.main, MANIFEST_LIMITS.manifestPathBytes) && (value.preload === null || text(value.preload, MANIFEST_LIMITS.manifestPathBytes))
    && (value.runtime === "web" || value.runtime === "node")
    && Array.isArray(value.featureCodes) && value.featureCodes.length <= MANIFEST_LIMITS.featureCount
    && value.featureCodes.every((code: unknown) => text(code, MANIFEST_LIMITS.featureCodeBytes)
      && !/[\u0000-\u001f\u007f-\u009f]/.test(code));
  const encoded = JSON.stringify(value);
  return fieldsValid && typeof encoded === "string" && utf8Bytes(encoded) <= MANIFEST_LIMITS.identityJsonBytes;
}
function validCandidate(value: unknown, selection: ManifestSelection): value is ManifestCandidate {
  if (!record(value) || value.selection !== selection) return false;
  if (value.status === "valid") {
    return exactKeys(value, ["selection", "status", "manifestSha256", "identity"])
      && digest(value.manifestSha256) && validIdentity(value.identity);
  }
  if (value.status === "missing") {
    return exactKeys(value, ["selection", "status", "code"]) && value.code === "manifest_missing";
  }
  if (value.status === "invalid") {
    return exactKeys(value, ["selection", "status", "code"]) && value.code === "manifest_invalid";
  }
  return false;
}
function sameIdentity(left: ManifestIdentity, right: ManifestIdentity): boolean {
  return left.id === right.id && left.version === right.version && left.main === right.main
    && left.preload === right.preload && left.runtime === right.runtime
    && left.featureCodes.length === right.featureCodes.length
    && left.featureCodes.every((code, index) => code === right.featureCodes[index]);
}

/** Accept wholly legacy inspection payloads, but reject partially upgraded metadata. */
export function parseSourceManifestMetadata(value: unknown): ParsedSourceManifestMetadata | null {
  if (!record(value)) return null;
  const present = metadataKeys.filter(key => Object.prototype.hasOwnProperty.call(value, key));
  if (present.length === 0) return { kind: "legacy" };
  if (present.length !== metadataKeys.length) return null;

  const selection = value.manifestSelection;
  if (selection !== null && selection !== "root" && selection !== "public") return null;
  const manifestSha256 = value.manifestSha256;
  const selectedIdentity = value.manifestIdentity;
  if (manifestSha256 !== null && !digest(manifestSha256)) return null;
  if (selectedIdentity !== null && !validIdentity(selectedIdentity)) return null;
  if (selection === null && (manifestSha256 !== null || selectedIdentity !== null)
    || selection !== null && ((manifestSha256 === null) !== (selectedIdentity === null))) return null;
  if (!Array.isArray(value.manifestCandidates) || value.manifestCandidates.length !== 2
    || !validCandidate(value.manifestCandidates[0], "root") || !validCandidate(value.manifestCandidates[1], "public")) return null;
  if (!Array.isArray(value.manifestDifferences) || value.manifestDifferences.length > differenceOrder.length) return null;
  const differences = value.manifestDifferences;
  if (!differences.every(item => differenceOrder.includes(item as ManifestDifference))) return null;
  const canonicalDifferences = differenceOrder.filter(item => differences.includes(item));
  if (canonicalDifferences.length !== differences.length || canonicalDifferences.some((item, index) => item !== differences[index])) return null;

  const encodedMetadata = JSON.stringify({
    manifestSelection: selection, manifestSha256, manifestIdentity: selectedIdentity,
    manifestCandidates: value.manifestCandidates, manifestDifferences: differences,
  });
  if (typeof encodedMetadata !== "string" || utf8Bytes(encodedMetadata) > MANIFEST_LIMITS.metadataJsonBytes) return null;
  if (selection !== null) {
    const candidate = value.manifestCandidates[selection === "root" ? 0 : 1] as ManifestCandidate;
    if (candidate.status === "valid") {
      if (manifestSha256 === null || selectedIdentity === null || candidate.manifestSha256 !== manifestSha256
        || !sameIdentity(candidate.identity, selectedIdentity)) return null;
    } else if (manifestSha256 !== null || selectedIdentity !== null) return null;
  }
  const [root, published] = value.manifestCandidates as [ManifestCandidate, ManifestCandidate];
  if (root.status === "valid" && published.status === "valid") {
    const actual: ManifestDifference[] = [];
    for (const field of differenceOrder) {
      if (field === "featureCodes") {
        if (root.identity.featureCodes.length !== published.identity.featureCodes.length
          || root.identity.featureCodes.some((code, index) => code !== published.identity.featureCodes[index])) actual.push(field);
      } else if (root.identity[field] !== published.identity[field]) actual.push(field);
    }
    if (actual.length !== differences.length || actual.some((field, index) => field !== differences[index])) return null;
  } else if (differences.length > 0) return null;
  return { kind: "current", value: {
    manifestSelection: selection as ManifestSelection | null,
    manifestSha256: manifestSha256 as string | null,
    manifestIdentity: selectedIdentity as ManifestIdentity | null,
    manifestCandidates: value.manifestCandidates as [ManifestCandidate, ManifestCandidate],
    manifestDifferences: differences as ManifestDifference[],
  } };
}

export function requiresExplicitManifestChoice(metadata: ParsedSourceManifestMetadata): boolean {
  if (metadata.kind === "legacy") return false;
  const { manifestCandidates: [root, published], manifestDifferences } = metadata.value;
  if (manifestDifferences.length > 0) return true;
  if (metadata.value.manifestSelection === null && (root.status === "valid" || published.status === "valid")) return true;
  // A malformed root can shadow a valid public candidate under the legacy default.
  return root.status === "invalid" && published.status === "valid";
}

export function manifestChoiceLabel(selection: ManifestSelection): string {
  return selection === "root" ? "项目根目录" : "发布目录";
}
