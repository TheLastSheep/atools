import type { PanelWindowMode } from "./nativePanelWindowEvidence";
import { deriveEscapeTimelineMetrics, ESCAPE_TIMING_SCHEMA, type NativePanelEscapeTrace } from "../../scripts/lib/native-panel-escape-timeline.mjs";
type FrameFocus = { documentHasFocus: boolean; visibilityState: string; activeElementTag: string };

/** Passive message/DOM observations. Production Escape deferral and the existing polling endpoint stay unchanged. */
export async function measureNativePanelEscape(options: { token: string; mode: PanelWindowMode;
  request: (operation: string, args?: Record<string, unknown>) => Promise<FrameFocus>;
  until: <T>(read: () => T | Promise<T>, message: string) => Promise<NonNullable<T>>;
  input: () => HTMLInputElement | null; observations: Record<string, unknown> }) {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  if (!frame?.contentWindow) throw Error("Escape measurement has no original frame");
  if (options.mode === "foreground") {
    frame.focus();
    const focused = await options.request("focus", { selector: "textarea.input-area" });
    if (!focused.documentHasFocus || focused.visibilityState !== "visible") throw Error("Original iframe did not acquire visible DOM focus before foreground Escape measurement");
  }
  const source = frame.contentWindow, traces: NativePanelEscapeTrace[] = [], bridgeMessages: number[] = [];
  const measurementId = crypto.randomUUID();
  let started = 0, removedMs: number | null = null, focusMs: number | null = null, ackMs: number | null = null;
  const elapsed = () => performance.now() - started;
  const inspect = () => {
    if (!document.querySelector(".plugin-panel")) {
      removedMs ??= elapsed();
      if (document.activeElement === options.input()) focusMs ??= elapsed();
    }
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== source) return;
    if (event.data?.__ipc_plugin_escape__ === true) bridgeMessages.push(elapsed());
    if (event.data?.kind === "atools-panel-escape-trace" && event.data.token === options.token && event.data.measurementId === measurementId) {
      traces.push({ ...event.data.trace, probeRequestId: event.data.id, parentObservedMs: elapsed() });
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(document.body, { subtree: true, childList: true });
  document.addEventListener("focusin", inspect, true); window.addEventListener("message", receive, true);
  const parentBefore = { visibility: document.visibilityState, hasFocus: document.hasFocus() };
  let frameBefore: FrameFocus | undefined;
  started = performance.now(); const epochStart = performance.timeOrigin + started;
  try {
    frameBefore = await options.request("escape", { measurementId }); ackMs = elapsed();
    await options.until(() => !document.querySelector(".plugin-panel") && document.activeElement === options.input(), "Search did not regain focus after Escape");
    inspect();
    const totalMs = elapsed();
    const phases = { mode: options.mode, timingSchema: ESCAPE_TIMING_SCHEMA, bridgeMessageMs: bridgeMessages[0] ?? null, totalMs, acknowledgementMs: ackMs,
      bridgeMessageCount: bridgeMessages.length, panelRemovedObservedMs: removedMs, focusRestoredObservedMs: focusMs,
      frameTraces: traces, parentStartedEpochMs: epochStart,
      frameDocumentHasFocus: frameBefore.documentHasFocus, frameVisibilityState: frameBefore.visibilityState,
      frameActiveElementTag: frameBefore.activeElementTag, parentVisibilityBefore: parentBefore.visibility,
      parentDocumentHasFocusBefore: parentBefore.hasFocus, parentDocumentHasFocus: document.hasFocus(),
      boundary: "All request/trace receipt, bridge message, removal and focus observations use the same parent performance.now clock. Receipt traces include the request, frame work and trace return-message queue; after-keydown trace to bridge is the gap between parent observations, not precise one-way transport or native deferral time. Only keydown dispatch uses one frame-local monotonic clock. Raw cross-frame epochs are diagnostic only. No production timer, event or original plugin behavior replaced; total retains prior 25ms DOM polling granularity." };
    options.observations.escapePhases = phases;
    Object.assign(phases, deriveEscapeTimelineMetrics(phases));
    if (options.mode === "foreground" && (!frameBefore.documentHasFocus || frameBefore.visibilityState !== "visible")) throw Error("Foreground Escape began in a hidden or unfocused iframe");
    Object.assign(phases,{complete:true});
    return totalMs;
  } finally {
    observer.disconnect(); document.removeEventListener("focusin", inspect, true); window.removeEventListener("message", receive, true);
    options.observations.escapeTraceOnCompletion = { frameTraces: traces, bridgeMessages, acknowledgementMs: ackMs,
      panelRemovedObservedMs: removedMs, focusRestoredObservedMs: focusMs };
  }
}
