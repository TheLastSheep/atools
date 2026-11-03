import { createHash } from "node:crypto";
import { validateNativePaintDiagnostics } from "./ztools-native-paint-diagnostics.mjs";
import {
  NATIVE_PNG_MAX_BYTES,
  NATIVE_PNG_MAX_PIXELS,
  nativePngDimensions,
  readNativePngNoFollow,
} from "./ztools-native-png.mjs";

export const NATIVE_MATERIAL_SCOPE = "hidden-original-vue-native-window-material";
export const NATIVE_MATERIAL_STAGES = Object.freeze([
  "startup", "openAllCommands", "mainMatch", "mainNoMatch", "mainClear", "pinSearch",
  "childValueReturn", "ownerRotation", "closeCleanup", "freshReopen", "unpinSearch", "finalCleanup",
]);

const ROOT_KEYS = ["schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId",
  "passed", "elapsedMs", "stages", "theme", "snapshots", "paintDiagnostics", "cleanup", "errors"];
const OBSERVATION_KEYS = ["supported", "installed", "mainOwner", "settingsLeaseCount", "totalOwners",
  "cleanupPending", "effectCount", "tag", "material", "blendingMode", "state", "effectiveAppearance"];
const STAGE_KEYS = ["key", "elapsedMs", "passed", "actual", "errors", "childDrawsBackground"];
const THEME_ROOT_KEYS = ["passed", "initial", "steps", "restoration"];
const INITIAL_KEYS = ["databaseTheme", "routeAllCommands", "childCommittedTheme", "childMediaDark",
  "mainMediaDark", "effectiveAppearance", "passed", "generalEntry"];
const GENERAL_ENTRY_KEYS = ["routeGeneral", "sidebarFound", "navigationDispatched", "themeControlFound",
  "selectedTheme", "childCommittedTheme", "childMediaDark", "passed"];
const THEME_STEP_KEYS = ["theme", "routeGeneral", "themeControlFound", "themeMenuOpened", "optionSetValid",
  "selectionDispatched", "selected", "selectedTheme", "childCommittedTheme", "databaseTheme",
  "childMediaDark", "mainMediaDark", "effectiveAppearance", "passed"];
const RESTORATION_KEYS = ["theme", "routeGeneral", "selectedTheme", "childCommittedTheme", "databaseTheme",
  "childMediaDark", "mainMediaDark", "effectiveAppearance", "matchesInitialAppearance", "passed"];
const SNAPSHOT_KEYS = ["light", "dark"];
const SNAPSHOT_RECORD_KEYS = ["state", "filename", "reason", "evidence", "readiness"];
const READINESS_KEYS = ["routeGeneral", "mediaMatches", "menusAbsent", "rootTextMatches",
  "sidebarTextMatches", "labelTextMatches", "framesObserved", "settled"];
