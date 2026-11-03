import { isAbsolute, normalize } from "node:path";
import { markerMatches } from "./ztools-renderer-native-runtime.mjs";
import { validateLaunchReturnSettingsRegistration } from "./ztools-launch-return-settings-registration.mjs";

export const LAUNCH_RETURN_NATIVE_SCOPE = "hidden-original-vue-real-launch-return";
export const LAUNCH_RETURN_NATIVE_STAGES = Object.freeze([
  "baseline", "pasted", "denied", "direct-return", "typed", "keyboard-return", "disposed",
]);

const TOP_KEYS = ["schemaVersion", "journey", "scope", "runId", "identifier", "root", "pid", "passed", "errors", "metadata", "clipboard", "stages", "probes"];
const METADATA_KEYS_V1 = ["ownedFixture", "catalogItems", "windowPolicy", "dataStorePersistent", "backgroundOnly", "autoClear"];
const METADATA_KEYS_V2 = [...METADATA_KEYS_V1, "targetKind", "localShortcutItems"];
const METADATA_KEYS_V3 = [...METADATA_KEYS_V2, "registrationSource"];
const CLIPBOARD_KEYS = ["reads", "writes", "pastes"];
const STAGE_KEYS = ["name", "status", "dom", "native"];
const DOM_KEYS = ["inputValue", "pastedText", "selectedTitle", "visibility", "documentHasFocus", "inputFocused", "actions", "adapter"];
const ACTION_KEYS = ["metaFDefaultPrevented", "launchRejected", "launchResolved", "arrowDownDefaultPrevented", "enterDefaultPrevented"];
const ADAPTER_KEYS = ["launchCalls", "outstandingNativeCalls", "listeners", "windowDrag"];
const LISTENER_NAMES = ["focusEvents", "appState", "appCatalog", "appLaunched", "contextMenu", "settingsView", "generalPreferenceEvents"];
const EVENT_SOURCE_KEYS = ["subscribers", "listenerState", "deliveredEvents", "registrationErrors", "callbackErrors", "registrationsPending", "lateListenerUnlistens", "cleanupPending", "cleanupErrors"];
const LOCAL_SHORTCUT_EVENT_KEYS = [...EVENT_SOURCE_KEYS, "invalidEvents", "staleEvents", "latestRevision", "replayPending"];
const FOCUS_KEYS = [...EVENT_SOURCE_KEYS, "windowContextAvailable"];
const APP_STATE_KEYS = ["version", "revision", "historySubscribers", "pinnedSubscribers", "listenerState", "eventSource", "queuedMutations", "acceptedReplies", "acceptedEvents", "stalePayloads", "invalidPayloads", "mutationFailures", "applyErrors", "callbackErrors", "disposed"];
const APP_CATALOG_KEYS = ["cachedApps", "readPending", "invalidations", "eventSource"];
const APP_LAUNCHED_KEYS = ["invalidPayloads", "eventSource"];
const CONTEXT_MENU_KEYS = ["version", "subscribers", "showInFlight", "whitelistedCommands", "showRequests", "showFailures", "acceptedCommands", "ignoredEvents", "invalidEvents", "callbackErrors", "eventSource", "disposed"];
const SETTINGS_VIEW_KEYS = ["version", "listenerState", "activePhase", "pendingOpen", "openFailures", "closeFailures", "invalidPayloads", "registrationErrors", "lateListenerUnlistens", "cleanupErrors"];
const SETTINGS_VIEW_INPUT_KEYS = ["callbacks", "invalidPayloads", "stalePayloads", "callbackErrors", "notifyFailures", "staleReplies", "notifyPending", "notifyInFlight", "disposed"];
const SETTINGS_VIEW_KEYS_V2 = [...SETTINGS_VIEW_KEYS, "input"];
const GENERAL_PREFERENCES_KEYS = ["version", "invalidPayloads", "notifiedFields"];
const WINDOW_DRAG_KEYS = ["disposed", "pending", "queued", "inFlight", "pendingPositionReads", "queuedMoves", "queuedLocks", "positionReads", "moveRequests", "lockRequests", "dispatchedPositions", "dispatchedMoves", "dispatchedLocks", "coalescedMoves", "rejectedOperations", "failures", "cancelledReads", "droppedAfterDispose"];
const NATIVE_KEYS = ["window", "focusGainedEvents", "childWebviews", "activeChildLayouts", "wkStorePersistent", "taskRuns", "audits", "history", "appLaunchedWitness", "probes"];
const NATIVE_WINDOW_KEYS = ["visible", "focused", "sizeLocked", "bounds"];
const BOUNDS_KEYS = ["x", "y", "width", "height"];
const TASK_RUN_KEYS = ["total", "cancelled", "succeeded"];
const AUDIT_KEYS = ["denied", "confirmed"];
const HISTORY_KEYS = ["items", "firstUseCount", "secondUseCount"];
const HISTORY_KEYS_V2 = [...HISTORY_KEYS, "appItems", "localShortcutItems"];
const WITNESS_KEYS = ["targetLabel", "deliveredEvents", "payloadIsNull"];
const NATIVE_PROBE_COUNT_KEYS = ["started", "exited", "liveProcesses", "pendingLaunches"];
const PROBE_KEYS = ["probeId", "bundleName", "backgroundOnly", "marker"];
const PROBE_MARKER_KEYS = ["started", "exiting", "runIdMatched", "probeIdMatched", "pid", "processTerminal"];
const PROBE_IDS = ["first", "second"];
const PROBE_NAMES = ["AToolsOwnedProbeFirst.app", "AToolsOwnedProbeSecond.app"];
const PROBE_TITLES = ["AToolsOwnedProbeFirst", "AToolsOwnedProbeSecond"];
const DRAG_COUNTERS = WINDOW_DRAG_KEYS.filter(key => !["disposed", "inFlight"].includes(key));
const EXPECTED_STAGES = [
  { input: "", pasted: "", selected: "", launches: 0, events: 0, locks: 0, locked: false, actions: {}, runs: [0, 0, 0], audits: [0, 0], history: [0, 0, 0], probes: [0, 0, 0, 0] },
  { input: "", pastedContains: PROBE_TITLES[0], selected: "", launches: 0, events: 0, locks: 1, locked: true, actions: { metaFDefaultPrevented: true }, runs: [0, 0, 0], audits: [0, 0], history: [0, 0, 0], probes: [0, 0, 0, 0] },
  { input: "", pastedContains: PROBE_TITLES[0], selected: "", launches: 1, events: 0, locks: 1, locked: true, actions: { launchRejected: true }, runs: [1, 1, 0], audits: [1, 0], history: [0, 0, 0], probes: [0, 0, 0, 0] },
  { input: "", pasted: "", selected: "", launches: 2, events: 1, locks: 1, locked: false, actions: { launchResolved: true }, runs: [2, 1, 1], audits: [1, 1], history: [1, 1, 0], probes: [1, 1, 0, 0] },
  { input: "AToolsOwnedProbe", pasted: "", selected: PROBE_TITLES[1], launches: 2, events: 1, locks: 2, locked: true, actions: { arrowDownDefaultPrevented: true }, runs: [2, 1, 1], audits: [1, 1], history: [1, 1, 0], probes: [1, 1, 0, 0] },
  { input: "", pasted: "", selected: "", launches: 3, events: 2, locks: 2, locked: false, actions: { enterDefaultPrevented: true, launchResolved: true }, runs: [3, 1, 2], audits: [1, 2], history: [2, 1, 1], probes: [2, 2, 0, 0] },
  { input: "", pasted: "", selected: "", launches: 3, events: 2, locks: 2, locked: false, actions: {}, runs: [3, 1, 2], audits: [1, 2], history: [2, 1, 1], probes: [2, 2, 0, 0] },
];

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

