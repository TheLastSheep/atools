import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeNativeReport,
  validateMultiwebviewMode,
} from "./lib/ztools-renderer-multiwebview-validation.mjs";

function validBounds() {
  return {
    x: 0,
    y: 64,
    width: 900,
    height: 600,
    parentWidth: 900,
    parentHeight: 664,
    scaleFactor: 1,
    fitsParent: true,
    widthFillsParent: true,
    topReservedLogical: 64,
    headerReservationVerified: true,
    contentHeightFillsParent: true,
    minimumHeightSatisfied: true,
  };
}

function validSnapshot() {
  return {
    schemaVersion: 1,
    enabled: true,
    passed: true,
    identity: {
      mainWindowLabel: "main",
      parentLabel: "main",
      parentWebviews: ["main", "renderer-settings-probe"],
      mainWindowLookup: "present",
      getWebviewWindowMain: "absent",
      mainWebviewRole: "present",
      mainWebviewParent: "main",
      childWebviewRole: "present",
      parentIsWebviewWindow: { value: false, basis: "public-webview-window-lookup-absent" },
    },
    main: {
      ipc: { getGeneralSettings: "allowed", windowIsVisible: "allowed", resourceExists: "allowed" },
      windowJourney: {
        expand: { issued: true, verified: true, childBoundsVerified: true, innerHeightPhysical: 720 },
        reset: { verified: true, childBoundsVerified: true },
        hide: { issued: true, verified: true, visible: false },
        restore: { visible: true, focused: true },
        domAlive: true,
      },
    },
    child: {
      label: "renderer-settings-probe",
      created: true,
      parentLabel: "main",
      incognitoPersistent: false,
      boundsPhysical: validBounds(),
      boundsAfterExpandPhysical: validBounds(),
      boundsAfterResetPhysical: validBounds(),
      focusJourney: {
        childWebviewFocused: true,
        mainWebviewFocused: true,
        windowVisible: true,
        windowFocused: true,
      },
      ipc: {
        getGeneralSettings: { outcome: "denied", code: "CHILD_WEBVIEW_APP_COMMAND_DENIED", permissionDenied: true },
        windowIsVisible: { outcome: "denied", code: "REJECTED", permissionDenied: true },
        resourceExists: { outcome: "denied", code: "REJECTED", permissionDenied: true },
      },
    },
    cleanup: {
      documentIdentityFreshOnReopen: true,
      initialCloseObservedAbsent: true,
      reopenCreated: true,
      reopenedChildClosed: true,
      finalChildAbsent: true,
      liveChildren: 0,
      liveLayoutRegistrations: 0,
      reopenBoundsPhysical: validBounds(),
    },
    errors: [],
  };
}

test("single mode requires an explicit null child-proof field", () => {
  assert.equal(validateMultiwebviewMode({ multiwebview: null }, "single").valid, true);
  assert.equal(validateMultiwebviewMode({}, "single").valid, false);
  assert.equal(validateMultiwebviewMode({ multiwebview: validSnapshot() }, "single").valid, false);
  assert.equal(validateMultiwebviewMode({}, "unknown").errors[0], "unsupported-mode");
});

test("multiwebview mode requires the complete passing native evidence", () => {
  const result = validateMultiwebviewMode({ multiwebview: validSnapshot() }, "multiwebview");
  assert.deepEqual(result, { mode: "multiwebview", valid: true, enabled: true, passed: true, errors: [] });
});

test("raw bounds must fit at initial, expand, reset, and reopen checkpoints", () => {
  const boundsAt = [
    ["initial", snapshot => snapshot.child.boundsPhysical],
    ["expand", snapshot => snapshot.child.boundsAfterExpandPhysical],
    ["reset", snapshot => snapshot.child.boundsAfterResetPhysical],
    ["reopen", snapshot => snapshot.cleanup.reopenBoundsPhysical],
  ];
  for (const [checkpoint, selectBounds] of boundsAt) {
    const snapshot = validSnapshot();
    const bounds = selectBounds(snapshot);
    bounds.parentHeight = 1000;
    bounds.height = 120;
    assert.equal(validateMultiwebviewMode({ multiwebview: snapshot }, "multiwebview").valid, false,
      `${checkpoint}: short content must fail even when booleans claim success`);
  }
});

