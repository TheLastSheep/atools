(async function runWindowDragProbe(token, documentId) {
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
    if (typeof call !== "function" || !dom) throw new Error("observation");
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
  let baseline = null;
  let point = null;
  let dragStarted = false;
  let mouseReleased = false;
  let restoredStage = false;
  let navigationAttempted = false;

  try {
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
    baseline = await observe("baseline", position);
    if (!baseline?.position || !baseline?.innerSize || !finite(baseline.position.x)
      || !finite(baseline.position.y) || !finite(baseline.innerSize.height)) {
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
    point.screenX = baseline.position.x + point.clientX;
    point.screenY = baseline.position.y + point.clientY;
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
    const movedPoint = { ...point, screenX: point.screenX + 20, screenY: point.screenY + 15 };
    for (const [dx, dy] of [[6, 5], [13, 10], [20, 15]]) {
      dispatch(box, "mousemove", { ...point, screenX: point.screenX + dx, screenY: point.screenY + dy }, 1);
    }
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.moveRequests >= beforeMove.drag.moveRequests + 3
        && current.drag.dispatchedMoves > beforeMove.drag.dispatchedMoves && settled();
    }))) throw new Error("window-drag-move-not-settled");
    const dragged = await observe("dragged");
    if (dragged?.locked !== true) throw new Error("window-drag-native-move-not-observed");

    const beforeResize = snapshot();
    const resizedHeight = Math.round(baseline.innerSize.height) + 24;
    if (resizedHeight < 1 || resizedHeight > 10_000
      || !(await resizeAndSettle(resizedHeight, beforeResize.expandWindowCalls))) {
      throw new Error("window-drag-resize-not-observed");
    }
    const resized = await observe("resized");
    if (resized?.locked !== true) throw new Error("window-drag-resize-not-observed");

    const beforeRelease = snapshot();
    release(movedPoint);
    mouseReleased = true;
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.lockRequests > beforeRelease.drag.lockRequests
        && current.drag.dispatchedLocks > beforeRelease.drag.dispatchedLocks
        && current.drag.pending === 0 && current.drag.queued === 0
        && current.drag.inFlight === null && current.outstandingNativeCalls === 0;
    }))) throw new Error("window-drag-mouseup-not-settled");
    const released = await observe("released");
    if (released?.locked !== false) throw new Error("window-drag-mouseup-not-settled");

    const beforeRestore = snapshot();
    const baselineHeight = Math.round(baseline.innerSize.height);
    if (!(await resizeAndSettle(baselineHeight, beforeRestore.expandWindowCalls))) {
      throw new Error("window-drag-restore-not-settled");
    }
    const beforePositionRestore = snapshot();
    api.setWindowPosition(baseline.position.x, baseline.position.y);
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.moveRequests > beforePositionRestore.drag.moveRequests
        && current.drag.dispatchedMoves > beforePositionRestore.drag.dispatchedMoves && settled();
    }))) throw new Error("window-drag-restore-not-settled");
    await observe("restored");
    restoredStage = true;

    const beforeHideLock = snapshot();
    dispatch(box, "mousedown", point, 1);
    dragStarted = true;
    mouseReleased = false;
    restoredStage = false;
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.positionReads > beforeHideLock.drag.positionReads
        && current.drag.lockRequests > beforeHideLock.drag.lockRequests
        && current.drag.dispatchedLocks > beforeHideLock.drag.dispatchedLocks && settled();
    }))) throw new Error("window-drag-hide-lock-not-started");
    const hideLocked = await observe("hide-locked");
    if (hideLocked?.locked !== true) throw new Error("window-drag-hide-lock-not-observed");

    const beforeHide = snapshot();
    if (typeof api.hideWindow !== "function") throw new Error("window-drag-hide-api-unavailable");
    api.hideWindow();
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.hideWindowCalls > beforeHide.hideWindowCalls && settled();
    }))) throw new Error("window-drag-hide-not-settled");
    const hiddenCleared = await observe("hidden-cleared");
    if (hiddenCleared?.locked !== false) throw new Error("window-drag-hide-did-not-clear-lock");

    const beforeHideRelease = snapshot();
    release(point);
    mouseReleased = true;
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.lockRequests > beforeHideRelease.drag.lockRequests
        && current.drag.pending === 0 && current.drag.queued === 0
        && current.drag.inFlight === null && current.outstandingNativeCalls === 0;
    }))) throw new Error("window-drag-hide-mouseup-not-settled");

    const beforeRedrag = snapshot();
    dispatch(box, "mousedown", point, 1);
    dragStarted = true;
    mouseReleased = false;
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.positionReads > beforeRedrag.drag.positionReads
        && current.drag.lockRequests > beforeRedrag.drag.lockRequests
        && current.drag.dispatchedLocks > beforeRedrag.drag.dispatchedLocks && settled();
    }))) throw new Error("window-drag-post-hide-mousedown-not-started");
    const beforeRedragMove = snapshot();
    for (const [dx, dy] of [[3, 2], [6, 4], [8, 6]]) {
      dispatch(box, "mousemove", { ...point, screenX: point.screenX + dx, screenY: point.screenY + dy }, 1);
    }
    if (!(await waitFor(() => {
      const current = snapshot();
      return current && current.drag.moveRequests >= beforeRedragMove.drag.moveRequests + 3
        && current.drag.dispatchedMoves > beforeRedragMove.drag.dispatchedMoves && settled();
    }))) throw new Error("window-drag-post-hide-move-not-settled");
    const redragged = await observe("redragged");
    if (redragged?.locked !== true) throw new Error("window-drag-post-hide-redrag-not-observed");
    const call = invoke();
    if (typeof call !== "function") throw new Error("window-drag-navigation-unavailable");
    await call("window_drag_probe_navigate", { token, documentId });
    navigationAttempted = true;
    await new Promise(() => {});
  } catch (error) {
    const code = typeof error?.message === "string" && error.message.startsWith("window-drag-")
      ? error.message : "window-drag-observation-failed";
    record(code);
  } finally {
    if (dragStarted && !mouseReleased && box) {
      try { release(point); } catch (_) { record("window-drag-mouseup-not-settled"); }
      mouseReleased = true;
      await waitFor(() => {
        const current = snapshot();
        return current && current.drag.pending === 0 && current.drag.queued === 0
          && current.drag.inFlight === null && current.outstandingNativeCalls === 0;
      }, 3000);
    }
    if (baseline && !restoredStage && api && box) {
      try {
        const current = snapshot();
        if (current?.drag.pending === 0 && current.drag.queued === 0 && current.drag.inFlight === null) {
          api.setWindowSizeLock(false);
          await waitFor(() => settled(), 3000);
          const beforeSize = snapshot();
          await resizeAndSettle(Math.round(baseline.innerSize.height), beforeSize?.expandWindowCalls ?? 0);
          const beforePosition = snapshot();
          api.setWindowPosition(baseline.position.x, baseline.position.y);
          await waitFor(() => {
            const next = snapshot();
            return next && next.drag.moveRequests > beforePosition.drag.moveRequests && settled();
          }, 3000);
        }
      } catch (_) {
        record("window-drag-restore-not-settled");
      }
    }
    if (!navigationAttempted) {
      try {
        const call = invoke();
        if (typeof call === "function") await call("window_drag_probe_finish", { token, documentId, errors });
        else record("window-drag-observation-failed");
      } catch (_) {
        // Missing Native receipt remains a hard failure in the external validator.
      }
    }
  }
})("__ATOOLS_RENDERER_WINDOW_DRAG_TOKEN__", "__ATOOLS_RENDERER_WINDOW_DRAG_DOCUMENT_ID__");