function maybeCount(value) {
  return value === null || count(value);
}

function maybeString(value) {
  return value === null || typeof value === "string";
}

function maybeBoolean(value) {
  return value === null || typeof value === "boolean";
}

function zero(value) {
  return value === 0;
}

function check(errors, condition, code) {
  if (!condition) errors.push(code);
}

function validateEventSource(value, code, errors, keys = EVENT_SOURCE_KEYS) {
  check(errors, exactKeys(value, keys), `${code}-shape`);
  if (!isRecord(value)) return;
  for (const key of ["subscribers", "deliveredEvents", "registrationErrors", "callbackErrors", "registrationsPending", "lateListenerUnlistens", "cleanupPending", "cleanupErrors"]) {
    check(errors, count(value[key]), `${code}-${key}-integer`);
  }
  check(errors, typeof value.listenerState === "string", `${code}-listener-state`);
}

function validateListenerSnapshots(listeners, errors, schemaVersion) {
  const names = schemaVersion >= 2 ? [...LISTENER_NAMES, "localShortcutEvents"] : LISTENER_NAMES;
  check(errors, exactKeys(listeners, names), "listeners-shape");
  if (!isRecord(listeners)) return;
  for (const name of names) {
    const value = listeners[name];
    const code = `listener-${name}`;
    if (name === "focusEvents") {
      check(errors, exactKeys(value, FOCUS_KEYS), `${code}-shape`);
      validateEventSource(value, code, errors, FOCUS_KEYS);
      check(errors, value?.windowContextAvailable === false, `${code}-window-context`);
    } else if (name === "appState") {
      check(errors, exactKeys(value, APP_STATE_KEYS), `${code}-shape`);
      if (isRecord(value)) {
        check(errors, value.version === 1, `${code}-version`);
        check(errors, value.revision === null || count(value.revision), `${code}-revision`);
        for (const key of ["historySubscribers", "pinnedSubscribers", "queuedMutations", "acceptedReplies", "acceptedEvents", "stalePayloads", "invalidPayloads", "mutationFailures", "applyErrors", "callbackErrors"]) {
          check(errors, count(value[key]), `${code}-${key}-integer`);
        }
        check(errors, typeof value.listenerState === "string" && typeof value.disposed === "boolean", `${code}-state`);
        validateEventSource(value.eventSource, `${code}-event-source`, errors);
      }
    } else if (name === "appCatalog") {
      check(errors, exactKeys(value, APP_CATALOG_KEYS), `${code}-shape`);
      if (isRecord(value)) {
        check(errors, count(value.cachedApps) && count(value.invalidations), `${code}-counts`);
        check(errors, typeof value.readPending === "boolean", `${code}-read-pending`);
        validateEventSource(value.eventSource, `${code}-event-source`, errors);
      }
    } else if (name === "appLaunched") {
      check(errors, exactKeys(value, APP_LAUNCHED_KEYS), `${code}-shape`);
      if (isRecord(value)) {
        check(errors, count(value.invalidPayloads), `${code}-invalid-payload-count`);
        validateEventSource(value.eventSource, `${code}-event-source`, errors);
      }
    } else if (name === "contextMenu") {
      check(errors, exactKeys(value, CONTEXT_MENU_KEYS), `${code}-shape`);
      if (isRecord(value)) {
        check(errors, value.version === 1, `${code}-version`);
        for (const key of ["subscribers", "whitelistedCommands", "showRequests", "showFailures", "acceptedCommands", "ignoredEvents", "invalidEvents", "callbackErrors"]) {
          check(errors, count(value[key]), `${code}-${key}-integer`);
        }
        check(errors, typeof value.showInFlight === "boolean" && typeof value.disposed === "boolean", `${code}-state`);
        validateEventSource(value.eventSource, `${code}-event-source`, errors);
      }
    } else if (name === "localShortcutEvents") {
      check(errors, exactKeys(value, LOCAL_SHORTCUT_EVENT_KEYS), `${code}-shape`);
      validateEventSource(value, code, errors, LOCAL_SHORTCUT_EVENT_KEYS);
      if (isRecord(value)) {
        check(errors, count(value.invalidEvents) && count(value.staleEvents), `${code}-event-counts`);
        check(errors, maybeCount(value.latestRevision) && typeof value.replayPending === "boolean", `${code}-replay-state`);
      }
    } else if (name === "settingsView") {
      const settingsKeys = schemaVersion >= 2 ? SETTINGS_VIEW_KEYS_V2 : SETTINGS_VIEW_KEYS;
      check(errors, exactKeys(value, settingsKeys), `${code}-shape`);
      if (isRecord(value)) {
        check(errors, value.version === 1 && typeof value.listenerState === "string", `${code}-state`);
        check(errors, maybeString(value.activePhase) && typeof value.pendingOpen === "boolean", `${code}-phase`);
        for (const key of ["openFailures", "closeFailures", "invalidPayloads", "registrationErrors", "lateListenerUnlistens", "cleanupErrors"]) {
          check(errors, count(value[key]), `${code}-${key}-integer`);
        }
        if (schemaVersion >= 2) validateSettingsViewInput(value.input, code, errors);
      }
    } else {
      check(errors, exactKeys(value, GENERAL_PREFERENCES_KEYS), `${code}-shape`);
      if (isRecord(value)) {
        check(errors, value.version === 1 && count(value.invalidPayloads), `${code}-diagnostics`);
        check(errors, exactKeys(value.notifiedFields, ["placeholder"]) && count(value.notifiedFields?.placeholder), `${code}-notified-fields`);
      }
    }
  }
}

