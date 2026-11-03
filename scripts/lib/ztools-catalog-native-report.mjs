import { markerMatches } from "./ztools-renderer-native-runtime.mjs";

export const CATALOG_NATIVE_SCOPE = "hidden-original-vue-real-catalog-events";
export const CATALOG_NATIVE_STAGES = Object.freeze(["initial", "added", "removed", "disposed", "post-dispose"]);

const TOP_KEYS = ["schemaVersion", "journey", "scope", "identifier", "root", "pid", "autoClear", "passed", "metadata", "clipboard", "staleLaunch", "errors", "stages"];
const METADATA_KEYS = ["ownedFixture", "rootCount", "windowPolicy", "dataStorePersistent"];
const CLIPBOARD_KEYS = ["reads", "writes", "pastes"];
const STALE_LAUNCH_KEYS = ["rejected", "taskRunsBefore", "taskRunsAfter", "historyBefore", "historyAfter"];
const STAGE_KEYS = ["stage", "elapsedMs", "dom", "native", "errors"];
const DOM_KEYS = ["inputFound", "inputValue", "titles", "documentVisibility", "documentHasFocus", "appListCalls", "catalogDeliveredEvents", "catalogSubscriberCount", "pendingNativeCalls", "appReadPending", "disposed", "icon", "eventSources", "settingsView", "nativeCatalogEvents", "witnessStopped"];
const EVENT_SOURCE_KEYS = ["subscribers", "listenerState", "deliveredEvents", "registrationErrors", "callbackErrors", "registrationsPending", "cleanupPending", "cleanupErrors"];
const SETTINGS_VIEW_KEYS = ["listenerState", "registrationErrors", "cleanupErrors"];
const NATIVE_KEYS = ["visible", "focused", "focusGainedEvents", "activeChildLayouts", "childWebviews", "dataStorePersistent", "catalogItems"];
const ICON_KEYS = ["complete", "width", "height", "analysisSucceeded"];
const EVENT_SOURCE_NAMES = ["focusEvents", "appState", "contextMenu", "appCatalog"];
const CATALOG_TITLES = [
  ["ATools Catalog Initial"],
  ["ATools Catalog Added", "ATools Catalog Initial"],
  ["ATools Catalog Initial"],
  ["ATools Catalog Initial"],
  ["ATools Catalog Initial"],
];
const CATALOG_ITEM_COUNTS = [1, 2, 1, 1, 2];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isObject(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function requireEvidence(errors, condition, name) {
  if (!condition) errors.push(name);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function countIncreases(previous, current, field) {
  const before = previous?.[field];
  const after = current?.[field];
  return isCount(before) && isCount(after) && after > before;
}

function countDoesNotDecrease(previous, current, field) {
  const before = previous?.[field];
  const after = current?.[field];
  return isCount(before) && isCount(after) && after >= before;
}

function countIsStable(previous, current, field) {
  const before = previous?.[field];
  const after = current?.[field];
  return isCount(before) && isCount(after) && after === before;
}

function isEmptyErrors(value) {
  return Array.isArray(value) && value.length === 0;
}

function validateEventSource(source, name, state, errors) {
  requireEvidence(errors, exactKeys(source, EVENT_SOURCE_KEYS), `event-source-${name}-shape`);
  requireEvidence(errors, source?.listenerState === state, `event-source-${name}-state`);
  requireEvidence(errors, isCount(source?.subscribers)
    && (state === "listening" ? source.subscribers >= (name === "appCatalog" ? 2 : 1) : source.subscribers === 0),
  `event-source-${name}-subscribers`);
  for (const field of ["deliveredEvents", "registrationErrors", "callbackErrors", "registrationsPending", "cleanupPending", "cleanupErrors"]) {
    requireEvidence(errors, isCount(source?.[field]), `event-source-${name}-${field}-integer`);
  }
  for (const field of ["registrationErrors", "callbackErrors", "registrationsPending", "cleanupPending", "cleanupErrors"]) {
    requireEvidence(errors, source?.[field] === 0, `event-source-${name}-${field}-zero`);
  }
}

function validIcon(icon) {
  return exactKeys(icon, ICON_KEYS) && icon.complete === true && icon.width === 64
    && icon.height === 64 && icon.analysisSucceeded === true;
}

function validateStage(stage, index, previousElapsed, errors) {
  const name = CATALOG_NATIVE_STAGES[index];
  const active = index < 3;
  const expectedTitles = CATALOG_TITLES[index];
  requireEvidence(errors, exactKeys(stage, STAGE_KEYS), `stage-${name}-shape`);
  requireEvidence(errors, stage?.stage === name, `stage-${name}-identity`);
  requireEvidence(errors, Number.isFinite(stage?.elapsedMs) && stage.elapsedMs >= 0
    && stage.elapsedMs <= 120_000 && stage.elapsedMs >= previousElapsed, `stage-${name}-elapsed`);
  requireEvidence(errors, isEmptyErrors(stage?.errors), `stage-${name}-errors-empty`);

  const dom = stage?.dom;
  requireEvidence(errors, exactKeys(dom, DOM_KEYS), `stage-${name}-dom-shape`);
  requireEvidence(errors, dom?.inputFound === true && dom?.inputValue === "ATools Catalog", `stage-${name}-search-input`);
  requireEvidence(errors, JSON.stringify(dom?.titles) === JSON.stringify(expectedTitles), `stage-${name}-titles`);
  requireEvidence(errors, dom?.documentVisibility === "hidden", `stage-${name}-document-hidden`);
  requireEvidence(errors, dom?.documentHasFocus === false, `stage-${name}-document-unfocused`);
  requireEvidence(errors, isCount(dom?.appListCalls) && dom.appListCalls >= 1, `stage-${name}-app-list-calls`);
  requireEvidence(errors, isCount(dom?.catalogDeliveredEvents), `stage-${name}-catalog-events`);
  requireEvidence(errors, isCount(dom?.catalogSubscriberCount), `stage-${name}-catalog-subscribers`);
  requireEvidence(errors, dom?.pendingNativeCalls === 0, `stage-${name}-native-calls-settled`);
  requireEvidence(errors, dom?.appReadPending === false, `stage-${name}-app-read-settled`);
  requireEvidence(errors, dom?.disposed === !active, `stage-${name}-disposed-state`);
  requireEvidence(errors, isCount(dom?.nativeCatalogEvents), `stage-${name}-native-catalog-events`);
  requireEvidence(errors, dom?.witnessStopped === (name === "post-dispose"), `stage-${name}-witness-state`);

  if (index < 2) requireEvidence(errors, validIcon(dom?.icon), `stage-${name}-icon`);
  else requireEvidence(errors, dom?.icon === null, `stage-${name}-icon-cleared`);

  requireEvidence(errors, exactKeys(dom?.eventSources, EVENT_SOURCE_NAMES), `stage-${name}-event-sources-shape`);
  const eventState = active ? "listening" : "disposed";
  for (const sourceName of EVENT_SOURCE_NAMES) {
    validateEventSource(dom?.eventSources?.[sourceName], sourceName, eventState, errors);
  }
  requireEvidence(errors, dom?.catalogSubscriberCount === dom?.eventSources?.appCatalog?.subscribers,
    `stage-${name}-catalog-subscriber-match`);
  requireEvidence(errors, dom?.catalogDeliveredEvents === dom?.eventSources?.appCatalog?.deliveredEvents,
    `stage-${name}-catalog-event-match`);
  requireEvidence(errors, exactKeys(dom?.settingsView, SETTINGS_VIEW_KEYS), `stage-${name}-settings-view-shape`);
  requireEvidence(errors, dom?.settingsView?.listenerState === eventState, `stage-${name}-settings-view-state`);
  requireEvidence(errors, dom?.settingsView?.registrationErrors === 0 && dom?.settingsView?.cleanupErrors === 0,
    `stage-${name}-settings-view-errors-zero`);

  const native = stage?.native;
  requireEvidence(errors, exactKeys(native, NATIVE_KEYS), `stage-${name}-native-shape`);
  requireEvidence(errors, native?.visible === false && native?.focused === false, `stage-${name}-native-hidden-unfocused`);
  requireEvidence(errors, native?.focusGainedEvents === 0, `stage-${name}-focus-gained-zero`);
  requireEvidence(errors, native?.activeChildLayouts === 0, `stage-${name}-child-layouts-zero`);
  requireEvidence(errors, native?.childWebviews === 0, `stage-${name}-child-webviews-zero`);
  requireEvidence(errors, native?.dataStorePersistent === false, `stage-${name}-data-store-nonpersistent`);
  requireEvidence(errors, native?.catalogItems === CATALOG_ITEM_COUNTS[index], `stage-${name}-catalog-item-count`);
  return Number.isFinite(stage?.elapsedMs) ? stage.elapsedMs : previousElapsed;
}

function safeErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).map(error => typeof error === "string" && /^[a-z0-9._-]{1,120}$/i.test(error)
    ? error : "unrecognized-native-error");
}

