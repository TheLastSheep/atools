import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { editorInputAdmission } from "./nativeEditorInputAdmission";
import { nativeUiInputCompositionSettled, nativeUiInputDiagnosticsValid,
  type NativeUiInputDiagnostics } from "../../scripts/lib/native-ui-input-diagnostics.mjs";

type InputRecord = { trustedKeydowns: number; trustedBeforeInputs: number; trustedInputs: number;
  trustedEditorPointers: number; trustedFormatClicks: number; rejectedUntrusted: number; overflow: boolean;
  diagnostics: NativeUiInputDiagnostics };
export type NativeJsonUiInputObservation = { schemaVersion: number; phase: string | null; stopped: boolean;
  listenerCount: number; records: Record<string, InputRecord> };
type State = { inputText: string; malformedMarkerCount: number;
  focusDiagnostics: { textareaActive: boolean; documentHasFocus: boolean; documentHidden?: boolean; visibilityState?: string };
  nativeUiInputObservation?: NativeJsonUiInputObservation };
type Validation<T extends State> = { read: () => Promise<T>; count: (state: T) => number;
  matches: (state: T, baseline: number, valid: boolean) => boolean;
  assert: (state: T, expectation: "valid" | "malformed") => unknown };

const validJson = '{"name":"ATools","nested":{"active":true,"items":[1,2]}}';
const invalidJson = '{"name":"ATools","nested":[1,]}';
const formattedJson = '{\n    "name": "ATools",\n    "nested": {\n        "active": true,\n        "items": [\n            1,\n            2\n        ]\n    }\n}';
const phaseDeadlineMs = 60_000;

export function nativeJsonUiInputConfirmed(observation: NativeJsonUiInputObservation | undefined, phase: string) {
  const record = observation?.records?.[phase];
  return observation?.schemaVersion === 2 && observation.phase === phase && observation.stopped === false
    && observation.listenerCount === 8 && !!record && record.overflow === false
    && [record.trustedKeydowns, record.trustedBeforeInputs, record.trustedInputs,
      record.trustedEditorPointers, record.trustedFormatClicks, record.rejectedUntrusted]
      .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 8192) && record.trustedKeydowns > 0
    && record.trustedBeforeInputs > 0 && record.trustedInputs > 0
    && nativeUiInputDiagnosticsValid(record.diagnostics, record) && nativeUiInputCompositionSettled(record.diagnostics);
}

