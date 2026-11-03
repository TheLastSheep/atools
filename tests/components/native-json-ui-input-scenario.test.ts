import { afterEach, expect, it, vi } from "vitest";
import { runNativeJsonUiInputScenario } from "./nativeOriginalJsonUiInputScenario";
import { settledInputDiagnostics } from "./nativeUiInputDiagnosticTestFixture";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

const valid = '{"name":"ATools","nested":{"active":true,"items":[1,2]}}';
const malformed = '{"name":"ATools","nested":[1,]}';
const formatted = JSON.stringify(JSON.parse(valid), null, 4);
type Phase = "initial" | "valid" | "format" | "malformed" | "recovery";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
function fixture(change: (phase: Phase, state: any) => void = () => {}) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  let phase: Phase = "initial", elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const observations: Record<string, any> = {}, operations: string[] = [], asserted: string[] = [];
  function read() {
    const editing = phase !== "format" && phase !== "initial";
    const state = { inputText: phase === "initial" ? "" : phase === "format" ? formatted : phase === "malformed" ? malformed : valid,
      malformedMarkerCount: phase === "malformed" ? 1 : 0,
      focusDiagnostics: { textareaActive: true, documentHasFocus: true, documentHidden: false, visibilityState: "visible" },
      nativeUiInputObservation: { schemaVersion: 2, phase, stopped: false, listenerCount: 8,
        records: { [phase]: { trustedEditorPointers: 0, trustedFormatClicks: phase === "format" ? 1 : 0,
          trustedKeydowns: editing ? 1 : 0, trustedBeforeInputs: editing ? 1 : 0, trustedInputs: editing ? 1 : 0,
          rejectedUntrusted: 0, overflow: false, diagnostics: settledInputDiagnostics(editing ? 2 : 0) } } } };
    change(phase, state);
    return state;
  }
  const value = { fixture: { nativeUiInput: true }, profile: { caseId: "local-json-editor" }, observations,
    async probe(operation: string) {
      operations.push(operation);
      if (operation === "native-ui-stop") return { ...read(), nativeUiInputObservation: { ...read().nativeUiInputObservation, stopped: true, listenerCount: 0 } };
      phase = operation.slice("native-ui-".length) as Phase;
      return read();
    }, setPhase() {}, check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async pause() { elapsed += 60001; } } as unknown as PublishedScenarioContext;
  const validation = { read: async () => read(), count: () => ({ initial: 0, valid: 1, format: 1, malformed: 2, recovery: 3 })[phase],
    matches: () => true, assert: (_state: unknown, expectation: string) => { asserted.push(expectation); return { expectation }; } };
  return { value, validation, observations, operations, asserted };
}

it("keeps all four exact rendered-text, trusted toolbar and worker recovery stages without synthesizing editor actions", async () => {
  const test = fixture(), focus = vi.spyOn(HTMLElement.prototype, "focus"), click = vi.spyOn(HTMLElement.prototype, "click");
  const storage = vi.spyOn(Storage.prototype, "setItem"), exec = vi.fn();
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  const result = await runNativeJsonUiInputScenario(test.value, test.validation);
  expect(result.businessOutcome).toBe("scoped_pass");
  expect(test.operations).toEqual(["native-ui-valid", "native-ui-format", "native-ui-malformed", "native-ui-recovery", "native-ui-stop"]);
  expect(test.asserted).toEqual(["valid", "malformed", "valid"]);
  expect(test.observations.jsonEditorNativeUiInput).toMatchObject({ textObservation: "Original .view-lines rendered DOM; no direct Monaco model access",
    cleanup: { schemaVersion: 2, stopped: true, listenerCount: 0 }, proofs: { valid: expect.any(Object), format: expect.any(Object), malformed: expect.any(Object), recovery: expect.any(Object) } });
  expect(focus).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  expect(document.querySelector("[data-atools-native-json-input]")).toBeNull();
});

it.each(["composition", "missing-diagnostics", "old-schema", "rendered-text", "format-click", "recovery-marker"] as const)("rejects %s and cleans up rather than manufacturing a pass", failure => {
  const test = fixture((phase, state) => {
    if (failure === "format-click" && phase === "format") state.nativeUiInputObservation.records.format.trustedFormatClicks = 0;
    if (failure === "recovery-marker" && phase === "recovery") state.malformedMarkerCount = 1;
    if (phase !== "valid") return;
    const record = state.nativeUiInputObservation.records.valid;
    if (failure === "composition") record.diagnostics.composition.active = true;
    if (failure === "missing-diagnostics") delete record.diagnostics;
    if (failure === "old-schema") state.nativeUiInputObservation.schemaVersion = 1;
    if (failure === "rendered-text") state.inputText = "converted by IME";
  });
  const failedPhase = failure === "format-click" ? "format" : failure === "recovery-marker" ? "recovery" : "valid";
  return expect(runNativeJsonUiInputScenario(test.value, test.validation)).rejects.toThrow("Deadline:" + failedPhase).then(() => {
    expect(test.operations.at(-1)).toBe("native-ui-stop");
    expect(test.observations.jsonEditorNativeUiInput.cleanup).toMatchObject({ stopped: true, listenerCount: 0 });
    expect(document.querySelector("[data-atools-native-json-input]")).toBeNull();
  });
});

it("preserves the input failure if cleanup also fails and never treats cleanup failure as a green result", async () => {
  for (const primaryFailure of [true, false]) {
    const test = fixture((phase, state) => { if (primaryFailure && phase === "valid") state.inputText = "wrong"; });
    const original = test.value.probe;
    test.value.probe = async (operation, extra) => {
      if (operation === "native-ui-stop") throw Error("stop failure");
      return original(operation, extra);
    };
    await expect(runNativeJsonUiInputScenario(test.value, test.validation)).rejects.toThrow(primaryFailure ? "Deadline:valid" : "stop failure");
    expect(test.observations.jsonEditorNativeUiCleanupFailure).toEqual({ errorClass: "Error", primaryErrorPreserved: primaryFailure });
  }
});
