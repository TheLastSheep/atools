import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERAL_POLICIES_ERRORS,
  GENERAL_POLICIES_REPORT_FILENAME,
  validateGeneralPoliciesReport,
  readGeneralPoliciesReport,
} from "./ztools-general-policies-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};

function positionSample() {
  return {
    cursor: { x: 500, y: 400 },
    monitor: {
      x: 0, y: 0, width: 1440, height: 900,
      workX: 0, workY: 24, workWidth: 1440, workHeight: 876,
      scaleFactor: 1, isPrimary: true,
    },
    window: { x: 320, y: 162, width: 800, height: 600 },
  };
}

function rememberedPosition() {
  return {
    monitor: {
      x: 0, y: 0, width: 1440, height: 900,
      workX: 0, workY: 24, workWidth: 1440, workHeight: 876,
      scaleFactor: 1, isPrimary: true,
    },
    windowSize: { width: 800, height: 600 },
    saved: { x: 120, y: 80 },
    moved: { x: 420, y: 220 },
    restored: { x: 120, y: 80 },
  };
}

function clipboardSnapshot(values = {}) {
  return {
    pasteboardCount: 3,
    legacyCount: 2,
    expiredUnpinnedPresent: true,
    recentUnpinnedPresent: true,
    expiredPinnedPresent: true,
    legacyExpiredPresent: true,
    legacyRecentPresent: true,
    reset100DayPresent: false,
    legacyReset100DayPresent: false,
    ...values,
  };
}

function report() {
  const phases = Object.fromEntries([
    "baseline", "afterCursor", "afterPrimary", "afterLastActive", "afterRememberSave",
    "afterRememberMove", "afterRememberRestore", "after30Save", "after30Capture",
    "after1Save", "after1Capture", "afterReset180", "afterResetCapture", "afterFreshReopen",
    "afterRestore", "afterClose",
  ].map(key => [key, { visible: false, focused: false }]));
  return {
    schemaVersion: 1,
    journey: "settings-general-policies",
    scope: "hidden-original-General-position-and-retention",
    ...owner,
    observations: {
      windowUi: {
        initialUiStrategy: "remember",
        initialStoredStrategy: null,
        cursor: { uiSelected: true, storedStrategy: "cursor" },
        primary: { uiSelected: true, storedStrategy: "primary" },
        lastActive: { uiSelected: true, storedStrategy: "lastActive" },
        remember: { uiSelected: true, storedStrategy: "remember" },
        reopened: { freshSession: true, uiStrategy: "remember", storedStrategy: "remember" },
        restored: { uiStrategy: "remember", storedStrategy: "remember" },
        unrelatedSettingsPreserved: true,
      },
      geometry: {
        cursor: positionSample(),
        primary: positionSample(),
        lastActiveFallback: { externalWindowAvailable: false, position: positionSample() },
        remember: rememberedPosition(),
      },
      clipboard: {
        initialUiDays: 180,
        initialStoredDays: null,
        at30: {
          uiDays: 30, storedDays: 30, resetDispatched: false, captureSucceeded: true,
          beforeCapture: clipboardSnapshot(),
          afterCapture: clipboardSnapshot({ pasteboardCount: 3, legacyCount: 2, expiredUnpinnedPresent: false, legacyExpiredPresent: false }),
        },
        at1: {
          uiDays: 1, storedDays: 1, resetDispatched: false, captureSucceeded: true,
          beforeCapture: clipboardSnapshot({ pasteboardCount: 3, legacyCount: 2, expiredUnpinnedPresent: false, legacyExpiredPresent: false }),
          afterCapture: clipboardSnapshot({
            pasteboardCount: 3, legacyCount: 2, expiredUnpinnedPresent: false,
            recentUnpinnedPresent: false, legacyExpiredPresent: false, legacyRecentPresent: false,
          }),
        },
        afterReset180: {
          uiDays: 180, storedDays: 180, resetDispatched: true, captureSucceeded: true,
          beforeReset: clipboardSnapshot({
            pasteboardCount: 3, legacyCount: 2, expiredUnpinnedPresent: false,
            recentUnpinnedPresent: false, legacyExpiredPresent: false, legacyRecentPresent: false,
          }),
          afterReset: clipboardSnapshot({
            pasteboardCount: 3, legacyCount: 2, expiredUnpinnedPresent: false,
            recentUnpinnedPresent: false, legacyExpiredPresent: false, legacyRecentPresent: false,
          }),
          beforeCapture: clipboardSnapshot({
            pasteboardCount: 4, legacyCount: 3, expiredUnpinnedPresent: false,
            recentUnpinnedPresent: false, legacyExpiredPresent: false, legacyRecentPresent: false,
            reset100DayPresent: true, legacyReset100DayPresent: true,
          }),
          afterCapture: clipboardSnapshot({
            pasteboardCount: 5, legacyCount: 4, expiredUnpinnedPresent: false,
            recentUnpinnedPresent: false, legacyExpiredPresent: false, legacyRecentPresent: false,
            reset100DayPresent: true, legacyReset100DayPresent: true,
          }),
        },
        finalUiDays: 180,
        finalStoredDays: 180,
      },
      windowSafety: {
        phases,
        focusEventsBefore: 0,
        focusEventsAfter: 0,
      },
      pluginUiOpened: false,
      preloadStarted: false,
      childClosed: true,
    },
    errors: [],
  };
}

