export const SOURCE_BUILD_PROBE_PHASES = Object.freeze([
  "preflight",
  "fixture_setup",
  "source_fingerprint",
  "package_prepare",
  "vite_build",
  "cargo_build",
  "native_app_stage",
  "pre_native_validation",
  "native_execution_requested",
  "native_process_returned",
  "evidence_validation",
  "cleanup",
  "complete",
]);

const MAX_ELAPSED_MS = 86_400_000;
const MAX_FAILURE_NODES = 8;
const MAX_BUDGET_MS = 600_000;
const MAX_OMITTED_CAUSE_COUNT = 1_000_000;

function boundedElapsed(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_ELAPSED_MS, Math.round(value));
}

function validBudget(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BUDGET_MS) {
    throw new Error("Source-build probe budget must be a bounded positive integer");
  }
  return value;
}

function classifyOne(error) {
  if (!error || typeof error !== "object") return { classification: "unknown" };

  const code = typeof error.code === "string" ? error.code : "";
  if (code === "ETIMEDOUT") return { classification: "controlled_timeout_code" };
  if (code === "ENOENT") return { classification: "controlled_missing_resource_code" };
  if (code === "EACCES" || code === "EPERM") return { classification: "controlled_access_code" };
  if (code === "EPIPE") return { classification: "controlled_pipe_code" };

  const message = typeof error.message === "string" ? error.message : "";
  const timeout = /^Native smoke exceeded (\d+) ms$/.exec(message);
  if (timeout) {
    const reportedTimeoutMs = Number(timeout[1]);
    return Number.isSafeInteger(reportedTimeoutMs) && [150_000, 180_000].includes(reportedTimeoutMs)
      ? { classification: "process_deadline_exceeded", reportedTimeoutMs }
      : { classification: "unknown" };
  }
  const exited = /^Native smoke exited (-?\d+)$/.exec(message);
  if (exited) {
    const exitCode = Number(exited[1]);
    return Number.isInteger(exitCode) && exitCode >= -255 && exitCode <= 255 && exitCode !== 0
      ? { classification: "process_nonzero_exit", exitCode }
      : { classification: "unknown" };
  }
  if (message === "Native smoke interrupted") return { classification: "process_interrupted" };
  return { classification: "unknown" };
}

function classifyFailure(error, context) {
  if (context.remaining <= 0) {
    context.truncated = true;
    return null;
  }
  context.remaining -= 1;
  if (!error || typeof error !== "object") return { classification: "unknown" };
  if (context.seen.has(error)) {
    context.truncated = true;
    return { classification: "cycle" };
  }
  context.seen.add(error);

  if (!(error instanceof AggregateError)) return classifyOne(error);
  const errors = Array.isArray(error.errors) ? error.errors : [];
  const causes = [];
  let omittedCauseCount = 0;
  let omittedCauseCountCapped = false;
  const addOmitted = count => {
    const next = omittedCauseCount + count;
    if (next > MAX_OMITTED_CAUSE_COUNT) omittedCauseCountCapped = true;
    omittedCauseCount = Math.min(MAX_OMITTED_CAUSE_COUNT, next);
  };
  for (let index = 0; index < errors.length; index += 1) {
    if (context.remaining <= 0) {
      addOmitted(errors.length - index);
      context.truncated = true;
      break;
    }
    const cause = classifyFailure(errors[index], context);
    if (cause) causes.push(cause);
    else addOmitted(1);
  }
  return { classification: "aggregate", causes, omittedCauseCount, omittedCauseCountCapped, truncated: context.truncated };
}

export function classifySourceBuildProbeFailure(error) {
  const context = { remaining: MAX_FAILURE_NODES, seen: new WeakSet(), truncated: false };
  const root = classifyFailure(error, context) ?? { classification: "unknown" };
  if (root.classification === "aggregate") root.truncated ||= context.truncated;
  return root;
}

export function createSourceBuildProbeDiagnostics({
  now = () => performance.now(),
  buildBudgetMs = 180_000,
  nativeBudgetMs = 150_000,
} = {}) {
  const budgets = { buildMs: validBudget(buildBudgetMs), nativeMs: validBudget(nativeBudgetMs) };
  let timingAvailable = true;
  let previousClock = null;
  function readClock() {
    if (!timingAvailable) return null;
    let value;
    try { value = now(); } catch { timingAvailable = false; return null; }
    if (!Number.isFinite(value) || value < 0 || (previousClock !== null && value < previousClock)) {
      timingAvailable = false;
      return null;
    }
    previousClock = value;
    return value;
  }

  const startedAt = readClock();
  let phase = "preflight";
  let phaseStartedAt = startedAt;
  let nativeExecutionRequested = false;
  const completedPhases = [];
  let failureObservation = null;

  function transition(nextPhase) {
    if (!SOURCE_BUILD_PROBE_PHASES.includes(nextPhase)) throw new Error("Unknown source-build probe phase");
    if (phase === nextPhase) return;
    const at = readClock();
    const elapsed = at === null || phaseStartedAt === null ? null : boundedElapsed(at - phaseStartedAt);
    const prior = completedPhases.find(item => item.phase === phase);
    if (prior) prior.elapsedMs = prior.elapsedMs === null || elapsed === null ? null : boundedElapsed(prior.elapsedMs + elapsed);
    else completedPhases.push({ phase, elapsedMs: elapsed });
    phase = nextPhase;
    phaseStartedAt = at;
  }

  function markNativeExecutionRequested() {
    nativeExecutionRequested = true;
    transition("native_execution_requested");
  }

  function observeFailure(error) {
    if (failureObservation) return failureObservation;
    const at = readClock();
    failureObservation = {
      phase,
      elapsedMs: at === null || startedAt === null ? null : boundedElapsed(at - startedAt),
      elapsedInPhaseMs: at === null || phaseStartedAt === null ? null : boundedElapsed(at - phaseStartedAt),
      timingAvailable,
      nativeExecutionRequested,
      classification: classifySourceBuildProbeFailure(error),
    };
    return failureObservation;
  }

  function snapshot() {
    const at = readClock();
    const durations = completedPhases.map(item => ({ ...item }));
    const currentElapsed = at === null || phaseStartedAt === null ? null : boundedElapsed(at - phaseStartedAt);
    const current = durations.find(item => item.phase === phase);
    if (current) current.elapsedMs = current.elapsedMs === null || currentElapsed === null
      ? null : boundedElapsed(current.elapsedMs + currentElapsed);
    else durations.push({ phase, elapsedMs: currentElapsed });
    return {
      phase,
      elapsedMs: at === null || startedAt === null ? null : boundedElapsed(at - startedAt),
      timingAvailable,
      phaseElapsedMs: durations,
      nativeExecutionRequested,
      budgets: { ...budgets },
      failureObservation: failureObservation ? { ...failureObservation } : null,
    };
  }

  return { transition, markNativeExecutionRequested, observeFailure, snapshot };
}
