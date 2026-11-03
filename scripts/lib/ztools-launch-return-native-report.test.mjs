import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchReturnNativeArgs, launchReturnProbeReportsAgree, launchReturnRootCleanupAllowed } from "./ztools-launch-return-native-case.mjs";
import { parseLaunchReturnNativeArgs } from "../test-ztools-launch-return-native.mjs";
import { validateLaunchReturnNativeReport } from "./ztools-launch-return-native-report.mjs";
import { makeLaunchReturnSettingsRegistrationFixture } from "./ztools-launch-return-settings-fixtures.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const root = "/private/tmp/atools-renderer-launch-return-fixture";
const pid = 99123;
const identifier = `dev.atools.renderer-smoke.${runId}`;
const stageNames = ["baseline", "pasted", "denied", "direct-return", "typed", "keyboard-return", "disposed"];
const first = "AToolsOwnedProbeFirst";
const second = "AToolsOwnedProbeSecond";
const expected = [
  { input: "", pasted: "", selected: "", launches: 0, events: 0, locks: 0, locked: false, runs: [0, 0, 0], audits: [0, 0], history: [0, 0, 0], probes: [0, 0, 0, 0] },
  { input: "", pasted: first, selected: "", launches: 0, events: 0, locks: 1, locked: true, runs: [0, 0, 0], audits: [0, 0], history: [0, 0, 0], probes: [0, 0, 0, 0] },
  { input: "", pasted: first, selected: "", launches: 1, events: 0, locks: 1, locked: true, runs: [1, 1, 0], audits: [1, 0], history: [0, 0, 0], probes: [0, 0, 0, 0] },
  { input: "", pasted: "", selected: "", launches: 2, events: 1, locks: 1, locked: false, runs: [2, 1, 1], audits: [1, 1], history: [1, 1, 0], probes: [1, 1, 0, 0] },
  { input: "AToolsOwnedProbe", pasted: "", selected: second, launches: 2, events: 1, locks: 2, locked: true, runs: [2, 1, 1], audits: [1, 1], history: [1, 1, 0], probes: [1, 1, 0, 0] },
  { input: "", pasted: "", selected: "", launches: 3, events: 2, locks: 2, locked: false, runs: [3, 1, 2], audits: [1, 2], history: [2, 1, 1], probes: [2, 2, 0, 0] },
  { input: "", pasted: "", selected: "", launches: 3, events: 2, locks: 2, locked: false, runs: [3, 1, 2], audits: [1, 2], history: [2, 1, 1], probes: [2, 2, 0, 0] },
];

function eventSource(listenerState, deliveredEvents = 0) {
  return {
    subscribers: listenerState === "disposed" ? 0 : 1,
    listenerState,
    deliveredEvents,
    registrationErrors: 0,
    callbackErrors: 0,
    registrationsPending: 0,
    lateListenerUnlistens: 0,
    cleanupPending: 0,
    cleanupErrors: 0,
  };
}

function listeners(stageIndex, targetKind = "app", schemaVersion = 2) {
  const disposed = stageIndex === 6;
  const state = disposed ? "disposed" : "listening";
  const launched = expected[stageIndex].events;
  const source = () => eventSource(state);
  return {
    focusEvents: { ...eventSource(state), windowContextAvailable: false },
    appState: {
      version: 1, revision: launched === 0 ? null : launched,
      historySubscribers: disposed ? 0 : 1, pinnedSubscribers: disposed ? 0 : 1,
      listenerState: state, eventSource: eventSource(state, launched), queuedMutations: 0,
      acceptedReplies: 0, acceptedEvents: launched, stalePayloads: launched,
      invalidPayloads: 0, mutationFailures: 0, applyErrors: 0, callbackErrors: 0, disposed,
    },
    appCatalog: { cachedApps: disposed ? 0 : schemaVersion >= 2 && targetKind === "local-shortcut" ? 0 : 2,
      readPending: false, invalidations: 0, eventSource: source() },
    appLaunched: { invalidPayloads: 0, eventSource: eventSource(state, launched) },
    contextMenu: {
      version: 1, subscribers: disposed ? 0 : 1, showInFlight: false, whitelistedCommands: 0, showRequests: 0,
      showFailures: 0, acceptedCommands: 0, ignoredEvents: 0, invalidEvents: 0, callbackErrors: 0,
      eventSource: source(), disposed,
    },
    settingsView: {
      version: 1, listenerState: state, activePhase: null, pendingOpen: false, openFailures: 0,
      closeFailures: 0, invalidPayloads: 0, registrationErrors: 0, lateListenerUnlistens: 0, cleanupErrors: 0,
      // Captured from run-92a747355e1648b9a6046d872106821c/native-report.json stage 0.
      ...(schemaVersion >= 2 ? { input: {
        callbacks: disposed ? 0 : 5, invalidPayloads: 0, stalePayloads: 0, callbackErrors: 0,
        notifyFailures: 0, staleReplies: 0, notifyPending: false, notifyInFlight: false, disposed,
      } } : {}),
    },
    generalPreferenceEvents: { version: 1, invalidPayloads: 0, notifiedFields: { placeholder: 0 } },
    ...(schemaVersion >= 2 ? { localShortcutEvents: {
      ...eventSource(state), invalidEvents: 0, staleEvents: 0,
      latestRevision: disposed || launched === 0 ? null : launched, replayPending: false,
    } } : {}),
  };
}