function validateSettingsViewInput(value, code, errors) {
  check(errors, exactKeys(value, SETTINGS_VIEW_INPUT_KEYS), `${code}-input-shape`);
  if (!isRecord(value)) return;
  for (const key of ["callbacks", "invalidPayloads", "stalePayloads", "callbackErrors", "notifyFailures", "staleReplies"]) {
    check(errors, count(value[key]), `${code}-input-${key}-integer`);
  }
  for (const key of ["notifyPending", "notifyInFlight", "disposed"]) {
    check(errors, typeof value[key] === "boolean", `${code}-input-${key}-boolean`);
  }
}

function validateWindowDrag(value, code, errors) {
  check(errors, exactKeys(value, WINDOW_DRAG_KEYS), `${code}-shape`);
  if (!isRecord(value)) return;
  check(errors, typeof value.disposed === "boolean" && maybeString(value.inFlight), `${code}-state`);
  for (const key of DRAG_COUNTERS) check(errors, count(value[key]), `${code}-${key}-integer`);
}

function validateDom(value, code, errors, schemaVersion) {
  check(errors, exactKeys(value, DOM_KEYS), `${code}-shape`);
  if (!isRecord(value)) return;
  for (const key of ["inputValue", "pastedText", "selectedTitle", "visibility"]) {
    check(errors, maybeString(value[key]), `${code}-${key}-string`);
  }
  for (const key of ["documentHasFocus", "inputFocused"]) check(errors, maybeBoolean(value[key]), `${code}-${key}-boolean`);
  check(errors, exactKeys(value.actions, ACTION_KEYS), `${code}-actions-shape`);
  if (isRecord(value.actions)) for (const key of ACTION_KEYS) check(errors, maybeBoolean(value.actions[key]), `${code}-action-${key}`);
  check(errors, exactKeys(value.adapter, ADAPTER_KEYS), `${code}-adapter-shape`);
  if (isRecord(value.adapter)) {
    check(errors, maybeCount(value.adapter.launchCalls) && maybeCount(value.adapter.outstandingNativeCalls), `${code}-adapter-counts`);
    validateListenerSnapshots(value.adapter.listeners, errors, schemaVersion);
    validateWindowDrag(value.adapter.windowDrag, `${code}-window-drag`, errors);
  }
}

