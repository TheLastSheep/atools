import assert from "node:assert/strict";
import test from "node:test";
import {
  validateBuiltinStateNativeReports,
  validateBuiltinStateSeedReport,
} from "./ztools-builtin-state-native-report.mjs";

const runId = "1234567890ab4cde8fab1234567890ab";
const identifier = `dev.atools.renderer-settings-input.${runId}`;
const root = `/private/tmp/atools-renderer-settings-input-${runId}`;
const expectedOwner = { runId, identifier, root };
const createdAtFingerprint = "a".repeat(64);
const seedPid = 41001;
const mainPid = 41002;

function seedReport() {
  return {
    schemaVersion: 2,
    journey: "builtin-state-seed",
    scope: "settings-input-timestamp-disabled-seed",
    identifier,
    root,
    pid: seedPid,
    runId,
    observations: {
      stagedPackageValid: true,
      metadataRegistered: true,
      pluginIdResolved: true,
      disableCommitted: true,
      enabledAfterDisable: false,
      documentWritten: true,
      attachmentWritten: true,
      databaseDevice: "16777234",
      databaseInode: "9223372036854775807",
      createdAtFingerprint,
      traySettingStored: true,
      trayConfiguredVisible: false,
    },
    errors: [],
  };
}

function mainReport() {
  return {
    schemaVersion: 2,
    journey: "builtin-state",
    scope: "settings-input-original-vue-cold-start",
    identifier,
    root,
    pid: mainPid,
    runId,
    seedPid,
    observations: {
      resumeClaimed: true,
      pendingWaiterObserved: true,
      pendingListReadCount: 1,
      pendingNativeCalls: 2,
      storeReadyBeforeRelease: false,
      metadataRegistered: true,
      enabledAfterMetadataRefresh: false,
      documentPreserved: true,
      attachmentPreserved: true,
      startupStoreReady: true,
      startupTimestampMatchCount: 0,
      startupTargetAppCount: 1,
      startupEventDeliveredBefore: 0,
      startupEventDeliveredAfter: 1,
      startupListReadBefore: 1,
      startupListReadAfter: 2,
      restoreCommitted: true,
      enabledAfterRestore: true,
      finalTimestampMatchCount: 1,
      finalTargetAppCount: 1,
      restoreEventDeliveredBefore: 1,
      restoreEventDeliveredAfter: 2,
      restoreListReadBefore: 2,
      restoreListReadAfter: 3,
      pluginUiOpened: false,
      preloadStarted: false,
      databaseDevice: "16777234",
      databaseInode: "9223372036854775807",
      createdAtFingerprint,
      trayConfiguredVisible: false,
      trayNativeVisible: false,
    },
    errors: [],
  };
}