test("derives hidden window geometry, UI persistence, and capture-time retention from raw facts", () => {
  const result = validateGeneralPoliciesReport(report(), owner);
  assert.equal(GENERAL_POLICIES_REPORT_FILENAME, "native-general-policies-report.json");
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
});

test("geometry uses the fixed 800 by 600 logical anchor and clamps the actual extent", () => {
  const value = report();
  const monitor = {
    x: 0, y: 0, width: 2880, height: 1800,
    workX: 0, workY: 48, workWidth: 2880, workHeight: 1752,
    scaleFactor: 2, isPrimary: true,
  };
  const sample = () => ({ cursor: { x: 500, y: 400 }, monitor: { ...monitor }, window: { x: 640, y: 724, width: 1000, height: 400 } });
  value.observations.geometry.cursor = sample();
  value.observations.geometry.primary = sample();
  value.observations.geometry.lastActiveFallback.position = sample();
  value.observations.geometry.remember.monitor = { ...monitor };
  value.observations.geometry.remember.windowSize = { width: 1000, height: 400 };
  value.observations.geometry.remember.saved = { x: 100, y: 100 };
  value.observations.geometry.remember.moved = { x: 1700, y: 1200 };
  value.observations.geometry.remember.restored = { x: 100, y: 100 };
  assert.equal(validateGeneralPoliciesReport(value, owner).passed, false, "actual-height centering must not pass");
  for (const key of ["cursor", "primary"]) {
    value.observations.geometry[key].window = { x: 640, y: 324, width: 1000, height: 400 };
  }
  value.observations.geometry.lastActiveFallback.position.window = { x: 640, y: 324, width: 1000, height: 400 };
  assert.equal(validateGeneralPoliciesReport(value, owner).passed, true);
});

test("DPI geometry centers in logical space before rounding physical offsets", () => {
  const monitor = {
    x: 0, y: 0, width: 3024, height: 2016,
    workX: 0, workY: 66, workWidth: 3024, workHeight: 1898,
    scaleFactor: 2, isPrimary: true,
  };
  const install = (value, height, position, saved, moved, restored) => {
    const sample = {
      cursor: { x: 100, y: 100 }, monitor: { ...monitor },
      window: { x: position.x, y: position.y, width: 1200, height },
    };
    value.observations.geometry.cursor = structuredClone(sample);
    value.observations.geometry.primary = structuredClone(sample);
    value.observations.geometry.lastActiveFallback = {
      externalWindowAvailable: false, position: structuredClone(sample),
    };
    value.observations.geometry.remember = {
      monitor: { ...monitor }, windowSize: { width: 1200, height }, saved, moved, restored,
    };
    return value;
  };
  const centered = install(report(), 1300, { x: 712, y: 414 },
    { x: 800, y: 500 }, { x: 864, y: 564 }, { x: 800, y: 500 });
  assert.equal(validateGeneralPoliciesReport(centered, owner).passed, true);
  for (const oldY of [415, 416]) {
    const wrong = structuredClone(centered);
    wrong.observations.geometry.cursor.window.y = oldY;
    assert.equal(validateGeneralPoliciesReport(wrong, owner).passed, false, `y=${oldY} must be rejected`);
  }

  const negativeMonitor = {
    ...monitor, x: -1920, y: -1080, workX: -1920, workY: -1014,
  };
  const negative = structuredClone(centered);
  const negativeSample = {
    cursor: { x: -1000, y: -500 }, monitor: negativeMonitor,
    window: { x: -1208, y: -666, width: 1200, height: 1300 },
  };
  negative.observations.geometry.cursor = structuredClone(negativeSample);
  negative.observations.geometry.primary = structuredClone(negativeSample);
  negative.observations.geometry.lastActiveFallback = {
    externalWindowAvailable: false, position: structuredClone(negativeSample),
  };
  negative.observations.geometry.remember = {
    monitor: negativeMonitor, windowSize: { width: 1200, height: 1300 },
    saved: { x: -1100, y: -700 }, moved: { x: -1040, y: -640 }, restored: { x: -1100, y: -700 },
  };
  assert.equal(validateGeneralPoliciesReport(negative, owner).passed, true);

  const compact = install(report(), 1800, { x: 712, y: 164 },
    { x: 800, y: 100 }, { x: 864, y: 164 }, { x: 800, y: 100 });
  assert.equal(validateGeneralPoliciesReport(compact, owner).passed, true, "actual extent is clamped after logical centering");
});

