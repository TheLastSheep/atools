export type NativeUiInputDiagnostics = {
  schemaVersion: number;
  composition: { starts: number; ends: number; active: boolean };
  composingEvents: { yes: number; no: number; unknown: number };
  lastEditingIsComposing: "yes" | "no" | "unknown";
  editingContexts: Record<"visibleFocusedEditor" | "visibleUnfocusedEditor" | "visibleOtherFocus" | "hidden" | "unknown", number>;
  lastEditingContext: "visibleFocusedEditor" | "visibleUnfocusedEditor" | "visibleOtherFocus" | "hidden" | "unknown";
  inputTypes: { insertText: number; insertCompositionText: number; insertFromComposition: number;
    insertLineBreak: number; insertParagraph: number; deletion: number; history: number; other: number; missing: number };
  targets: Record<"pointerdown" | "mousedown" | "click", Record<"editor" | "container" | "outside", number>>;
};
export function emptyNativeUiInputDiagnostics(): NativeUiInputDiagnostics;
export function nativeUiInputDiagnosticsValid(value: unknown, record: unknown): boolean;
export function nativeUiInputCompositionSettled(value: NativeUiInputDiagnostics | undefined): boolean;
