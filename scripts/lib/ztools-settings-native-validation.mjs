import { markerMatches, validateNativeReport } from "./ztools-renderer-native-runtime.mjs";

const PREFERENCE_FIELDS = [
  "showRecentInSearch", "recentRows", "pinnedRows", "searchMode",
  "showMatchRecommendation", "tabKeyFunction", "tabTargetCommand", "spaceOpenCommand",
];
const PREFERENCE_ROW_KEYS = ["field", "edited", "committed", "mainApplied", "reopened"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireEvidence(errors, condition, field) {
  if (!condition) errors.push(field);
}

function requireTrue(errors, value, field) {
  requireEvidence(errors, value === true, field);
}

function requireZero(errors, value, field) {
  requireEvidence(errors, Number.isSafeInteger(value) && value === 0, field);
}

function validatePreferences(preferences, errors) {
  requireEvidence(errors, preferences?.schemaVersion === 1, "preferences-schema-version");
  requireEvidence(errors, preferences?.editableFieldCount === 13, "preferences-editable-field-count");
  requireTrue(errors, preferences?.coldStartup?.passed, "preferences-cold-startup-passed");
  requireEvidence(errors, preferences?.coldStartup?.fieldCount === 13, "preferences-cold-startup-field-count");
  requireEvidence(errors, preferences?.coldStartup?.tabTargetCommandBytes === 2049, "preferences-cold-startup-tab-target-bytes");
  requireTrue(errors, preferences?.readonlyRejected, "preferences-readonly-rejected");
  requireTrue(errors, preferences?.invalidValueRejected, "preferences-invalid-value-rejected");
  const structure = preferences?.mainObservation?.searchModeStructure;
  requireTrue(errors, structure?.verified, "preferences-mode-verified");
  requireTrue(errors, structure?.visible, "preferences-mode-visible");
  requireEvidence(errors, structure?.mode === "aggregate" && structure?.selector === ".aggregate-view", "preferences-mode-identity");
  requireTrue(errors, structure?.queryInjected, "preferences-mode-query-injected");
  requireTrue(errors, structure?.queryRestored, "preferences-mode-query-restored");
  requireEvidence(errors, Number.isSafeInteger(structure?.resultCount) && structure.resultCount >= 1
    && structure.resultCount <= 1024, "preferences-mode-visible-results");
  requireEvidence(errors, structure?.rowCountClaimed === false && structure?.unavailableReason === "none", "preferences-mode-scope");
  const rows = preferences?.fields;
  if (!Array.isArray(rows) || rows.length !== PREFERENCE_FIELDS.length) {
    errors.push("preferences-field-count");
    return;
  }
  const seen = new Set();
  for (const row of rows) {
    if (!isObject(row) || Object.keys(row).length !== PREFERENCE_ROW_KEYS.length
      || PREFERENCE_ROW_KEYS.some(key => !Object.hasOwn(row, key))) {
      errors.push("preferences-row-shape");
      continue;
    }
    if (!PREFERENCE_FIELDS.includes(row.field) || seen.has(row.field)) {
      errors.push("preferences-field-identity");
      continue;
    }
    seen.add(row.field);
    for (const key of PREFERENCE_ROW_KEYS.slice(1)) {
      requireTrue(errors, row[key], `preferences-${row.field}-${key}`);
    }
  }
  requireEvidence(errors, PREFERENCE_FIELDS.every(field => seen.has(field)), "preferences-fields-complete");
}

export function validateSettingsViewMode(report) {
  const settings = isObject(report) ? report.settingsView : null;
  const errors = [];
  if (!isObject(settings)) {
    return { mode: "settings", valid: false, enabled: false, passed: false, errors: ["settings-view-snapshot-missing"] };
  }

  requireEvidence(errors, report.multiwebview === null && Object.hasOwn(report, "multiwebview"), "multiwebview-must-be-null");
  requireEvidence(errors, settings.schemaVersion === 2, "schema-version");
  requireTrue(errors, settings.enabled, "settings-view-enabled");
  requireTrue(errors, settings.passed, "settings-view-passed");
  requireEvidence(errors, Array.isArray(settings.errors) && settings.errors.length === 0, "settings-view-errors-empty");

  const bootstrap = settings.bootstrap;
  requireTrue(errors, bootstrap?.domMounted, "bootstrap-dom-mounted");
  requireTrue(errors, bootstrap?.nativeReady, "bootstrap-native-ready");
  requireEvidence(errors, bootstrap?.platform === "darwin", "bootstrap-platform-darwin");
  requireTrue(errors, bootstrap?.launchAtLoginAvailable, "bootstrap-launch-at-login-available");
  requireTrue(errors, bootstrap?.opacityApplied, "bootstrap-opacity-applied");
  requireTrue(errors, bootstrap?.sourceTrusted, "bootstrap-source-trusted");

  const entryPoints = settings.entryPoints;
  for (const name of ["button", "keyboard"]) {
    const entry = entryPoints?.[name];
    requireTrue(errors, entry?.mainPluginMode, `entry-${name}-main-plugin-mode`);
    requireEvidence(errors, Number.isSafeInteger(entry?.childViews) && entry.childViews === 1, `entry-${name}-one-child-view`);
  }

  const save = settings.save;
  requireTrue(errors, save?.inputChanged, "save-input-changed");
  requireTrue(errors, save?.committed, "save-committed");
  requireTrue(errors, save?.rawUpdated, "save-raw-updated");
  requireTrue(errors, save?.mainNotified, "save-main-notified");

  requireTrue(errors, settings.reopen?.freshDocument, "reopen-fresh-document");
  requireTrue(errors, settings.reopen?.persistedDOM, "reopen-persisted-dom");
  validatePreferences(settings.preferences, errors);

  const exit = settings.exit;
  for (const route of ["button", "childEscape"]) {
    const result = exit?.[route];
    requireTrue(errors, result?.childAbsent, `exit-${route}-child-absent`);
    requireZero(errors, result?.layoutRegistrations, `exit-${route}-layout-registrations-zero`);
    requireTrue(errors, result?.searchQueryEmpty, `exit-${route}-search-query-empty`);
    requireTrue(errors, result?.searchFocused, `exit-${route}-search-focused`);
  }

  const isolation = settings.isolation;
  requireTrue(errors, isolation?.secretsAbsent, "isolation-secrets-absent");
  requireTrue(errors, isolation?.staleSessionRejected, "isolation-stale-session-rejected");
  requireTrue(errors, isolation?.genericAppDenied, "isolation-generic-app-denied");
  requireTrue(errors, isolation?.coreDenied, "isolation-core-denied");
  requireTrue(errors, isolation?.unlistedResourceDenied, "isolation-unlisted-resource-denied");

  const cleanup = settings.cleanup;
  for (const field of ["sessions", "childViews", "layoutRegistrations", "pendingCalls", "pendingWrites"]) {
    requireZero(errors, cleanup?.[field], `cleanup-${field}-zero`);
  }

  return {
    mode: "settings",
    schemaVersion: settings.schemaVersion,
    valid: errors.length === 0,
    enabled: settings.enabled === true,
    passed: settings.passed === true,
    errors,
  };
}

export function summarizeSettingsNativeReport(reportFile, markerFile, { autoClear, fixtureRoot, childPid }) {
  const marker = markerFile?.value;
  const ownerMatches = markerMatches(marker, fixtureRoot, childPid);
  const owner = {
    exists: markerFile?.exists ?? false,
    valid: ownerMatches,
    identifier: ownerMatches ? marker.identifier : null,
    markerPidMatchesChild: ownerMatches,
    rootMatchesFixture: ownerMatches,
  };
  if (!reportFile?.exists || !isObject(reportFile.value)) {
    const modeEvidence = validateSettingsViewMode(null);
    return {
      exists: reportFile?.exists ?? false,
      valid: false,
      version: null,
      autoClear: null,
      passed: false,
      metadataMatchesOwner: false,
      multiwebview: null,
      settingsView: modeEvidence,
      modeEvidence,
      exception: reportFile?.exception ?? null,
      owner,
    };
  }

  const generic = validateNativeReport(reportFile.value, { autoClear, marker, fixtureRoot, childPid });
  const modeEvidence = validateSettingsViewMode(reportFile.value);
  return {
    exists: true,
    ...generic,
    valid: generic.valid && modeEvidence.valid,
    multiwebview: reportFile.value.multiwebview ?? null,
    settingsView: modeEvidence,
    modeEvidence,
    exception: null,
    owner,
  };
}

