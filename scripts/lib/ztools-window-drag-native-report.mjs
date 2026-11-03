const SCOPE = "hidden-original-vue-searchbox-events";
const STAGES = Object.freeze([
  "baseline", "dragged", "resized", "released", "restored",
  "hide-locked", "hidden-cleared", "redragged", "navigated", "recovered",
]);
const TOP_KEYS = ["schemaVersion", "journey", "scope", "runId", "identifier", "root", "pid", "passed", "errors", "stages"];
const STAGE_KEYS = ["stage", "elapsedMs", "dom", "native", "errors"];
const DOM_KEYS = ["searchBoxFound", "inputEmpty", "documentVisibility", "documentHasFocus", "documentId", "positionRead", "outstandingNativeCalls", "rendererWindowDragCalls", "expandWindowCalls", "hideWindowCalls", "windowNotificationPendingReplies", "windowNotificationFailures", "drag"];
const DRAG_KEYS = ["pending", "queued", "inFlight", "pendingPositionReads", "queuedMoves", "queuedLocks", "positionReads", "moveRequests", "lockRequests", "dispatchedPositions", "dispatchedMoves", "dispatchedLocks", "coalescedMoves", "rejectedOperations", "failures", "cancelledReads", "droppedAfterDispose", "disposed"];
const NATIVE_KEYS = ["position", "innerSize", "scaleFactor", "locked", "visible", "focused", "focusGainedEvents", "activeChildLayouts", "childWebviews", "dataStorePersistent", "documentGeneration", "pageLoadStarts", "pageLoadFinishes", "documentId"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function close(left, right, tolerance) {
  return finite(left) && finite(right) && Math.abs(left - right) <= tolerance;
}

function add(errors, condition, name) {
  if (!condition) errors.push(name);
}

function validPoint(value) {
  return exactKeys(value, ["x", "y"]) && finite(value.x) && finite(value.y);
}

function validSize(value) {
  return exactKeys(value, ["width", "height"]) && finite(value.width) && finite(value.height)
    && value.width > 0 && value.height > 0;
}

function validDocumentId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function sameGeometry(left, right) {
  return close(left?.position?.x, right?.position?.x, 1)
    && close(left?.position?.y, right?.position?.y, 1)
    && close(left?.innerSize?.width, right?.innerSize?.width, 0.75)
    && close(left?.innerSize?.height, right?.innerSize?.height, 0.75);
}

function validateStage(stage, index, priorStages, errors) {
  const name = STAGES[index];
  add(errors, exactKeys(stage, STAGE_KEYS), `stage-${name}-shape`);
  add(errors, stage?.stage === name, `stage-${name}-identity`);
  const previousElapsed = index === 0 ? 0 : priorStages[index - 1]?.elapsedMs;
  add(errors, finite(stage?.elapsedMs) && stage.elapsedMs >= 0 && stage.elapsedMs <= 120_000
    && (index === 0 || (finite(previousElapsed) && stage.elapsedMs >= previousElapsed)), `stage-${name}-elapsed`);
  add(errors, Array.isArray(stage?.errors) && stage.errors.length === 0, `stage-${name}-errors`);

  const dom = stage?.dom;
  add(errors, exactKeys(dom, DOM_KEYS), `stage-${name}-dom-shape`);
  add(errors, dom?.searchBoxFound === true && dom?.inputEmpty === true, `stage-${name}-original-searchbox`);
  add(errors, dom?.documentVisibility === "hidden" && typeof dom?.documentHasFocus === "boolean", `stage-${name}-dom-hidden`);
  add(errors, validDocumentId(dom?.documentId), `stage-${name}-dom-document-id`);
  for (const key of ["outstandingNativeCalls", "rendererWindowDragCalls", "expandWindowCalls", "hideWindowCalls", "windowNotificationPendingReplies", "windowNotificationFailures"]) {
    add(errors, count(dom?.[key]), `stage-${name}-${key}-count`);
  }
  add(errors, dom?.outstandingNativeCalls === 0 && dom.windowNotificationPendingReplies === 0
    && dom.windowNotificationFailures === 0, `stage-${name}-host-calls-settled`);

  const drag = dom?.drag;
  add(errors, exactKeys(drag, DRAG_KEYS), `stage-${name}-drag-shape`);
  for (const key of DRAG_KEYS.filter(key => key !== "inFlight" && key !== "disposed")) {
    add(errors, count(drag?.[key]), `stage-${name}-drag-${key}-count`);
  }
  add(errors, drag?.disposed === false && drag?.pending === 0 && drag?.queued === 0 && drag?.inFlight === null
    && drag?.pendingPositionReads === 0 && drag?.queuedMoves === 0 && drag?.queuedLocks === 0,
  `stage-${name}-drag-not-settled`);
  add(errors, drag?.rejectedOperations === 0 && drag?.failures === 0 && drag?.cancelledReads === 0
    && drag?.droppedAfterDispose === 0, `stage-${name}-drag-errors`);

  const native = stage?.native;
  add(errors, exactKeys(native, NATIVE_KEYS), `stage-${name}-native-shape`);
  add(errors, validPoint(native?.position) && validSize(native?.innerSize), `stage-${name}-geometry`);
  add(errors, finite(native?.scaleFactor) && native.scaleFactor > 0, `stage-${name}-scale`);
  add(errors, typeof native?.locked === "boolean", `stage-${name}-lock-known`);
  add(errors, native?.visible === false && native?.focused === false && native?.focusGainedEvents === 0,
    `stage-${name}-native-hidden-unfocused`);
  add(errors, native?.activeChildLayouts === 0 && native?.childWebviews === 0
    && native?.dataStorePersistent === false, `stage-${name}-isolation`);
  add(errors, count(native?.documentGeneration) && count(native?.pageLoadStarts)
    && count(native?.pageLoadFinishes), `stage-${name}-document-lifecycle-counts`);
  add(errors, validDocumentId(native?.documentId) && native?.documentId === dom?.documentId,
    `stage-${name}-document-identity`);
  const expectedGeneration = index < 8 ? 0 : 1;
  add(errors, native?.documentGeneration === expectedGeneration
    && native?.pageLoadStarts === expectedGeneration
    && native?.pageLoadFinishes === expectedGeneration, `stage-${name}-document-lifecycle`);

  if (index > 0) {
    const initialId = priorStages[0]?.native?.documentId;
    const previous = priorStages[index - 1];
    if (native?.documentId === previous?.native?.documentId) {
      add(errors, dom?.hideWindowCalls >= previous?.dom?.hideWindowCalls,
        `stage-${name}-hide-window-counter-monotonic`);
    }
    if (index < 8) {
      add(errors, native?.documentId === initialId, `stage-${name}-document-id-stable`);
    } else {
      add(errors, validDocumentId(initialId) && native?.documentId !== initialId,
        `stage-${name}-document-id-changed`);
      if (index === 9) {
        add(errors, native?.documentId === priorStages[8]?.native?.documentId,
          `stage-${name}-document-id-retained`);
      }
    }
  }

  if (index === 0) {
    add(errors, native?.locked === false, "baseline-unlocked");
    add(errors, validPoint(dom?.positionRead) && close(dom.positionRead.x, native?.position?.x, 0.75)
      && close(dom.positionRead.y, native?.position?.y, 0.75), "baseline-position-read");
    add(errors, drag?.positionReads >= 1 && drag?.dispatchedPositions >= 1
      && dom?.rendererWindowDragCalls >= 1, "baseline-position-read");
  }
  if (index === 1) {
    const before = priorStages[0];
    const dx = native?.position?.x - before?.native?.position?.x;
    const dy = native?.position?.y - before?.native?.position?.y;
    add(errors, native?.locked === true, "dragged-locked");
    add(errors, dom?.positionRead === null, "dragged-position-read-absent");
    add(errors, close(dx, 20, 1) && close(dy, 15, 1), "dragged-position-delta");
    add(errors, close(native?.innerSize?.width, before?.native?.innerSize?.width, 0.75)
      && close(native?.innerSize?.height, before?.native?.innerSize?.height, 0.75), "dragged-size-stable");
    add(errors, drag?.positionReads > before?.dom?.drag?.positionReads
      && drag?.dispatchedPositions > before?.dom?.drag?.dispatchedPositions
      && drag?.lockRequests > before?.dom?.drag?.lockRequests
      && drag?.dispatchedLocks > before?.dom?.drag?.dispatchedLocks
      && drag?.moveRequests >= before?.dom?.drag?.moveRequests + 3
      && drag?.dispatchedMoves > before?.dom?.drag?.dispatchedMoves
      && drag?.coalescedMoves > before?.dom?.drag?.coalescedMoves
      && dom?.rendererWindowDragCalls > before?.dom?.rendererWindowDragCalls, "dragged-production-api");
  }
  if (index === 2) {
    const before = priorStages[1];
    add(errors, dom?.positionRead === null, "resized-position-read-absent");
    add(errors, native?.locked === true, "resized-still-locked");
    add(errors, close(native?.innerSize?.width, before?.native?.innerSize?.width, 0.75)
      && native?.innerSize?.height > before?.native?.innerSize?.height + 8
      && native?.innerSize?.height <= before?.native?.innerSize?.height + 40, "resized-native-size");
    add(errors, dom?.expandWindowCalls > before?.dom?.expandWindowCalls, "resized-production-api");
  }
  if (index === 3) {
    const before = priorStages[2];
    add(errors, dom?.positionRead === null, "released-position-read-absent");
    add(errors, native?.locked === false, "released-unlocked");
    add(errors, close(native?.innerSize?.width, before?.native?.innerSize?.width, 0.75)
      && close(native?.innerSize?.height, before?.native?.innerSize?.height, 0.75)
      && close(native?.position?.x, before?.native?.position?.x, 1)
      && close(native?.position?.y, before?.native?.position?.y, 1), "released-geometry-stable");
    add(errors, drag?.lockRequests > before?.dom?.drag?.lockRequests
      && drag?.dispatchedLocks > before?.dom?.drag?.dispatchedLocks, "released-production-api");
  }
  if (index === 4) {
    const baseline = priorStages[0];
    const before = priorStages[3];
    add(errors, dom?.positionRead === null, "restored-position-read-absent");
    add(errors, native?.locked === false, "restored-unlocked");
    add(errors, close(native?.position?.x, baseline?.native?.position?.x, 1)
      && close(native?.position?.y, baseline?.native?.position?.y, 1)
      && close(native?.innerSize?.width, baseline?.native?.innerSize?.width, 0.75)
      && close(native?.innerSize?.height, baseline?.native?.innerSize?.height, 0.75), "restored-baseline-geometry");
    add(errors, drag?.moveRequests > before?.dom?.drag?.moveRequests
      && drag?.dispatchedMoves > before?.dom?.drag?.dispatchedMoves
      && dom?.expandWindowCalls > before?.dom?.expandWindowCalls, "restored-production-api");
  }
  if (index === 5) {
    const before = priorStages[4];
    add(errors, native?.locked === true, "hide-locked-lock-active");
    add(errors, dom?.positionRead === null && sameGeometry(native, before?.native), "hide-locked-geometry-stable");
    add(errors, drag?.lockRequests > before?.dom?.drag?.lockRequests
      && drag?.dispatchedLocks > before?.dom?.drag?.dispatchedLocks, "hide-locked-production-api");
  }
  if (index === 6) {
    const before = priorStages[5];
    add(errors, native?.locked === false, "hidden-cleared-unlocked");
    add(errors, dom?.positionRead === null && sameGeometry(native, before?.native), "hidden-cleared-geometry-stable");
    add(errors, dom?.hideWindowCalls > before?.dom?.hideWindowCalls, "hidden-cleared-production-hide-api");
  }
  if (index === 7) {
    const before = priorStages[6];
    const dx = native?.position?.x - before?.native?.position?.x;
    const dy = native?.position?.y - before?.native?.position?.y;
    add(errors, native?.locked === true, "redragged-locked");
    add(errors, dom?.positionRead === null, "redragged-position-read-absent");
    add(errors, close(dx, 8, 1) && close(dy, 6, 1), "redragged-position-delta");
    add(errors, close(native?.innerSize?.width, before?.native?.innerSize?.width, 0.75)
      && close(native?.innerSize?.height, before?.native?.innerSize?.height, 0.75), "redragged-size-stable");
    add(errors, drag?.lockRequests > before?.dom?.drag?.lockRequests
      && drag?.dispatchedLocks > before?.dom?.drag?.dispatchedLocks
      && drag?.moveRequests > before?.dom?.drag?.moveRequests
      && drag?.dispatchedMoves > before?.dom?.drag?.dispatchedMoves
      && dom?.rendererWindowDragCalls > before?.dom?.rendererWindowDragCalls, "redragged-production-api");
  }
  if (index === 8) {
    const before = priorStages[7];
    add(errors, native?.locked === false, "navigated-unlocked");
    add(errors, sameGeometry(native, before?.native), "navigated-geometry-stable");
    add(errors, validPoint(dom?.positionRead) && close(dom.positionRead.x, native?.position?.x, 0.75)
      && close(dom.positionRead.y, native?.position?.y, 0.75), "navigated-position-read");
    add(errors, drag?.positionReads >= 1 && drag?.dispatchedPositions >= 1
      && dom?.rendererWindowDragCalls >= 1, "navigated-production-api");
    add(errors, drag?.positionReads === 1 && drag?.dispatchedPositions === 1
      && drag?.moveRequests === 0 && drag?.lockRequests === 0
      && drag?.dispatchedMoves === 0 && drag?.dispatchedLocks === 0
      && dom?.rendererWindowDragCalls === 1
      && dom?.hideWindowCalls === 0, "navigated-adapter-counters-reset");
  }
  if (index === 9) {
    const baseline = priorStages[0];
    const before = priorStages[8];
    add(errors, native?.locked === false && dom?.positionRead === null, "recovered-unlocked");
    add(errors, sameGeometry(native, baseline?.native), "recovered-baseline-geometry");
    add(errors, drag?.lockRequests > before?.dom?.drag?.lockRequests
      && drag?.dispatchedLocks > before?.dom?.drag?.dispatchedLocks
      && drag?.moveRequests > before?.dom?.drag?.moveRequests
      && drag?.dispatchedMoves > before?.dom?.drag?.dispatchedMoves
      && dom?.expandWindowCalls > before?.dom?.expandWindowCalls, "recovered-production-api");
  }
}

export function validateWindowDragNativeReport(report, { runId, fixtureRoot, childPid, expectedIdentifier } = {}) {
  const errors = [];
  add(errors, exactKeys(report, TOP_KEYS), "report-shape");
  add(errors, report?.schemaVersion === 2 && report?.journey === "window-drag" && report?.scope === SCOPE,
    "report-contract");
  add(errors, report?.runId === runId && report?.identifier === expectedIdentifier
    && report?.root === fixtureRoot && report?.pid === childPid && Number.isSafeInteger(childPid), "report-owner-binding");
  add(errors, report?.passed === true, "native-passed");
  add(errors, Array.isArray(report?.errors) && report.errors.length === 0, "native-errors");
  add(errors, Array.isArray(report?.stages) && report.stages.length === STAGES.length, "stage-count");
  if (Array.isArray(report?.stages)) {
    for (let index = 0; index < STAGES.length; index += 1) {
      validateStage(report.stages[index], index, report.stages.slice(0, index), errors);
    }
  }
  const uniqueErrors = [...new Set(errors)];
  return { journey: "window-drag", valid: uniqueErrors.length === 0, passed: uniqueErrors.length === 0, errors: uniqueErrors };
}

export function summarizeWindowDragNativeReport(file, identity) {
  const result = validateWindowDragNativeReport(file?.value, identity);
  const exception = object(file?.exception)
    ? { name: typeof file.exception.name === "string" ? file.exception.name : "Error",
      code: typeof file.exception.code === "string" ? file.exception.code : null }
    : null;
  return {
    exists: file?.exists === true,
    valid: file?.exists === true && file?.exception === null && result.valid,
    passed: file?.exists === true && file?.exception === null && result.passed,
    errors: result.errors,
    exception,
  };
}