function makeStage(index, targetKind = "app", schemaVersion = 2) {
  const item = expected[index];
  const disposed = index === 6;
  const action = { metaFDefaultPrevented: null, launchRejected: null, launchResolved: null,
    arrowDownDefaultPrevented: null, enterDefaultPrevented: null };
  if (index === 1) action.metaFDefaultPrevented = true;
  if (index === 2) action.launchRejected = true;
  if (index === 3) action.launchResolved = true;
  if (index === 4) action.arrowDownDefaultPrevented = true;
  if (index === 5) {
    action.enterDefaultPrevented = true;
    action.launchResolved = true;
  }
  return {
    name: stageNames[index], status: "observed",
    dom: {
      inputValue: item.input, pastedText: item.pasted, selectedTitle: schemaVersion === 3 && item.selected ? `${item.selected}.app` : item.selected,
      visibility: "hidden", documentHasFocus: false, inputFocused: false, actions: action,
      adapter: {
        launchCalls: item.launches, outstandingNativeCalls: 0, listeners: listeners(index, targetKind, schemaVersion),
        windowDrag: {
          disposed, pending: 0, queued: 0, inFlight: null, pendingPositionReads: 0, queuedMoves: 0, queuedLocks: 0,
          positionReads: 0, moveRequests: 0, lockRequests: item.locks, dispatchedPositions: 0, dispatchedMoves: 0,
          dispatchedLocks: item.locks, coalescedMoves: 0, rejectedOperations: 0, failures: 0, cancelledReads: 0,
          droppedAfterDispose: 0,
        },
      },
    },
    native: {
      window: { visible: false, focused: false, sizeLocked: item.locked, bounds: { x: 12, y: 24, width: 500, height: 480 } },
      focusGainedEvents: 0, childWebviews: 0, activeChildLayouts: 0, wkStorePersistent: false,
      taskRuns: { total: item.runs[0], cancelled: item.runs[1], succeeded: item.runs[2] },
      audits: { denied: item.audits[0], confirmed: item.audits[1] },
      history: {
        items: item.history[0], firstUseCount: item.history[1], secondUseCount: item.history[2],
        ...(schemaVersion >= 2 ? {
          appItems: targetKind === "app" ? item.history[0] : 0,
          localShortcutItems: targetKind === "local-shortcut" ? item.history[0] : 0,
        } : {}),
      },
      appLaunchedWitness: { targetLabel: "main", deliveredEvents: item.events, payloadIsNull: item.events ? true : null },
      probes: { started: item.probes[0], exited: item.probes[1], liveProcesses: item.probes[2], pendingLaunches: item.probes[3] },
    },
  };
}