function safeCountFields(value, keys) {
  if (!isObject(value)) return null;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key))
    .map(key => [key, isCount(value[key]) ? value[key] : null]));
}

function safeEventSource(source) {
  if (!isObject(source)) return null;
  return {
    subscribers: isCount(source.subscribers) ? source.subscribers : null,
    listenerState: ["idle", "registering", "listening", "failed", "disposed"].includes(source.listenerState)
      ? source.listenerState : null,
    deliveredEvents: isCount(source.deliveredEvents) ? source.deliveredEvents : null,
    registrationErrors: isCount(source.registrationErrors) ? source.registrationErrors : null,
    callbackErrors: isCount(source.callbackErrors) ? source.callbackErrors : null,
    registrationsPending: isCount(source.registrationsPending) ? source.registrationsPending : null,
    cleanupPending: isCount(source.cleanupPending) ? source.cleanupPending : null,
    cleanupErrors: isCount(source.cleanupErrors) ? source.cleanupErrors : null,
  };
}

function safeSettingsView(view) {
  if (!isObject(view)) return null;
  return {
    listenerState: ["idle", "registering", "listening", "failed", "disposed"].includes(view.listenerState)
      ? view.listenerState : null,
    registrationErrors: isCount(view.registrationErrors) ? view.registrationErrors : null,
    cleanupErrors: isCount(view.cleanupErrors) ? view.cleanupErrors : null,
  };
}

