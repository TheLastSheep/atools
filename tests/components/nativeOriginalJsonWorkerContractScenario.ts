import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type ContractStage = {
  stage: string;
  expectedVersion?: number;
  request?: string;
  response?: string;
  updateRequest?: string;
  updateAck?: string;
  validationRequest?: string;
  validationResponse?: string;
  markerCount?: number;
  errorCount?: number;
  codes?: string[];
  positions?: Array<{ line: number; column: number }>;
};
type ContractResult = {
  completed: boolean;
  entryResolved: boolean;
  failedStage?: string;
  failureKind?: string;
  elapsedMs: number;
  stages: ContractStage[];
};
type ObservedValidationReply = {
  requestOrdinal: number;
  validationTransport: "fmr" | "direct";
  markerCount: number;
  errorCount: number;
  codes: string[];
  positions: Array<{ line: number; column: number }>;
};
type ContractWorkerEvidence = {
  name: string;
  entry: string;
  constructed: boolean;
  requests: number;
  responses: number;
  validationRequests: number;
  validationResponses: number;
  errors: number;
  terminated: boolean;
  validationReplies: ObservedValidationReply[];
};
type ContractProbe = {
  ready: boolean;
  workerContract?: ContractResult;
  workerEvidence?: { supported: boolean; overflowed?: boolean; workers: ContractWorkerEvidence[] };
};

function requireStage(result: ContractResult, name: ContractStage["stage"]) {
  const stage = result.stages.find(item => item.stage === name);
  if (!stage) throw Error(`Original JSON worker contract omitted stage ${name}`);
  return stage;
}

function workerEvidence(state: ContractProbe) {
  const evidence = state.workerEvidence;
  if (evidence?.supported !== true) throw Error("Native Worker observer is unavailable for JSON worker contract");
  if (evidence.overflowed === true) throw Error("Native Worker observer overflowed during JSON worker contract");
  const worker = evidence.workers.find(item => item.name === "json-contract" && item.entry === "json.worker.js");
  if (!worker) throw Error("The separately constructed original JSON contract worker was not observed");
  if (!worker.constructed || !worker.terminated || worker.errors !== 0) {
    throw Error("Original JSON contract worker construction, teardown, or runtime evidence is invalid");
  }
  return worker;
}

function assertObservedValidation(worker: ContractWorkerEvidence, stage: ContractStage, ordinal: number,
  valid: boolean, context: PublishedScenarioContext) {
  const reply = worker.validationReplies.find(item => item.requestOrdinal === ordinal);
  if (!reply || reply.validationTransport !== "fmr") {
    throw Error(`Original JSON contract validation ${ordinal} lacks a fresh observed fmr request/response`);
  }
  context.check(reply.markerCount === stage.markerCount && reply.errorCount === stage.errorCount,
    `Original JSON worker observer independently matched ${stage.stage} diagnostic counts`);
  context.check(reply.codes.length <= 4 && reply.positions.length <= 3
    && reply.positions.every(position => Number.isSafeInteger(position.line) && position.line > 0
      && Number.isSafeInteger(position.column) && position.column > 0),
  `Original JSON worker observer exposed only bounded diagnostic codes and positions for ${stage.stage}`);
  if (valid) {
    context.check(reply.markerCount === 0 && reply.errorCount === 0,
      `Original JSON worker returned no diagnostics for ${stage.stage}`);
  } else {
    context.check(reply.markerCount > 0 && reply.errorCount > 0 && reply.positions.length > 0,
      "Original JSON worker returned a positioned error for malformed JSON");
  }
  return { requestOrdinal: reply.requestOrdinal, validationTransport: reply.validationTransport,
    markerCount: reply.markerCount, errorCount: reply.errorCount,
    codes: reply.codes, positions: reply.positions };
}

