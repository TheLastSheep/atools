import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const HOST_CLIPBOARD_ORIGINAL_PINS = [
  { id: "uuid-kit", sha256: "d59f525e164bcefe1d47425164e0c32d52c93f800593bc7bfb549e89fa80e654" },
  { id: "subnet-calculator", sha256: "3623302f8be9e12405e0f7ce14d9f0ee69fcb7aabdda4b79057401e321f66901" },
];

/** Selected source binding only; deliberately does not claim a complete toolchain closure. */
export async function captureHostClipboardSources(root) {
  const files = ["Cargo.toml", "Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "package.json", "pnpm-lock.yaml",
    "scripts/probe-host-clipboard-desktop.mjs", "scripts/lib/host-clipboard-native-evidence.mjs",
    "scripts/lib/native-smoke-process.mjs", "scripts/lib/native-smoke-descendants.mjs",
    "scripts/lib/native-process-resource-sampler.mjs", "scripts/lib/native-smoke-app-bundle.mjs",
    "src/lib/hostClipboardBridge.ts", "src/lib/pluginElectronAdapter.ts", "src/lib/pluginElectronWebFrame.ts",
    "src/lib/pluginHostedIpcBridge.ts", "tests/components/nativeClipboardSmoke.ts",
    "src-tauri/examples/host_clipboard_desktop_smoke.rs", "src-tauri/src/lib.rs", "src-tauri/src/state.rs",
    "src-tauri/src/agent_tools.rs", "src-tauri/src/plugin_loopback.rs", "src-tauri/src/plugin_loopback_origin.rs", "src-tauri/src/plugin_loopback_dialog.rs",
    "ZTools-plugins/plugins/uuid-kit/preload.js", "ZTools-plugins/plugins/subnet-calculator/preload.js"];
  for (const directory of ["src-tauri/src/host_runtime", "src-tauri/src/plugin_page_runtime"])
    for (const name of await readdir(join(root, directory))) if (name.endsWith(".rs")) files.push(`${directory}/${name}`);
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async path => {
    const bytes = await readFile(join(root, path)); return [path, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  })));
}

export async function fingerprintHostArtifact(path) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}

export function sameHostFingerprints(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function validateHostClipboardOutcome(report) {
  assert.equal(report?.passed, true, "Private native clipboard scenario failed");
  assert.equal(report.temporaryDataRemoved, true, "Private native data directory was not removed");
  const required = ["metadataZeroAuthorizationAndListener", "scopeOnlyPending", "rawTextRejectedBeforePersist",
    "sameRunApprovalReplayRejected", "directionsIndependentlyGranted", "unknownOriginAndTokenRejected", "nativeExactValues",
    "manualReopenRotatesToken", "lateOldCloseCancelsSuccessor", "closeWinsPendingApproval", "deniedScopeBlocked",
    "revocationStopsLastListener", "durableHistoryContainsNoTextOrEndpoint", "durableHistoryContainsNoTextFilesOrEndpoint",
    "privateInvocationStoreDrained", "fileReadScopeAndWriteIsolation"];
  const files = ["nativeNamedUrlsAndMetadata", "spacesUnicodeAndNewlinesPreserved", "noFileContentsReturned",
    "unknownPayloadsRejectedBeforeTaskRun", "missingFileAtomicFailureWithoutPath", "nativeCountOverflowAtomicFailure"];
  const frame = ["beforeGrantThrowsWithoutPayload", "filesBeforeGrantThrowsWithoutReplay", "nativeFilesFixtureHasActualFileAndDirectory",
    "nativeCopiedFilesAreSynchronousExactMetadata", "copiedFileLegacyAliasMatchesCanonicalDirectory", "nativeCopiedFilesReturnFreshMetadata",
    "getCopyedFilesSerializedNativeExactFiles", "getCopiedFilesSerializedNativeExactFiles", "actualMetadata", "readDoesNotGrantWrite",
    "uuidOriginalReturn", "subnetOriginalReturn", "uuid-kitOriginalNativeReadback", "subnet-calculatorOriginalNativeReadback"];
  for (let i = 0; i < 4; i++) frame.push(`syncWrite${i}`, `exactNativeText${i}`);
  for (const key of required) assert.equal(report.checks?.[key], true, "Native gate: " + key);
  for (const key of files) assert.equal(report.nativeFiles?.[key], true, "Native file metadata: " + key);
  assert.equal(report.nativeFrame?.passed, true);
  for (const key of frame) assert.equal(report.nativeFrame.checks?.[key], true, "Opaque Wry frame: " + key);
  assert.deepEqual(report.nativeFrame.originalPlugins?.map(value => value.id).sort(), ["subnet-calculator", "uuid-kit"]);
  assert(report.nativeFrame.originalPlugins.every(value => value.businessPassed === true
    && HOST_CLIPBOARD_ORIGINAL_PINS.some(pin => pin.id === value.id && pin.sha256 === value.sha256)));
  assert(Number.isSafeInteger(report.taskRunCount) && report.taskRunCount > 0);
  return { gateChecks: required.length, fileChecks: files.length, frameChecks: frame.length,
    namedPasteboardOnly: true, syntheticApprovalBypassesDialog: true, appShellVerified: false,
    newWholeOriginalPluginAcceptance: 0, physicalInputVerified: false };
}
