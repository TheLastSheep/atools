(async function resumeWindowDragProbe(token, documentId, baselinePosition, baselineSize) {
  "use strict";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  const adapter = () => window.__ATOOLS_ZTOOLS_HOST_ADAPTER__;
  const invoke = () => window.__TAURI__?.core?.invoke;
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);

  function snapshot() {
    const value = adapter()?.snapshot?.();
    const drag = value?.windowDrag;
    const calls = value?.nativeCalls;
    const notifications = value?.windowNotifications;
    if (!value || !drag || !calls || !notifications) return null;
    const dragFields = [
      "pending", "queued", "pendingPositionReads", "queuedMoves", "queuedLocks",
      "positionReads", "moveRequests", "lockRequests", "dispatchedPositions",
      "dispatchedMoves", "dispatchedLocks", "coalescedMoves", "rejectedOperations",
      "failures", "cancelledReads", "droppedAfterDispose",
    ];
    const counters = Object.fromEntries(dragFields.map((key) => [key, integer(drag[key]) ?? Number.MAX_SAFE_INTEGER]));
    const inFlight = drag.inFlight === null || ["position", "lock", "move"].includes(drag.inFlight)
      ? drag.inFlight : "invalid";
    return {
      searchBoxFound: document.querySelector(".search-box") !== null,
      inputEmpty: document.querySelector("input.search-input")?.value === "",
      documentVisibility: typeof document.visibilityState === "string" ? document.visibilityState : "unknown",
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
      documentId,
      outstandingNativeCalls: integer(value.outstandingNativeCalls) ?? Number.MAX_SAFE_INTEGER,
      rendererWindowDragCalls: integer(calls.renderer_window_drag) ?? 0,
      expandWindowCalls: integer(calls.expand_window) ?? 0,
      hideWindowCalls: integer(calls.hide_main_window) ?? 0,
      windowNotificationPendingReplies: integer(notifications.pendingReplies) ?? Number.MAX_SAFE_INTEGER,
      windowNotificationFailures: integer(notifications.failures) ?? Number.MAX_SAFE_INTEGER,
      drag: {
        ...counters,
        inFlight,
        disposed: typeof drag.disposed === "boolean" ? drag.disposed : true,
      },
    };
  }

  function settled() {
    const dom = snapshot();
    return dom !== null && dom.outstandingNativeCalls === 0
      && dom.windowNotificationPendingReplies === 0 && dom.windowNotificationFailures === 0
      && dom.drag.pending === 0 && dom.drag.queued === 0 && dom.drag.inFlight === null
      && dom.drag.pendingPositionReads === 0 && dom.drag.queuedMoves === 0 && dom.drag.queuedLocks === 0;
  }

  async function waitFor(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (predicate() === true) return true; } catch (_) {}
      await sleep(20);
    }
    return false;
  }

  async function observe(stage, positionRead = null) {
    const call = invoke();
    const dom = snapshot();
    if (typeof call !== "function" || !dom) throw new Error("window-drag-observation-failed");
    return await call("window_drag_probe_observe", { token, stage, dom: { ...dom, positionRead } });
  }

  function dispatch(box, type, point, buttons) {
    box.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons,
      clientX: point.clientX,
      clientY: point.clientY,
      screenX: point.screenX,
      screenY: point.screenY,
    }));
  }

  function release(point) {
    const input = document.querySelector("input.search-input");
    if (!input) throw new Error("window-drag-dom-not-ready");
    dispatch(input, "mouseup", point, 0);
  }

  function record(error) {
    if (!errors.includes(error)) errors.push(error);
  }

  async function resizeAndSettle(height, priorCalls) {
    const api = window.ztools;
    if (typeof api?.resizeWindow !== "function") return false;
    api.resizeWindow(height);
    return await waitFor(() => {
      const dom = snapshot();
      return dom && dom.windowNotificationPendingReplies === 0
        && dom.windowNotificationFailures === 0 && dom.expandWindowCalls > priorCalls
        && dom.outstandingNativeCalls === 0;
    });
  }

  let api = null;
  let box = null;
  let point = null;
  let dragStarted = false;
  let mouseReleased = false;
  let restored = false;
  let reportFinished = false;

  try {
    if (!finite(baselinePosition?.x) || !finite(baselinePosition?.y)
      || !finite(baselineSize?.width) || !finite(baselineSize?.height)) {
      throw new Error("window-drag-baseline-unavailable");
    }
    if (!(await waitFor(() => snapshot()?.searchBoxFound === true && settled(), 9000))) {
      throw new Error("window-drag-dom-not-ready");
    }
    api = window.ztools;
    box = document.querySelector(".search-box");
    if (typeof api?.getWindowPosition !== "function"
      || typeof api?.setWindowPosition !== "function"
      || typeof api?.setWindowSizeLock !== "function"
      || typeof api?.resizeWindow !== "function"
      || typeof invoke() !== "function") throw new Error("window-drag-dom-not-ready");

    const position = await api.getWindowPosition();
    if (!position || !finite(position.x) || !finite(position.y) || !(await waitFor(settled))) {
      throw new Error("window-drag-position-read-failed");
    }
    const navigated = await observe("navigated", position);
    if (!navigated?.position || !navigated?.innerSize
      || !finite(navigated.position.x) || !finite(navigated.position.y)) {
      throw new Error("window-drag-observation-failed");
    }

    const rect = box.getBoundingClientRect();
    if (!finite(rect.width) || !finite(rect.height) || rect.width < 8 || rect.height < 8) {
      throw new Error("window-drag-dom-not-ready");
    }
    point = {
      clientX: Math.min(Math.max(4, rect.width / 2), rect.width - 2),
      clientY: Math.min(Math.max(4, rect.height / 2), rect.height - 2),
    };
    point.screenX = position.x + point.clientX;
    point.screenY = position.y + point.clientY;
    const beforeDrag = snapshot();
    dispatch(box, "mousedown", point, 1);
    dragStarted = true;
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.positionReads > beforeDrag.drag.positionReads
        && current.drag.lockRequests > beforeDrag.drag.lockRequests
        && current.drag.dispatchedLocks > beforeDrag.drag.dispatchedLocks && settled();
    }))) throw new Error("window-drag-mousedown-not-started");

    const beforeMove = snapshot();
    for (const [dx, dy] of [[3, 2], [6, 4], [8, 6]]) {
      dispatch(box, "mousemove", { ...point, screenX: point.screenX + dx, screenY: point.screenY + dy }, 1);
    }
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.moveRequests >= beforeMove.drag.moveRequests + 3
        && current.drag.dispatchedMoves > beforeMove.drag.dispatchedMoves && settled();
    }))) throw new Error("window-drag-move-not-settled");

    const beforeRelease = snapshot();
    release({ ...point, screenX: point.screenX + 8, screenY: point.screenY + 6 });
    mouseReleased = true;
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.lockRequests > beforeRelease.drag.lockRequests
        && current.drag.dispatchedLocks > beforeRelease.drag.dispatchedLocks && settled();
    }))) throw new Error("window-drag-mouseup-not-settled");

    const beforeResize = snapshot();
    if (!(await resizeAndSettle(Math.round(baselineSize.height), beforeResize.expandWindowCalls))) {
      throw new Error("window-drag-restore-not-settled");
    }
    const beforePosition = snapshot();
    api.setWindowPosition(baselinePosition.x, baselinePosition.y);
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.moveRequests > beforePosition.drag.moveRequests
        && current.drag.dispatchedMoves > beforePosition.drag.dispatchedMoves && settled();
    }))) throw new Error("window-drag-restore-not-settled");
    const recovered = await observe("recovered");
    if (!recovered?.position || !recovered?.innerSize) throw new Error("window-drag-observation-failed");
    restored = true;
  } catch (error) {
    const code = typeof error?.message === "string" && error.message.startsWith("window-drag-")
      ? error.message : "window-drag-observation-failed";
    record(code);
  } finally {
    if (dragStarted && !mouseReleased && box) {
      try { release(point); } catch (_) { record("window-drag-mouseup-not-settled"); }
      mouseReleased = true;
      await waitFor(settled, 3000);
    }
    if (!restored && api && baselinePosition && baselineSize && snapshot()?.drag?.pending === 0) {
      try {
        api.setWindowSizeLock(false);
        await waitFor(settled, 3000);
        const current = snapshot();
        await resizeAndSettle(Math.round(baselineSize.height), current?.expandWindowCalls ?? 0);
        api.setWindowPosition(baselinePosition.x, baselinePosition.y);
        await waitFor(settled, 3000);
      } catch (_) {
        record("window-drag-restore-not-settled");
      }
    }
    try {
      const call = invoke();
      if (typeof call === "function") {
        await call("window_drag_probe_finish", { token, documentId, errors });
        reportFinished = true;
      } else record("window-drag-observation-failed");
    } catch (_) {
      // Missing or failed Native receipt blocks the catalog continuation.
    }
  }
  if (!reportFinished) throw new Error("window-drag-report-incomplete");
})(
  "__ATOOLS_RENDERER_WINDOW_DRAG_TOKEN__",
  "__ATOOLS_RENDERER_WINDOW_DRAG_DOCUMENT_ID__",
  __ATOOLS_RENDERER_WINDOW_DRAG_BASELINE_POSITION__,
  __ATOOLS_RENDERER_WINDOW_DRAG_BASELINE_SIZE__
);