const EVIDENCE_KEYS = ["width", "height", "pngBytes", "sha256", "nonUniform", "nonTransparent"];
const CLEANUP_KEYS = ["stopAcknowledged", "actual", "passed"];
const UNVERIFIED_REASONS = new Set([
  "settings-input-material-snapshot-not-attempted",
  "settings-input-material-snapshot-write-failed",
  "settings-input-material-report-write-failed",
  "settings-input-snapshot-requires-macos",
  "settings-input-snapshot-dispatch-failed",
  "settings-input-snapshot-timeout",
  "settings-input-snapshot-callback-interrupted",
  "settings-input-snapshot-native-failed",
  "settings-input-snapshot-dimensions-invalid",
  "settings-input-snapshot-intermediate-too-large",
  "settings-input-snapshot-encoding-failed",
  "settings-input-snapshot-png-invalid",
  "settings-input-snapshot-png-decode-failed",
  "settings-input-snapshot-blank",
  "settings-input-material-snapshot-unsettled",
]);
const MAX_SNAPSHOT_BYTES = NATIVE_PNG_MAX_BYTES;
const MAX_SNAPSHOT_PIXELS = NATIVE_PNG_MAX_PIXELS;
const SNAPSHOT_FILENAMES = Object.freeze({
  light: "native-general-light.png",
  dark: "native-general-dark.png",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function duration(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function check(errors, condition, code) {
  if (!condition) errors.push(code);
}

function noErrors(value) {
  return Array.isArray(value) && value.length === 0;
}

function validAppearance(value) {
  return value === "light" || value === "dark";
}

function expectedAppearance(theme, appearance) {
  if (theme === "light" || theme === "dark") return appearance === theme;
  return theme === "system" && validAppearance(appearance);
}

function expectedChild(stage) {
  return !["startup", "closeCleanup", "finalCleanup"].includes(stage);
}

function validateObservation(value, child, released, errors, prefix) {
  check(errors, exactKeys(value, OBSERVATION_KEYS), `${prefix}-observation-shape`);
  if (!isRecord(value)) return;
  const leaseCount = Number(child);
  if (released) {
    check(errors, value.supported === true && value.installed === true && value.mainOwner === false
      && value.settingsLeaseCount === 0 && value.totalOwners === 0 && value.cleanupPending === false
      && value.effectCount === 0 && value.tag === null && value.material === null
      && value.blendingMode === null && value.state === null && validAppearance(value.effectiveAppearance),
    `${prefix}-cleanup-observation`);
    return;
  }
  check(errors, value.supported === true && value.installed === true && value.mainOwner === true
    && value.settingsLeaseCount === leaseCount && value.totalOwners === 1 + leaseCount
    && value.cleanupPending === false && value.effectCount === 1 && value.tag === 91_376_254
    && value.material === 15 && value.blendingMode === 0 && value.state === 0
    && validAppearance(value.effectiveAppearance), `${prefix}-active-observation`);
}

function validateThemes(value, errors) {
  check(errors, exactKeys(value, THEME_ROOT_KEYS), "theme-shape");
  if (!isRecord(value)) return;
  check(errors, value.passed === true, "theme-not-passed");
  const initial = value.initial;
  check(errors, exactKeys(initial, INITIAL_KEYS), "theme-initial-shape");
  if (isRecord(initial)) {
    check(errors, initial.databaseTheme === "dark" && initial.routeAllCommands === true
      && initial.childCommittedTheme === "dark" && initial.passed === true
      && initial.childMediaDark === true && initial.mainMediaDark === true
      && initial.effectiveAppearance === "dark", "theme-initial-mismatch");
    const entry = initial.generalEntry;
    check(errors, exactKeys(entry, GENERAL_ENTRY_KEYS), "theme-general-entry-shape");
    if (isRecord(entry)) {
      check(errors, entry.routeGeneral === true && entry.sidebarFound === true
        && entry.navigationDispatched === true && entry.themeControlFound === true
        && entry.selectedTheme === "dark" && entry.childCommittedTheme === "dark"
        && entry.childMediaDark === true && entry.passed === true, "theme-general-entry-mismatch");
    }
  }

  const themes = ["light", "dark", "system"];
  check(errors, Array.isArray(value.steps) && value.steps.length === themes.length, "theme-step-count");
  if (Array.isArray(value.steps)) {
    value.steps.slice(0, themes.length).forEach((step, index) => {
      const theme = themes[index];
      check(errors, exactKeys(step, THEME_STEP_KEYS), `theme-step-${theme}-shape`);
      if (!isRecord(step)) return;
      const appearance = step.effectiveAppearance;
      const isDark = appearance === "dark";
      check(errors, step.theme === theme && step.routeGeneral === true && step.themeControlFound === true
        && step.themeMenuOpened === true && step.optionSetValid === true && step.selectionDispatched === true
        && step.selected === true && step.selectedTheme === theme && step.childCommittedTheme === theme
        && step.databaseTheme === theme && validAppearance(appearance)
        && step.childMediaDark === isDark && step.mainMediaDark === isDark
        && expectedAppearance(theme, appearance) && step.passed === true,
      `theme-step-${theme}-mismatch`);
    });
  }

  const restoration = value.restoration;
  check(errors, exactKeys(restoration, RESTORATION_KEYS), "theme-restoration-shape");
  if (isRecord(restoration)) {
    check(errors, restoration.theme === "dark" && restoration.routeGeneral === true
      && restoration.selectedTheme === "dark" && restoration.childCommittedTheme === "dark"
      && restoration.databaseTheme === "dark" && restoration.childMediaDark === true
      && restoration.mainMediaDark === true && restoration.effectiveAppearance === "dark"
      && restoration.matchesInitialAppearance === true && restoration.passed === true,
    "theme-restoration-mismatch");
  }
}

function readinessValid(value) {
  if (!exactKeys(value, READINESS_KEYS) || READINESS_KEYS.some(key => typeof value[key] !== "boolean")) return false;
  const readinessFactsPassed = READINESS_KEYS.slice(0, -1).every(key => value[key] === true);
  return value.settled === readinessFactsPassed;
}

function readinessSettled(value) {
  return readinessValid(value) && value.settled === true
    && READINESS_KEYS.slice(0, -1).every(key => value[key] === true);
}

async function validateSnapshots(value, runDirectory, errors) {
  check(errors, exactKeys(value, SNAPSHOT_KEYS), "snapshots-shape");
  const summary = {};
  const captured = {};
  if (!isRecord(value)) return { summary, visualStatus: "unverified", visualReason: "snapshot-shape-invalid" };
  for (const theme of SNAPSHOT_KEYS) {
    const snapshot = value[theme];
    check(errors, exactKeys(snapshot, SNAPSHOT_RECORD_KEYS), `snapshot-${theme}-shape`);
    if (!isRecord(snapshot)) {
      summary[theme] = { state: "invalid" };
      continue;
    }
    if (snapshot.state === "unverified") {
      const common = snapshot.filename === null && UNVERIFIED_REASONS.has(snapshot.reason)
        && snapshot.evidence === null;
      const readinessValidForReason = snapshot.reason === "settings-input-material-snapshot-unsettled"
        ? readinessValid(snapshot.readiness) && snapshot.readiness.settled === false
        : snapshot.readiness === null || readinessSettled(snapshot.readiness);
      const valid = common && readinessValidForReason;
      check(errors, valid, `snapshot-${theme}-unverified-invalid`);
      summary[theme] = { state: valid ? "unverified" : "invalid", reason: valid ? snapshot.reason : null };
      continue;
    }
    const expectedFilename = SNAPSHOT_FILENAMES[theme];
    const evidence = snapshot.evidence;
    const shapeValid = snapshot.state === "captured" && snapshot.filename === expectedFilename
      && snapshot.reason === null && exactKeys(evidence, EVIDENCE_KEYS)
      && readinessSettled(snapshot.readiness);
    check(errors, shapeValid, `snapshot-${theme}-captured-invalid`);
    if (!shapeValid) {
      summary[theme] = { state: "invalid" };
      continue;
    }
    try {
      const bytes = await readNativePngNoFollow(
        runDirectory, expectedFilename, Object.values(SNAPSHOT_FILENAMES), MAX_SNAPSHOT_BYTES, "snapshot",
      );
      const dimensions = nativePngDimensions(bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const dimensionsValid = dimensions !== null && dimensions.width >= 16 && dimensions.width <= 4096
        && dimensions.height >= 16 && dimensions.height <= 4096
        && dimensions.width * dimensions.height <= MAX_SNAPSHOT_PIXELS;
      const evidenceValid = dimensionsValid && evidence.width === dimensions.width
        && evidence.height === dimensions.height && evidence.pngBytes === bytes.byteLength
        && evidence.sha256 === digest && /^[0-9a-f]{64}$/.test(evidence.sha256)
        && evidence.nonUniform === true && evidence.nonTransparent === true;
      check(errors, evidenceValid, `snapshot-${theme}-evidence-mismatch`);
      summary[theme] = evidenceValid
        ? { state: "captured", filename: expectedFilename, pngBytes: bytes.byteLength, sha256: digest }
        : { state: "invalid" };
      if (evidenceValid) captured[theme] = digest;
    } catch {
      check(errors, false, `snapshot-${theme}-file-invalid`);
      summary[theme] = { state: "invalid" };
    }
  }
  if (captured.light && captured.dark && captured.light === captured.dark) {
    return { summary, visualStatus: "unverified", visualReason: "identical-light-dark-pngs" };
  }
  const visualPassed = Boolean(captured.light && captured.dark);
  return {
    summary,
    visualStatus: visualPassed ? "captured" : "unverified",
    visualReason: visualPassed ? null : "one-or-more-snapshots-unverified",
  };
}

/** Independently validates the material report; Native's `passed` flag is informational only. */
export async function validateNativeMaterialReport(report, expectedOwner, runDirectory) {
  const errors = [];
  if (!isRecord(report)) return invalidResult(["report-shape"]);
  check(errors, exactKeys(report, ROOT_KEYS), "report-shape");
  const owner = isRecord(expectedOwner) ? expectedOwner : {};
  check(errors, report.schemaVersion === 1 && report.journey === "settings-input-material"
    && report.scope === NATIVE_MATERIAL_SCOPE, "report-identity");
  check(errors, report.runId === owner.runId && report.identifier === owner.identifier
    && report.root === owner.root && report.pid === owner.pid
    && typeof report.runId === "string" && /^[0-9a-f]{32}$/.test(report.runId)
    && report.identifier === `dev.atools.renderer-settings-input.${report.runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0,
  "report-owner-mismatch");
  check(errors, typeof report.passed === "boolean" && duration(report.elapsedMs), "report-timing-invalid");
  check(errors, noErrors(report.errors), "report-errors");
  const paintDiagnostics = validateNativePaintDiagnostics(report.paintDiagnostics);
  errors.push(...paintDiagnostics.errors);
  check(errors, Array.isArray(report.stages) && report.stages.length === NATIVE_MATERIAL_STAGES.length,
    "stage-count");
  if (Array.isArray(report.stages)) {
    NATIVE_MATERIAL_STAGES.forEach((key, index) => {
      const stage = report.stages[index];
      check(errors, exactKeys(stage, STAGE_KEYS), `stage-${key}-shape`);
      if (!isRecord(stage)) return;
      const child = expectedChild(key);
      check(errors, stage.key === key && stage.passed === true && duration(stage.elapsedMs)
        && noErrors(stage.errors), `stage-${key}-state`);
      check(errors, stage.childDrawsBackground === (child ? false : null),
        `stage-${key}-child-background`);
      validateObservation(stage.actual, child, false, errors, `stage-${key}`);
    });
  }
  validateThemes(report.theme, errors);
  const cleanup = report.cleanup;
  check(errors, exactKeys(cleanup, CLEANUP_KEYS), "cleanup-shape");
  if (isRecord(cleanup)) {
    check(errors, cleanup.stopAcknowledged === true && cleanup.passed === true, "cleanup-not-acknowledged");
    validateObservation(cleanup.actual, false, true, errors, "cleanup");
  }
  const snapshots = await validateSnapshots(report.snapshots, runDirectory, errors);
  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    passed: uniqueErrors.length === 0,
    errors: uniqueErrors,
    paintDiagnostics: paintDiagnostics.summary,
    visual: {
      status: snapshots.visualStatus,
      passed: snapshots.visualStatus === "captured",
      reason: snapshots.visualReason,
      snapshots: snapshots.summary,
    },
  };
}

function invalidResult(errors) {
  return {
    valid: false,
    passed: false,
    errors,
    paintDiagnostics: { light: { state: "invalid" }, dark: { state: "invalid" } },
    visual: { status: "unverified", passed: false, reason: "report-shape-invalid", snapshots: {} },
  };
}
