import { emptyNativeUiInputDiagnostics } from "../../scripts/lib/native-ui-input-diagnostics.mjs";

/** Test-only complete, settled classifications paired with explicit trusted edit counters. */
export function settledInputDiagnostics(editingEvents: number) {
  const value = emptyNativeUiInputDiagnostics();
  value.composingEvents.no = editingEvents;
  value.inputTypes.insertText = editingEvents;
  value.editingContexts.unknown = editingEvents;
  value.lastEditingIsComposing = editingEvents > 0 ? "no" : "unknown";
  return value;
}
