import { expect, it } from "vitest";
import { emptyNativeUiInputDiagnostics, nativeUiInputCompositionSettled, nativeUiInputDiagnosticsValid } from "../../scripts/lib/native-ui-input-diagnostics.mjs";
import { settledInputDiagnostics } from "./nativeUiInputDiagnosticTestFixture";

it("requires classifications to account for every trusted editing event", () => {
  const record = { trustedBeforeInputs: 1, trustedInputs: 1 };
  expect(nativeUiInputDiagnosticsValid(settledInputDiagnostics(2), record)).toBe(true);
  expect(nativeUiInputDiagnosticsValid(emptyNativeUiInputDiagnostics(), record)).toBe(false);
  expect(nativeUiInputCompositionSettled(emptyNativeUiInputDiagnostics())).toBe(false);
});
it("rejects extra arbitrary values at every nested diagnostic boundary instead of accepting leaked content", () => {
  for (const change of [
    (value: any) => { value.key = "private"; },
    (value: any) => { value.composition.data = "private"; },
    (value: any) => { value.composingEvents.private = 1; },
    (value: any) => { value.editingContexts.private = 1; },
    (value: any) => { value.lastEditingContext = "private"; },
    (value: any) => { value.editingContexts.unknown = 8193; },
    (value: any) => { value.schemaVersion = 1; },
    (value: any) => { value.inputTypes.private = 1; },
    (value: any) => { value.targets.private = {}; },
    (value: any) => { value.targets.click.private = 1; },
    (value: any) => { value.lastEditingIsComposing = "private"; },
    (value: any) => { value.composition.starts = Infinity; },
    (value: any) => { value.targets.mousedown.outside = 8193; },
  ]) {
    const value = settledInputDiagnostics(2); change(value);
    expect(nativeUiInputDiagnosticsValid(value, { trustedBeforeInputs: 1, trustedInputs: 1 })).toBe(false);
  }
});
