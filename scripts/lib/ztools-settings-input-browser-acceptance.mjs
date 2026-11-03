const UPDATER_UNAVAILABLE_ERROR_PREFIX =
  "检查更新状态失败: ZToolsRendererHostError: ATools does not provide the ZTools method: updater.getDownloadStatus()";

export function isKnownUpdaterUnavailableError(entry) {
  return entry?.page === "main" && entry?.type === "error" && typeof entry.text === "string" &&
    (entry.text === UPDATER_UNAVAILABLE_ERROR_PREFIX || entry.text.startsWith(`${UPDATER_UNAVAILABLE_ERROR_PREFIX}\n`));
}

export function classifySettingsInputSlice({
  mode,
  acceptanceCompleted,
  checksCount,
  sourceStable,
  resourcesClean,
  cleanupErrorCount,
  updaterCapability,
  consoleDiagnostics,
  network,
  serverRejected,
}) {
  const knownErrors = consoleDiagnostics.errors.filter(isKnownUpdaterUnavailableError);
  const expectedAliasErrors = new Set(consoleDiagnostics.expectedAliasConflict);
  const otherErrors = consoleDiagnostics.errors.filter((entry) =>
    !expectedAliasErrors.has(entry) && !knownErrors.includes(entry));
  const blockers = [];

  if (mode !== "acceptance") blockers.push("not_acceptance_mode");
  if (acceptanceCompleted !== true) blockers.push("acceptance_incomplete");
  if (!Number.isInteger(checksCount) || checksCount <= 0) blockers.push("no_acceptance_checks");
  if (sourceStable !== true) blockers.push("source_identity_not_stable");
  if (resourcesClean !== true) blockers.push("owned_resources_not_clean");
  if (cleanupErrorCount !== 0) blockers.push("cleanup_errors");
  const expectedKnownUpdaterErrors = updaterCapability === "unavailable" ? 1
    : updaterCapability === "limited" ? 0
      : null;
  if (expectedKnownUpdaterErrors === null) blockers.push("updater_capability_mismatch");
  else if (knownErrors.length !== expectedKnownUpdaterErrors) {
    blockers.push(updaterCapability === "limited"
      ? "limited_updater_error_count_mismatch"
      : "known_updater_error_count_mismatch");
  }
  if (consoleDiagnostics.exceptions.length || consoleDiagnostics.warnings.length ||
      consoleDiagnostics.unhandled.length || otherErrors.length) blockers.push("other_console_or_runtime_issues");
  if (network.externalAttempts.length || network.denied.length || network.failures.length || network.pending !== 0) {
    blockers.push("network_issues");
  }
  if (serverRejected !== 0) blockers.push("static_server_rejections");

  return {
    passed: blockers.length === 0,
    blockers,
    knownUnsupported: knownErrors.map((entry) => ({
      method: "updater.getDownloadStatus",
      page: entry.page,
      document: entry.document,
      capability: updaterCapability ?? null,
      text: entry.text,
    })),
  };
}
