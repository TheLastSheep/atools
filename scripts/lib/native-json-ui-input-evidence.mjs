import { nativeUiInputCompositionSettled, nativeUiInputDiagnosticsValid } from "./native-ui-input-diagnostics.mjs";
const phases = ["valid", "format", "malformed", "recovery"];
const counters = ["trustedKeydowns", "trustedBeforeInputs", "trustedInputs", "trustedEditorPointers", "trustedFormatClicks", "rejectedUntrusted"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Independently reject a manual-input report that merely ran the older edit-command case. */
export function validateNativeJsonUiInput(report) {
  const evidence = report?.observations?.jsonEditorNativeUiInput;
  if (!record(evidence) || !record(evidence.proofs) || !record(evidence.visibility) || !record(evidence.worker)
    || evidence.hardwareHumanInputVerified !== false) return { passed: false, reason: "native_input_evidence_missing" };
  for (const phase of phases) {
    const proof = evidence.proofs[phase], view = evidence.visibility[phase];
    const counts = proof?.records?.[phase];
    if (!record(proof) || proof.schemaVersion !== 2 || proof.phase !== phase || proof.stopped !== false
      || proof.listenerCount !== 8 || !record(counts) || counts.overflow !== false
      || !counters.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0 && counts[key] <= 8192)
      || !nativeUiInputDiagnosticsValid(counts.diagnostics, counts)) {
      return { passed: false, reason: "native_input_counters_invalid", phase };
    }
    if (!record(view) || !["hostVisible", "hostHasFocus", "frameVisible", "frameHasFocus"].every(key => view[key] === true)
      || phase !== "format" && view.textareaActive !== true) return { passed: false, reason: "native_input_not_visible_or_focused", phase };
    if (phase === "format" ? counts.diagnostics.composition.active !== false : !nativeUiInputCompositionSettled(counts.diagnostics)) {
      return { passed: false, reason: "native_input_composition_unsettled", phase };
    }
    if (phase === "format" ? counts.trustedFormatClicks < 1
      : counts.trustedKeydowns < 1 || counts.trustedBeforeInputs < 1 || counts.trustedInputs < 1) {
      return { passed: false, reason: "trusted_input_sequence_missing", phase };
    }
  }
  const { valid, malformed, recovery } = evidence.worker;
  if (![valid, malformed, recovery].every(value => record(value) && positive(value.requestOrdinal)
    && positive(value.validationRequests) && positive(value.validationResponses))
    || !(valid.requestOrdinal < malformed.requestOrdinal && malformed.requestOrdinal < recovery.requestOrdinal)
    || valid.markerCount !== 0 || valid.errorCount !== 0 || recovery.markerCount !== 0 || recovery.errorCount !== 0
    || !positive(malformed.markerCount) || !positive(malformed.errorCount)
    || !Array.isArray(malformed.positions) || !malformed.positions.some(value => positive(value?.line) && positive(value?.column))) {
    return { passed: false, reason: "paired_worker_recovery_evidence_invalid" };
  }
  if (evidence.textObservation !== "Original .view-lines rendered DOM; no direct Monaco model access") {
    return { passed: false, reason: "rendered_text_observation_missing" };
  }
  if (evidence.cleanup?.schemaVersion !== 2 || evidence.cleanup.stopped !== true || evidence.cleanup.listenerCount !== 0) {
    return { passed: false, reason: "observer_cleanup_missing" };
  }
  return { passed: true, phases: phases.length, humanHardwareInputVerified: false };
}