function safeStage(stage) {
  if (!isObject(stage)) return null;
  const dom = stage.dom;
  const sources = isObject(dom?.eventSources) ? Object.fromEntries(EVENT_SOURCE_NAMES
    .filter(name => isObject(dom.eventSources[name]))
    .map(name => [name, safeEventSource(dom.eventSources[name])])) : null;
  const settingsView = safeSettingsView(dom?.settingsView);
  const safeDom = isObject(dom) ? {
    inputFound: dom.inputFound === true,
    inputValue: dom.inputValue === "ATools Catalog" ? dom.inputValue : null,
    titles: Array.isArray(dom.titles) ? dom.titles.filter(title => CATALOG_TITLES.flat().includes(title)).slice(0, 2) : [],
    documentVisibility: dom.documentVisibility === "hidden" || dom.documentVisibility === "visible" ? dom.documentVisibility : null,
    documentHasFocus: dom.documentHasFocus === true ? true : dom.documentHasFocus === false ? false : null,
    appListCalls: isCount(dom.appListCalls) ? dom.appListCalls : null,
    catalogDeliveredEvents: isCount(dom.catalogDeliveredEvents) ? dom.catalogDeliveredEvents : null,
    catalogSubscriberCount: isCount(dom.catalogSubscriberCount) ? dom.catalogSubscriberCount : null,
    pendingNativeCalls: isCount(dom.pendingNativeCalls) ? dom.pendingNativeCalls : null,
    appReadPending: typeof dom.appReadPending === "boolean" ? dom.appReadPending : null,
    disposed: typeof dom.disposed === "boolean" ? dom.disposed : null,
    icon: dom.icon === null ? null : validIcon(dom.icon) ? { complete: true, width: 64, height: 64, analysisSucceeded: true } : null,
    eventSources: sources,
    settingsView,
    nativeCatalogEvents: isCount(dom.nativeCatalogEvents) ? dom.nativeCatalogEvents : null,
    witnessStopped: typeof dom.witnessStopped === "boolean" ? dom.witnessStopped : null,
  } : null;
  const native = isObject(stage.native) ? {
    visible: typeof stage.native.visible === "boolean" ? stage.native.visible : null,
    focused: typeof stage.native.focused === "boolean" ? stage.native.focused : null,
    focusGainedEvents: isCount(stage.native.focusGainedEvents) ? stage.native.focusGainedEvents : null,
    activeChildLayouts: isCount(stage.native.activeChildLayouts) ? stage.native.activeChildLayouts : null,
    childWebviews: isCount(stage.native.childWebviews) ? stage.native.childWebviews : null,
    dataStorePersistent: typeof stage.native.dataStorePersistent === "boolean" ? stage.native.dataStorePersistent : null,
    catalogItems: isCount(stage.native.catalogItems) ? stage.native.catalogItems : null,
  } : null;
  return {
    stage: CATALOG_NATIVE_STAGES.includes(stage.stage) ? stage.stage : null,
    elapsedMs: Number.isFinite(stage.elapsedMs) ? stage.elapsedMs : null,
    dom: safeDom,
    native,
    errors: safeErrors(stage.errors),
  };
}