export async function runOriginalJsonWorkerContractScenario(
  context: PublishedScenarioContext,
): Promise<PublishedBusinessResult> {
  if (context.profile.caseId !== "local-json-editor" || context.fixture.workerContractOnly !== true) {
    throw Error("Original JSON worker contract requires the explicit local-json-editor worker-contract-only fixture");
  }
  context.setPhase("original-json-worker-contract-only");
  const state = await context.probe<ContractProbe>("worker-contract");
  context.observations.jsonWorkerContractLastState = state;
  const result = state.workerContract;
  context.check(state.ready === true, "Original local JSON Editor page is mounted for isolated Worker contract testing");
  if (!result || result.entryResolved !== true) {
    throw Error("Original JSON worker contract did not resolve the package's worker URL");
  }
  if (!result.completed) {
    throw Error(`Original JSON worker contract failed at ${result.failedStage ?? "unknown"} (${result.failureKind ?? "unclassified"})`);
  }
  if (!Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0 || result.elapsedMs > 3800) {
    throw Error("Original JSON worker contract exceeded its 3.8-second client deadline");
  }
  const initialize = requireStage(result, "initialize");
  const language = requireStage(result, "load-json-language-service");
  const valid = requireStage(result, "valid");
  const malformed = requireStage(result, "malformed");
  const recovery = requireStage(result, "recovery");
  const removed = requireStage(result, "remove-model");
  context.check(initialize.request === "1" && initialize.response === "1"
    && language.request === "2" && language.response === "2",
  "Original Monaco SimpleWorker and JSON language service completed paired RPC handshakes");

  for (const [stage, expectedVersion, updateRequest, validationRequest] of [
    [valid, 1, "3", "4"], [malformed, 2, "5", "6"], [recovery, 3, "7", "8"],
  ] as const) {
    context.check(stage.expectedVersion === expectedVersion && stage.updateRequest === updateRequest
      && stage.updateAck === updateRequest && stage.validationRequest === validationRequest
      && stage.validationResponse === validationRequest,
    `Original JSON worker serialized version ${expectedVersion} model acknowledgement before fresh validation`);
  }
  context.check(removed.request === "9" && removed.response === "9",
    "Original JSON worker acknowledged model removal before teardown");
  context.check(valid.markerCount === 0 && valid.errorCount === 0,
    "Original JSON worker accepted the fixed valid JSON model");
  context.check(malformed.markerCount! > 0 && malformed.errorCount! > 0
    && malformed.positions?.some(position => position.line > 0 && position.column > 0),
  "Original JSON worker diagnosed malformed JSON with a source position");
  context.check(recovery.markerCount === 0 && recovery.errorCount === 0,
    "Original JSON worker cleared diagnostics after a valid model update");

  const worker = workerEvidence(state);
  context.check(worker.validationRequests >= 3 && worker.validationResponses >= 3
    && worker.validationReplies.length >= 3 && worker.responses <= worker.requests,
  "Independent native observer paired the contract worker's three validation requests and responses");
  const observed = [
    assertObservedValidation(worker, valid, 1, true, context),
    assertObservedValidation(worker, malformed, 2, false, context),
    assertObservedValidation(worker, recovery, 3, true, context),
  ];
  context.observations.jsonWorkerContract = {
    worker: { name: worker.name, entry: worker.entry, constructed: worker.constructed,
      requests: worker.requests, responses: worker.responses, validationRequests: worker.validationRequests,
      validationResponses: worker.validationResponses, errors: worker.errors, terminated: worker.terminated },
    stages: result.stages.map(stage => ({ ...stage })),
    independentlyObservedValidationReplies: observed,
    elapsedMs: result.elapsedMs,
    boundary: "Separate genuine Worker resolved through the unchanged package MonacoEnvironment URL; fixed in-memory model only, with no UI-input claim, filesystem access, clipboard, schema/network request, AI, or persistence operation.",
  };
  return {
    businessOutcome: "worker_contract_pass",
    executionMode: "original_worker_contract",
    tested: ["original SimpleWorker handshake", "JSON language service load", "serialized valid/invalid/recovery model updates", "fresh fmr validation replies and native Worker observation", "model removal and Worker termination"],
    notTested: ["original Monaco UI editing/focus", "file open/save and preload readFileContent", "clipboard, URL/XML/YAML ingestion, conversion", "large-payload performance", "other original local packages"],
    boundary: "This isolated Worker contract run does not satisfy or replace the separate original UI interaction scenario.",
  };
}
