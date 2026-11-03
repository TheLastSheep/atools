import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { runNativeJsonUiInputScenario, type NativeJsonUiInputObservation } from "./nativeOriginalJsonUiInputScenario";

type JsonWorkerValidationReply = {
  requestOrdinal: number;
  markerCount: number;
  errorCount: number;
  codes: string[];
  positions: Array<{ line: number; column: number }>;
};
type JsonWorkerEvidence = {
  name: string;
  entry: string;
  constructed: boolean;
  requests: number;
  responses: number;
  validationRequests: number;
  validationResponses: number;
  validationReplies: JsonWorkerValidationReply[];
  errors: number;
  terminated: boolean;
};
type JsonEditorState = {
  ready: boolean;
  inputText: string;
  inputReady: boolean;
  formatActionReady: boolean;
  malformedMarkerCount: number;
  focusDiagnostics: {
    documentHasFocus: boolean;
    activeElementTag: string;
    activeElementClass: string;
    textareaDisabled: boolean;
    textareaReadOnly: boolean;
    textareaTabIndex: number | null;
    textareaConnected: boolean;
    textareaWidth: number;
    textareaHeight: number;
    textareaActive: boolean;
    ancestors: Array<{ tag: string; className: string; display: string; visibility: string; hidden: boolean; inert: boolean; ariaHidden: boolean }>;
  };
  editCommandResults: Array<{ command: string; accepted: boolean }>;
  focusObservation?: unknown;
  nativeUiInputObservation?: NativeJsonUiInputObservation;
  workerEvidence?: { supported: boolean; overflowed?: boolean; workers: JsonWorkerEvidence[] };
};

// The original editor does not override Monaco's default 4-space model indentation.
const formattedJson = '{\n    "name": "ATools",\n    "nested": {\n        "active": true,\n        "items": [\n            1,\n            2\n        ]\n    }\n}';

async function waitState(
  context: PublishedScenarioContext,
  accept: (state: JsonEditorState) => boolean,
  message: string
) {
  try {
    return await context.until(async () => {
      const value = await context.probe<JsonEditorState>("state");
      context.observations.jsonEditorLastState = value;
      return accept(value) ? value : null;
    }, message);
  } catch (error) {
    // Diagnose only after the real UI assertion failed; never turn control success into acceptance.
    try {
      context.observations.jsonEditorFocusControlDiagnostics = (await context.probe<{ focusControlDiagnostics: unknown }>("diagnose-focus-controls")).focusControlDiagnostics;
    } catch { context.observations.jsonEditorFocusControlDiagnosticsUnavailable = true; }
    throw error;
  }
}

function jsonWorker(state: JsonEditorState): JsonWorkerEvidence {
  const evidence = state.workerEvidence?.workers?.find(worker => worker.name === "json"
    && worker.entry === "json.worker.js");
  if (!evidence) throw Error("Original Monaco JSON worker evidence is missing from the frame probe");
  if (state.workerEvidence?.supported !== true) throw Error("Original Monaco JSON worker support was not positively observed");
  if (state.workerEvidence.overflowed === true) throw Error("Original Monaco JSON worker evidence overflowed its bounded diagnostic buffer");
  return evidence;
}

function validationRequestCount(state: JsonEditorState) {
  return state.workerEvidence?.workers?.find(value => value.name === "json" && value.entry === "json.worker.js")
    ?.validationRequests ?? 0;
}

export function hasObservedTextareaFocus(state: JsonEditorState) {
  return state.focusDiagnostics?.textareaActive === true;
}

function hostFocusSnapshot() {
  const active = document.activeElement;
  const frame = document.querySelector('iframe[title="Plugin"]');
  return { documentHasFocus: document.hasFocus(), activeTag: active?.tagName.toLowerCase().slice(0, 32) ?? "",
    activeIsPluginFrame: active === frame, pluginFrameConnected: frame?.isConnected === true };
}