function process(pid) {
  return {
    spawned: true,
    pid,
    terminalObserved: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

function validatePair(overrides = {}) {
  return validateBuiltinStateNativeReports({
    seedReport: seedReport(),
    mainReport: mainReport(),
    seedProcess: process(seedPid),
    mainProcess: process(mainPid),
    expectedOwner,
    ...overrides,
  });
}

test("accepts a real terminal seed followed by a cold Main restart and restore", () => {
  const result = validatePair();
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.errors, []);
});

test("accepts startup list-read race of one or two reads while requiring startup event delivery", () => {
  const oneRead = mainReport();
  oneRead.observations.startupListReadAfter = 1;
  oneRead.observations.restoreListReadBefore = 1;
  oneRead.observations.restoreListReadAfter = 2;
  const result = validatePair({ mainReport: oneRead });
  assert.equal(result.passed, true);
});

test("keeps the target app present while the timestamp plugin is disabled", () => {
  const report = mainReport();
  report.observations.startupTargetAppCount = 0;
  assert.equal(validatePair({ mainReport: report }).passed, false);

  const restored = mainReport();
  restored.observations.finalTargetAppCount = 0;
  assert.equal(validatePair({ mainReport: restored }).passed, false);
});

test("requires metadata refresh to preserve the seed disabled state", () => {
  const report = mainReport();
  report.observations.enabledAfterMetadataRefresh = true;
  assert.equal(validatePair({ mainReport: report }).passed, false);
});

test("cold startup preserves the Core seeded hidden tray configuration and native state", () => {
  const seed = seedReport();
  const main = mainReport();
  assert.equal(validatePair().passed, true);
  seed.observations.traySettingStored = false;
  assert.equal(validatePair({ seedReport: seed }).passed, false);
  main.observations.trayConfiguredVisible = true;
  assert.equal(validatePair({ mainReport: main }).passed, false);
  main.observations.trayConfiguredVisible = false;
  main.observations.trayNativeVisible = true;
  assert.equal(validatePair({ mainReport: main }).passed, false);
  main.observations.trayNativeVisible = null;
  const unknown = validatePair({ mainReport: main });
  assert.equal(unknown.valid, true);
  assert.equal(unknown.passed, false);
});

test("rejects same-process runs and a Main report bound to another seed PID", () => {
  const samePid = process(seedPid);
  assert.equal(validatePair({ mainProcess: samePid }).passed, false);

  const wrongSeed = mainReport();
  wrongSeed.seedPid += 1;
  assert.equal(validatePair({ mainReport: wrongSeed }).passed, false);
});

test("requires same database file and preserved created_at fingerprint across processes", () => {
  const differentDatabase = mainReport();
  differentDatabase.observations.databaseInode = "9223372036854775806";
  assert.equal(validatePair({ mainReport: differentDatabase }).passed, false);

  const changedCreatedAt = mainReport();
  changedCreatedAt.observations.createdAtFingerprint = "b".repeat(64);
  assert.equal(validatePair({ mainReport: changedCreatedAt }).passed, false);

  const malformedDevice = mainReport();
  malformedDevice.observations.databaseDevice = "016777234";
  assert.equal(validatePair({ mainReport: malformedDevice }).valid, false);
});

test("requires startup and restore event/list counters to show the expected transitions", () => {
  const missedStartupEvent = mainReport();
  missedStartupEvent.observations.startupEventDeliveredAfter = 0;
  assert.equal(validatePair({ mainReport: missedStartupEvent }).passed, false);

  const missedRestoreRead = mainReport();
  missedRestoreRead.observations.restoreListReadAfter = 2;
  assert.equal(validatePair({ mainReport: missedRestoreRead }).passed, false);
});

test("null observations remain valid diagnostics but cannot pass the journey", () => {
  const report = mainReport();
  for (const key of Object.keys(report.observations)) report.observations[key] = null;
  assert.equal(validatePair({ mainReport: report }).valid, true);
  assert.equal(validatePair({ mainReport: report }).passed, false);
});

test("null counter observations cannot be treated as zero during event delta checks", () => {
  const report = mainReport();
  report.observations.startupEventDeliveredBefore = null;
  assert.equal(validatePair({ mainReport: report }).valid, true);
  assert.equal(validatePair({ mainReport: report }).passed, false);
});

test("rejects extra schema keys, unknown errors, and duplicate native errors", () => {
  const extraKey = mainReport();
  extraKey.observations.unreviewedFact = true;
  assert.equal(validatePair({ mainReport: extraKey }).valid, false);

  const unknownError = mainReport();
  unknownError.errors = ["builtin-state-unrecognized-error"];
  assert.equal(validatePair({ mainReport: unknownError }).valid, false);

  const duplicateError = mainReport();
  duplicateError.errors = ["builtin-state-runtime-started", "builtin-state-runtime-started"];
  assert.equal(validatePair({ mainReport: duplicateError }).valid, false);

  const knownNativeError = mainReport();
  knownNativeError.errors = ["builtin-state-database-identity-invalid"];
  assert.equal(validatePair({ mainReport: knownNativeError }).valid, true);
  assert.equal(validatePair({ mainReport: knownNativeError }).passed, false);
});

test("rejects reports owned by another run", () => {
  const report = mainReport();
  report.root = "/private/tmp/atools-renderer-settings-input-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(validatePair({ mainReport: report }).valid, false);
});

test("validates seed facts before allowing a Main invocation", () => {
  const seed = seedReport();
  assert.equal(validateBuiltinStateSeedReport(seed, process(seedPid), expectedOwner).passed, true);

  seed.observations.enabledAfterDisable = true;
  assert.equal(validateBuiltinStateSeedReport(seed, process(seedPid), expectedOwner).passed, false);
});

test("a failed or nonterminal seed is not eligible for resume", () => {
  const nonterminal = process(seedPid);
  nonterminal.terminalObserved = false;
  assert.equal(validateBuiltinStateSeedReport(seedReport(), nonterminal, expectedOwner).passed, false);

  const failed = process(seedPid);
  failed.exitCode = 1;
  assert.equal(validateBuiltinStateSeedReport(seedReport(), failed, expectedOwner).passed, false);
});
