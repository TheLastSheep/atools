import assert from "node:assert/strict";
import { buildLocalNativeArguments, localFixtureCleanupSummary, parseLocalNativeModes } from "./probe-local-original-plugin-native.mjs";
import { readPublishedPluginProfile, profilePackageDigest } from "./lib/published-plugin-profile.mjs";

for (const caseId of ["local-content-workbench", "local-my-calculator-zpx"]) {
  const profile = await readPublishedPluginProfile(caseId), root = `/private/tmp/fixture-${caseId}`;
  const fixture = { pluginRoot: `${root}/plugin`, sourceReviewJSON: `${root}/source-review.json`,
    packageImportPath: profile.sourceKind === "local_original_archive" ? `${root}/source.zpx` : undefined };
  const runId = "00000000-0000-4000-8000-000000000001";
  const args = buildLocalNativeArguments(caseId, profile, fixture, `/private/tmp/${caseId}.json`, { runId });
  assert.equal(args[args.indexOf("--run-id") + 1], runId);
  assert.equal(args[args.indexOf("--expected-sha256") + 1], profilePackageDigest(profile));
  assert.equal(args.includes("--package-import-path"), profile.sourceKind === "local_original_archive");
  assert.equal(args.includes("--require-foreground"), false, "foreground mode remains opt-in");
  const cleanup = localFixtureCleanupSummary(profile, true, true);
  assert.equal(cleanup.originalBytesNotModified, true);
  assert.equal(cleanup.originalDirectoryNotModified, profile.sourceKind === "local_full_directory" ? true : undefined);
  assert.equal(cleanup.originalArchiveNotModified, profile.sourceKind === "local_original_archive" ? true : undefined);
}

{
  const caseId = "local-content-workbench", profile = await readPublishedPluginProfile(caseId);
  const fixture = { pluginRoot: "/private/tmp/plugin", sourceReviewJSON: "/private/tmp/review.json" };
  const output = "/private/tmp/foreground.json", runId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(parseLocalNativeModes(["--require-foreground"]), {
    workerContractOnly: false, nativeUiInput: false, requireForeground: true, nativeLaunchMode: "direct",
  });
  for (const invalid of [
    ["--require-foreground", "--require-foreground"],
    ["--require-foreground", "true"],
    ["--require-foreground", "--native-launch-mode"],
    ["--require-foreground", "--native-ui-input"],
    ["--require-foreground", "--worker-contract-only"],
    ["--require-foreground", "--native-launch-mode", "launchservices"],
    ["--unknown"],
  ]) assert.throws(() => parseLocalNativeModes(invalid));
  const args = buildLocalNativeArguments(caseId, profile, fixture, output, { runId, requireForeground: true });
  assert.equal(args.filter(arg => arg === "--require-foreground").length, 1);
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, output, { runId, requireForeground: "true" }));
}

{
  for (const caseId of ["local-json-editor", "local-plain-text"]) {
  const profile = await readPublishedPluginProfile(caseId);
  const fixture = { pluginRoot: "/private/tmp/json/plugin", sourceReviewJSON: "/private/tmp/json/review.json" };
  const options = { runId: "00000000-0000-4000-8000-000000000001", nativeUiInput: true };
  assert.equal(buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", options).includes("--native-ui-input"), true);
  const direct = buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", options);
  assert.equal(direct.includes("--native-launch-mode"), false, "direct remains the default launch mode");
  const launchservices = buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", { ...options, nativeLaunchMode: "launchservices" });
  assert.deepEqual(launchservices.slice(-2), ["--native-launch-mode", "launchservices"]);
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", { ...options, nativeLaunchMode: "bogus" }));
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", { ...options, nativeLaunchMode: "launchservices", workerContractOnly: true }));
  assert.throws(() => buildLocalNativeArguments("local-content-workbench", profile, fixture, "/private/tmp/json/result.json", { ...options, nativeLaunchMode: "launchservices" }));
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", { ...options, workerContractOnly: true }));
  assert.throws(() => buildLocalNativeArguments("local-content-workbench", profile, fixture, "/private/tmp/json/result.json", options));
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/json/result.json", { ...options, nativeUiInput: "true" }));
  assert.throws(() => buildLocalNativeArguments("local-subnet-calculator", profile, fixture, "/private/tmp/json/result.json", options));
  }
}

console.log("local original native argument tests passed (2 profile paths; 2 explicit editor modes)");
