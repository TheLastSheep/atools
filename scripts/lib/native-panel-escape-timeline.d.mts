export const ESCAPE_TIMING_SCHEMA: "parent-observed-traces-v2";
export const ESCAPE_TIMING_METRICS: string[];
export type NativePanelEscapeTrace = {
  phase: string; epochMs: number; frameMonotonicMs: number; frameTimeOriginMs: number;
  parentObservedMs: number; probeRequestId: number; defaultPrevented?: boolean;
  visibilityState?: string; documentHasFocus?: boolean;
};
export type NativePanelEscapeMetrics = {
  requestToFrameReceiptTraceObservedMs: number; frameKeydownDispatchMs: number;
  afterKeydownTraceToBridgeObservedMs: number; bridgeToPanelRemovedObservedMs: number;
  bridgeToFocusRestoredObservedMs: number;
};
export function deriveEscapeTimelineMetrics(value: unknown): NativePanelEscapeMetrics;
