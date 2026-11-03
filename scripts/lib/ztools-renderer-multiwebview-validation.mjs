import { markerMatches, validateNativeReport } from "./ztools-renderer-native-runtime.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireEvidence(errors, condition, field) {
  if (!condition) errors.push(field);
}

function hasUsableBounds(bounds) {
  if (!isObject(bounds)) return false;
  const { x, y, width, height, parentWidth, parentHeight, scaleFactor } = bounds;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
      || !Number.isSafeInteger(width) || width <= 1
      || !Number.isSafeInteger(height) || height <= 1
      || !Number.isSafeInteger(parentWidth) || parentWidth <= 0
      || !Number.isSafeInteger(parentHeight) || parentHeight <= 0
      || !Number.isFinite(scaleFactor) || scaleFactor <= 0
      || !Number.isFinite(bounds.topReservedLogical)) return false;

  const right = x + width;
  const bottom = y + height;
  const tolerancePhysical = 3 * scaleFactor;
  const maxRight = parentWidth + 2;
  const maxBottom = parentHeight + 2;
  const topLogical = y / scaleFactor;
  const parentHeightLogical = parentHeight / scaleFactor;
  if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom)
      || !Number.isSafeInteger(maxRight) || !Number.isSafeInteger(maxBottom)
      || !Number.isFinite(tolerancePhysical) || !Number.isFinite(topLogical)
      || !Number.isFinite(parentHeightLogical)) return false;

  return x >= 0 && y >= 0
    && parentHeightLogical > 65
    && right <= maxRight && bottom <= maxBottom
    && Math.abs(parentWidth - width) <= tolerancePhysical
    && Math.abs(topLogical - 64) <= 3
    && Math.abs(parentHeight - bottom) <= tolerancePhysical
    && bounds.fitsParent === true
    && bounds.widthFillsParent === true
    && Math.abs(bounds.topReservedLogical - 64) <= 3
    && bounds.headerReservationVerified === true
    && bounds.contentHeightFillsParent === true
    && bounds.minimumHeightSatisfied === true;
}