export function validateCatalogNativeMode(report, {
  autoClear = "never", marker, fixtureRoot, childPid, expectedIdentifier,
} = {}) {
  const errors = [];
  requireEvidence(errors, exactKeys(report, TOP_KEYS), "top-level-shape");
  requireEvidence(errors, report?.schemaVersion === 1, "schema-version");
  requireEvidence(errors, report?.journey === "catalog", "journey-catalog");
  requireEvidence(errors, report?.scope === CATALOG_NATIVE_SCOPE, "scope-catalog-hidden");
  const ownerValid = markerMatches(marker, fixtureRoot, childPid);
  requireEvidence(errors, ownerValid, "owner-marker-mismatch");
  requireEvidence(errors, typeof expectedIdentifier === "string" && marker?.identifier === expectedIdentifier,
    "owner-identifier-run-id-mismatch");
  requireEvidence(errors, report?.identifier === marker?.identifier, "identifier-owner-mismatch");
  requireEvidence(errors, report?.identifier === expectedIdentifier, "identifier-run-id-mismatch");
  requireEvidence(errors, report?.root === fixtureRoot, "root-owner-mismatch");
  requireEvidence(errors, report?.pid === childPid && Number.isSafeInteger(report?.pid), "pid-child-mismatch");
  requireEvidence(errors, autoClear === "never" && report?.autoClear === "never", "auto-clear-never");
  requireEvidence(errors, report?.passed === true, "native-passed-false");

  requireEvidence(errors, exactKeys(report?.metadata, METADATA_KEYS), "metadata-shape");
  requireEvidence(errors, report?.metadata?.ownedFixture === true && report?.metadata?.rootCount === 1,
    "metadata-owned-fixture");
  requireEvidence(errors, report?.metadata?.windowPolicy === "hidden-no-foreground", "metadata-window-policy");
  requireEvidence(errors, report?.metadata?.dataStorePersistent === false, "metadata-data-store-nonpersistent");

  requireEvidence(errors, exactKeys(report?.clipboard, CLIPBOARD_KEYS), "clipboard-shape");
  for (const field of CLIPBOARD_KEYS) requireEvidence(errors, report?.clipboard?.[field] === 0, `clipboard-${field}-zero`);
  requireEvidence(errors, exactKeys(report?.staleLaunch, STALE_LAUNCH_KEYS), "stale-launch-shape");
  requireEvidence(errors, report?.staleLaunch?.rejected === true, "stale-launch-rejected");
  for (const field of STALE_LAUNCH_KEYS.slice(1)) {
    requireEvidence(errors, report?.staleLaunch?.[field] === 0, `stale-launch-${field}-zero`);
  }
  requireEvidence(errors, isEmptyErrors(report?.errors), "native-errors-empty");

  const stages = report?.stages;
  requireEvidence(errors, Array.isArray(stages) && stages.length === CATALOG_NATIVE_STAGES.length, "stage-count");
  let previousElapsed = 0;
  if (Array.isArray(stages)) {
    for (let index = 0; index < CATALOG_NATIVE_STAGES.length; index += 1) {
      previousElapsed = validateStage(stages[index], index, previousElapsed, errors);
    }
  }
  if (Array.isArray(stages) && stages.length === CATALOG_NATIVE_STAGES.length) {
    const doms = stages.map(stage => stage?.dom);
    for (let index = 1; index < 3; index += 1) {
      requireEvidence(errors, countIncreases(doms[index - 1], doms[index], "appListCalls"),
        `catalog-stage-${CATALOG_NATIVE_STAGES[index]}-app-read-increment`);
      requireEvidence(errors, countIncreases(doms[index - 1], doms[index], "catalogDeliveredEvents"),
      `catalog-stage-${CATALOG_NATIVE_STAGES[index]}-adapter-event-increment`);
      requireEvidence(errors, countIncreases(doms[index - 1], doms[index], "nativeCatalogEvents"),
      `catalog-stage-${CATALOG_NATIVE_STAGES[index]}-witness-event-increment`);
    }
    for (const field of ["appListCalls", "catalogDeliveredEvents"]) {
      requireEvidence(errors, countDoesNotDecrease(doms[2], doms[3], field),
        `catalog-disposed-${field}-monotonic`);
      requireEvidence(errors, countIsStable(doms[3], doms[4], field),
        `catalog-post-dispose-${field}-stable`);
    }
    requireEvidence(errors, countDoesNotDecrease(doms[2], doms[3], "nativeCatalogEvents"),
      "catalog-disposed-witness-event-monotonic");
    requireEvidence(errors, countIncreases(doms[3], doms[4], "nativeCatalogEvents"),
      "catalog-post-dispose-witness-event-increment");
    for (const sourceName of EVENT_SOURCE_NAMES) {
      requireEvidence(errors, countIsStable(
        doms[3]?.eventSources?.[sourceName], doms[4]?.eventSources?.[sourceName], "deliveredEvents",
      ),
      `catalog-post-dispose-${sourceName}-callbacks-stable`);
    }
  }

  return { journey: "catalog", valid: errors.length === 0, passed: report?.passed === true, errors };
}