test("multiwebview validation rejects missing ACL, role, lifecycle, or native evidence", () => {
  const invalid = [
    ["snapshot not enabled", snapshot => { snapshot.enabled = false; }],
    ["parent webview set changed", snapshot => { snapshot.identity.parentWebviews = ["main"]; }],
    ["primary role mismatch", snapshot => { snapshot.identity.mainWebviewParent = "other"; }],
    ["main IPC failed", snapshot => { snapshot.main.ipc.resourceExists = "denied"; }],
    ["expand child bounds proof missing", snapshot => { delete snapshot.main.windowJourney.expand.childBoundsVerified; }],
    ["expand child bounds proof false", snapshot => { snapshot.main.windowJourney.expand.childBoundsVerified = false; }],
    ["bounds after expand missing", snapshot => { delete snapshot.child.boundsAfterExpandPhysical; }],
    ["bounds after expand invalid", snapshot => { snapshot.child.boundsAfterExpandPhysical.headerReservationVerified = false; }],
    ["reset child bounds proof missing", snapshot => { delete snapshot.main.windowJourney.reset.childBoundsVerified; }],
    ["reset child bounds proof false", snapshot => { snapshot.main.windowJourney.reset.childBoundsVerified = false; }],
    ["bounds after reset missing", snapshot => { delete snapshot.child.boundsAfterResetPhysical; }],
    ["bounds after reset invalid", snapshot => { snapshot.child.boundsAfterResetPhysical.topReservedLogical = 72; }],
    ["child app IPC allowed", snapshot => { snapshot.child.ipc.getGeneralSettings.outcome = "allowed"; }],
    ["child app IPC not classified as denied", snapshot => { snapshot.child.ipc.getGeneralSettings.permissionDenied = false; }],
    ["child core IPC allowed", snapshot => { snapshot.child.ipc.windowIsVisible.code = "SUCCESS"; }],
    ["child core IPC not classified as denied", snapshot => { snapshot.child.ipc.windowIsVisible.permissionDenied = false; }],
    ["child core IPC missing permission classification", snapshot => { delete snapshot.child.ipc.windowIsVisible.permissionDenied; }],
    ["child filesystem IPC allowed", snapshot => { snapshot.child.ipc.resourceExists.outcome = "allowed"; }],
    ["child filesystem IPC not classified as denied", snapshot => { snapshot.child.ipc.resourceExists.permissionDenied = false; }],
    ["child filesystem IPC missing permission classification", snapshot => { delete snapshot.child.ipc.resourceExists.permissionDenied; }],
    ["persistent child store", snapshot => { snapshot.child.incognitoPersistent = true; }],
    ["child bounds missing", snapshot => { delete snapshot.child.boundsPhysical; }],
    ["child bounds too small", snapshot => { snapshot.child.boundsPhysical.width = 1; }],
    ["child bounds do not fill parent", snapshot => { snapshot.child.boundsPhysical.width = 850; }],
    ["fit allowance stays at two physical pixels at scale two", snapshot => {
      Object.assign(snapshot.child.boundsPhysical, {
        x: 4, y: 128, width: 900, height: 600, parentWidth: 900, parentHeight: 728, scaleFactor: 2,
        topReservedLogical: 64,
      });
    }],
    ["child height too small", snapshot => { snapshot.child.boundsPhysical.height = 1; }],
    ["child position negative", snapshot => { snapshot.child.boundsPhysical.x = -1; }],
    ["child exceeds physical parent", snapshot => { snapshot.child.boundsPhysical.x = 50; }],
    ["child bounds do not fit parent", snapshot => { snapshot.child.boundsPhysical.fitsParent = false; }],
    ["child top reservation mismatched", snapshot => { snapshot.child.boundsPhysical.topReservedLogical = 80; }],
    ["child bottom edge differs from parent", snapshot => { snapshot.child.boundsPhysical.height = 500; }],
    ["child parent width missing", snapshot => { delete snapshot.child.boundsPhysical.parentWidth; }],
    ["child parent height invalid", snapshot => { snapshot.child.boundsPhysical.parentHeight = 0; }],
    ["parent logical height at 65 is rejected", snapshot => {
      Object.assign(snapshot.child.boundsPhysical, { y: 640, height: 10, parentHeight: 650, scaleFactor: 10 });
    }],
    ["child scale factor invalid", snapshot => { snapshot.child.boundsPhysical.scaleFactor = 0; }],
    ["child content-height report false", snapshot => { snapshot.child.boundsPhysical.contentHeightFillsParent = false; }],
    ["reopened child bounds missing", snapshot => { delete snapshot.cleanup.reopenBoundsPhysical; }],
    ["reopened child bounds not verified", snapshot => { snapshot.cleanup.reopenBoundsPhysical.minimumHeightSatisfied = false; }],
    ["layout registration count missing", snapshot => { delete snapshot.cleanup.liveLayoutRegistrations; }],
    ["layout registration count null", snapshot => { snapshot.cleanup.liveLayoutRegistrations = null; }],
    ["layout registration remains live", snapshot => { snapshot.cleanup.liveLayoutRegistrations = 1; }],
    ["child focus journey missing", snapshot => { delete snapshot.child.focusJourney; }],
    ["child webview focus missing", snapshot => { snapshot.child.focusJourney.childWebviewFocused = false; }],
    ["main webview focus missing after child", snapshot => { snapshot.child.focusJourney.mainWebviewFocused = false; }],
    ["window hidden during focus journey", snapshot => { snapshot.child.focusJourney.windowVisible = false; }],
    ["window focus missing after child", snapshot => { snapshot.child.focusJourney.windowFocused = false; }],
    ["child remains after cleanup", snapshot => { snapshot.cleanup.liveChildren = 1; }],
    ["native report has errors", snapshot => { snapshot.errors = ["probe failed"]; }],
    ["native journey failed", snapshot => { snapshot.main.windowJourney.restore.focused = false; }],
  ];

  for (const [name, mutate] of invalid) {
    const snapshot = validSnapshot();
    mutate(snapshot);
    assert.equal(validateMultiwebviewMode({ multiwebview: snapshot }, "multiwebview").valid, false, name);
  }
});

