export const ESCAPE_TIMING_SCHEMA = "parent-observed-traces-v2";
export const ESCAPE_TIMING_METRICS = ["requestToFrameReceiptTraceObservedMs", "frameKeydownDispatchMs",
  "afterKeydownTraceToBridgeObservedMs", "bridgeToPanelRemovedObservedMs", "bridgeToFocusRestoredObservedMs"];

/** Parent receipt times include the frame's return message queue; they are not one-way transport timestamps. */
export function deriveEscapeTimelineMetrics(value) {
  const fail = reason => { throw Error("Escape timing incomplete: " + reason); };
  const finite = number => typeof number === "number" && Number.isFinite(number);
  const phases = ["frame-received", "before-keydown", "after-keydown"];
  if (value?.timingSchema !== ESCAPE_TIMING_SCHEMA || !Array.isArray(value.frameTraces)
    || value.frameTraces.length !== phases.length || value.bridgeMessageCount !== 1) fail("exactly three traces and one production bridge message are required");
  const traces = value.frameTraces;
  if (traces.some((trace, index) => trace?.phase !== phases[index]
    || ![trace.epochMs, trace.frameMonotonicMs, trace.frameTimeOriginMs, trace.parentObservedMs].every(finite)
    || !Number.isSafeInteger(trace.probeRequestId) || trace.probeRequestId < 1
    || trace.probeRequestId !== traces[0].probeRequestId
    || trace.frameTimeOriginMs !== traces[0].frameTimeOriginMs)) fail("missing, duplicate, foreign or out-of-order frame trace");
  const [received, before, after] = traces;
  const parentChain = [0, received.parentObservedMs, value.acknowledgementMs, before.parentObservedMs,
    after.parentObservedMs, value.bridgeMessageMs, value.panelRemovedObservedMs, value.focusRestoredObservedMs, value.totalMs];
  if (!finite(value.parentStartedEpochMs) || parentChain.some((time, index) => !finite(time)
    || index > 0 && time < parentChain[index - 1])) fail("same-parent-clock observations are missing or out of FIFO order");
  const localChain = [received.frameMonotonicMs, before.frameMonotonicMs, after.frameMonotonicMs];
  if (localChain.some((time, index) => time < 0 || index > 0 && time < localChain[index - 1])) fail("frame-local monotonic dispatch order is invalid");
  return {
    requestToFrameReceiptTraceObservedMs: received.parentObservedMs,
    frameKeydownDispatchMs: after.frameMonotonicMs - before.frameMonotonicMs,
    afterKeydownTraceToBridgeObservedMs: value.bridgeMessageMs - after.parentObservedMs,
    bridgeToPanelRemovedObservedMs: value.panelRemovedObservedMs - value.bridgeMessageMs,
    bridgeToFocusRestoredObservedMs: value.focusRestoredObservedMs - value.bridgeMessageMs,
  };
}
