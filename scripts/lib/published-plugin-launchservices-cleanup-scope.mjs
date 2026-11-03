const PINNED_EDITOR_CLEANUP_CASES = Object.freeze({
  "local-plain-text": Object.freeze({
    packageSha256: "cac445cf31c918e213dcc0d1dde206e5bcc3514957c46088307e88e48601fda2",
    preloadPath: "preload/services.js",
    preloadSha256: "3544e9e1a8368fa8c95a0059eb9b20d7eafb544b3a7081aad54d024feadafd58",
  }),
  "local-json-editor": Object.freeze({
    packageSha256: "33a1f7140a8e1e11e291c7d80e5a7c1ce3575f66950cc1a378a2e69c6ec76ea7",
    preloadPath: "preload.js",
    preloadSha256: "d37a020e184435abbbc72786cc3f3e2a3d296a0e59a8da2a63be673d6cfcc627",
  }),
});

export function evaluateRegisteredLaunchServicesCleanupScope({ caseId, packageSha256, verifiedFileHashes,
  nativeReport, targetTerminated, descendantCleanup, descendantCoverage, taggedResidualCount }) {
  const failures = [];
  const pin = PINNED_EDITOR_CLEANUP_CASES[caseId];
  if (!pin) failures.push("case-not-registered-for-bounded-cleanup-scope");
  if (pin && packageSha256 !== pin.packageSha256) failures.push("registered-package-pin-mismatch");
  const preload = Array.isArray(verifiedFileHashes)
    ? verifiedFileHashes.find(file => file?.path === pin?.preloadPath) : null;
  if (!pin || !preload || preload.sha256 !== pin.preloadSha256) failures.push("registered-preload-pin-mismatch");
  if (!nativeReport || nativeReport.passed !== true || nativeReport.cleanupComplete !== true
    || nativeReport.taskRunsTerminal !== true || nativeReport.finalRuntimeDrained !== true
    || !Number.isSafeInteger(nativeReport.taskRunCount) || nativeReport.taskRunCount < 0) {
    failures.push("native-taskrun-and-runtime-drain-not-proven");
  }
  if (targetTerminated !== true) failures.push("launchservices-target-not-proven-terminal");
  if (!descendantCleanup || descendantCleanup.attempted !== true || !Array.isArray(descendantCleanup.survivors)
    || descendantCleanup.survivors.length !== 0 || descendantCleanupCompleted(descendantCleanup) !== true
    || descendantCleanup.unresolvedCount !== 0) {
    failures.push("observed-owned-descendants-not-cleared");
  }
  if (descendantCoverage !== "unknown-unobserved-detached-descendants") {
    failures.push("arbitrary-descendant-coverage-must-remain-explicitly-unknown");
  }
  if (taggedResidualCount !== 0) failures.push("run-tagged-sidecar-residue-or-scan-unavailable");
  return {
    passed: failures.length === 0,
    failures,
    registeredCase: pin ? caseId : null,
    registeredPackageSha256: pin?.packageSha256 ?? null,
    registeredPreload: pin ? { path: pin.preloadPath, sha256: pin.preloadSha256 } : null,
    observedOwnedDescendantsCleared: failures.includes("observed-owned-descendants-not-cleared") === false,
    runTaggedSidecarsAbsent: taggedResidualCount === 0,
    taskRunsTerminal: nativeReport?.taskRunsTerminal === true,
    finalRuntimeDrained: nativeReport?.finalRuntimeDrained === true,
    arbitraryUnobservedDetachedDescendantCoverage: "unknown",
    scope: "registered pinned local plain/json editor fixture only; no general OS process sandbox or arbitrary plugin cleanup claim",
  };
}

function descendantCleanupCompleted(cleanup) {
  return cleanup.survivors.length === 0;
}
