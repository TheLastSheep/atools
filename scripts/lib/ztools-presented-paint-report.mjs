import { createHash } from "node:crypto";
import {
  NATIVE_PNG_MAX_BYTES,
  NATIVE_PNG_MAX_PIXELS,
  nativePngDimensions,
  readNativePngNoFollow,
} from "./ztools-native-png.mjs";
import { validatePresentedWindowTrace } from "./ztools-presented-window-trace.mjs";

export const PRESENTED_PAINT_SCOPE = "owned-settings-child-visible-unfocused";
export const PRESENTED_PAINT_FILENAMES = Object.freeze({
  light: "native-presented-general-light.png",
  dark: "native-presented-general-dark.png",
});

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "mode", "attempted", "identifier", "root", "pid", "runId",
  "elapsedMs", "passed", "presentation", "steps", "restoration", "cleanup", "windowTrace", "errors",
]);
const PRESENTATION_KEYS = Object.freeze(["visible", "windowFocused", "windowKey", "appActive", "frontmostIsSelf"]);
const STEP_KEYS = Object.freeze([
  "theme", "themeControlFound", "themeMenuOpened", "optionSetValid", "selectionDispatched", "selected",
  "selectedTheme", "databaseTheme", "childMediaDark", "mainMediaDark", "nativeAppearance", "readiness",
  "presentation", "snapshot",
]);
const STEP_BOOLEAN_KEYS = Object.freeze([
  "themeControlFound", "themeMenuOpened", "optionSetValid", "selectionDispatched", "selected",
]);
const READINESS_KEYS = Object.freeze([
  "routeGeneral", "mediaMatches", "menusAbsent", "rootTextMatches", "sidebarTextMatches",
  "labelTextMatches", "framesObserved", "settled",
]);
const SNAPSHOT_KEYS = Object.freeze(["state", "filename", "evidence", "reason"]);
const EVIDENCE_KEYS = Object.freeze(["width", "height", "pngBytes", "sha256", "nonUniform", "nonTransparent"]);
const RESTORATION_KEYS = Object.freeze([
  "selectedTheme", "databaseTheme", "childMediaDark", "mainMediaDark", "nativeAppearance", "presentation",
]);
const CLEANUP_KEYS = Object.freeze([
  "hideConfirmed", "visible", "windowFocused", "windowKey", "appActive", "frontmostIsSelf",
]);
const THEMES = Object.freeze(["light", "dark", "system"]);
const NATIVE_ERRORS = new Set([
  "settings-input-presented-paint-identity-invalid",
  "settings-input-presented-paint-show-failed",
  "settings-input-presented-paint-visible-state-invalid",
  "settings-input-presented-paint-focus-changed",
  "settings-input-presented-paint-theme-selection-invalid",
  "settings-input-presented-paint-theme-convergence-timeout",
  "settings-input-presented-paint-readiness-timeout",
  "settings-input-presented-paint-snapshot-failed",
  "settings-input-presented-paint-restore-failed",
  "settings-input-presented-paint-hide-failed",
  "settings-input-presented-paint-watchdog-expired",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isBooleanOrNull(value) {
  return value === null || typeof value === "boolean";
}

function validTheme(value) {
  return value === "light" || value === "dark" || value === "system";
}

function validAppearance(value) {
  return value === "light" || value === "dark";
}

function safeReadinessSummary(value, theme) {
  if (theme === "system" || !exactKeys(value, READINESS_KEYS)
      || READINESS_KEYS.some(key => typeof value[key] !== "boolean")) return null;
  return Object.fromEntries(READINESS_KEYS.map(key => [key, value[key]]));
}

function safeSnapshotSummary(value, theme) {
  if (!exactKeys(value, SNAPSHOT_KEYS) || !["captured", "unverified", "not-required"].includes(value.state)) {
    return { state: "invalid" };
  }
  if (value.state === "not-required") {
    return theme === "system" && value.filename === null && value.evidence === null && value.reason === null
      ? { state: "not-required", filename: null, evidence: null, reason: null }
      : { state: "invalid" };
  }
  if (value.state === "unverified") {
    return value.filename === null && value.evidence === null && NATIVE_ERRORS.has(value.reason)
      ? { state: "unverified", filename: null, evidence: null, reason: value.reason }
      : { state: "invalid" };
  }
  const filename = PRESENTED_PAINT_FILENAMES[theme];
  const evidence = value.evidence;
  if (filename === undefined || value.filename !== filename || value.reason !== null
      || !exactKeys(evidence, EVIDENCE_KEYS)) return { state: "invalid" };
  return {
    state: "captured",
    filename,
    evidence: {
      width: Number.isSafeInteger(evidence.width) ? evidence.width : null,
      height: Number.isSafeInteger(evidence.height) ? evidence.height : null,
      pngBytes: Number.isSafeInteger(evidence.pngBytes) ? evidence.pngBytes : null,
      sha256: typeof evidence.sha256 === "string" && /^[0-9a-f]{64}$/.test(evidence.sha256)
        ? evidence.sha256 : null,
      nonUniform: typeof evidence.nonUniform === "boolean" ? evidence.nonUniform : null,
      nonTransparent: typeof evidence.nonTransparent === "boolean" ? evidence.nonTransparent : null,
    },
    reason: null,
  };
}

function safePresentation(value) {
  return exactKeys(value, PRESENTATION_KEYS)
    && PRESENTATION_KEYS.every(key => isBooleanOrNull(value[key]))
    && value.visible === true && value.windowFocused === false && value.windowKey === false
    && value.appActive === false && value.frontmostIsSelf === false;
}

function presentationShape(value) {
  return exactKeys(value, PRESENTATION_KEYS) && PRESENTATION_KEYS.every(key => isBooleanOrNull(value[key]));
}

function safeCleanup(value) {
  return exactKeys(value, CLEANUP_KEYS) && CLEANUP_KEYS.every(key => isBooleanOrNull(value[key]))
    && value.hideConfirmed === true && value.visible === false && value.windowFocused === false
    && value.windowKey === false && value.appActive === false && value.frontmostIsSelf === false;
}

function validatePresentation(value, prefix, errors) {
  if (!presentationShape(value)) {
    errors.push(`${prefix}-shape`);
    return false;
  }
  return safePresentation(value);
}

function validateReadiness(value, theme, errors) {
  if (theme === "system") return value === null;
  if (!exactKeys(value, READINESS_KEYS) || READINESS_KEYS.some(key => typeof value[key] !== "boolean")) {
    errors.push(`presented-paint-${theme}-readiness-shape`);
    return false;
  }
  return READINESS_KEYS.every(key => value[key] === true);
}

function validateSnapshotShape(value, theme, errors) {
  if (!exactKeys(value, SNAPSHOT_KEYS)) {
    errors.push(`presented-paint-${theme}-snapshot-shape`);
    return false;
  }
  if (theme === "system") {
    const valid = value.state === "not-required" && value.filename === null
      && value.evidence === null && value.reason === null;
    if (!valid) errors.push("presented-paint-system-snapshot-not-required");
    return valid;
  }
  if (value.state === "unverified") {
    const valid = value.filename === null && value.evidence === null
      && typeof value.reason === "string" && NATIVE_ERRORS.has(value.reason);
    if (!valid) errors.push(`presented-paint-${theme}-snapshot-unverified-shape`);
    return valid;
  }
  if (value.state !== "captured" || value.filename !== PRESENTED_PAINT_FILENAMES[theme]
      || value.reason !== null || !exactKeys(value.evidence, EVIDENCE_KEYS)) {
    errors.push(`presented-paint-${theme}-snapshot-captured-shape`);
    return false;
  }
  const evidence = value.evidence;
  const valid = Number.isSafeInteger(evidence.width) && evidence.width >= 16 && evidence.width <= 4096
    && Number.isSafeInteger(evidence.height) && evidence.height >= 16 && evidence.height <= 4096
    && evidence.width * evidence.height <= NATIVE_PNG_MAX_PIXELS
    && Number.isSafeInteger(evidence.pngBytes) && evidence.pngBytes > 0
    && evidence.pngBytes <= NATIVE_PNG_MAX_BYTES
    && typeof evidence.sha256 === "string" && /^[0-9a-f]{64}$/.test(evidence.sha256)
    && evidence.nonUniform === true && evidence.nonTransparent === true;
  if (!valid) errors.push(`presented-paint-${theme}-snapshot-evidence-shape`);
  return valid;
}

function validateStepShape(step, theme, errors) {
  if (!exactKeys(step, STEP_KEYS) || step.theme !== theme) {
    errors.push(`presented-paint-${theme}-step-shape`);
    return null;
  }

  let valid = true;
  for (const key of STEP_BOOLEAN_KEYS) {
    if (typeof step[key] !== "boolean") {
      errors.push(`presented-paint-${theme}-${key}-type`);
      valid = false;
    }
  }
  if (!isBooleanOrNull(step.childMediaDark) || !isBooleanOrNull(step.mainMediaDark)) {
    errors.push(`presented-paint-${theme}-media-type`);
    valid = false;
  }
  if (!(step.selectedTheme === null || validTheme(step.selectedTheme))
      || !(step.databaseTheme === null || validTheme(step.databaseTheme))) {
    errors.push(`presented-paint-${theme}-theme-readback-type`);
    valid = false;
  }
  if (!(step.nativeAppearance === null || validAppearance(step.nativeAppearance))) {
    errors.push(`presented-paint-${theme}-native-appearance-type`);
    valid = false;
  }
  const readinessPass = validateReadiness(step.readiness, theme, errors);
  if (theme === "system" && step.readiness !== null) {
    errors.push("presented-paint-system-readiness-not-null");
    valid = false;
  }
  const shownSafely = validatePresentation(step.presentation, `presented-paint-${theme}-presentation`, errors);
  if (!presentationShape(step.presentation)) valid = false;
  const snapshotValid = validateSnapshotShape(step.snapshot, theme, errors);
  if (!snapshotValid) valid = false;

  if (theme !== "system" && !readinessPass && step.snapshot?.state === "captured") {
    errors.push(`presented-paint-${theme}-snapshot-before-readiness`);
    valid = false;
  }

  const expectedThemeDark = theme === "dark";
  const systemMediaMatchesAppearance = theme === "system"
    && validAppearance(step.nativeAppearance)
    && step.childMediaDark === (step.nativeAppearance === "dark")
    && step.mainMediaDark === step.childMediaDark;
  const mediaMatches = theme === "system"
    ? systemMediaMatchesAppearance
    : step.childMediaDark === expectedThemeDark && step.mainMediaDark === expectedThemeDark
      && step.nativeAppearance === theme;
  const selectionsPass = STEP_BOOLEAN_KEYS.every(key => step[key] === true)
    && step.selectedTheme === theme && step.databaseTheme === theme;
  const factsPass = valid && selectionsPass && mediaMatches && shownSafely
    && (theme === "system" || readinessPass && step.snapshot?.state === "captured");
  return {
    valid,
    factsPass,
    summary: {
      theme,
      themeControlFound: typeof step.themeControlFound === "boolean" ? step.themeControlFound : null,
      themeMenuOpened: typeof step.themeMenuOpened === "boolean" ? step.themeMenuOpened : null,
      optionSetValid: typeof step.optionSetValid === "boolean" ? step.optionSetValid : null,
      selectionDispatched: typeof step.selectionDispatched === "boolean" ? step.selectionDispatched : null,
      selected: typeof step.selected === "boolean" ? step.selected : null,
      selectedTheme: step.selectedTheme === null || validTheme(step.selectedTheme) ? step.selectedTheme : null,
      databaseTheme: step.databaseTheme === null || validTheme(step.databaseTheme) ? step.databaseTheme : null,
      childMediaDark: isBooleanOrNull(step.childMediaDark) ? step.childMediaDark : null,
      mainMediaDark: isBooleanOrNull(step.mainMediaDark) ? step.mainMediaDark : null,
      nativeAppearance: step.nativeAppearance === null || validAppearance(step.nativeAppearance)
        ? step.nativeAppearance : null,
      readiness: safeReadinessSummary(step.readiness, theme),
      presentation: presentationShape(step.presentation) ? step.presentation : null,
      snapshot: safeSnapshotSummary(step.snapshot, theme),
    },
  };
}

function validateRestoration(value, errors) {
  if (!exactKeys(value, RESTORATION_KEYS)) {
    errors.push("presented-paint-restoration-shape");
    return { valid: false, factsPass: false, summary: null };
  }
  let valid = true;
  if (!(value.selectedTheme === null || validTheme(value.selectedTheme))
      || !(value.databaseTheme === null || validTheme(value.databaseTheme))) {
    errors.push("presented-paint-restoration-theme-type");
    valid = false;
  }
  if (!isBooleanOrNull(value.childMediaDark) || !isBooleanOrNull(value.mainMediaDark)) {
    errors.push("presented-paint-restoration-media-type");
    valid = false;
  }
  if (!(value.nativeAppearance === null || validAppearance(value.nativeAppearance))) {
    errors.push("presented-paint-restoration-native-appearance-type");
    valid = false;
  }
  const shownSafely = validatePresentation(value.presentation, "presented-paint-restoration-presentation", errors);
  if (!presentationShape(value.presentation)) valid = false;
  const factsPass = valid && value.selectedTheme === "dark" && value.databaseTheme === "dark"
    && value.childMediaDark === true && value.mainMediaDark === true
    && value.nativeAppearance === "dark" && shownSafely;
  return {
    valid,
    factsPass,
    summary: {
      selectedTheme: value.selectedTheme === null || validTheme(value.selectedTheme) ? value.selectedTheme : null,
      databaseTheme: value.databaseTheme === null || validTheme(value.databaseTheme) ? value.databaseTheme : null,
      childMediaDark: isBooleanOrNull(value.childMediaDark) ? value.childMediaDark : null,
      mainMediaDark: isBooleanOrNull(value.mainMediaDark) ? value.mainMediaDark : null,
      nativeAppearance: value.nativeAppearance === null || validAppearance(value.nativeAppearance)
        ? value.nativeAppearance : null,
      presentation: presentationShape(value.presentation) ? value.presentation : null,
    },
  };
}

function validateCleanup(value, errors) {
  if (!exactKeys(value, CLEANUP_KEYS) || CLEANUP_KEYS.some(key => !isBooleanOrNull(value[key]))) {
    errors.push("presented-paint-cleanup-shape");
    return { valid: false, factsPass: false, summary: null };
  }
  return { valid: true, factsPass: safeCleanup(value), summary: Object.fromEntries(CLEANUP_KEYS.map(key => [key, value[key]])) };
}

function validateTraceCleanupAgreement(trace, cleanup, errors) {
  if (!trace?.afterHide || !cleanup) return true;
  let valid = true;
  for (const key of ["visible", "windowFocused", "windowKey", "appActive", "frontmostIsSelf"]) {
    if (trace.afterHide[key] === null || cleanup[key] === null || trace.afterHide[key] === cleanup[key]) continue;
    errors.push("presented-paint-window-trace-cleanup-mismatch");
    valid = false;
    break;
  }
  return valid;
}

async function validateCapturedPng(step, theme, runDirectory, errors) {
  if (step?.snapshot?.state !== "captured") return false;
  try {
    const filename = PRESENTED_PAINT_FILENAMES[theme];
    const bytes = await readNativePngNoFollow(
      runDirectory, filename, Object.values(PRESENTED_PAINT_FILENAMES), NATIVE_PNG_MAX_BYTES, "presented-paint",
    );
    const dimensions = nativePngDimensions(bytes);
    const evidence = step.snapshot.evidence;
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    const validDimensions = dimensions !== null && dimensions.width >= 16 && dimensions.width <= 4096
      && dimensions.height >= 16 && dimensions.height <= 4096
      && dimensions.width * dimensions.height <= NATIVE_PNG_MAX_PIXELS;
    const validEvidence = validDimensions && evidence.width === dimensions.width
      && evidence.height === dimensions.height && evidence.pngBytes === bytes.byteLength
      && evidence.sha256 === actualHash && evidence.nonUniform === true && evidence.nonTransparent === true;
    if (!validEvidence) errors.push(`presented-paint-${theme}-png-evidence-mismatch`);
    return validEvidence;
  } catch {
    errors.push(`presented-paint-${theme}-png-file-invalid`);
    return false;
  }
}

/** Validates exact bounded facts and PNG bytes; `passed` is derived and never trusts Native's summary bit. */
export async function validatePresentedPaintReport(report, expectedOwner, runDirectory) {
  const errors = [];
  if (!exactKeys(report, REPORT_KEYS)) {
    return invalidResult(["presented-paint-report-shape"]);
  }

  const owner = isRecord(expectedOwner) ? expectedOwner : {};
  const runIdValid = typeof report.runId === "string" && /^[0-9a-f]{32}$/.test(report.runId);
  const identityValid = report.schemaVersion === 2 && report.journey === "settings-input-presented-paint"
    && report.scope === PRESENTED_PAINT_SCOPE && report.mode === "visible-unfocused"
    && runIdValid && report.runId === owner.runId && report.identifier === owner.identifier
    && report.identifier === `dev.atools.renderer-settings-input.${report.runId}`
    && report.root === owner.root && report.pid === owner.pid
    && Number.isSafeInteger(report.pid) && report.pid > 0;
  if (!identityValid) errors.push("presented-paint-report-identity");
  if (typeof report.attempted !== "boolean") errors.push("presented-paint-report-attempted-type");
  if (!Number.isSafeInteger(report.elapsedMs) || report.elapsedMs < 0 || report.elapsedMs > 12_000) {
    errors.push("presented-paint-report-elapsed");
  }
  if (typeof report.passed !== "boolean") errors.push("presented-paint-report-passed-type");
  const nativeErrorsValid = Array.isArray(report.errors)
    && report.errors.every(error => NATIVE_ERRORS.has(error))
    && new Set(report.errors).size === report.errors.length;
  if (!nativeErrorsValid) errors.push("presented-paint-report-errors");

  const topPresentationPass = validatePresentation(report.presentation, "presented-paint-presentation", errors);
  if (!presentationShape(report.presentation)) errors.push("presented-paint-report-presentation-shape");

  let stepsValid = Array.isArray(report.steps) && report.steps.length === THEMES.length;
  const stepSummaries = {};
  const stepsPass = [];
  if (!stepsValid) errors.push("presented-paint-report-step-count");
  if (Array.isArray(report.steps)) {
    THEMES.forEach((theme, index) => {
      const step = report.steps[index];
      const validated = validateStepShape(step, theme, errors);
      if (validated === null) {
        stepsValid = false;
        stepsPass.push(false);
        stepSummaries[theme] = { state: "invalid" };
        return;
      }
      if (!validated.valid) stepsValid = false;
      stepsPass.push(validated.factsPass);
      stepSummaries[theme] = validated.summary;
    });
  }

  for (const theme of ["light", "dark"]) {
    const step = Array.isArray(report.steps) ? report.steps[THEMES.indexOf(theme)] : null;
    if (step?.snapshot?.state === "captured") {
      if (!await validateCapturedPng(step, theme, runDirectory, errors)) stepsValid = false;
    }
  }

  const restoration = validateRestoration(report.restoration, errors);
  if (!restoration.valid) stepsValid = false;
  const cleanup = validateCleanup(report.cleanup, errors);
  if (!cleanup.valid) stepsValid = false;
  const windowTrace = validatePresentedWindowTrace(report.windowTrace);
  if (!windowTrace.valid) errors.push(...windowTrace.errors);
  const traceCleanupAgreement = validateTraceCleanupAgreement(windowTrace.summary, cleanup.summary, errors);

  const nativeErrorsEmpty = Array.isArray(report.errors) && report.errors.length === 0;
  const factsPass = identityValid && report.attempted === true && topPresentationPass
    && stepsValid && stepsPass.length === THEMES.length && stepsPass.every(Boolean)
    && restoration.factsPass && cleanup.factsPass && windowTrace.passed && traceCleanupAgreement && nativeErrorsEmpty;
  if (report.passed !== factsPass) errors.push("presented-paint-report-pass-mismatch");

  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    passed: uniqueErrors.length === 0 && factsPass,
    errors: uniqueErrors,
    summary: {
      mode: report.mode === "visible-unfocused" ? report.mode : null,
      attempted: report.attempted === true,
      presentation: presentationShape(report.presentation) ? report.presentation : null,
      steps: stepSummaries,
      restoration: restoration.summary,
      cleanup: cleanup.summary,
      windowTrace: windowTrace.summary,
      nativeErrors: nativeErrorsValid ? report.errors : [],
    },
  };
}

function invalidResult(errors) {
  return {
    valid: false,
    passed: false,
    errors,
    summary: {
      mode: null, attempted: false, presentation: null, steps: {}, restoration: null, cleanup: null,
      windowTrace: null, nativeErrors: [],
    },
  };
}