function makeReport(targetKind = "app", schemaVersion = 2) {
  return {
    schemaVersion, journey: "launch-return", scope: "hidden-original-vue-real-launch-return",
    runId, identifier, root, pid, passed: true, errors: [],
    metadata: {
      ownedFixture: true, catalogItems: schemaVersion >= 2 && targetKind === "local-shortcut" ? 0 : 2,
      ...(schemaVersion >= 2 ? {
        targetKind, localShortcutItems: targetKind === "local-shortcut" ? 2 : 0,
      } : {}),
      windowPolicy: "hidden-no-foreground",
      dataStorePersistent: false, backgroundOnly: true, autoClear: "never",
    },
    clipboard: { reads: 0, writes: 0, pastes: 0 },
    stages: stageNames.map((_, index) => makeStage(index, targetKind, schemaVersion)),
    probes: ["first", "second"].map((probeId, index) => ({
      probeId, bundleName: `AToolsOwnedProbe${index === 0 ? "First" : "Second"}.app`, backgroundOnly: true,
      marker: { started: true, exiting: true, runIdMatched: true, probeIdMatched: true,
        pid: 1001 + index, processTerminal: true },
    })),
  };
}

function expectedOwner(report = makeReport(), targetKind = "app") {
  return {
    runId: report.runId, identifier: report.identifier, root: report.root, pid: report.pid,
    targetKind, registrationSource: "core-seed",
    marker: { schemaVersion: 1, identifier: report.identifier, root: report.root, pid: report.pid },
  };
}

test("accepts complete schema-v2 hidden launch-return evidence with the production snapshot shapes", () => {
  const report = makeReport();
  report.stages[0].dom.inputFocused = true;
  const result = validateLaunchReturnNativeReport(report, expectedOwner(report));
  assert.deepEqual(result, { valid: true, errors: [], passed: true });
});

test("fails closed on malformed, reordered, invented, or unmeasured report evidence", () => {
  const extraField = makeReport();
  extraField.stages[0].dom.adapter.listeners.generalPreferenceEvents.subscribers = 0;
  assert.equal(validateLaunchReturnNativeReport(extraField, expectedOwner(extraField)).valid, false);

  const reordered = makeReport();
  [reordered.stages[0], reordered.stages[1]] = [reordered.stages[1], reordered.stages[0]];
  assert.equal(validateLaunchReturnNativeReport(reordered, expectedOwner(reordered)).valid, false);

  const missingObservation = makeReport();
  missingObservation.stages[0].native.window.focused = null;
  assert.equal(validateLaunchReturnNativeReport(missingObservation, expectedOwner(missingObservation)).valid, false);

  const nullInputFocus = makeReport();
  nullInputFocus.stages[0].dom.inputFocused = null;
  assert.equal(validateLaunchReturnNativeReport(nullInputFocus, expectedOwner(nullInputFocus)).valid, false);

  const documentFocused = makeReport();
  documentFocused.stages[0].dom.documentHasFocus = true;
  assert.equal(validateLaunchReturnNativeReport(documentFocused, expectedOwner(documentFocused)).valid, false);

  const nativeFocused = makeReport();
  nativeFocused.stages[0].native.window.focused = true;
  assert.equal(validateLaunchReturnNativeReport(nativeFocused, expectedOwner(nativeFocused)).valid, false);

  const falseBackgroundPolicy = makeReport();
  falseBackgroundPolicy.probes[1].backgroundOnly = false;
  assert.equal(validateLaunchReturnNativeReport(falseBackgroundPolicy, expectedOwner(falseBackgroundPolicy)).valid, false);

  const invalidProbePid = makeReport();
  invalidProbePid.probes[0].marker.pid = 0;
  assert.equal(validateLaunchReturnNativeReport(invalidProbePid, expectedOwner(invalidProbePid)).valid, false);

  const ownerMismatch = makeReport();
  assert.equal(validateLaunchReturnNativeReport(ownerMismatch, { ...expectedOwner(ownerMismatch), marker: null }).valid, false);
});

