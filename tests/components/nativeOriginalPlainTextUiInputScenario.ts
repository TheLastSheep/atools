import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { editorInputAdmission } from "./nativeEditorInputAdmission";
import { nativeUiInputCompositionSettled, nativeUiInputDiagnosticsValid,
  type NativeUiInputDiagnostics } from "../../scripts/lib/native-ui-input-diagnostics.mjs";

export type NativePlainTextUiInputObservation = { schemaVersion: number; phase: string | null; stopped: boolean;
  listenerCount: number; lifecycleListenerCount: number;
  records: Record<string, { trustedEditorPointers: number; trustedKeydowns: number; trustedBeforeInputs: number;
    trustedInputs: number; rejectedUntrusted: number; overflow: boolean; diagnostics: NativeUiInputDiagnostics }> };
type PlainState = { ready: boolean; text: string; mode: string; previewHeading: string; previewItems: string[];
  drawerOpen: boolean; drafts: Array<{ title: string; active: boolean }>;
  editCommandResults: Array<{ command: string; accepted: boolean }>; focusAttempt: unknown;
  focusDiagnostics: { visibilityState: string; documentHidden: boolean; documentHasFocus: boolean;
    editorActive: boolean; editorConnected: boolean; editorIsContentEditable: boolean; editorWidth: number; editorHeight: number;
    computedStyle: { webkitUserModify: string; userSelect: string; pointerEvents: string } | null; inertAncestors: string[];
    userActivation: { isActive: boolean; hasBeenActive: boolean } | null };
  nativeUiInputObservation?: NativePlainTextUiInputObservation };
type ProofPhase = { proof: NativePlainTextUiInputObservation; hostVisible: boolean; hostHasFocus: boolean;
  frameVisible: boolean; frameHasFocus: boolean; editorActive: boolean; editorVisible: boolean;
  renderedText: string; renderedTextMatches: boolean; editCommandResults: unknown[]; focusAttempt: unknown;
  focusDiagnostics: PlainState["focusDiagnostics"] };

const expected = {
  alpha: "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.",
  beta: "# ATools markdown beta document\n\n- first\n- second",
} as const;
const phaseDeadlineMs = 60_000;
const pollIntervalMs = 150;
const phases = ["alpha", "beta"] as const;

function nativePlainUiInputEnabled(context: PublishedScenarioContext) {
  const enabled = (context.fixture as PublishedScenarioContext["fixture"] & { nativeUiInput?: boolean }).nativeUiInput;
  if (enabled !== true || context.profile.caseId !== "local-plain-text") throw Error("NativePlainTextUiInputFixtureRequired");
}

function confirmed(proof: NativePlainTextUiInputObservation | undefined, phase: typeof phases[number]) {
  const record = proof?.records?.[phase];
  return proof?.schemaVersion === 2 && proof.phase === phase && proof.stopped === false
    && proof.listenerCount === 8 && proof.lifecycleListenerCount === 2 && !!record && record.overflow === false
    && [record.trustedEditorPointers, record.trustedKeydowns, record.trustedBeforeInputs,
      record.trustedInputs, record.rejectedUntrusted].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 8192)
    && record.trustedEditorPointers > 0 && record.trustedKeydowns > 0 && record.trustedBeforeInputs > 0 && record.trustedInputs > 0
    && nativeUiInputDiagnosticsValid(record.diagnostics, record) && nativeUiInputCompositionSettled(record.diagnostics);
}

/** Creates a read-only OS-input session; the caller owns its lifetime across both original drafts. */
export async function createNativeOriginalPlainTextUiInputScenario(context: PublishedScenarioContext) {
  nativePlainUiInputEnabled(context);
  const guide = document.createElement("aside");
  guide.setAttribute("data-atools-native-plain-text-input", "");
  guide.setAttribute("role", "status");
  guide.setAttribute("aria-live", "polite");
  guide.style.cssText = "position:fixed;top:64px;left:12px;right:12px;z-index:2147483647;pointer-events:none;padding:8px 12px;background:#fff5c2;color:#352b10;border:1px solid #9f8737;border-radius:6px;font:12px/1.5 system-ui;white-space:pre-wrap";
  document.body.appendChild(guide);
  const proofs: Partial<Record<typeof phases[number], NativePlainTextUiInputObservation>> = {};
  const visibility: Partial<Record<typeof phases[number], ProofPhase>> = {};
  let stopped = false;

  async function enter(phase: typeof phases[number]) {
    if (stopped || !phases.includes(phase) || proofs[phase] || (phase === "beta" && !proofs.alpha) || (phase === "alpha" && proofs.beta))
      throw Error("NativePlainTextUiPhaseRejected");
    context.setPhase("original-plain-text-os-input-" + phase);
    await context.probe("native-ui-" + phase);
    guide.textContent = "隔离纯文本验收 · " + phase + "\n点击原版编辑区，按 ⌘A 全选后用系统键盘输入：\n" + expected[phase];
    await editorInputAdmission(context)?.arm(phase);
    const deadline = performance.now() + phaseDeadlineMs;
    while (performance.now() < deadline) {
      await editorInputAdmission(context)?.service();
      const state = await context.probe<PlainState>("state");
      context.observations.originalPlainNativeUiLastState = state;
      const focus = state.focusDiagnostics, proof = state.nativeUiInputObservation;
      const hostVisible = document.visibilityState === "visible";
      const hostHasFocus = document.hasFocus();
      const frameVisible = focus.visibilityState === "visible" && focus.documentHidden === false;
      const frameHasFocus = focus.documentHasFocus === true;
      const editorActive = focus.editorActive === true && focus.editorConnected === true
        && focus.editorIsContentEditable === true;
      const editorVisible = Number.isFinite(focus.editorWidth) && Number.isFinite(focus.editorHeight)
        && focus.editorWidth > 0 && focus.editorHeight > 0;
      const renderedTextMatches = state.text === expected[phase];
      const noProgrammaticEditing = Array.isArray(state.editCommandResults) && state.editCommandResults.length === 0
        && state.focusAttempt === null;
      const admission = editorInputAdmission(context);
      if ((!admission || admission.readyForAcceptance()) && hostVisible && hostHasFocus && frameVisible && frameHasFocus && editorActive && editorVisible
        && renderedTextMatches && confirmed(proof, phase) && noProgrammaticEditing) {
        proofs[phase] = proof!;
        visibility[phase] = { proof: proof!, hostVisible, hostHasFocus, frameVisible, frameHasFocus,
          editorActive, editorVisible, renderedText: state.text, renderedTextMatches, editCommandResults: state.editCommandResults,
          focusAttempt: state.focusAttempt, focusDiagnostics: focus };
        context.check(true, "Original visible CodeMirror editor received trusted OS pointer, keydown, beforeinput and input events");
        return state;
      }
      await context.pause(pollIntervalMs);
    }
    throw Error("NativePlainTextUiInputDeadline:" + phase);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    guide.remove();
    const state = await context.probe<PlainState>("native-ui-stop");
    const cleanup = state.nativeUiInputObservation;
    context.check(cleanup?.stopped === true && cleanup.listenerCount === 0 && cleanup.lifecycleListenerCount === 0,
      "Plain-text input observer removes all document and lifecycle listeners");
    context.observations.originalPlainNativeUiInput = { proofs, visibility, cleanup, phaseDeadlineMs,
      pollIntervalMs, controller: "External OS UI control; fixture only reads rendered DOM and trusted event counters",
      hardwareHumanInputVerified: false };
  }

  return { enter, stop };
}
