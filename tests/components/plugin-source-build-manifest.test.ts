import { expect, it } from "vitest";
import type { SourceBuildInspection } from "../../src/lib/pluginSourceBuildProtocol";
import { MANIFEST_LIMITS, parseSourceManifestMetadata, requiresExplicitManifestChoice, type ManifestCandidate, type ManifestIdentity } from "../../src/lib/pluginSourceBuildManifest";

const identity = (patch: Partial<ManifestIdentity> = {}): ManifestIdentity => ({
  id: "deepread", version: "1.0.0", main: "index.html", preload: null, runtime: "web", featureCodes: ["open"], ...patch,
});
function inspection(patch: Partial<SourceBuildInspection> = {}): SourceBuildInspection {
  const root = identity();
  const published = identity({ version: "2.0.0", featureCodes: ["open", "settings"] });
  const candidates: [ManifestCandidate, ManifestCandidate] = [
    { selection: "root", status: "valid", manifestSha256: "a".repeat(64), identity: root },
    { selection: "public", status: "valid", manifestSha256: "b".repeat(64), identity: published },
  ];
  return {
    status: "eligible", pluginId: "deepread", version: "1.0.0", blockers: [], sourceRevision: "c".repeat(64),
    manifestSelection: "root", manifestSha256: "a".repeat(64), manifestIdentity: root,
    manifestCandidates: candidates, manifestDifferences: ["version", "featureCodes"], ...patch,
  } as SourceBuildInspection;
}

it("keeps the two candidate identities and ordered feature differences bound to the selected digest", () => {
  const parsed = parseSourceManifestMetadata(inspection());
  expect(parsed?.kind).toBe("current");
  if (parsed?.kind !== "current") return;
  expect(requiresExplicitManifestChoice(parsed)).toBe(true);
  expect(parsed.value.manifestIdentity?.featureCodes).toEqual(["open"]);
  expect(parsed.value.manifestCandidates[1].status === "valid" && parsed.value.manifestCandidates[1].identity.featureCodes).toEqual(["open", "settings"]);
  expect(parsed.value.manifestDifferences).toEqual(["version", "featureCodes"]);
});

it.each([
  { manifestSelection: "public" },
  { manifestSha256: "d".repeat(64) },
  { manifestIdentity: identity({ runtime: "node" }) },
  { manifestCandidates: [{ selection: "public", status: "valid", manifestSha256: "b".repeat(64), identity: identity() }, inspection().manifestCandidates[1]] },
  { manifestDifferences: ["main"] },
  { manifestDifferences: [] },
])("rejects partial, foreign, or tampered manifest metadata: %j", patch => {
  expect(parseSourceManifestMetadata(inspection(patch))).toBeNull();
});

it("accepts wholly legacy results but rejects partially upgraded ones", () => {
  expect(parseSourceManifestMetadata({ status: "blocked", blockers: [] })).toEqual({ kind: "legacy" });
  expect(parseSourceManifestMetadata({ status: "blocked", blockers: [], manifestSelection: null })).toBeNull();
});

it("applies the frozen complete identity bounds without truncating feature codes", () => {
  const codes = Array.from({ length: MANIFEST_LIMITS.featureCount }, (_, index) => `feature-${index}`);
  const candidate = inspection();
  const selected = identity({ featureCodes: codes });
  candidate.manifestIdentity = selected;
  const root = candidate.manifestCandidates[0]; const published = candidate.manifestCandidates[1];
  if (root.status !== "valid" || published.status !== "valid") throw Error("fixture candidates must be valid");
  root.identity = selected; root.manifestSha256 = "a".repeat(64);
  published.identity = selected; published.manifestSha256 = "b".repeat(64);
  candidate.manifestDifferences = [];
  expect(parseSourceManifestMetadata(candidate)?.kind).toBe("current");
  const overflowIdentity = identity({ featureCodes: [...codes, "overflow"] });
  candidate.manifestIdentity = overflowIdentity;
  root.identity = overflowIdentity;
  expect(parseSourceManifestMetadata(candidate)).toBeNull();
});

it.each([" ", "line\nfeed", "x".repeat(MANIFEST_LIMITS.featureCodeBytes + 1)])("rejects invalid feature code bytes/control data", code => {
  const candidate = inspection();
  const selected = identity({ featureCodes: [code] });
  candidate.manifestIdentity = selected;
  const root = candidate.manifestCandidates[0];
  if (root.status !== "valid") throw Error("fixture candidate must be valid");
  root.identity = selected;
  expect(parseSourceManifestMetadata(candidate)).toBeNull();
});


const controlIdentityFields: Array<[string, Partial<ManifestIdentity>]> = [
  ["id", { id: "deepread\u0000bad" }],
  ["version", { version: "1.0.0\u0085" }],
  ["main", { main: "index\n.html" }],
  ["preload", { preload: "pre\tload.js" }],
];
it.each(controlIdentityFields)("rejects control characters in identity field %s", (_field, patch) => {
  const candidate = inspection();
  const selected = identity(patch);
  candidate.manifestIdentity = selected;
  const root = candidate.manifestCandidates[0];
  if (root.status !== "valid") throw Error("fixture candidate must be valid");
  root.identity = selected;
  expect(parseSourceManifestMetadata(candidate)).toBeNull();
});


