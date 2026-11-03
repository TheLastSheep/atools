import { nativeUiInputObservationSource } from "./nativeUiInputTimeline.mjs";
import { settledInputDiagnostics } from "./nativeUiInputDiagnosticTestFixture";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { nativeJsonUiInputConfirmed, type NativeJsonUiInputObservation } from "./nativeOriginalJsonUiInputScenario";
// @ts-expect-error the fixture-only Node verifier intentionally has no production declaration
import { validateNativeJsonUiInput } from "../../scripts/lib/native-json-ui-input-evidence.mjs";

function observation(): NativeJsonUiInputObservation {
  return { schemaVersion: 2, phase: "valid", stopped: false, listenerCount: 8,
    records: { valid: { trustedKeydowns: 1, trustedBeforeInputs: 1, trustedInputs: 1,
      trustedEditorPointers: 1, trustedFormatClicks: 0, rejectedUntrusted: 0, overflow: false, diagnostics: settledInputDiagnostics(2) } } };
}
function install() {
  const listeners = new Map<string, Function>(), windowListeners = new Map<string, Function>();
  const textarea = {}, format = { contains: (target: unknown) => target === format };
  const editor = { contains: (target: unknown) => target === textarea };
  const document = { querySelector: (selector: string) => selector.includes("textarea") ? textarea : selector === "#inputEditor" ? editor : format,
    addEventListener: (name: string, callback: Function) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name) };
  const window: any = { addEventListener: (name: string, callback: Function) => windowListeners.set(name, callback),
    removeEventListener: (name: string) => windowListeners.delete(name) };
  vm.runInNewContext(nativeUiInputObservationSource(readFileSync("tests/components/nativeJsonUiInputObservation.js", "utf8")), { window, document });
  return { api: window.__ATOOLS_NATIVE_JSON_UI_INPUT__, listeners, windowListeners, textarea, format,
    emit(type: string, target = textarea, isTrusted = true) {
      listeners.get(type)?.({ type, target, isTrusted, isComposing: false, inputType: "insertText", data: "private-input-marker", key: "private-key-marker" });
    } };
}