function validateNative(value, code, errors, schemaVersion) {
  check(errors, exactKeys(value, NATIVE_KEYS), `${code}-shape`);
  if (!isRecord(value)) return;
  check(errors, exactKeys(value.window, NATIVE_WINDOW_KEYS), `${code}-window-shape`);
  if (isRecord(value.window)) {
    for (const key of ["visible", "focused", "sizeLocked"]) check(errors, maybeBoolean(value.window[key]), `${code}-window-${key}`);
    if (value.window.bounds !== null) {
      check(errors, exactKeys(value.window.bounds, BOUNDS_KEYS), `${code}-window-bounds-shape`);
      if (isRecord(value.window.bounds)) for (const key of BOUNDS_KEYS) {
        check(errors, Number.isFinite(value.window.bounds[key]), `${code}-window-bounds-${key}`);
      }
    }
  }
  for (const key of ["focusGainedEvents", "childWebviews", "activeChildLayouts"]) check(errors, maybeCount(value[key]), `${code}-${key}-integer`);
  check(errors, maybeBoolean(value.wkStorePersistent), `${code}-store-persistence`);
  const historyKeys = schemaVersion >= 2 ? HISTORY_KEYS_V2 : HISTORY_KEYS;
  for (const [key, fields] of [["taskRuns", TASK_RUN_KEYS], ["audits", AUDIT_KEYS], ["history", historyKeys], ["probes", NATIVE_PROBE_COUNT_KEYS]]) {
    check(errors, exactKeys(value[key], fields), `${code}-${key}-shape`);
    if (isRecord(value[key])) for (const field of fields) check(errors, maybeCount(value[key][field]), `${code}-${key}-${field}`);
  }
  check(errors, exactKeys(value.appLaunchedWitness, WITNESS_KEYS), `${code}-witness-shape`);
  if (isRecord(value.appLaunchedWitness)) {
    check(errors, value.appLaunchedWitness.targetLabel === "main" || value.appLaunchedWitness.targetLabel === null,
      `${code}-witness-target`);
    check(errors, maybeCount(value.appLaunchedWitness.deliveredEvents) && maybeBoolean(value.appLaunchedWitness.payloadIsNull), `${code}-witness-values`);
  }
}

function zeroEventSource(source) {
  return isRecord(source) && ["registrationErrors", "callbackErrors", "registrationsPending", "cleanupPending", "cleanupErrors", "invalidEvents", "staleEvents"]
    .every(key => !Object.hasOwn(source, key) || zero(source[key]));
}

