import { expect, it } from "vitest";
import registry from "../fixtures/local-original-archive-cases.json";
import { reviewedPackageImportPath, verifyOriginalArchiveConflictReport, verifyOriginalArchiveInstalled } from "./nativeOriginalArchiveImport";
import type { PublishedFixture, PublishedPluginProfile } from "./nativePublishedPluginCommon";

const profile = registry.cases.find(p => p.caseId === "local-my-calculator-zpx") as PublishedPluginProfile;
const root = "/private/tmp/atools-published-plugin-fixture-test/plugin";
const fixture = (): PublishedFixture => ({ profile, pluginRoot: root, packageImportPath: root.slice(0, -7) + "/source.zpx",
  runId: "test", token: "test", assetProbePath: "/inert", packageSha256: profile.archiveSha256! });
const installed = () => ({ pluginId: profile.id, version: profile.version, exactPinnedFiles: true, fileCount: 8,
  files: registry.witnesses["local-my-calculator-zpx"].files.map(f => ({ ...f })) });

it("requires both exact sources to be rejected, with no success or skip", () => {
  const report = () => ({ imported: [] as string[], skipped: [] as unknown[], failed: [root, fixture().packageImportPath!]
    .map(path => ({ path, error: `安装 ID '${profile.id}' 对应多个来源` })) });
  verifyOriginalArchiveConflictReport(report(), fixture());
  for (const kind of ["imported", "skipped", "missing", "duplicate", "path", "identity", "reason"]) {
    const value = report();
    if (kind === "imported") value.imported.push(profile.id);
    if (kind === "skipped") value.skipped.push({});
    if (kind === "missing") value.failed.pop();
    if (kind === "duplicate") value.failed[1] = { ...value.failed[0] };
    if (kind === "path") value.failed[0].path = "/other";
    if (kind === "identity") value.failed[0].error = "other 多个来源";
    if (kind === "reason") value.failed[0].error = profile.id + " unrelated failure";
    expect(() => verifyOriginalArchiveConflictReport(value, fixture())).toThrow();
  }
});

it("imports the retained original ZPX independently of its extracted review directory", () => {
  expect(reviewedPackageImportPath(fixture())).toBe(root.slice(0, -7) + "/source.zpx");
  const legacy = { ...fixture(), profile: { ...profile, sourceKind: "local_full_directory" as const }, packageImportPath: undefined };
  expect(reviewedPackageImportPath(legacy)).toBe(root);
  expect(() => reviewedPackageImportPath({ ...legacy, pluginRoot: undefined })).toThrow(/omitted its package root/);
  expect(() => reviewedPackageImportPath({ ...legacy, packageImportPath: "/arbitrary" })).toThrow();
});

it.each([undefined, root, "/private/tmp/source.zpx", root.slice(0, -7) + "/source.zip"])("rejects a substituted archive import source %s", packageImportPath => {
  expect(() => reviewedPackageImportPath({ ...fixture(), packageImportPath })).toThrow();
});

it("rejects traversal even if the retained path shares its textual parent", () => {
  expect(() => reviewedPackageImportPath({ ...fixture(), pluginRoot: "/private/tmp/../owned/plugin", packageImportPath: "/private/tmp/../owned/source.zpx" })).toThrow();
});

it("checks every installed file against the independent registered witness", () => {
  const value = installed();
  expect(verifyOriginalArchiveInstalled(value, profile)).toBe(value);
  value.files[0].sha256 = "0".repeat(64);
  expect(() => verifyOriginalArchiveInstalled(value, profile)).toThrow();
});

it("rejects missing, extra, duplicate or wrong-size installed bytes", () => {
  for (const kind of ["missing", "extra", "duplicate", "size"]) {
    const value = installed();
    if (kind === "missing") value.files.pop();
    if (kind === "extra") value.files.push({ path: "extra", bytes: 0, sha256: "0".repeat(64) });
    if (kind === "duplicate") value.files[1] = { ...value.files[0] };
    if (kind === "size") value.files[0].bytes += 1;
    expect(() => verifyOriginalArchiveInstalled(value, profile)).toThrow();
  }
});

it("rejects unregistered profiles and incorrect database identity", () => {
  expect(() => verifyOriginalArchiveInstalled(installed(), { ...profile, caseId: "other" })).toThrow();
  expect(() => verifyOriginalArchiveInstalled({ ...installed(), pluginId: "other" }, profile)).toThrow();
  expect(() => verifyOriginalArchiveInstalled({ ...installed(), version: "9.0.0" }, profile)).toThrow();
  expect(() => verifyOriginalArchiveInstalled({ ...installed(), exactPinnedFiles: false }, profile)).toThrow();
});