async function waitForOriginalTextareaUiFocus(context: PublishedScenarioContext) {
  context.setPhase("original-json-editor-ui-focus");
  const deadline = performance.now() + 30_000;
  let polls = 0;
  while (performance.now() < deadline) {
    const state = await context.probe<JsonEditorState>("state");
    context.observations.jsonEditorLastState = state;
    context.observations.jsonEditorHostFocusLast = hostFocusSnapshot();
    context.observations.jsonEditorFocusObservation = state.focusObservation;
    polls += 1;
    if (performance.now() <= deadline && hasObservedTextareaFocus(state)) {
      const focus = state.focusDiagnostics;
      context.observations.jsonEditorUiFocus = {
        observed: true,
        polls,
        documentHasFocus: focus.documentHasFocus,
        activeElementTag: focus.activeElementTag,
        activeElementClass: focus.activeElementClass,
        textareaConnected: focus.textareaConnected,
        textareaWidth: focus.textareaWidth,
        textareaHeight: focus.textareaHeight,
      };
      return state;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await context.pause(Math.min(500, remaining));
  }
  const last = context.observations.jsonEditorLastState as JsonEditorState | undefined;
  const focus = last?.focusDiagnostics;
  context.observations.jsonEditorUiFocus = {
    observed: false,
    polls,
    documentHasFocus: focus?.documentHasFocus === true,
    activeElementTag: focus?.activeElementTag ?? "",
    activeElementClass: focus?.activeElementClass ?? "",
    textareaConnected: focus?.textareaConnected === true,
    textareaWidth: focus?.textareaWidth ?? 0,
    textareaHeight: focus?.textareaHeight ?? 0,
  };
  throw Error("Original Monaco textarea did not receive real UI focus within 30 seconds; no JSON input operation was attempted");
}

function recordEditCommandResults(context: PublishedScenarioContext, state: JsonEditorState,
  operation: "enter-valid-json" | "enter-malformed-json") {
  context.observations.jsonEditorLastState = state;
  if (!state.focusDiagnostics?.textareaActive) {
    const focus = state.focusDiagnostics;
    throw Error(`Original Monaco textarea focus was not acquired (documentHasFocus=${focus?.documentHasFocus === true}, active=${focus?.activeElementTag || "unknown"}.${focus?.activeElementClass || ""}, disabled=${focus?.textareaDisabled === true}, readOnly=${focus?.textareaReadOnly === true}, tabIndex=${focus?.textareaTabIndex ?? "unknown"}, connected=${focus?.textareaConnected === true}, rect=${focus?.textareaWidth ?? 0}x${focus?.textareaHeight ?? 0}, ancestors=${JSON.stringify(focus?.ancestors ?? [])})`);
  }
  const results = state.editCommandResults;
  if (!Array.isArray(results) || results.length !== 2 || results[0]?.command !== "selectAll"
    || results[1]?.command !== "insertText") {
    throw Error(`Original Monaco ${operation} did not report the reviewed browser edit commands`);
  }
  const observations = context.observations.jsonEditorEditCommandResults as Array<Record<string, unknown>> | undefined;
  context.observations.jsonEditorEditCommandResults = [...(observations ?? []), {
    operation,
    commands: results.map(result => ({ command: result.command, accepted: result.accepted === true })),
  }];
}

export function hasObservedInitialWorkerHandshake(state: JsonEditorState) {
  const worker = state.workerEvidence?.workers?.find(value => value.name === "json" && value.entry === "json.worker.js");
  return state.workerEvidence?.supported === true && state.workerEvidence.overflowed !== true
    && worker?.constructed === true && worker.requests > 0 && worker.responses > 0
    && worker.responses <= worker.requests;
}

export function latestReplyMatches(state: JsonEditorState, requestBaseline: number, isValid: boolean) {
  const worker = state.workerEvidence?.workers?.find(value => value.name === "json" && value.entry === "json.worker.js");
  const reply = worker?.validationReplies[worker.validationReplies.length - 1];
  return state.workerEvidence?.supported === true && state.workerEvidence.overflowed !== true
    && !!worker && worker.validationResponses > 0 && !!reply && reply.requestOrdinal > requestBaseline
    && (isValid ? reply.markerCount === 0 && reply.errorCount === 0
      : reply.markerCount > 0 && reply.errorCount > 0);
}

function assertJsonWorkerRoundTrip(context: PublishedScenarioContext, state: JsonEditorState,
  expectation: "valid" | "malformed") {
  const worker = jsonWorker(state);
  const reply = worker.validationReplies.at(-1);
  if (worker.entry !== "json.worker.js" || !worker.constructed || worker.terminated || worker.errors > 0) {
    throw Error("Original Monaco JSON worker identity, construction, or runtime status is invalid");
  }
  context.check(worker.validationRequests > 0 && worker.validationResponses > 0
    && worker.responses >= worker.validationResponses,
  "Original Monaco JSON worker completed a paired doValidation request and response round trip");
  if (!reply) throw Error("Original Monaco JSON worker validation reply evidence is missing");
  if (!Number.isSafeInteger(reply.requestOrdinal) || reply.requestOrdinal < 1) {
    throw Error("Original Monaco JSON worker reply does not identify its paired validation request ordinal");
  }
  if (expectation === "malformed") {
    const hasError = reply.markerCount > 0 && reply.errorCount > 0
      && reply.positions.some(position => position.line > 0 && position.column > 0);
    context.check(hasError,
      "Original Monaco JSON worker returned a positioned error diagnostic for malformed JSON");
    return { name: worker.name, entry: worker.entry, requestOrdinal: reply.requestOrdinal,
      validationRequests: worker.validationRequests,
      validationResponses: worker.validationResponses, markerCount: reply.markerCount,
      errorCount: reply.errorCount, codes: reply.codes, positions: reply.positions };
  }
  context.check(reply.markerCount === 0 && reply.errorCount === 0,
    "Original Monaco JSON worker reports no errors for valid JSON input");
  return { name: worker.name, entry: worker.entry, requestOrdinal: reply.requestOrdinal,
    validationRequests: worker.validationRequests,
    validationResponses: worker.validationResponses, markerCount: reply.markerCount, errorCount: reply.errorCount };
}

export async function runOriginalJsonEditorScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, probe, setPhase, observations } = context;
  let state = await waitState(context, value => value.ready,
    "Original JSON Editor Monaco input and reformat control did not mount");
  check(state.inputReady && state.formatActionReady,
    "Original JSON Editor exposes its actual Monaco input and reformat toolbar control");
  if (state.workerEvidence?.supported !== true) throw Error("Native Worker observation is unsupported in this frame");
  if (state.workerEvidence.overflowed === true) throw Error("Native Worker observation overflowed before JSON business input");
  setPhase("original-json-editor-initial-worker-handshake");
  state = await waitState(context, hasObservedInitialWorkerHandshake,
    "Original Monaco JSON worker did not complete a paired request/response handshake before the fixed-input baseline");
  const initialWorker = jsonWorker(state);
  if (!initialWorker.constructed || initialWorker.terminated || initialWorker.errors > 0
    || initialWorker.requests < 1 || initialWorker.responses < 1 || initialWorker.responses > initialWorker.requests) {
    throw Error("Original Monaco JSON worker handshake identity or paired request/response counts are invalid");
  }
  observations.jsonEditorInitialWorkerHandshake = {
    name: initialWorker.name,
    entry: initialWorker.entry,
    requests: initialWorker.requests,
    responses: initialWorker.responses,
    validationRequests: initialWorker.validationRequests,
    validationResponses: initialWorker.validationResponses,
  };
  check(true, "Original Monaco JSON worker completed a paired generic request/response handshake");

  if ((context.fixture as unknown as { nativeUiInput?: boolean }).nativeUiInput === true) {
    return runNativeJsonUiInputScenario(context, {
      read: () => probe<JsonEditorState>("state"), count: validationRequestCount, matches: latestReplyMatches,
      assert: (value, expectation) => assertJsonWorkerRoundTrip(context, value, expectation),
    });
  }

  observations.jsonEditorHostFocusBeforeInput = hostFocusSnapshot();
  state = await probe<JsonEditorState>("begin-focus-observation");
  observations.jsonEditorTextareaFocusedOnEntry = hasObservedTextareaFocus(state);
  if (!hasObservedTextareaFocus(state)) {
    state = await probe<JsonEditorState>("focus-input");
    observations.jsonEditorProgrammaticFocus = { attempted: true, succeeded: hasObservedTextareaFocus(state) };
    if (!hasObservedTextareaFocus(state)) {
      observations.jsonEditorFocusControlDiagnostics = (await probe<{ focusControlDiagnostics: unknown }>("diagnose-focus-controls")).focusControlDiagnostics;
      observations.jsonEditorFocusObservation = (await probe<JsonEditorState>("state")).focusObservation;
      throw Error("Original textarea focus failed; independent control diagnostics recorded without attempting JSON input");
    }
  }
  state = await waitForOriginalTextareaUiFocus(context);
  setPhase("original-json-editor-json-worker-valid-format");
  const initialValidationBaseline = validationRequestCount(state);
  state = await probe<JsonEditorState>("enter-valid-json");
  recordEditCommandResults(context, state, "enter-valid-json");
  state = await waitState(context, value => value.inputText.includes('"items"') && value.inputText.includes("active")
    && latestReplyMatches(value, initialValidationBaseline, true),
  "Original Monaco editor did not render and validate the fixed nested JSON input in its real worker");
  const validWorker = assertJsonWorkerRoundTrip(context, state, "valid");
  await probe("reformat");
  state = await waitState(context, value => value.inputText === formattedJson,
    "Original reformat action did not produce the expected readable nested JSON");
  check(state.inputText === formattedJson,
    "Original JSON Editor reformat action formats nested objects and arrays with stable indentation");

  setPhase("original-json-editor-worker-diagnostics-and-recovery");
  state = await probe<JsonEditorState>("state");
  const malformedValidationBaseline = validationRequestCount(state);
  state = await probe<JsonEditorState>("enter-malformed-json");
  recordEditCommandResults(context, state, "enter-malformed-json");
  state = await waitState(context, value => value.inputText.includes('"nested"') && value.malformedMarkerCount > 0
    && latestReplyMatches(value, malformedValidationBaseline, false),
  "Original Monaco JSON worker did not diagnose malformed input and render its marker");
  const invalidWorker = assertJsonWorkerRoundTrip(context, state, "malformed");
  const recoveryValidationBaseline = validationRequestCount(state);
  state = await probe<JsonEditorState>("enter-valid-json");
  recordEditCommandResults(context, state, "enter-valid-json");
  state = await waitState(context, value => value.inputText.includes('"items"') && value.malformedMarkerCount === 0
    && latestReplyMatches(value, recoveryValidationBaseline, true),
  "Original Monaco JSON worker did not clear its malformed JSON diagnostic after recovery");
  const recoveryWorker = assertJsonWorkerRoundTrip(context, state, "valid");

  observations.jsonEditor = {
    formattedJson,
    worker: { validInput: validWorker, malformedInput: invalidWorker, recovery: recoveryWorker },
    boundary: "Fixed local JSON values entered with browser selectAll/insertText commands in the original focused Monaco textarea; reformat invoked by the original toolbar. No physical keyboard, files entry, filesystem read, paste/copy, clipboard, external URL, network schema request, AI or persistence operation was invoked."
  };
  return {
    businessOutcome: "scoped_pass",
    tested: ["original Monaco JSON worker request/response", "nested JSON formatting", "worker malformed-JSON diagnostic", "diagnostic recovery after valid input"],
    notTested: ["files and preload readFileContent", "paste/copy and clipboard", "URL/XML/YAML ingestion", "JSON-to-XML/TypeScript conversion", "large-payload performance", "other original local packages"],
    boundary: "Only fixed local inputs and original UI actions were used; no plugin filesystem, clipboard or external-service operation was invoked."
  };
}
