export type NativeUiInputTimelinePhase = "admission" | "alpha" | "beta" | "valid" | "format" | "malformed" | "recovery";
export type NativeUiInputTargetKind = "exact-editor" | "editor-container" | "format-button" | "host-plugin-frame" | "body" | "document" | "other" | "unknown";
export type NativeUiInputTimelineSnapshot = {
  schemaVersion: 1; context: "host" | "plugin"; capacity: 128; counterLimit: 8192;
  total: number; overflow: boolean; stopped: boolean; clock: "local-performance-now" | "unavailable";
  entries: Array<{ seq: number; elapsedMs: number | null; phase: NativeUiInputTimelinePhase;
    eventType: "installed" | "pointerdown" | "mousedown" | "click" | "keydown" | "beforeinput" | "input" | "compositionstart" | "compositionend";
    targetKind: NativeUiInputTargetKind; activeKind: NativeUiInputTargetKind;
    isTrusted: boolean | "unknown"; documentHasFocus: boolean | "unknown";
    visibility: "visible" | "hidden" | "unknown"; isComposing: boolean | "unknown" }>;
};
export type NativeUiInputTimeline = {
  eventTypes: readonly string[];
  observe(event: Event, phase?: NativeUiInputTimelinePhase | null): void;
  snapshot(): NativeUiInputTimelineSnapshot;
  stop(): void;
};
export function createNativeUiInputTimeline(document: Document, window: Window,
  options: { context: "host" | "plugin"; editorKind: "plain" | "json" | "host" }): NativeUiInputTimeline;
export function nativeUiInputObservationSource(source: string): string;