/** Read-only state polling during explicit OS control; never dispatches editor input or clicks. */
export async function runNativeJsonUiInputScenario<T extends State>(
  context: PublishedScenarioContext, validation: Validation<T>,
): Promise<PublishedBusinessResult> {
  if ((context.fixture as unknown as { nativeUiInput?: boolean }).nativeUiInput !== true
    || context.profile.caseId !== "local-json-editor") throw Error("NativeJsonUiInputFixtureRequired");
  const guide = document.createElement("aside");
  guide.setAttribute("data-atools-native-json-input", "");
  guide.setAttribute("role", "status");
  guide.setAttribute("aria-live", "polite");
  guide.style.cssText = "position:fixed;top:64px;left:12px;right:12px;z-index:2147483647;pointer-events:none;padding:8px 12px;background:#fff5c2;color:#352b10;border:1px solid #9f8737;border-radius:6px;font:12px/1.5 system-ui;white-space:pre-wrap";
  document.body.appendChild(guide);
  const proofs: Record<string, unknown> = {};
  const worker: Record<string, unknown> = {};
  const visibility: Record<string, unknown> = {};
  const evidence = { proofs, worker, visibility, phaseDeadlineMs,
    controller: "External OS UI controller; no fixture editor writes, model mutations, browser edit commands or synthetic clicks",
    hardwareHumanInputVerified: false, textObservation: "Original .view-lines rendered DOM; no direct Monaco model access",
    cleanup: undefined as NativeJsonUiInputObservation | undefined };
  context.observations.jsonEditorNativeUiInput = evidence;
  let last: T;
  async function begin(phase: string, instruction: string) {
    context.setPhase("original-json-editor-os-input-" + phase);
    await context.probe("native-ui-" + phase);
    guide.textContent = "隔离 JSON 验收 · " + phase + "\n" + instruction;
    await editorInputAdmission(context)?.arm(phase as "valid" | "format" | "malformed" | "recovery");
  }
  async function wait(phase: string, accept: (state: T) => boolean) {
    const deadline = performance.now() + phaseDeadlineMs;
    while (performance.now() < deadline) {
      await editorInputAdmission(context)?.service();
      last = await validation.read();
      context.observations.jsonEditorNativeUiLastState = last;
      const admission = editorInputAdmission(context);
      if ((!admission || admission.readyForAcceptance()) && accept(last)) return last;
      await context.pause(150);
    }
    throw Error("NativeJsonUiInputDeadline:" + phase);
  }
  function visibleInput(state: T) {
    const focus = state.focusDiagnostics;
    return document.visibilityState === "visible" && document.hasFocus()
      && focus.textareaActive && focus.documentHasFocus && focus.documentHidden === false
      && focus.visibilityState === "visible";
  }
  function recordVisibility(phase: string, state: T) {
    visibility[phase] = { hostVisible: document.visibilityState === "visible", hostHasFocus: document.hasFocus(),
      frameVisible: state.focusDiagnostics.visibilityState === "visible", frameHasFocus: state.focusDiagnostics.documentHasFocus,
      textareaActive: state.focusDiagnostics.textareaActive };
  }
  let inputFailed = false;
  try {
    let state = await validation.read();
    let baseline = validation.count(state);
    await begin("valid", "点击左侧原版编辑区，用系统键盘输入以下 JSON：\n" + validJson);
    state = await wait("valid", value => value.inputText === validJson && visibleInput(value)
      && nativeJsonUiInputConfirmed(value.nativeUiInputObservation, "valid") && validation.matches(value, baseline, true));
    proofs.valid = state.nativeUiInputObservation;
    recordVisibility("valid", state);
    worker.valid = validation.assert(state, "valid");
    context.check(true, "Trusted OS keydown, beforeinput and input reach the focused visible original Monaco textarea");

    await begin("format", "点击原版工具栏的第一个格式化按钮，等待进入下一步。");
    state = await wait("format", value => value.inputText === formattedJson
      && document.visibilityState === "visible" && document.hasFocus()
      && value.focusDiagnostics.documentHasFocus && value.focusDiagnostics.visibilityState === "visible"
      && (value.nativeUiInputObservation?.records.format?.trustedFormatClicks ?? 0) > 0
      && value.nativeUiInputObservation?.schemaVersion === 2 && value.nativeUiInputObservation.phase === "format"
      && value.nativeUiInputObservation.stopped === false && value.nativeUiInputObservation.listenerCount === 8
      && value.nativeUiInputObservation.records.format?.overflow === false
      && nativeUiInputDiagnosticsValid(value.nativeUiInputObservation.records.format.diagnostics, value.nativeUiInputObservation.records.format)
      && value.nativeUiInputObservation.records.format.diagnostics.composition.active === false);
    proofs.format = state.nativeUiInputObservation;
    recordVisibility("format", state);
    context.check(true, "Trusted click on the original reformat button formats the actual rendered nested JSON text");

    baseline = validation.count(state);
    await begin("malformed", "点击原版编辑区，全选并用系统键盘替换为：\n" + invalidJson);
    state = await wait("malformed", value => value.inputText === invalidJson && visibleInput(value)
      && nativeJsonUiInputConfirmed(value.nativeUiInputObservation, "malformed")
      && value.malformedMarkerCount > 0 && validation.matches(value, baseline, false));
    proofs.malformed = state.nativeUiInputObservation;
    recordVisibility("malformed", state);
    worker.malformed = validation.assert(state, "malformed");

    baseline = validation.count(state);
    await begin("recovery", "点击原版编辑区，全选并用系统键盘恢复为：\n" + validJson);
    state = await wait("recovery", value => value.inputText === validJson && visibleInput(value)
      && nativeJsonUiInputConfirmed(value.nativeUiInputObservation, "recovery")
      && value.malformedMarkerCount === 0 && validation.matches(value, baseline, true));
    proofs.recovery = state.nativeUiInputObservation;
    recordVisibility("recovery", state);
    worker.recovery = validation.assert(state, "valid");
    context.check(true, "Trusted OS input produces original worker diagnostics and clears them after valid recovery");
    return { businessOutcome: "scoped_pass", tested: ["visible original textarea OS input", "trusted original reformat click",
      "original JSON worker malformed diagnostics", "diagnostic recovery after trusted OS input"],
      notTested: ["human hardware input", "files", "clipboard", "external URLs", "other original packages", "large-input performance"],
      boundary: "Explicit isolated OS-controlled fixture only. Exact text is read from original .view-lines rendered DOM. Trusted diagnostic counters contain no key values or input text; no fixture input dispatch or Monaco model access." };
  } catch (error) {
    inputFailed = true;
    throw error;
  } finally {
    guide.remove();
    try {
      const state = await context.probe<T>("native-ui-stop");
      evidence.cleanup = state.nativeUiInputObservation;
      context.check(state.nativeUiInputObservation?.stopped === true && state.nativeUiInputObservation.listenerCount === 0,
        "Native JSON input observer removes all listeners before whole-plugin close");
    } catch (error) {
      context.observations.jsonEditorNativeUiCleanupFailure = {
        errorClass: error instanceof Error ? "Error" : "NonError", primaryErrorPreserved: inputFailed,
      };
      if (!inputFailed) throw error;
    }
  }
}
