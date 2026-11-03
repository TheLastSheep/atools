import assert from "node:assert/strict";
import { HOST_CLIPBOARD_ORIGINAL_PINS, validateHostClipboardOutcome } from "./lib/host-clipboard-native-evidence.mjs";

// Generated outcome verifies the acceptance filter, never native clipboard behavior.
const checks = Object.fromEntries(["metadataZeroAuthorizationAndListener", "scopeOnlyPending", "rawTextRejectedBeforePersist",
  "sameRunApprovalReplayRejected", "directionsIndependentlyGranted", "unknownOriginAndTokenRejected", "nativeExactValues",
  "manualReopenRotatesToken", "lateOldCloseCancelsSuccessor", "closeWinsPendingApproval", "deniedScopeBlocked", "revocationStopsLastListener",
  "durableHistoryContainsNoTextOrEndpoint", "durableHistoryContainsNoTextFilesOrEndpoint", "privateInvocationStoreDrained", "fileReadScopeAndWriteIsolation"].map(key => [key, true]));
const nativeFiles = Object.fromEntries(["nativeNamedUrlsAndMetadata", "spacesUnicodeAndNewlinesPreserved", "noFileContentsReturned",
  "unknownPayloadsRejectedBeforeTaskRun", "missingFileAtomicFailureWithoutPath", "nativeCountOverflowAtomicFailure"].map(key => [key, true]));
const frameChecks = Object.fromEntries(["beforeGrantThrowsWithoutPayload", "filesBeforeGrantThrowsWithoutReplay", "nativeFilesFixtureHasActualFileAndDirectory",
  "nativeCopiedFilesAreSynchronousExactMetadata", "copiedFileLegacyAliasMatchesCanonicalDirectory", "nativeCopiedFilesReturnFreshMetadata",
  "getCopyedFilesSerializedNativeExactFiles", "getCopiedFilesSerializedNativeExactFiles", "actualMetadata", "readDoesNotGrantWrite",
  "uuidOriginalReturn", "subnetOriginalReturn", "uuid-kitOriginalNativeReadback", "subnet-calculatorOriginalNativeReadback"].map(key => [key, true]));
for (let i = 0; i < 4; i++) { frameChecks[`syncWrite${i}`] = true; frameChecks[`exactNativeText${i}`] = true; }
const accepted = { passed: true, temporaryDataRemoved: true, checks, nativeFiles, taskRunCount: 25,
  nativeFrame: { passed: true, checks: frameChecks, originalPlugins: HOST_CLIPBOARD_ORIGINAL_PINS.map(pin => ({ ...pin, businessPassed: true })) } };
assert.deepEqual(validateHostClipboardOutcome(accepted), { gateChecks: 16, fileChecks: 6, frameChecks: 22,
  namedPasteboardOnly: true, syntheticApprovalBypassesDialog: true, appShellVerified: false, newWholeOriginalPluginAcceptance: 0, physicalInputVerified: false });
let rejected = 0;
for (const section of ["checks", "nativeFiles"]) for (const key of Object.keys(accepted[section])) {
  const forged = structuredClone(accepted); delete forged[section][key]; assert.throws(() => validateHostClipboardOutcome(forged)); rejected++;
}
for (const key of Object.keys(frameChecks)) {
  const forged = structuredClone(accepted); forged.nativeFrame.checks[key] = false; assert.throws(() => validateHostClipboardOutcome(forged)); rejected++;
}
for (const mutate of [r => r.passed = false, r => r.temporaryDataRemoved = false, r => r.taskRunCount = 0,
  r => r.nativeFrame.originalPlugins.pop(), r => r.nativeFrame.originalPlugins[0].sha256 = "a".repeat(64),
  r => r.nativeFrame.originalPlugins[0].businessPassed = false]) {
  const forged = structuredClone(accepted); mutate(forged); assert.throws(() => validateHostClipboardOutcome(forged)); rejected++;
}
console.log(JSON.stringify({ passed: true, generatedPositiveOutcome: 1, forgedOutcomesRejected: rejected, nativeClipboardVerified: false }));
