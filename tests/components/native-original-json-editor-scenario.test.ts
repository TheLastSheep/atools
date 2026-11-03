import { expect, it } from "vitest";
import { hasObservedInitialWorkerHandshake, hasObservedTextareaFocus, latestReplyMatches } from "./nativeOriginalJsonEditorScenario";

function state(overrides: Record<string, unknown> = {}) {
  const worker = {
    name: "json",
    entry: "json.worker.js",
    constructed: true,
    requests: 1,
    responses: 1,
    validationRequests: 0,
    validationResponses: 0,
    validationReplies: [],
    errors: 0,
    terminated: false,
    ...(overrides.worker as Record<string, unknown> | undefined),
  };
  return {
    ready: true,
    inputText: "",
    inputReady: true,
    formatActionReady: true,
    malformedMarkerCount: 0,
    focusDiagnostics: { textareaActive: false },
    workerEvidence: { supported: true, overflowed: false, workers: [worker] },
    ...overrides,
  } as never;
}

it("accepts a paired generic worker handshake without requiring empty-model validation", () => {
  expect(hasObservedInitialWorkerHandshake(state())).toBe(true);
  expect(hasObservedInitialWorkerHandshake(state({ worker: { requests: 1, responses: 0 } }))).toBe(false);
  expect(hasObservedInitialWorkerHandshake(state({ worker: { requests: 1, responses: 2 } }))).toBe(false);
  expect(hasObservedInitialWorkerHandshake(state({ worker: { constructed: false } }))).toBe(false);
  expect(hasObservedInitialWorkerHandshake(state({ workerEvidence: { supported: true, overflowed: true, workers: [] } }))).toBe(false);
});

it("gates all fixed JSON input on observed focus of the original textarea", () => {
  expect(hasObservedTextareaFocus(state())).toBe(false);
  expect(hasObservedTextareaFocus(state({ focusDiagnostics: { textareaActive: true } }))).toBe(true);
});

it("keeps valid/invalid diagnostics tied to a fresh doValidation request ordinal", () => {
  const validation = (markerCount: number, errorCount: number, requestOrdinal: number) => state({
    worker: {
      requests: 3,
      responses: 3,
      validationRequests: 2,
      validationResponses: 2,
      validationReplies: [{ markerCount, errorCount, requestOrdinal }],
    },
  });
  expect(latestReplyMatches(validation(0, 0, 2), 1, true)).toBe(true);
  expect(latestReplyMatches(validation(0, 0, 1), 1, true)).toBe(false);
  expect(latestReplyMatches(validation(1, 1, 2), 1, false)).toBe(true);
  expect(latestReplyMatches(validation(0, 0, 2), 1, false)).toBe(false);
});