export function summarizeCatalogNativeReport(reportFile, markerFile, options = {}) {
  const report = reportFile?.value;
  const marker = markerFile?.value;
  const ownerValid = markerFile?.exists === true
    && markerMatches(marker, options.fixtureRoot, options.childPid)
    && typeof options.expectedIdentifier === "string"
    && marker?.identifier === options.expectedIdentifier;
  if (!reportFile?.exists || !isObject(report)) {
    return {
      exists: typeof reportFile?.exists === "boolean" ? reportFile.exists : null,
      valid: false,
      schemaVersion: null,
      journey: null,
      scope: null,
      passed: false,
      metadataMatchesOwner: false,
      validationErrors: [reportFile?.exception?.code === "ENOENT" ? "native-report-missing" : "native-report-unreadable"],
      nativeErrors: [],
      owner: { exists: typeof markerFile?.exists === "boolean" ? markerFile.exists : null, valid: ownerValid },
      evidence: null,
    };
  }
  const mode = validateCatalogNativeMode(report, { ...options, marker });
  return {
    exists: true,
    valid: mode.valid && ownerValid,
    schemaVersion: Number.isSafeInteger(report.schemaVersion) ? report.schemaVersion : null,
    journey: report.journey === "catalog" ? report.journey : null,
    scope: report.scope === CATALOG_NATIVE_SCOPE ? report.scope : null,
    passed: report.passed === true,
    metadataMatchesOwner: ownerValid && report.identifier === marker?.identifier && report.root === options.fixtureRoot,
    validationErrors: mode.errors,
    nativeErrors: safeErrors(report.errors),
    owner: {
      exists: typeof markerFile?.exists === "boolean" ? markerFile.exists : null,
      valid: ownerValid,
      identifier: ownerValid ? marker.identifier : null,
      markerPidMatchesChild: markerFile?.exists === true && marker?.pid === options.childPid,
      rootMatchesFixture: markerFile?.exists === true && marker?.root === options.fixtureRoot,
    },
    evidence: {
      metadata: isObject(report.metadata) ? {
        ownedFixture: typeof report.metadata.ownedFixture === "boolean" ? report.metadata.ownedFixture : null,
        rootCount: isCount(report.metadata.rootCount) ? report.metadata.rootCount : null,
        windowPolicy: report.metadata.windowPolicy === "hidden-no-foreground" ? report.metadata.windowPolicy : null,
        dataStorePersistent: typeof report.metadata.dataStorePersistent === "boolean" ? report.metadata.dataStorePersistent : null,
      } : null,
      clipboard: safeCountFields(report.clipboard, CLIPBOARD_KEYS),
      staleLaunch: isObject(report.staleLaunch) ? {
        rejected: typeof report.staleLaunch.rejected === "boolean" ? report.staleLaunch.rejected : null,
        ...safeCountFields(report.staleLaunch, STALE_LAUNCH_KEYS.slice(1)),
      } : null,
      stages: Array.isArray(report.stages) ? report.stages.slice(0, CATALOG_NATIVE_STAGES.length).map(safeStage) : [],
    },
  };
}
