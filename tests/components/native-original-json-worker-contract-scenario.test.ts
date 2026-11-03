import { expect, it, vi } from "vitest";
import { runOriginalJsonWorkerContractScenario } from "./nativeOriginalJsonWorkerContractScenario";

function makeContext(probeResult: Record<string, unknown>) {
  const checks: Array<{ ok: unknown; label: string }> = [];
  const context = {
    profile: { caseId: "local-json-editor" },
    fixture: { workerContractOnly: true },
    check: (ok: unknown, label: string) => { checks.push({ ok, label }); if (!ok) throw Error(label); },
    until: vi.fn(), pause: vi.fn(), probe: vi.fn(async () => probeResult),
    setPhase: vi.fn(), observations: {} as Record<string, unknown>,
  } as never;
  return { context, checks };
}

function passedProbe() {
  const noDiagnostics = { markerCount: 0, errorCount: 0, codes: [], positions: [] };
  const invalidDiagnostics = { markerCount: 1, errorCount: 1, codes: ["513"], positions: [{ line: 1, column: 7 }] };
  return {
    ready: true,
    workerContract: {
      completed: true, entryResolved: true, elapsedMs: 720,
      stages: [
        { stage: "initialize", request: "1", response: "1" },
        { stage: "load-json-language-service", request: "2", response: "2" },
        { stage: "valid", expectedVersion: 1, updateRequest: "3", updateAck: "3", validationRequest: "4", validationResponse: "4", ...noDiagnostics },
        { stage: "malformed", expectedVersion: 2, updateRequest: "5", updateAck: "5", validationRequest: "6", validationResponse: "6", ...invalidDiagnostics },
        { stage: "recovery", expectedVersion: 3, updateRequest: "7", updateAck: "7", validationRequest: "8", validationResponse: "8", ...noDiagnostics },
        { stage: "remove-model", request: "9", response: "9" },
      ],
    },
    workerEvidence: {
      supported: true, overflowed: false,
      workers: [{ name: "json-contract", entry: "json.worker.js", constructed: true, terminated: true,
        requests: 9, responses: 9, validationRequests: 3, validationResponses: 3, errors: 0,
        validationReplies: [
          { requestOrdinal: 1, validationTransport: "fmr", ...noDiagnostics },
          { requestOrdinal: 2, validationTransport: "fmr", ...invalidDiagnostics },
          { requestOrdinal: 3, validationTransport: "fmr", ...noDiagnostics },
        ] }],
    },
  };
}

it("requires an independently observed, terminated original JSON contract Worker", async () => {
  const noNativeObserver = passedProbe();
  noNativeObserver.workerEvidence = { supported: false, workers: [] };
  const missing = makeContext(noNativeObserver);
  await expect(runOriginalJsonWorkerContractScenario(missing.context)).rejects.toThrow(/observer is unavailable/);

  const valid = makeContext(passedProbe());
  const result = await runOriginalJsonWorkerContractScenario(valid.context);
  expect(result.businessOutcome).toBe("worker_contract_pass");
  expect(result.executionMode).toBe("original_worker_contract");
  expect(result.notTested).toContain("original Monaco UI editing/focus");
  expect(valid.context.observations.jsonWorkerContract).toMatchObject({
    worker: { name: "json-contract", entry: "json.worker.js", terminated: true },
    independentlyObservedValidationReplies: [
      { requestOrdinal: 1, markerCount: 0, errorCount: 0 },
      { requestOrdinal: 2, markerCount: 1, errorCount: 1, positions: [{ line: 1, column: 7 }] },
      { requestOrdinal: 3, markerCount: 0, errorCount: 0 },
    ],
  });
  expect((valid.context.probe as ReturnType<typeof vi.fn>).mock.calls).toEqual([["worker-contract"]]);
});

it("rejects synthetic completion without fresh fmr validation replies", async () => {
  const result = passedProbe();
  result.workerEvidence.workers[0].validationReplies[1].validationTransport = "direct";
  const context = makeContext(result);
  await expect(runOriginalJsonWorkerContractScenario(context.context)).rejects.toThrow(/fresh observed fmr/);
});