function validateStageSemantics(stage, index, targetKind, schemaVersion, errors) {
  const expected = EXPECTED_STAGES[index];
  const code = `stage-${LAUNCH_RETURN_NATIVE_STAGES[index]}`;
  const disposed = index === LAUNCH_RETURN_NATIVE_STAGES.length - 1;
  check(errors, stage?.status === "observed", `${code}-observed`);
  const dom = stage?.dom;
  const native = stage?.native;
  if (!isRecord(dom) || !isRecord(native)) {
    check(errors, false, `${code}-evidence-missing`);
    return;
  }
  const adapter = dom.adapter;
  const listeners = adapter?.listeners;
  const drag = adapter?.windowDrag;
  const runs = native.taskRuns;
  const audits = native.audits;
  const history = native.history;
  const witness = native.appLaunchedWitness;
  const probeCounts = native.probes;
  const pastedMatches = Object.hasOwn(expected, "pastedContains")
    ? typeof dom.pastedText === "string" && dom.pastedText.includes(expected.pastedContains)
    : dom.pastedText === expected.pasted;
  check(errors, dom.inputValue === expected.input && pastedMatches
    && dom.selectedTitle === (schemaVersion === 3 && expected.selected ? `${expected.selected}.app` : expected.selected), `${code}-dom-values`);
  check(errors, dom.visibility === "hidden" && dom.documentHasFocus === false
    && typeof dom.inputFocused === "boolean",
    `${code}-dom-hidden-unfocused`);
  check(errors, adapter?.launchCalls === expected.launches && adapter?.outstandingNativeCalls === 0,
    `${code}-adapter-launch-counts`);
  check(errors, native.window?.visible === false && native.window?.focused === false
    && native.window?.sizeLocked === expected.locked && native.wkStorePersistent === false,
  `${code}-native-window-policy`);
  check(errors, zero(native.focusGainedEvents) && zero(native.childWebviews) && zero(native.activeChildLayouts),
    `${code}-native-focus-child-state`);
  for (const [action, expectedValue] of Object.entries(expected.actions)) {
    check(errors, dom.actions?.[action] === expectedValue, `${code}-${action}`);
  }
  for (const action of ACTION_KEYS.filter(key => !Object.hasOwn(expected.actions, key))) {
    check(errors, dom.actions?.[action] === null, `${code}-${action}-unused`);
  }
  check(errors, runs?.total === expected.runs[0] && runs?.cancelled === expected.runs[1]
    && runs?.succeeded === expected.runs[2], `${code}-task-runs`);
  check(errors, audits?.denied === expected.audits[0] && audits?.confirmed === expected.audits[1], `${code}-audits`);
  const appItems = targetKind === "app" ? expected.history[0] : 0;
  const localShortcutItems = targetKind === "local-shortcut" ? expected.history[0] : 0;
  check(errors, history?.items === expected.history[0] && history?.firstUseCount === expected.history[1]
    && history?.secondUseCount === expected.history[2]
    && (schemaVersion < 2 || history?.appItems === appItems && history?.localShortcutItems === localShortcutItems),
  `${code}-history`);
  check(errors, witness?.deliveredEvents === expected.events
    && (expected.events === 0 ? witness?.payloadIsNull === null : witness?.payloadIsNull === true), `${code}-native-witness`);
  check(errors, witness?.targetLabel === "main", `${code}-native-main-witness-target`);
  check(errors, probeCounts?.started === expected.probes[0] && probeCounts?.exited === expected.probes[1]
    && probeCounts?.liveProcesses === expected.probes[2] && probeCounts?.pendingLaunches === expected.probes[3], `${code}-probe-counts`);

  check(errors, listeners?.focusEvents?.deliveredEvents === 0, `${code}-focus-events-zero`);
  check(errors, listeners?.appLaunched?.eventSource?.deliveredEvents === expected.events
    && listeners?.appLaunched?.invalidPayloads === 0, `${code}-app-launched-events`);
  const eventNames = ["focusEvents", "appState", "appCatalog", "appLaunched", "contextMenu",
    ...(schemaVersion >= 2 ? ["localShortcutEvents"] : [])];
  for (const name of eventNames) {
    const source = name === "focusEvents" || name === "localShortcutEvents" ? listeners?.[name]
      : listeners?.[name]?.eventSource;
    check(errors, zeroEventSource(source), `${code}-${name}-event-errors`);
  }
  check(errors, listeners?.appState?.queuedMutations === 0
    && listeners?.appState?.invalidPayloads === 0 && listeners?.appState?.mutationFailures === 0
    && listeners?.appState?.applyErrors === 0 && listeners?.appState?.callbackErrors === 0,
  `${code}-app-state-errors`);
  check(errors, (expected.events === 0
    ? listeners?.appState?.revision === null
    : listeners?.appState?.revision === expected.events)
    && listeners?.appState?.acceptedEvents + listeners?.appState?.acceptedReplies === expected.events
    && listeners?.appState?.stalePayloads === expected.events
    && listeners?.appState?.eventSource?.deliveredEvents === expected.events,
  `${code}-app-state-revision-delivery`);
  check(errors, listeners?.appCatalog?.readPending === false
    && listeners?.appCatalog?.cachedApps === (disposed ? 0 : schemaVersion >= 2 && targetKind === "local-shortcut" ? 0 : 2),
    `${code}-app-catalog-ready`);
  check(errors, listeners?.contextMenu?.showInFlight === false && listeners?.contextMenu?.showFailures === 0
    && listeners?.contextMenu?.invalidEvents === 0 && listeners?.contextMenu?.callbackErrors === 0,
  `${code}-context-menu-idle`);
  check(errors, listeners?.settingsView?.pendingOpen === false && listeners?.settingsView?.openFailures === 0
    && listeners?.settingsView?.closeFailures === 0 && listeners?.settingsView?.invalidPayloads === 0
    && listeners?.settingsView?.registrationErrors === 0 && listeners?.settingsView?.cleanupErrors === 0,
  `${code}-settings-view-idle`);
  if (schemaVersion >= 2) {
    const input = listeners?.settingsView?.input;
    check(errors, input?.callbacks === (disposed ? 0 : 5)
      && ["invalidPayloads", "stalePayloads", "callbackErrors", "notifyFailures", "staleReplies"].every(key => zero(input?.[key]))
      && input?.notifyPending === false && input?.notifyInFlight === false && input?.disposed === disposed,
    `${code}-settings-view-input`);
  }
  check(errors, listeners?.generalPreferenceEvents?.invalidPayloads === 0, `${code}-general-preference-errors`);
  check(errors, drag?.pending === 0 && drag?.queued === 0 && drag?.inFlight === null
    && drag?.queuedMoves === 0 && drag?.queuedLocks === 0 && drag?.lockRequests === expected.locks
    && drag?.dispatchedLocks === expected.locks && drag?.failures === 0 && drag?.rejectedOperations === 0
    && drag?.cancelledReads === 0 && drag?.droppedAfterDispose === 0,
  `${code}-window-drag-settled`);

  const subscriptionCountValid = source => isRecord(source)
    && (disposed ? source.subscribers === 0 : count(source.subscribers) && source.subscribers > 0);
  check(errors, subscriptionCountValid(listeners?.focusEvents), `${code}-focus-subscribers`);
  for (const name of ["appState", "appCatalog", "appLaunched", "contextMenu",
    ...(schemaVersion >= 2 ? ["localShortcutEvents"] : [])]) {
    const source = name === "localShortcutEvents" ? listeners?.[name] : listeners?.[name]?.eventSource;
    check(errors, subscriptionCountValid(source), `${code}-${name}-subscribers`);
  }
  check(errors, count(listeners?.appState?.historySubscribers) && count(listeners?.appState?.pinnedSubscribers)
    && (disposed ? listeners?.appState?.historySubscribers === 0 && listeners?.appState?.pinnedSubscribers === 0
      : listeners?.appState?.historySubscribers > 0 && listeners?.appState?.pinnedSubscribers > 0),
  `${code}-app-state-subscribers`);
  check(errors, count(listeners?.contextMenu?.subscribers)
    && (disposed ? listeners?.contextMenu?.subscribers === 0 : listeners?.contextMenu?.subscribers > 0),
  `${code}-context-menu-subscribers`);
  check(errors, listeners?.focusEvents?.listenerState === (disposed ? "disposed" : "listening"), `${code}-focus-listener-state`);
  check(errors, listeners?.appState?.disposed === disposed
    && listeners?.appState?.eventSource?.listenerState === (disposed ? "disposed" : "listening"), `${code}-app-state-disposal`);
  check(errors, listeners?.appCatalog?.eventSource?.listenerState === (disposed ? "disposed" : "listening"), `${code}-app-catalog-state`);
  check(errors, listeners?.appLaunched?.eventSource?.listenerState === (disposed ? "disposed" : "listening"), `${code}-app-launched-state`);
  check(errors, listeners?.contextMenu?.disposed === disposed
    && listeners?.contextMenu?.eventSource?.listenerState === (disposed ? "disposed" : "listening"), `${code}-context-menu-disposal`);
  if (schemaVersion >= 2) {
    const localEvents = listeners?.localShortcutEvents;
    check(errors, localEvents?.listenerState === (disposed ? "disposed" : "listening"), `${code}-local-shortcut-listener-state`);
    check(errors, disposed ? localEvents?.subscribers === 0
      : count(localEvents?.subscribers) && localEvents.subscribers > 0, `${code}-local-shortcut-subscribers`);
    check(errors, localEvents?.invalidEvents === 0 && localEvents?.staleEvents === 0, `${code}-local-shortcut-errors`);
    if (disposed) check(errors, localEvents?.latestRevision === null && localEvents?.replayPending === false,
      `${code}-local-shortcut-disposal`);
  }
  check(errors, listeners?.settingsView?.listenerState === (disposed ? "disposed" : "listening"), `${code}-settings-view-state`);
  check(errors, drag?.disposed === disposed, `${code}-window-drag-disposal`);
}