test("counts idempotent app-state duplicates by phase and permits cache clearing on disposal", () => {
  const replyAccepted = makeReport();
  const directState = replyAccepted.stages[3].dom.adapter.listeners.appState;
  directState.acceptedEvents = 0;
  directState.acceptedReplies = 1;
  const keyboardState = replyAccepted.stages[5].dom.adapter.listeners.appState;
  keyboardState.acceptedEvents = 0;
  keyboardState.acceptedReplies = 2;
  assert.equal(validateLaunchReturnNativeReport(replyAccepted, expectedOwner(replyAccepted)).valid, true);

  const excessDuplicate = makeReport();
  excessDuplicate.stages[3].dom.adapter.listeners.appState.stalePayloads = 2;
  assert.equal(validateLaunchReturnNativeReport(excessDuplicate, expectedOwner(excessDuplicate)).valid, false);

  const excessAccepted = makeReport();
  excessAccepted.stages[3].dom.adapter.listeners.appState.acceptedReplies = 1;
  assert.equal(validateLaunchReturnNativeReport(excessAccepted, expectedOwner(excessAccepted)).valid, false);

  const wrongRevision = makeReport();
  wrongRevision.stages[3].dom.adapter.listeners.appState.revision = 2;
  assert.equal(validateLaunchReturnNativeReport(wrongRevision, expectedOwner(wrongRevision)).valid, false);

  const missingEvent = makeReport();
  missingEvent.stages[3].dom.adapter.listeners.appState.eventSource.deliveredEvents = 0;
  assert.equal(validateLaunchReturnNativeReport(missingEvent, expectedOwner(missingEvent)).valid, false);

  const activeCacheCleared = makeReport();
  activeCacheCleared.stages[4].dom.adapter.listeners.appCatalog.cachedApps = 0;
  assert.equal(validateLaunchReturnNativeReport(activeCacheCleared, expectedOwner(activeCacheCleared)).valid, false);

  const disposed = makeReport();
  assert.equal(disposed.stages[6].dom.adapter.listeners.appCatalog.cachedApps, 0);
  assert.equal(validateLaunchReturnNativeReport(disposed, expectedOwner(disposed)).valid, true);
});

test("routes launch history and catalog counts to the CLI-selected target kind", () => {
  const report = makeReport("local-shortcut");
  assert.equal(validateLaunchReturnNativeReport(report, expectedOwner(report, "local-shortcut")).valid, true);

  const wrongExpectedKind = validateLaunchReturnNativeReport(report, expectedOwner(report, "app"));
  assert.equal(wrongExpectedKind.valid, false, "the external target kind must override report self-description");

  const wrongMetadataKind = makeReport("local-shortcut");
  wrongMetadataKind.metadata.targetKind = "app";
  assert.equal(validateLaunchReturnNativeReport(wrongMetadataKind, expectedOwner(wrongMetadataKind, "local-shortcut")).valid, false);

  const localInAppHistory = makeReport("local-shortcut");
  localInAppHistory.stages[5].native.history.appItems = 2;
  localInAppHistory.stages[5].native.history.localShortcutItems = 0;
  assert.equal(validateLaunchReturnNativeReport(localInAppHistory, expectedOwner(localInAppHistory, "local-shortcut")).valid, false);

  const localInAppCatalog = makeReport("local-shortcut");
  localInAppCatalog.stages[3].dom.adapter.listeners.appCatalog.cachedApps = 2;
  assert.equal(validateLaunchReturnNativeReport(localInAppCatalog, expectedOwner(localInAppCatalog, "local-shortcut")).valid, false);
});

test("requires schema-v2 shortcut listener snapshots and keeps schema-v1 app reports historical-only", () => {
  const missingListener = makeReport();
  delete missingListener.stages[0].dom.adapter.listeners.localShortcutEvents;
  assert.equal(validateLaunchReturnNativeReport(missingListener, expectedOwner(missingListener)).valid, false);

  const missingKindCounts = makeReport();
  delete missingKindCounts.stages[3].native.history.localShortcutItems;
  assert.equal(validateLaunchReturnNativeReport(missingKindCounts, expectedOwner(missingKindCounts)).valid, false);

  const brokenDisposedListener = makeReport();
  brokenDisposedListener.stages[6].dom.adapter.listeners.localShortcutEvents.replayPending = true;
  assert.equal(validateLaunchReturnNativeReport(brokenDisposedListener, expectedOwner(brokenDisposedListener)).valid, false);

  const brokenActiveListener = makeReport();
  brokenActiveListener.stages[2].dom.adapter.listeners.localShortcutEvents.listenerState = "disposed";
  assert.equal(validateLaunchReturnNativeReport(brokenActiveListener, expectedOwner(brokenActiveListener)).valid, false);

  const invalidShortcutEvent = makeReport();
  invalidShortcutEvent.stages[2].dom.adapter.listeners.localShortcutEvents.invalidEvents = 1;
  assert.equal(validateLaunchReturnNativeReport(invalidShortcutEvent, expectedOwner(invalidShortcutEvent)).valid, false);

  const legacyAppReport = makeReport("app", 1);
  assert.equal(validateLaunchReturnNativeReport(legacyAppReport, expectedOwner(legacyAppReport, "app")).valid, true);
  assert.equal(validateLaunchReturnNativeReport(legacyAppReport, expectedOwner(legacyAppReport, "local-shortcut")).valid, false);
  assert.equal(validateLaunchReturnNativeReport(legacyAppReport, {
    ...expectedOwner(legacyAppReport, "app"), requiredSchemaVersion: 2,
  }).valid, false, "a new real run must require native schema v2");
});