describe("native JSON UI input evidence", () => {
  it("rejects an older UI or worker-only pass when the OS input mode was requested", () => {
    expect(validateNativeJsonUiInput({ passed: true, observations: { business: { businessOutcome: "scoped_pass" } } }).passed).toBe(false);
    const evidence: any = { hardwareHumanInputVerified: false, proofs: {}, visibility: {}, worker: {},
      textObservation: "Original .view-lines rendered DOM; no direct Monaco model access",
      cleanup: { schemaVersion: 2, stopped: true, listenerCount: 0 } };
    for (const phase of ["valid", "format", "malformed", "recovery"]) {
      evidence.proofs[phase] = observation(); evidence.proofs[phase].phase = phase;
      evidence.proofs[phase].records[phase] = { ...evidence.proofs[phase].records.valid, trustedFormatClicks: 1 };
      evidence.visibility[phase] = { hostVisible: true, hostHasFocus: true, frameVisible: true, frameHasFocus: true, textareaActive: true };
    }
    for (const [index, phase] of ["valid", "malformed", "recovery"].entries()) {
      evidence.worker[phase] = { requestOrdinal: index + 1, validationRequests: index + 1, validationResponses: index + 1,
        markerCount: phase === "malformed" ? 1 : 0, errorCount: phase === "malformed" ? 1 : 0, positions: [{ line: 1, column: 28 }] };
    }
    const report = { observations: { jsonEditorNativeUiInput: evidence } };
    expect(validateNativeJsonUiInput(report).passed).toBe(true);
    evidence.visibility.recovery.frameHasFocus = false;
    expect(validateNativeJsonUiInput(report).reason).toBe("native_input_not_visible_or_focused");
    evidence.visibility.recovery.frameHasFocus = true;
    evidence.worker.recovery.requestOrdinal = 1;
    expect(validateNativeJsonUiInput(report).reason).toBe("paired_worker_recovery_evidence_invalid");
    evidence.worker.recovery.requestOrdinal = 3;
    evidence.cleanup.listenerCount = 1;
    expect(validateNativeJsonUiInput(report).reason).toBe("observer_cleanup_missing");
    evidence.cleanup.listenerCount = 0;
    evidence.textObservation = "direct Monaco model";
    expect(validateNativeJsonUiInput(report).reason).toBe("rendered_text_observation_missing");
    evidence.textObservation = "Original .view-lines rendered DOM; no direct Monaco model access";
    evidence.proofs.valid.records.valid.diagnostics.composition.active = true;
    expect(validateNativeJsonUiInput(report).reason).toBe("native_input_composition_unsettled");
  });
  it("requires a paired trusted key/beforeinput/input sequence in the current live phase", () => {
    expect(nativeJsonUiInputConfirmed(observation(), "valid")).toBe(true);
    for (const key of ["trustedKeydowns", "trustedBeforeInputs", "trustedInputs"] as const) {
      const value = observation(); value.records.valid[key] = 0;
      expect(nativeJsonUiInputConfirmed(value, "valid")).toBe(false);
    }
    expect(nativeJsonUiInputConfirmed(observation(), "recovery")).toBe(false);
    expect(nativeJsonUiInputConfirmed(undefined, "valid")).toBe(false);
  });
  it("rejects stopped, overflowed and invalid counters instead of coercing evidence", () => {
    const stopped = observation(); stopped.stopped = true;
    expect(nativeJsonUiInputConfirmed(stopped, "valid")).toBe(false);
    for (const count of [Infinity, NaN, -1, 8193, "1"] as any[]) {
      const value = observation(); value.records.valid.trustedInputs = count;
      expect(nativeJsonUiInputConfirmed(value, "valid")).toBe(false);
    }
    const overflow = observation(); overflow.records.valid.overflow = true;
    expect(nativeJsonUiInputConfirmed(overflow, "valid")).toBe(false);
    for (const change of [
      (value: any) => { value.schemaVersion = 1; },
      (value: any) => { delete value.records.valid.diagnostics; },
      (value: any) => { value.records.valid.diagnostics.composition.active = true; },
      (value: any) => { value.records.valid.diagnostics.lastEditingIsComposing = "unknown"; },
    ]) { const value = observation(); change(value); expect(nativeJsonUiInputConfirmed(value, "valid")).toBe(false); }
  });
  it("does not turn synthetic DOM input or unrelated controls into OS input proof", () => {
    const fixture = install(); fixture.api.begin("valid");
    for (const type of ["keydown", "beforeinput", "input"]) fixture.emit(type, fixture.textarea, false);
    fixture.emit("keydown", {}); fixture.emit("input", {});
    let value = fixture.api.snapshot();
    expect(nativeJsonUiInputConfirmed(value, "valid")).toBe(false);
    expect(value.records.valid.rejectedUntrusted).toBe(3);
    for (const type of ["keydown", "beforeinput", "input"]) fixture.emit(type);
    value = fixture.api.snapshot();
    expect(nativeJsonUiInputConfirmed(value, "valid")).toBe(true);
    expect(JSON.stringify(value)).not.toContain("private-input-marker");
    expect(JSON.stringify(value)).not.toContain("private-key-marker");
  });
  it("counts only trusted original toolbar clicks and never reuses phase counters", () => {
    const fixture = install(); fixture.api.begin("format");
    fixture.emit("click", fixture.format, false); fixture.emit("click", {});
    expect(fixture.api.snapshot().records.format.trustedFormatClicks).toBe(0);
    fixture.emit("click", fixture.format);
    expect(fixture.api.snapshot().records.format.trustedFormatClicks).toBe(1);
    expect(() => fixture.api.begin("format")).toThrow();
    fixture.api.begin("recovery");
    expect(fixture.api.snapshot().records.recovery.trustedInputs).toBe(0);
    expect(() => fixture.api.begin("arbitrary-user-value")).toThrow();
  });
  it("removes all active listeners on stop and pagehide, without persisting input", () => {
    for (const stop of ["explicit", "pagehide", "atools-plugin-out"]) {
      const fixture = install(); fixture.api.begin("valid");
      if (stop === "explicit") fixture.api.stop(); else fixture.windowListeners.get(stop)!();
      expect(fixture.listeners.size).toBe(0); expect(fixture.windowListeners.size).toBe(0);
      expect(fixture.api.snapshot()).toMatchObject({ stopped: true, listenerCount: 0 });
      expect(() => fixture.api.begin("recovery")).toThrow();
    }
  });
});
