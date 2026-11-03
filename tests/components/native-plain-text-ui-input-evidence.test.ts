import { settledInputDiagnostics } from "./nativeUiInputDiagnosticTestFixture";
import { expect, it } from "vitest";
// @ts-expect-error Fixture-only parent validator is an ES module without a production TypeScript declaration.
import { validateNativePlainUiInput } from "../../scripts/lib/native-plain-text-ui-input-evidence.mjs";

const proof = (phase: "alpha" | "beta") => ({ schemaVersion: 2, phase, stopped: false, listenerCount: 8, lifecycleListenerCount: 2,
  records: { [phase]: { trustedEditorPointers: 1, trustedKeydowns: 2, trustedBeforeInputs: 2, trustedInputs: 2,
    rejectedUntrusted: 0, overflow: false, diagnostics: settledInputDiagnostics(4) } } });
const view = (phase: "alpha" | "beta") => ({ hostVisible: true, hostHasFocus: true, frameVisible: true, frameHasFocus: true,
  editorActive: true, editorVisible: true, renderedTextMatches: true,
  renderedText: phase === "alpha" ? "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line."
    : "# ATools markdown beta document\n\n- first\n- second", editCommandResults: [], focusAttempt: null,
  focusDiagnostics: { editorActive: true, documentHasFocus: true, documentHidden: false, visibilityState: "visible",
    editorIsContentEditable: true, editorWidth: 400, editorHeight: 200, computedStyle: { pointerEvents: "auto" }, inertAncestors: [] } });
const report = () => ({ observations: { originalPlainNativeUiInput: { hardwareHumanInputVerified: false,
  phaseDeadlineMs: 60000, pollIntervalMs: 150,
  proofs: { alpha: proof("alpha"), beta: proof("beta") }, visibility: { alpha: view("alpha"), beta: view("beta") },
  cleanup: { stopped: true, listenerCount: 0, lifecycleListenerCount: 0 } } } });

it("accepts only both phases with live trusted event counters, visible focused editor, no commands, and final listener cleanup", () => {
  expect(validateNativePlainUiInput(report())).toMatchObject({ passed: true, phases: 2, listenersAfterStop: 0,
    humanHardwareInputVerified: false });
});
it("rejects the older browser-command pass and missing phase proof", () => {
  expect(validateNativePlainUiInput({ observations: { originalPlainEditing: { inputMechanism: "execCommand" } } })).toMatchObject({ passed: false });
  const value = report(); delete (value.observations.originalPlainNativeUiInput.proofs as Record<string, unknown>).beta;
  expect(validateNativePlainUiInput(value)).toMatchObject({ passed: false, reason: "native_input_counters_invalid", phase: "beta" });
});
it.each(["pointer", "keydown", "beforeinput", "input"] as const)("rejects missing trusted %s evidence", event => {
  const value = report(), counts = value.observations.originalPlainNativeUiInput.proofs.alpha.records.alpha;
  const field = ({ pointer: "trustedEditorPointers", keydown: "trustedKeydowns", beforeinput: "trustedBeforeInputs", input: "trustedInputs" } as const)[event];
  counts[field] = 0;
  counts.diagnostics = settledInputDiagnostics(counts.trustedBeforeInputs + counts.trustedInputs);
  expect(validateNativePlainUiInput(value)).toMatchObject({ passed: false, reason: "trusted_input_sequence_missing", phase: "alpha" });
});
it("rejects invalid counters, overflow, missing focus and incomplete cleanup", () => {
  for (const count of [NaN, Infinity, -1, 8193, "1"]) {
    const invalid = report(), counts: Record<string, unknown> = invalid.observations.originalPlainNativeUiInput.proofs.beta.records.beta;
    counts.trustedInputs = count;
    expect(validateNativePlainUiInput(invalid)).toMatchObject({ passed: false, reason: "native_input_counters_invalid", phase: "beta" });
  }
  const overflow = report(); overflow.observations.originalPlainNativeUiInput.proofs.alpha.records.alpha.overflow = true;
  expect(validateNativePlainUiInput(overflow)).toMatchObject({ passed: false, reason: "native_input_counters_invalid", phase: "alpha" });
  const unfocused = report(); unfocused.observations.originalPlainNativeUiInput.visibility.alpha.hostHasFocus = false;
  expect(validateNativePlainUiInput(unfocused)).toMatchObject({ passed: false, reason: "native_input_not_visible_or_focused", phase: "alpha" });
  const dirty = report(); dirty.observations.originalPlainNativeUiInput.cleanup.listenerCount = 1;
  expect(validateNativePlainUiInput(dirty)).toMatchObject({ passed: false, reason: "observer_cleanup_missing" });
  const wrongText = report(); wrongText.observations.originalPlainNativeUiInput.visibility.beta.renderedText = "edited by script";
  expect(validateNativePlainUiInput(wrongText)).toMatchObject({ passed: false, reason: "native_input_not_visible_or_focused", phase: "beta" });
});
it("rejects old or incomplete diagnostics and pending or unobserved composition even with exact rendered text", () => {
  for (const change of [
    (value: any) => { value.schemaVersion = 1; },
    (value: any) => { delete value.records.alpha.diagnostics; },
    (value: any) => { value.records.alpha.diagnostics.inputTypes = {}; },
    (value: any) => { value.records.alpha.diagnostics.composition.active = true; },
    (value: any) => { value.records.alpha.diagnostics.lastEditingIsComposing = "unknown"; },
  ]) {
    const value = report(); change(value.observations.originalPlainNativeUiInput.proofs.alpha);
    expect(validateNativePlainUiInput(value).passed).toBe(false);
  }
});