test("native report summary combines owner, pass, and selected-mode proof", () => {
  const fixtureRoot = "/private/tmp/atools-renderer-native-unit";
  const marker = {
    schemaVersion: 1,
    pid: 77721,
    identifier: "dev.atools.renderer-smoke.0123456789abcdef0123456789abcdef",
    root: fixtureRoot,
  };
  const summary = summarizeNativeReport(
    { exists: true, value: {
      version: 1,
      autoClear: "never",
      passed: true,
      identifier: marker.identifier,
      metadata: { profileRoot: fixtureRoot },
      multiwebview: validSnapshot(),
    }, exception: null },
    { exists: true, value: marker, exception: null },
    { mode: "multiwebview", autoClear: "never", marker, fixtureRoot, childPid: 77721 },
  );
  assert.equal(summary.valid, true);
  assert.equal(summary.modeEvidence.valid, true);

  const singleSummary = summarizeNativeReport(
    { exists: true, value: { version: 1, autoClear: "never", passed: true, multiwebview: validSnapshot() }, exception: null },
    { exists: true, value: marker, exception: null },
    { mode: "single", autoClear: "never", marker, fixtureRoot, childPid: 77721 },
  );
  assert.equal(singleSummary.valid, false);
  assert.equal(singleSummary.modeEvidence.errors[0], "single-mode-requires-null-child-proof");
});