export function validateMultiwebviewMode(report, mode) {
  if (mode !== "single" && mode !== "multiwebview") {
    return { mode, valid: false, enabled: false, passed: false, errors: ["unsupported-mode"] };
  }
  if (mode === "single") {
    const valid = isObject(report) && Object.hasOwn(report, "multiwebview") && report.multiwebview === null;
    return {
      mode,
      valid,
      enabled: false,
      passed: null,
      errors: valid ? [] : ["single-mode-requires-null-child-proof"],
    };
  }

  const snapshot = isObject(report) ? report.multiwebview : null;
  const errors = [];
  if (!isObject(snapshot)) {
    return { mode, valid: false, enabled: false, passed: false, errors: ["multiwebview-snapshot-missing"] };
  }

  const identity = snapshot.identity;
  const main = snapshot.main;
  const mainIpc = main?.ipc;
  const journey = main?.windowJourney;
  const child = snapshot.child;
  const childIpc = child?.ipc;
  const focusJourney = child?.focusJourney;
  const cleanup = snapshot.cleanup;

  requireEvidence(errors, snapshot.schemaVersion === 1, "schema-version");
  requireEvidence(errors, snapshot.enabled === true, "feature-enabled");
  requireEvidence(errors, snapshot.passed === true, "native-multiwebview-passed");
  requireEvidence(errors, Array.isArray(snapshot.errors) && snapshot.errors.length === 0, "native-errors-empty");

  requireEvidence(errors, identity?.mainWindowLabel === "main", "identity-main-window-label");
  requireEvidence(errors, identity?.parentLabel === "main", "identity-parent-label");
  requireEvidence(errors, Array.isArray(identity?.parentWebviews)
    && identity.parentWebviews.length === 2
    && identity.parentWebviews[0] === "main"
    && identity.parentWebviews[1] === "renderer-settings-probe", "identity-parent-webviews");
  requireEvidence(errors, identity?.mainWindowLookup === "present", "identity-main-window-lookup");
  requireEvidence(errors, identity?.getWebviewWindowMain === "absent", "identity-webview-window-lookup-absent");
  requireEvidence(errors, identity?.mainWebviewRole === "present", "identity-primary-webview-role");
  requireEvidence(errors, identity?.mainWebviewParent === "main", "identity-primary-webview-parent");
  requireEvidence(errors, identity?.childWebviewRole === "present", "identity-child-webview-role");
  requireEvidence(errors, identity?.parentIsWebviewWindow?.value === false
    && identity.parentIsWebviewWindow.basis === "public-webview-window-lookup-absent", "identity-parent-window-wrapper");

  requireEvidence(errors, mainIpc?.getGeneralSettings === "allowed", "main-ipc-general-settings");
  requireEvidence(errors, mainIpc?.windowIsVisible === "allowed", "main-ipc-window-visibility");
  requireEvidence(errors, mainIpc?.resourceExists === "allowed", "main-ipc-resource-exists");
  requireEvidence(errors, journey?.expand?.issued === true
    && journey.expand.verified === true
    && journey.expand.childBoundsVerified === true
    && Number.isSafeInteger(journey.expand.innerHeightPhysical)
    && journey.expand.innerHeightPhysical > 0, "main-window-expand");
  requireEvidence(errors, hasUsableBounds(child?.boundsAfterExpandPhysical), "child-bounds-after-expand");
  requireEvidence(errors, journey?.reset?.verified === true
    && journey.reset.childBoundsVerified === true, "main-window-reset");
  requireEvidence(errors, hasUsableBounds(child?.boundsAfterResetPhysical), "child-bounds-after-reset");
  requireEvidence(errors, journey?.hide?.issued === true
    && journey.hide.verified === true
    && journey.hide.visible === false, "main-window-hide");
  requireEvidence(errors, journey?.restore?.visible === true && journey.restore.focused === true, "main-window-restore");
  requireEvidence(errors, journey?.domAlive === true, "main-dom-alive");

  requireEvidence(errors, child?.created === true, "child-created");
  requireEvidence(errors, child?.label === "renderer-settings-probe", "child-label");
  requireEvidence(errors, child?.parentLabel === "main", "child-parent-label");
  requireEvidence(errors, child?.incognitoPersistent === false, "child-incognito");
  requireEvidence(errors, hasUsableBounds(child?.boundsPhysical), "child-bounds-physical");
  requireEvidence(errors, focusJourney?.childWebviewFocused === true
    && focusJourney.mainWebviewFocused === true
    && focusJourney.windowVisible === true
    && focusJourney.windowFocused === true, "child-focus-journey");
  requireEvidence(errors, childIpc?.getGeneralSettings?.outcome === "denied"
    && childIpc.getGeneralSettings.code === "CHILD_WEBVIEW_APP_COMMAND_DENIED"
    && childIpc.getGeneralSettings.permissionDenied === true, "child-app-command-denied");
  requireEvidence(errors, childIpc?.windowIsVisible?.outcome === "denied"
    && childIpc.windowIsVisible.code === "REJECTED"
    && childIpc.windowIsVisible.permissionDenied === true, "child-core-command-denied");
  requireEvidence(errors, childIpc?.resourceExists?.outcome === "denied"
    && childIpc.resourceExists.code === "REJECTED"
    && childIpc.resourceExists.permissionDenied === true, "child-fs-command-denied");

  requireEvidence(errors, cleanup?.documentIdentityFreshOnReopen === true, "child-document-identity-fresh-on-reopen");
  requireEvidence(errors, cleanup?.initialCloseObservedAbsent === true, "initial-child-close");
  requireEvidence(errors, cleanup?.reopenCreated === true, "child-reopen");
  requireEvidence(errors, cleanup?.reopenedChildClosed === true, "reopened-child-close");
  requireEvidence(errors, cleanup?.finalChildAbsent === true, "final-child-absent");
  requireEvidence(errors, cleanup?.liveChildren === 0, "child-count-zero");
  requireEvidence(errors, cleanup?.liveLayoutRegistrations === 0, "layout-registration-count-zero");
  requireEvidence(errors, hasUsableBounds(cleanup?.reopenBoundsPhysical), "reopened-child-bounds-physical");

  return {
    mode,
    valid: errors.length === 0,
    enabled: snapshot.enabled === true,
    passed: snapshot.passed === true,
    errors,
  };
}

export function summarizeNativeReport(reportFile, markerFile, { mode, autoClear, fixtureRoot, childPid }) {
  const owner = markerFile.value;
  const ownerMatches = markerMatches(owner, fixtureRoot, childPid);
  const ownerEvidence = {
    exists: markerFile.exists,
    valid: ownerMatches,
    identifier: ownerMatches ? owner.identifier : null,
    markerPidMatchesChild: ownerMatches,
    rootMatchesFixture: ownerMatches,
  };
  if (!reportFile.exists || reportFile.value === null) {
    return {
      exists: reportFile.exists,
      valid: false,
      version: null,
      autoClear: null,
      passed: false,
      metadataMatchesOwner: false,
      modeEvidence: validateMultiwebviewMode(null, mode),
      exception: reportFile.exception,
      owner: ownerEvidence,
    };
  }

  const validation = validateNativeReport(reportFile.value, { autoClear, marker: owner, fixtureRoot, childPid });
  const modeEvidence = validateMultiwebviewMode(reportFile.value, mode);
  return {
    exists: true,
    ...validation,
    valid: validation.valid && modeEvidence.valid,
    modeEvidence,
    exception: null,
    owner: ownerEvidence,
  };
}