test("validates the production settings input snapshot for every schema-v2 stage", () => {
  const valid = makeReport();
  assert.equal(validateLaunchReturnNativeReport(valid, expectedOwner(valid)).valid, true);

  const missingInput = makeReport();
  delete missingInput.stages[0].dom.adapter.listeners.settingsView.input;
  assert.equal(validateLaunchReturnNativeReport(missingInput, expectedOwner(missingInput)).valid, false);

  const unknownField = makeReport();
  unknownField.stages[0].dom.adapter.listeners.settingsView.input.unexpected = 0;
  assert.equal(validateLaunchReturnNativeReport(unknownField, expectedOwner(unknownField)).valid, false);

  const missingNestedField = makeReport();
  delete missingNestedField.stages[0].dom.adapter.listeners.settingsView.input.notifyInFlight;
  assert.equal(validateLaunchReturnNativeReport(missingNestedField, expectedOwner(missingNestedField)).valid, false);

  const pendingNotification = makeReport();
  pendingNotification.stages[2].dom.adapter.listeners.settingsView.input.notifyPending = true;
  assert.equal(validateLaunchReturnNativeReport(pendingNotification, expectedOwner(pendingNotification)).valid, false);

  const inFlightNotification = makeReport();
  inFlightNotification.stages[2].dom.adapter.listeners.settingsView.input.notifyInFlight = true;
  assert.equal(validateLaunchReturnNativeReport(inFlightNotification, expectedOwner(inFlightNotification)).valid, false);

  const callbackError = makeReport();
  callbackError.stages[1].dom.adapter.listeners.settingsView.input.callbackErrors = 1;
  assert.equal(validateLaunchReturnNativeReport(callbackError, expectedOwner(callbackError)).valid, false);

  const wrongActiveCallbackCount = makeReport();
  wrongActiveCallbackCount.stages[4].dom.adapter.listeners.settingsView.input.callbacks = 4;
  assert.equal(validateLaunchReturnNativeReport(wrongActiveCallbackCount, expectedOwner(wrongActiveCallbackCount)).valid, false);

  const wrongDisposedState = makeReport();
  wrongDisposedState.stages[6].dom.adapter.listeners.settingsView.input.disposed = false;
  assert.equal(validateLaunchReturnNativeReport(wrongDisposedState, expectedOwner(wrongDisposedState)).valid, false);

  const activeMarkedDisposed = makeReport();
  activeMarkedDisposed.stages[2].dom.adapter.listeners.settingsView.input.disposed = true;
  assert.equal(validateLaunchReturnNativeReport(activeMarkedDisposed, expectedOwner(activeMarkedDisposed)).valid, false);

  const unsafeCounter = makeReport();
  unsafeCounter.stages[3].dom.adapter.listeners.settingsView.input.staleReplies = Infinity;
  assert.equal(validateLaunchReturnNativeReport(unsafeCounter, expectedOwner(unsafeCounter)).valid, false);
});

test("never throws for malformed JSON-like inputs", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [null, [], {}, cyclic]) {
    assert.doesNotThrow(() => validateLaunchReturnNativeReport(value, null));
    assert.equal(validateLaunchReturnNativeReport(value, null).valid, false);
  }
});