test("primary centering is independent of cursor display; fallback records unavailable external context", () => {
  const value = report();
  const secondary = {
    x: 1440, y: 0, width: 1440, height: 900,
    workX: 1440, workY: 24, workWidth: 1440, workHeight: 876,
    scaleFactor: 1, isPrimary: false,
  };
  value.observations.geometry.cursor = {
    cursor: { x: 1600, y: 400 }, monitor: secondary,
    window: { x: 1760, y: 162, width: 800, height: 600 },
  };
  value.observations.geometry.lastActiveFallback = {
    externalWindowAvailable: false,
    position: structuredClone(value.observations.geometry.cursor),
  };
  value.observations.geometry.remember.monitor = structuredClone(secondary);
  value.observations.geometry.remember.saved = { x: 1560, y: 80 };
  value.observations.geometry.remember.moved = { x: 1900, y: 220 };
  value.observations.geometry.remember.restored = { x: 1560, y: 80 };
  value.observations.geometry.primary.cursor = { x: 1600, y: 400 };
  assert.equal(validateGeneralPoliciesReport(value, owner).passed, true, "primary policy uses its primary monitor even when cursor is on another display");
  value.observations.geometry.lastActiveFallback.externalWindowAvailable = null;
  assert.equal(validateGeneralPoliciesReport(value, owner).passed, false, "fallback must record unavailable external context");
});

test("missing initial settings remain null while effective defaults are checked", () => {
  const value = report();
  value.observations.windowUi.initialStoredStrategy = null;
  value.observations.clipboard.initialStoredDays = null;
  value.observations.windowUi.initialUiStrategy = "cursor";
  assert.equal(validateGeneralPoliciesReport(value, owner).passed, false);
  value.observations.windowUi.initialUiStrategy = "remember";
  value.observations.clipboard.initialUiDays = 30;
  assert.equal(validateGeneralPoliciesReport(value, owner).passed, false);
});

test("unknown UI retention remains shape-valid but cannot pass, and days stay within the persisted range", () => {
  const unknownUi = report();
  unknownUi.observations.clipboard.at30.uiDays = null;
  const unknownResult = validateGeneralPoliciesReport(unknownUi, owner);
  assert.equal(unknownResult.valid, true);
  assert.equal(unknownResult.passed, false);

  const outOfRange = report();
  outOfRange.observations.clipboard.initialUiDays = 3660;
  outOfRange.observations.clipboard.finalUiDays = 3660;
  const rangeResult = validateGeneralPoliciesReport(outOfRange, owner);
  assert.equal(rangeResult.valid, false);
  assert.equal(rangeResult.passed, false);
});

