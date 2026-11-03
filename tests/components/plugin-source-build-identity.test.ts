import { expect, it } from "vitest";
import { inspectionFromRun, matchesSourceBuildRun, sourceBuildInstalledPlugin, validSourceBuildInspection, type SourceBuildInspection } from "../../src/lib/pluginSourceBuildProtocol";
import type { TaskRun } from "../../src/lib/types";

const revision = "a".repeat(64);
const eligible: SourceBuildInspection = { status: "eligible", pluginId: "source-plugin", version: "1.0.0", blockers: [], sourceRevision: revision };
const run = { status: "succeeded", output: { installed: true, pluginId: "source-plugin", version: "1.0.0", sourceRevision: revision } } as TaskRun;

it.each([
  { pluginId: undefined }, { pluginId: "" }, { pluginId: "x".repeat(257) },
  { version: undefined }, { version: " " }, { sourceRevision: undefined },
  { blockers: [{ code: "missing", message: "A build condition is missing" }] },
])("rejects incomplete or contradictory eligible identities: %j", patch => {
  const inspection = { ...eligible, ...patch };
  expect(validSourceBuildInspection(inspection)).toBe(false);
  expect(sourceBuildInstalledPlugin(run, inspection, revision)).toBeNull();
});

it("requires independently matching durable status, source revision, plugin ID and version", () => {
  expect(sourceBuildInstalledPlugin(run, eligible, revision)).toBe("source-plugin");
  expect(sourceBuildInstalledPlugin({ ...run, status: "running" }, eligible, revision)).toBeNull();
  expect(sourceBuildInstalledPlugin(run, { ...eligible, sourceRevision: "b".repeat(64) }, revision)).toBeNull();
  for (const output of [{ ...run.output as object, pluginId: "another" }, { ...run.output as object, version: "2.0.0" }]) {
    expect(sourceBuildInstalledPlugin({ ...run, output }, eligible, revision)).toBeNull();
  }
});

it("accepts ordered known build steps with bounded Node test counts and preserves legacy missing steps", () => {
  expect(validSourceBuildInspection(eligible)).toBe(true);
  expect(validSourceBuildInspection({ ...eligible, buildSteps: [
    { kind: "typecheck" }, { kind: "nodeTests", files: 128 }, { kind: "viteBuild" }, { kind: "packageScript" },
  ] })).toBe(true);
});

it("uses Rust whitespace semantics through the complete eligible TaskRun inspection gate", () => {
  const selected = (version: string): SourceBuildInspection => {
    const identity = { id: "source-plugin", version, main: "index.html", preload: null, runtime: "web" as const, featureCodes: ["open"] };
    return {
      ...eligible,
      version,
      manifestSelection: "root",
      manifestSha256: "b".repeat(64),
      manifestIdentity: identity,
      manifestCandidates: [
        { selection: "root", status: "valid", manifestSha256: "b".repeat(64), identity },
        { selection: "public", status: "missing", code: "manifest_missing" },
      ],
      manifestDifferences: [],
    };
  };

  const feffVersion = selected("\uFEFF");
  expect(validSourceBuildInspection(feffVersion)).toBe(true);
  expect(inspectionFromRun({ ...run, output: feffVersion } as TaskRun)).toEqual(feffVersion);
  expect(validSourceBuildInspection(selected("\u00A0"))).toBe(false);
  expect(validSourceBuildInspection(selected("\u0001release"))).toBe(false);
  expect(validSourceBuildInspection(selected("1.2.3"))).toBe(true);
});

it.each([
  null,
  [],
  Array.from({ length: 13 }, () => ({ kind: "typecheck" })),
  [{ kind: "networkInstall" }],
  [{ kind: "nodeTests" }],
  [{ kind: "nodeTests", files: 0 }],
  [{ kind: "nodeTests", files: 129 }],
  [{ kind: "typecheck", files: 1 }],
  [{ kind: "packageScript", scriptPath: "private/path" }],
  [{ kind: "viteBuild", extra: true }],
])("rejects malformed build step plans without inferring safe steps", buildSteps => {
  expect(validSourceBuildInspection({ ...eligible, buildSteps } as SourceBuildInspection)).toBe(false);
});


it("binds manifest-selected conversion results to both the chosen path and raw manifest digest", () => {
  const identity = { id: "run-1", sourcePath: "/source", expectedRevision: revision, overwrite: true, manifestSelection: "public" as const, expectedManifestSha256: "b".repeat(64) };
  const selectedRun = { ...run, id: "run-1", capabilityId: "convert_ztools_plugin", initiator: { type: "human", clientId: "atools-ui" },
    input: { sourcePath: "/source", expectedRevision: revision, overwrite: true, manifestSelection: "public", expectedManifestSha256: "b".repeat(64) } } as TaskRun;
  expect(matchesSourceBuildRun(selectedRun, identity)).toBe(true);
  expect(matchesSourceBuildRun({ ...selectedRun, input: { ...selectedRun.input as object, manifestSelection: "root" } }, identity)).toBe(false);
  expect(matchesSourceBuildRun({ ...selectedRun, input: { ...selectedRun.input as object, expectedManifestSha256: "c".repeat(64) } }, identity)).toBe(false);
});


it("rejects an eligible new-metadata result whose selected candidate is invalid", () => {
  const unresolved: SourceBuildInspection = { ...eligible, manifestSelection: "root", manifestSha256: null, manifestIdentity: null,
    manifestCandidates: [
      { selection: "root", status: "invalid", code: "manifest_invalid" },
      { selection: "public", status: "valid", manifestSha256: "b".repeat(64), identity: { id: "source-plugin", version: "1.0.0", main: "index.html", preload: null, runtime: "web", featureCodes: ["open"] } },
    ], manifestDifferences: [] };
  expect(validSourceBuildInspection(unresolved)).toBe(false);
});

it("rejects an eligible new-metadata result with no selectable manifest candidate", () => {
  const unresolved: SourceBuildInspection = { ...eligible, manifestSelection: null, manifestSha256: null, manifestIdentity: null,
    manifestCandidates: [
      { selection: "root", status: "missing", code: "manifest_missing" },
      { selection: "public", status: "invalid", code: "manifest_invalid" },
    ], manifestDifferences: [] };
  expect(validSourceBuildInspection(unresolved)).toBe(false);
});