test("runner CLI binds three absolute fresh inputs and selects only the launch-return journey", () => {
  const cli = parseLaunchReturnNativeArgs([
    "--binary", "/tmp/renderer-smoke",
    "--build-receipt", "/tmp/native-build-receipt-1.json",
    "--launcher-probe-binary", "/tmp/owned-probe",
  ]);
  assert.deepEqual(cli, {
    binary: "/tmp/renderer-smoke",
    buildReceipt: "/tmp/native-build-receipt-1.json",
    launcherProbeBinary: "/tmp/owned-probe",
    targetKind: "app", registrationSource: "core-seed",
  });
  const localCli = parseLaunchReturnNativeArgs([
    "--binary", "/tmp/renderer-smoke", "--build-receipt", "/tmp/receipt",
    "--launcher-probe-binary", "/tmp/probe", "--target-kind", "local-shortcut",
  ]);
  assert.equal(localCli.targetKind, "local-shortcut");
  assert.throws(() => parseLaunchReturnNativeArgs([
    "--binary", "/tmp/a", "--build-receipt", "/tmp/receipt", "--launcher-probe-binary", "/tmp/probe",
    "--target-kind", "plugin",
  ]), /app or local-shortcut/);
  assert.throws(() => parseLaunchReturnNativeArgs([
    "--binary", "/tmp/a", "--build-receipt", "/tmp/receipt", "--launcher-probe-binary", "/tmp/probe",
    "--target-kind", "app", "--target-kind", "local-shortcut",
  ]), /accepted once each/);
  assert.throws(() => parseLaunchReturnNativeArgs(["--binary", "relative"]), /absolute path/);
  assert.throws(() => parseLaunchReturnNativeArgs([
    "--binary", "/tmp/a", "--binary", "/tmp/b",
    "--build-receipt", "/tmp/receipt", "--launcher-probe-binary", "/tmp/probe",
  ]), /accepted once each/);

  const args = buildLaunchReturnNativeArgs({
    fixtureRoot: "/private/tmp/fixture",
    rendererDist: "/tmp/ztools-renderer/dist",
    output: "/tmp/native-report.json",
    runId,
  });
  assert.ok(args.includes("--auto-clear") && args[args.indexOf("--auto-clear") + 1] === "never");
  assert.deepEqual(args.slice(-6), ["--journey", "launch-return", "--target-kind", "app", "--registration-source", "core-seed"]);
  const localArgs = buildLaunchReturnNativeArgs({
    fixtureRoot: "/private/tmp/fixture", rendererDist: "/tmp/ztools-renderer/dist",
    output: "/tmp/native-report.json", runId, targetKind: "local-shortcut",
  });
  assert.deepEqual(localArgs.slice(-4), ["--target-kind", "local-shortcut", "--registration-source", "core-seed"]);
  assert.equal(args.includes("launcher"), false);
  assert.equal(args.includes("--profile"), false);
});

test("probe report agreement and profile cleanup require independent terminal PID evidence", () => {
  const probes = ["first", "second"].map((probeId, index) => ({
    probeId,
    bundleName: `AToolsOwnedProbe${index === 0 ? "First" : "Second"}.app`,
    backgroundOnly: true,
    marker: { started: true, exiting: true, runIdMatched: true, probeIdMatched: true,
      pid: 1001 + index, processTerminal: true },
  }));
  const nodeEvidence = {
    valid: true, probesTerminal: true, liveProbeProcesses: 0,
    probeReceipts: probes.map(probe => ({ probeId: probe.probeId, started: true, exited: true,
      pid: probe.marker.pid, processTerminal: true, liveProbeProcesses: 0 })),
  };
  assert.equal(launchReturnProbeReportsAgree({ probes }, nodeEvidence), true);
  assert.equal(launchReturnProbeReportsAgree({ probes }, { ...nodeEvidence, liveProbeProcesses: 1 }), false);
  assert.equal(launchReturnProbeReportsAgree({ probes }, {
    ...nodeEvidence,
    probeReceipts: nodeEvidence.probeReceipts.map((receipt, index) => index === 1
      ? { ...receipt, pid: receipt.pid + 1 } : receipt),
  }), false);
  const completeEvidence = {
    hostProcessSucceeded: true, profileOwnerValid: true, nativeReportValid: true,
    probeReportsAgree: true, probesValid: true, probesTerminal: true,
    liveProbeProcesses: 0, pendingLaunches: 0, nativeLiveProbeProcesses: 0, nativeProbesTerminal: true, registrationSource: "core-seed",
  };
  assert.equal(launchReturnRootCleanupAllowed(completeEvidence), true);
  assert.equal(launchReturnRootCleanupAllowed({ ...completeEvidence, probesTerminal: false }), false);
  assert.equal(launchReturnRootCleanupAllowed({ ...completeEvidence, profileOwnerValid: false }), false);
  const settingsEvidence = { ...completeEvidence, registrationSource: "settings-child", registrationSqliteValid: true };
  assert.equal(launchReturnRootCleanupAllowed(settingsEvidence), true);
  assert.equal(launchReturnRootCleanupAllowed({ ...settingsEvidence, registrationSqliteValid: false }), false);
  assert.equal(launchReturnRootCleanupAllowed({ ...settingsEvidence, registrationSource: "invented" }), false);
});

