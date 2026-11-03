import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLocalOriginalFixture } from "./lib/local-plugin-fixture.mjs";
import { prepareHeadCalculationPaperFixture } from "./lib/head-calculation-paper-fixture.mjs";
import { prepareHeadMybatisFixture } from "./lib/head-mybatis-fixture.mjs";
import { prepareHeadRandomDataFixture } from "./lib/head-random-data-fixture.mjs";
import { prepareHeadImageStitchFixture } from "./lib/head-image-stitch-fixture.mjs";
import { prepareLocalNativeFixture } from "./lib/local-native-fixture-dispatch.mjs";
import { prepareLocalOriginalArchiveFixture } from "./lib/local-original-archive-fixture.mjs";
import { main as runRegisteredNative } from "./probe-published-plugin-native.mjs";
import { profilePackageDigest, readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";
import { runAndFinalizeLocalFixture } from "./lib/local-original-run-finalization.mjs";

export function buildLocalNativeArguments(caseId, profile, fixture, output, { workerContractOnly = false, nativeUiInput = false, requireForeground = false, nativeLaunchMode = "direct", runId } = {}) {
  assert.equal(typeof nativeUiInput, "boolean");
  assert.equal(typeof requireForeground, "boolean");
  assert.ok(!requireForeground || !workerContractOnly && !nativeUiInput && nativeLaunchMode === "direct",
    "Foreground preconditions require ordinary reviewed fixture execution");
  assert.ok(["direct", "launchservices"].includes(nativeLaunchMode), "Unknown native launch mode");
  assert.ok(nativeLaunchMode !== "launchservices" || nativeUiInput && ["local-json-editor", "local-plain-text"].includes(caseId) && !workerContractOnly,
    "LaunchServices launch is restricted to native-ui-input for the registered plain/json cases");
  assert.ok(!nativeUiInput || ["local-json-editor", "local-plain-text"].includes(caseId) && !workerContractOnly,
    "Native UI input requires a registered editor and excludes worker-only mode");
  const expectedSha = profilePackageDigest(profile);
  if (typeof expectedSha !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha)) throw Error("Local fixture profile has no registered package digest");
  if (typeof runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw Error("Invalid local native run identity");
  const args = ["--case", caseId, "--execute-reviewed-package", "--plugin-root", fixture.pluginRoot];
  args.push("--run-id", runId);
  if (profile.sourceKind === "local_original_archive") args.push("--package-import-path", fixture.packageImportPath);
  args.push("--source-review", fixture.sourceReviewJSON, "--expected-sha256", expectedSha, "--output", resolve(output));
  if (workerContractOnly) args.push("--worker-contract-only");
  if (nativeUiInput) args.push("--native-ui-input");
  if (requireForeground) args.push("--require-foreground");
  if (nativeLaunchMode === "launchservices") args.push("--native-launch-mode", "launchservices");
  return args;
}

export function localFixtureCleanupSummary(profile, removed, sourceBytesUnchanged) {
  return { removed, originalBytesNotModified: sourceBytesUnchanged,
    ...(profile.sourceKind === "local_full_directory" ? { originalDirectoryNotModified: sourceBytesUnchanged } : {}),
    ...(profile.sourceKind === "local_original_archive" ? { originalArchiveNotModified: sourceBytesUnchanged } : {}) };
}

export function parseLocalNativeModes(modes) {
  let workerContractOnly = false, nativeUiInput = false, requireForeground = false, nativeLaunchMode = "direct", nativeLaunchModeSeen = false;
  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index];
    if (mode === "--worker-contract-only" && !workerContractOnly) workerContractOnly = true;
    else if (mode === "--native-ui-input" && !nativeUiInput) nativeUiInput = true;
    else if (mode === "--require-foreground" && !requireForeground) requireForeground = true;
    else if (mode === "--native-launch-mode" && !nativeLaunchModeSeen && ["direct", "launchservices"].includes(modes[index + 1])) {
      nativeLaunchModeSeen = true; nativeLaunchMode = modes[++index];
    } else throw Error("Unknown, duplicate, or malformed local native mode");
  }
  if (requireForeground && (workerContractOnly || nativeUiInput || nativeLaunchMode !== "direct"))
    throw Error("Foreground preconditions exclude worker or native UI input modes");
  return { workerContractOnly, nativeUiInput, requireForeground, nativeLaunchMode };
}

/** Executes one explicitly selected registered original fixture, preserving its actual import form. */
export async function runLocalOriginalNative(caseId, output, { workerContractOnly = false, nativeUiInput = false, requireForeground = false, nativeLaunchMode = "direct" } = {}) {
  assert.ok(typeof caseId === "string" && caseId.startsWith("local-"), "Select one registered local original case");
  assert.ok(!workerContractOnly || caseId === "local-json-editor", "Worker contract mode is registered only for JSON Editor");
  assert.equal(typeof nativeUiInput, "boolean");
  assert.equal(typeof requireForeground, "boolean");
  assert.ok(!requireForeground || !workerContractOnly && !nativeUiInput && nativeLaunchMode === "direct",
    "Foreground preconditions require ordinary reviewed fixture execution");
  assert.ok(["direct", "launchservices"].includes(nativeLaunchMode), "Unknown native launch mode");
  assert.ok(nativeLaunchMode !== "launchservices" || nativeUiInput && ["local-json-editor", "local-plain-text"].includes(caseId) && !workerContractOnly,
    "LaunchServices launch is restricted to native-ui-input for the registered plain/json cases");
  assert.ok(!nativeUiInput || ["local-json-editor", "local-plain-text"].includes(caseId) && !workerContractOnly,
    "Native UI input requires a registered editor and excludes worker-only mode");
  const target = resolve(output);
  assert.equal(await access(target).then(() => true, () => false), false, "Use a fresh report path");
  const temporaryParent = { temporaryParent: "/private/tmp" };
  const prepared = await prepareLocalNativeFixture(caseId, temporaryParent, {
    readProfile: readPublishedPluginProfile,
    prepareCalculation: prepareHeadCalculationPaperFixture,
    prepareMybatis: prepareHeadMybatisFixture,
    prepareRandomData: prepareHeadRandomDataFixture,
    prepareImageStitch: prepareHeadImageStitchFixture,
    prepareArchive: prepareLocalOriginalArchiveFixture,
    prepareGeneric: prepareLocalOriginalFixture,
  });
  const runId = randomUUID();
  return runAndFinalizeLocalFixture({
    target, profile: prepared.profile, runId, executionMode: workerContractOnly ? "original_worker_contract" : "original_ui",
    summarizeCleanup: localFixtureCleanupSummary,
    run: () => runRegisteredNative(buildLocalNativeArguments(caseId, prepared.profile, prepared.fixture, target, { workerContractOnly, nativeUiInput, requireForeground, nativeLaunchMode, runId })),
    cleanup: async () => { await prepared.cleanup(); return await access(prepared.fixture.ownedRoot).then(() => false, () => true); },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [caseId, output, ...modes] = process.argv.slice(2);
  const { workerContractOnly, nativeUiInput, requireForeground, nativeLaunchMode } = parseLocalNativeModes(modes);
  if (!caseId || !output) throw Error("Usage: probe-local-original-plugin-native.mjs local-case fresh-output.json [--worker-contract-only|--native-ui-input|--require-foreground] [--native-launch-mode launchservices]");
  await mkdir(dirname(resolve(output)), { recursive: true });
  await runLocalOriginalNative(caseId, output, { workerContractOnly, nativeUiInput, requireForeground, nativeLaunchMode });
}