function validateProbe(value, index, runId, hostPid, errors) {
  const code = `probe-${PROBE_IDS[index]}`;
  check(errors, exactKeys(value, PROBE_KEYS), `${code}-shape`);
  if (!isRecord(value)) return;
  check(errors, value.probeId === PROBE_IDS[index] && value.bundleName === PROBE_NAMES[index], `${code}-identity`);
  check(errors, value.backgroundOnly === true, `${code}-background-only`);
  const marker = value.marker;
  check(errors, exactKeys(marker, PROBE_MARKER_KEYS), `${code}-marker-shape`);
  if (!isRecord(marker)) return;
  check(errors, marker.started === true && marker.exiting === true && marker.runIdMatched === true
    && marker.probeIdMatched === true && Number.isSafeInteger(marker.pid) && marker.pid > 0
    && marker.pid !== hostPid && marker.processTerminal === true,
  `${code}-terminal-marker`);
  check(errors, runId.length === 32 && marker.runIdMatched === true, `${code}-run-id`);
}

function validateLaunchReturnNativeReportInner(report, expected, errors) {
  check(errors, exactKeys(report, report?.schemaVersion === 3 ? [...TOP_KEYS, "registration"] : TOP_KEYS), "top-level-shape");
  if (!isRecord(report)) return;
  const owner = isRecord(expected) ? expected : {};
  const targetKind = owner.targetKind;
  const schemaVersion = report.schemaVersion;
  const registrationSource = owner.registrationSource;
  check(errors, registrationSource === "core-seed" || registrationSource === "settings-child", "expected-registration-source");
  check(errors, targetKind === "app" || targetKind === "local-shortcut", "expected-target-kind");
  check(errors, [1, 2, 3].includes(schemaVersion), "report-schema-version");
  check(errors, schemaVersion === 3 ? registrationSource === "settings-child" && targetKind === "local-shortcut"
    && owner.requiredSchemaVersion === 3 : registrationSource === "core-seed", "report-registration-source-binding");
  if (schemaVersion === 3) errors.push(...validateLaunchReturnSettingsRegistration(report.registration, owner).errors);
  if (owner.requiredSchemaVersion !== undefined) {
    check(errors, schemaVersion === owner.requiredSchemaVersion, "required-report-schema-version");
  }
  if (schemaVersion === 1) check(errors, targetKind === "app", "legacy-schema-local-target");
  check(errors, [1, 2, 3].includes(schemaVersion) && report.journey === "launch-return"
    && report.scope === LAUNCH_RETURN_NATIVE_SCOPE, "report-contract");
  check(errors, typeof report.runId === "string" && /^[0-9a-f]{32}$/.test(report.runId), "run-id");
  check(errors, typeof report.identifier === "string" && report.identifier === `dev.atools.renderer-smoke.${report.runId}`,
    "identifier");
  check(errors, typeof report.root === "string" && isAbsolute(report.root) && normalize(report.root) === report.root,
    "fixture-root");
  check(errors, Number.isSafeInteger(report.pid) && report.pid > 0, "host-pid");
  check(errors, report.passed === true, "native-passed-false");
  check(errors, Array.isArray(report.errors) && report.errors.length === 0
    && report.errors.every(error => typeof error === "string" && /^[a-z0-9._-]{1,120}$/i.test(error)), "report-errors");

  const metadataKeys = schemaVersion === 3 ? METADATA_KEYS_V3 : schemaVersion >= 2 ? METADATA_KEYS_V2 : METADATA_KEYS_V1;
  const expectedCatalogItems = schemaVersion >= 2 && targetKind === "local-shortcut" ? 0 : 2;
  const expectedLocalShortcutItems = schemaVersion >= 2 && targetKind === "local-shortcut" ? 2 : 0;
  check(errors, exactKeys(report.metadata, metadataKeys), "metadata-shape");
  if (schemaVersion === 3) check(errors, report.metadata?.registrationSource === "settings-child", "metadata-registration-source");
  check(errors, report.metadata?.ownedFixture === true && report.metadata?.catalogItems === expectedCatalogItems
    && report.metadata?.windowPolicy === "hidden-no-foreground" && report.metadata?.dataStorePersistent === false
    && report.metadata?.backgroundOnly === true && report.metadata?.autoClear === "never"
    && (schemaVersion < 2 || report.metadata?.targetKind === targetKind
      && report.metadata?.localShortcutItems === expectedLocalShortcutItems), "metadata-policy");
  check(errors, exactKeys(report.clipboard, CLIPBOARD_KEYS)
    && CLIPBOARD_KEYS.every(key => report.clipboard[key] === 0), "clipboard-zero");

  check(errors, Array.isArray(report.stages) && report.stages.length === LAUNCH_RETURN_NATIVE_STAGES.length,
    "stage-count");
  if (Array.isArray(report.stages)) {
    for (let index = 0; index < LAUNCH_RETURN_NATIVE_STAGES.length; index += 1) {
      const stage = report.stages[index];
      const code = `stage-${LAUNCH_RETURN_NATIVE_STAGES[index]}`;
      check(errors, exactKeys(stage, STAGE_KEYS), `${code}-shape`);
      if (!isRecord(stage)) continue;
      check(errors, stage.name === LAUNCH_RETURN_NATIVE_STAGES[index], `${code}-order`);
      check(errors, ["observed", "failed", "not_run"].includes(stage.status), `${code}-status`);
      if (stage.dom !== null) validateDom(stage.dom, `${code}-dom`, errors, schemaVersion);
      if (stage.native !== null) validateNative(stage.native, `${code}-native`, errors, schemaVersion);
      validateStageSemantics(stage, index, targetKind, schemaVersion, errors);
      if (schemaVersion === 3) check(errors,
        stage.dom?.adapter?.listeners?.localShortcutEvents?.deliveredEvents === report.registration?.mainEvents?.cleaned
          && stage.dom?.adapter?.listeners?.localShortcutEvents?.latestRevision === (index === 6 ? null : 8),
        `${code}-registration-events-preserved`);
    }
  }

  check(errors, Array.isArray(report.probes) && report.probes.length === PROBE_IDS.length, "probe-count");
  if (Array.isArray(report.probes)) {
    for (let index = 0; index < PROBE_IDS.length; index += 1) validateProbe(report.probes[index], index, report.runId, report.pid, errors);
    const probePids = report.probes.map(probe => probe?.marker?.pid);
    check(errors, Number.isSafeInteger(probePids[0]) && probePids[0] > 0
      && Number.isSafeInteger(probePids[1]) && probePids[1] > 0 && probePids[0] !== probePids[1],
    "probe-pid-uniqueness");
  }

  check(errors, owner.runId === report.runId && owner.identifier === report.identifier
    && owner.root === report.root && owner.pid === report.pid, "expected-owner-mismatch");
  check(errors, typeof owner.root === "string" && isAbsolute(owner.root) && normalize(owner.root) === owner.root,
    "expected-root-invalid");
  check(errors, Number.isSafeInteger(owner.pid) && owner.pid > 0, "expected-pid-invalid");
  check(errors, markerMatches(owner.marker, owner.root, owner.pid)
    && exactKeys(owner.marker, ["schemaVersion", "pid", "identifier", "root"])
    && owner.marker.schemaVersion === 1 && owner.marker.identifier === owner.identifier,
  "owner-marker-mismatch");
}

/** Validates the closed native report and its independently read fixture owner marker. Never throws on malformed input. */
export function validateLaunchReturnNativeReport(report, expectedOwner) {
  const errors = [];
  let passed = false;
  try { validateLaunchReturnNativeReportInner(report, expectedOwner, errors); }
  catch { errors.push("validator-input-invalid"); }
  try { passed = report?.passed === true; }
  catch { errors.push("validator-input-invalid"); }
  return { valid: errors.length === 0, errors: [...new Set(errors)], passed };
}