function settingsReportFixture() {
  const report = makeReport("local-shortcut", 3);
  report.runId = "0123456789ab4def8123456789abcdef";
  report.root = `/private/tmp/atools-renderer-launch-return-${report.runId}`;
  report.identifier = `dev.atools.renderer-smoke.${report.runId}`;
  const { registration, ...registrationOwner } = makeLaunchReturnSettingsRegistrationFixture(report.root);
  report.registration = registration;
  report.metadata.registrationSource = "settings-child";
  for (const [index, stage] of report.stages.entries()) {
    stage.dom.adapter.listeners.localShortcutEvents.deliveredEvents = 8;
    stage.dom.adapter.listeners.localShortcutEvents.latestRevision = index === 6 ? null : 8;
  }
  return { report, owner: { ...expectedOwner(report, "local-shortcut"), ...registrationOwner,
    registrationSource: "settings-child", requiredSchemaVersion: 3 } };
}

test("schema3 Settings registration is mandatory and externally bound, with old contracts preserved", () => {
  const sample = settingsReportFixture();
  assert.deepEqual(validateLaunchReturnNativeReport(sample.report, sample.owner), { valid: true, errors: [], passed: true });
  for (const mutate of [
    value => { value.owner.registrationSource = "core-seed"; },
    value => { delete value.owner.registrationSource; },
    value => { delete value.owner.requiredSchemaVersion; },
    value => { value.owner.targetKind = "app"; },
    value => { value.owner.settingsBundleRevision = "b".repeat(64); },
    value => { delete value.owner.registrationSqlite; },
    value => { value.report.schemaVersion = 2; },
    value => { delete value.report.registration; },
    value => { value.report.metadata.registrationSource = "core-seed"; },
    value => { value.report.stages[0].dom.adapter.listeners.localShortcutEvents.deliveredEvents = 0; },
    value => { value.report.stages[4].dom.selectedTitle = "AToolsOwnedProbeSecond"; },
  ]) {
    const value = settingsReportFixture(); mutate(value);
    assert.equal(validateLaunchReturnNativeReport(value.report, value.owner).valid, false, mutate.toString());
  }
  for (const schema of [1, 2]) {
    const report = makeReport("app", schema);
    assert.equal(validateLaunchReturnNativeReport(report, { ...expectedOwner(report), registrationSource: "settings-child" }).valid, false);
  }
});

test("runner source selection accepts only the Settings-child/local-shortcut pair", () => {
  const base = ["--binary", "/tmp/a", "--build-receipt", "/tmp/receipt", "--launcher-probe-binary", "/tmp/probe"];
  const cli = parseLaunchReturnNativeArgs([...base, "--target-kind", "local-shortcut", "--registration-source", "settings-child"]);
  assert.equal(cli.registrationSource, "settings-child");
  assert.throws(() => parseLaunchReturnNativeArgs([...base, "--registration-source", "settings-child"]), /requires.*local-shortcut/);
  assert.throws(() => parseLaunchReturnNativeArgs([...base, "--registration-source", "unknown"]), /core-seed or settings-child/);
  assert.throws(() => buildLaunchReturnNativeArgs({ fixtureRoot: "/tmp/f", rendererDist: "/tmp/d", output: "/tmp/o", runId,
    registrationSource: "settings-child" }), /requires local-shortcut/);
});