test("requires delayed pruning, pinned retention, legacy projection pruning, and reset persistence", () => {
  for (const mutate of [
    value => { value.observations.clipboard.at30.beforeCapture.expiredUnpinnedPresent = false; },
    value => { value.observations.clipboard.at30.afterCapture.expiredPinnedPresent = false; },
    value => { value.observations.clipboard.at30.afterCapture.legacyExpiredPresent = true; },
    value => { value.observations.clipboard.at30.afterCapture.legacyCount = 3; },
    value => { value.observations.clipboard.at1.afterCapture.recentUnpinnedPresent = true; },
    value => { value.observations.clipboard.at1.afterCapture.legacyRecentPresent = true; },
    value => { value.observations.clipboard.afterReset180.afterCapture.legacyReset100DayPresent = false; },
    value => { value.observations.clipboard.afterReset180.resetDispatched = false; },
    value => { value.observations.clipboard.afterReset180.afterReset.legacyCount = 0; },
    value => { value.observations.clipboard.afterReset180.afterReset.pasteboardCount = 0; },
  ]) {
    const value = report();
    mutate(value);
    assert.equal(validateGeneralPoliciesReport(value, owner).passed, false);
  }
});

test("rejects forged owners, shape changes, unknown errors, and null facts as success", () => {
  const valid = report();
  assert.equal(validateGeneralPoliciesReport({ ...valid, passed: true }, owner).valid, false);
  const wrongOwner = report();
  wrongOwner.identifier = "dev.atools.renderer-settings-input.other";
  assert.equal(validateGeneralPoliciesReport(wrongOwner, owner).passed, false);
  const wrongPid = report();
  wrongPid.pid += 1;
  assert.equal(validateGeneralPoliciesReport(wrongPid, owner).passed, false);
  const extra = report();
  extra.observations.geometry.extra = true;
  assert.equal(validateGeneralPoliciesReport(extra, owner).valid, false);
  const missing = report();
  delete missing.observations.windowUi.cursor;
  assert.equal(validateGeneralPoliciesReport(missing, owner).valid, false);
  const unknownError = report();
  unknownError.errors = ["settings-input-general-policies-invented"];
  assert.equal(validateGeneralPoliciesReport(unknownError, owner).valid, false);
  const nativeError = report();
  nativeError.errors = [GENERAL_POLICIES_ERRORS[0]];
  assert.equal(validateGeneralPoliciesReport(nativeError, owner).passed, false);
  const unknown = report();
  unknown.observations.geometry.primary.monitor.scaleFactor = null;
  assert.equal(validateGeneralPoliciesReport(unknown, owner).valid, true);
  assert.equal(validateGeneralPoliciesReport(unknown, owner).passed, false);
});

test("requires remembered location restoration and hidden, unfocused checkpoints", () => {
  const wrongRemember = report();
  wrongRemember.observations.geometry.remember.restored.y += 1;
  assert.equal(validateGeneralPoliciesReport(wrongRemember, owner).passed, false);
  const defaultCenterRemember = report();
  defaultCenterRemember.observations.geometry.remember.saved = { x: 320, y: 162 };
  defaultCenterRemember.observations.geometry.remember.restored = { x: 320, y: 162 };
  assert.equal(validateGeneralPoliciesReport(defaultCenterRemember, owner).passed, false, "remember must restore a non-default saved position");
  const visible = report();
  visible.observations.windowSafety.phases.after1Capture.visible = true;
  assert.equal(validateGeneralPoliciesReport(visible, owner).passed, false);
  const focused = report();
  focused.observations.windowSafety.phases.afterRestore.focused = true;
  assert.equal(validateGeneralPoliciesReport(focused, owner).passed, false);
  const focusChanged = report();
  focusChanged.observations.windowSafety.focusEventsAfter = 1;
  assert.equal(validateGeneralPoliciesReport(focusChanged, owner).passed, false);
});

test("missing, malformed, oversized, unowned, and unsuccessful sidecars fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-general-policies-"));
  try {
    const path = join(directory, GENERAL_POLICIES_REPORT_FILENAME);
    assert.equal((await readGeneralPoliciesReport(path, owner, true, true)).passed, false);
    await writeFile(path, "{", { mode: 0o600 });
    assert.equal((await readGeneralPoliciesReport(path, owner, true, true)).passed, false);
    await writeFile(path, JSON.stringify(report()), { mode: 0o600 });
    assert.equal((await readGeneralPoliciesReport(path, owner, false, true)).passed, false);
    assert.equal((await readGeneralPoliciesReport(path, owner, true, false)).passed, false);
    await writeFile(path, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
    assert.equal((await readGeneralPoliciesReport(path, owner, true, true)).passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
