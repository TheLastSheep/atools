import { nativeUiInputCompositionSettled, nativeUiInputDiagnosticsValid } from "./native-ui-input-diagnostics.mjs";
const phases = ["alpha", "beta"];
const expectedText = { alpha: "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.",
  beta: "# ATools markdown beta document\n\n- first\n- second" };
const counters = ["trustedEditorPointers", "trustedKeydowns", "trustedBeforeInputs", "trustedInputs", "rejectedUntrusted"];
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeCounter = value => Number.isSafeInteger(value) && value >= 0 && value <= 8192;

/** Reject reports from the older programmatic editor-command scenario. */
export function validateNativePlainUiInput(report) {
  const evidence = report?.observations?.originalPlainNativeUiInput;
  if (!plain(evidence) || !plain(evidence.proofs) || !plain(evidence.visibility)
    || evidence.hardwareHumanInputVerified !== false || evidence.phaseDeadlineMs !== 60000 || evidence.pollIntervalMs !== 150) {
    return { passed: false, reason: "native_input_evidence_missing" };
  }
  for (const phase of phases) {
    const proof = evidence.proofs[phase], view = evidence.visibility[phase], record = proof?.records?.[phase];
    if (!plain(proof) || proof.schemaVersion !== 2 || proof.phase !== phase || proof.stopped !== false
      || proof.listenerCount !== 8 || proof.lifecycleListenerCount !== 2 || !plain(record)
      || record.overflow !== false || !counters.every(key => safeCounter(record[key]))
      || !nativeUiInputDiagnosticsValid(record.diagnostics, record)) {
      return { passed: false, reason: "native_input_counters_invalid", phase };
    }
    if (!plain(view) || !["hostVisible", "hostHasFocus", "frameVisible", "frameHasFocus", "editorActive", "editorVisible"]
      .every(key => view[key] === true) || view.renderedText !== expectedText[phase] || view.renderedTextMatches !== true
      || !Array.isArray(view.editCommandResults) || view.editCommandResults.length !== 0
      || view.focusAttempt !== null || !plain(view.focusDiagnostics) || view.focusDiagnostics.editorActive !== true
      || view.focusDiagnostics.documentHasFocus !== true || view.focusDiagnostics.documentHidden !== false
      || view.focusDiagnostics.visibilityState !== "visible" || view.focusDiagnostics.editorIsContentEditable !== true
      || !Number.isFinite(view.focusDiagnostics.editorWidth) || view.focusDiagnostics.editorWidth <= 0
      || !Number.isFinite(view.focusDiagnostics.editorHeight) || view.focusDiagnostics.editorHeight <= 0
      || !plain(view.focusDiagnostics.computedStyle) || !Array.isArray(view.focusDiagnostics.inertAncestors)
      || view.focusDiagnostics.inertAncestors.length > 12) {
      return { passed: false, reason: "native_input_not_visible_or_focused", phase };
    }
    if (!nativeUiInputCompositionSettled(record.diagnostics)) return { passed: false, reason: "native_input_composition_unsettled", phase };
    if (!(record.trustedEditorPointers > 0 && record.trustedKeydowns > 0
      && record.trustedBeforeInputs > 0 && record.trustedInputs > 0)) {
      return { passed: false, reason: "trusted_input_sequence_missing", phase };
    }
  }
  const cleanup = evidence.cleanup;
  if (!plain(cleanup) || cleanup.stopped !== true || cleanup.listenerCount !== 0 || cleanup.lifecycleListenerCount !== 0) {
    return { passed: false, reason: "observer_cleanup_missing" };
  }
  return { passed: true, phases: phases.length, listenersAfterStop: 0, humanHardwareInputVerified: false };
}