it("matches Rust trim semantics for FEFF, Unicode whitespace, and multibyte feature boundaries", () => {
  const feff = "\uFEFF";
  const accepted = identity({ id: feff, version: feff, main: feff, preload: feff, featureCodes: [feff] });
  const candidate = inspection();
  candidate.manifestIdentity = accepted;
  const root = candidate.manifestCandidates[0]; const published = candidate.manifestCandidates[1];
  if (root.status !== "valid" || published.status !== "valid") throw Error("fixture candidates must be valid");
  root.identity = accepted; published.identity = accepted; candidate.manifestDifferences = [];
  expect(parseSourceManifestMetadata(candidate)?.kind).toBe("current");

  for (const whitespace of ["\u00A0", "\u2003", "\u3000"]) {
    const blank = identity({ id: whitespace });
    candidate.manifestIdentity = blank; root.identity = blank; published.identity = blank;
    expect(parseSourceManifestMetadata(candidate)).toBeNull();
    const blankCode = identity({ featureCodes: [whitespace] });
    candidate.manifestIdentity = blankCode; root.identity = blankCode; published.identity = blankCode;
    expect(parseSourceManifestMetadata(candidate)).toBeNull();
  }

  const withinBytes = identity({ featureCodes: [`${feff}${"界".repeat(84)}`] });
  candidate.manifestIdentity = withinBytes; root.identity = withinBytes; published.identity = withinBytes;
  expect(parseSourceManifestMetadata(candidate)?.kind).toBe("current");
  const overBytes = identity({ featureCodes: [`${feff}${"界".repeat(85)}`] });
  candidate.manifestIdentity = overBytes; root.identity = overBytes; published.identity = overBytes;
  expect(parseSourceManifestMetadata(candidate)).toBeNull();
});

it("measures full identity and feature bounds in UTF-8 bytes", () => {
  const candidate = inspection();
  const root = candidate.manifestCandidates[0]; const published = candidate.manifestCandidates[1];
  if (root.status !== "valid" || published.status !== "valid") throw Error("fixture candidates must be valid");
  const asciiBoundary = identity({ id: "i".repeat(256), version: "v".repeat(256), main: "m".repeat(4096), preload: "p".repeat(4096), featureCodes: ["f".repeat(256)] });
  candidate.manifestIdentity = asciiBoundary; root.identity = asciiBoundary; published.identity = asciiBoundary;
  candidate.manifestDifferences = [];
  expect(parseSourceManifestMetadata(candidate)?.kind).toBe("current");

  const unicodeBoundary = identity({ id: "界".repeat(85), main: `${"界".repeat(1365)}a`, featureCodes: ["界".repeat(85)] });
  candidate.manifestIdentity = unicodeBoundary; root.identity = unicodeBoundary; published.identity = unicodeBoundary;
  expect(parseSourceManifestMetadata(candidate)?.kind).toBe("current");

  const overByteLimit = identity({ featureCodes: ["界".repeat(86)] });
  candidate.manifestIdentity = overByteLimit; root.identity = overByteLimit; published.identity = overByteLimit;
  expect(parseSourceManifestMetadata(candidate)).toBeNull();
  const overCount = identity({ featureCodes: Array.from({ length: MANIFEST_LIMITS.featureCount + 1 }, () => "x") });
  candidate.manifestIdentity = overCount; root.identity = overCount; published.identity = overCount;
  expect(parseSourceManifestMetadata(candidate)).toBeNull();
});


it("requires a concrete selection when valid candidate metadata has no resolved manifest", () => {
  const candidate = inspection();
  const root = candidate.manifestCandidates[0]; const published = candidate.manifestCandidates[1];
  if (root.status !== "valid" || published.status !== "valid") throw Error("fixture candidates must be valid");
  published.identity = root.identity;
  candidate.manifestSelection = null; candidate.manifestSha256 = null; candidate.manifestIdentity = null;
  candidate.manifestDifferences = [];
  const parsed = parseSourceManifestMetadata(candidate);
  expect(parsed?.kind).toBe("current");
  if (parsed?.kind === "current") expect(requiresExplicitManifestChoice(parsed)).toBe(true);
});


it.each([
  ["root", "invalid", "manifest_invalid"],
  ["public", "missing", "manifest_missing"],
] as const)("preserves a resolved %s candidate even when it is %s", (selection, status, code) => {
  const candidate = inspection({ status: "blocked", manifestSelection: selection, manifestSha256: null, manifestIdentity: null,
    manifestCandidates: [
      { selection: "root", status: "invalid", code: "manifest_invalid" },
      { selection: "public", status: "missing", code: "manifest_missing" },
    ], manifestDifferences: [] });
  const target = candidate.manifestCandidates[selection === "root" ? 0 : 1];
  expect(target).toMatchObject({ selection, status, code });
  expect(parseSourceManifestMetadata(candidate)?.kind).toBe("current");
});
