import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOURCE_BUILD_PROBE_PHASES,
  classifySourceBuildProbeFailure,
  createSourceBuildProbeDiagnostics,
} from "./lib/source-build-probe-diagnostics.mjs";

test("phase evidence is fixed, bounded, and distinguishes a request from a launched process", () => {
  let clock = 0;
  const diagnostics = createSourceBuildProbeDiagnostics({ now: () => clock, buildBudgetMs: 180_000, nativeBudgetMs: 150_000 });
  assert.equal(diagnostics.snapshot().nativeExecutionRequested, false);
  for (const phase of ["fixture_setup", "source_fingerprint", "package_prepare", "vite_build", "cargo_build", "native_app_stage", "pre_native_validation"]) {
    clock += 3;
    diagnostics.transition(phase);
  }
  clock += 4;
  diagnostics.markNativeExecutionRequested();
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.phase, "native_execution_requested");
  assert.equal(snapshot.nativeExecutionRequested, true);
  assert.deepEqual(snapshot.budgets, { buildMs: 180_000, nativeMs: 150_000 });
  assert.ok(snapshot.elapsedMs >= 0 && snapshot.elapsedMs <= 86_400_000);
  assert.ok(snapshot.phaseElapsedMs.every(item => SOURCE_BUILD_PROBE_PHASES.includes(item.phase) && item.elapsedMs >= 0));
});

test("snapshot is repeatable and does not double-count when the next phase begins", () => {
  const values = [0, 2, 10, 10, 15, 15];
  const diagnostics = createSourceBuildProbeDiagnostics({ now: () => values.shift() });
  diagnostics.transition("fixture_setup");
  const first = diagnostics.snapshot();
  const repeated = diagnostics.snapshot();
  assert.deepEqual(repeated, first);
  diagnostics.transition("source_fingerprint");
  const afterTransition = diagnostics.snapshot();
  assert.deepEqual(afterTransition.phaseElapsedMs.find(item => item.phase === "fixture_setup"), {
    phase: "fixture_setup", elapsedMs: 13,
  });
  assert.equal(afterTransition.phaseElapsedMs.filter(item => item.phase === "fixture_setup").length, 1);
});

test("invalid or backward clocks produce null elapsed values and explicit unavailable timing", () => {
  for (const invalid of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const diagnostics = createSourceBuildProbeDiagnostics({ now: () => invalid });
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.timingAvailable, false);
    assert.equal(snapshot.elapsedMs, null);
    assert.equal(snapshot.phaseElapsedMs[0].elapsedMs, null);
  }
  const values = [5, 4];
  const backward = createSourceBuildProbeDiagnostics({ now: () => values.shift() });
  backward.transition("fixture_setup");
  const snapshot = backward.snapshot();
  assert.equal(snapshot.timingAvailable, false);
  assert.equal(snapshot.elapsedMs, null);
  assert.equal(snapshot.phaseElapsedMs[0].elapsedMs, null);
});

test("budgets must be bounded positive integers", () => {
  for (const value of [Number.NaN, 0, -1, 600_001, 1.5]) {
    assert.throws(() => createSourceBuildProbeDiagnostics({ buildBudgetMs: value }), /bounded positive integer/);
    assert.throws(() => createSourceBuildProbeDiagnostics({ nativeBudgetMs: value }), /bounded positive integer/);
  }
});

test("only explicit controlled timeout and nonzero exit messages receive native classifications", () => {
  assert.deepEqual(classifySourceBuildProbeFailure(new Error("Native smoke exceeded 180000 ms")), {
    classification: "process_deadline_exceeded", reportedTimeoutMs: 180_000,
  });
  assert.deepEqual(classifySourceBuildProbeFailure(new Error("Native smoke exited 101")), {
    classification: "process_nonzero_exit", exitCode: 101,
  });
  assert.deepEqual(classifySourceBuildProbeFailure(new Error("Native smoke exited 0")), { classification: "unknown" });
  assert.deepEqual(classifySourceBuildProbeFailure(new Error("Native smoke exceeded 170000 ms")), { classification: "unknown" });
  assert.deepEqual(classifySourceBuildProbeFailure(Object.assign(new Error("private path"), { code: "ENOENT" })), {
    classification: "controlled_missing_resource_code",
  });
  assert.deepEqual(classifySourceBuildProbeFailure(new Error("cargo took too long maybe timeout")), { classification: "unknown" });
  const build = createSourceBuildProbeDiagnostics({ now: () => 1 });
  build.transition("cargo_build");
  const buildFailure = build.observeFailure(new Error("Native smoke exceeded 180000 ms"));
  assert.equal(buildFailure.phase, "cargo_build");
  assert.equal(buildFailure.classification.classification, "process_deadline_exceeded");
  const native = createSourceBuildProbeDiagnostics({ now: () => 1 });
  native.markNativeExecutionRequested();
  const nativeFailure = native.observeFailure(new Error("Native smoke exceeded 150000 ms"));
  assert.equal(nativeFailure.phase, "native_execution_requested");
  assert.equal(nativeFailure.classification.classification, "process_deadline_exceeded");
});

test("10,000 primitive causes have a global output cap and bounded serialized size", () => {
  const many = new AggregateError(Array.from({ length: 10_000 }, (_, index) => `private-path-${index}`), "secret aggregate");
  const summary = classifySourceBuildProbeFailure(many);
  function classifiedCount(value) {
    return value && typeof value === "object"
      ? (typeof value.classification === "string" ? 1 : 0) + Object.values(value).reduce((sum, child) => sum + classifiedCount(child), 0)
      : 0;
  }
  assert.ok(classifiedCount(summary) <= 8);
  assert.equal(summary.truncated, true);
  assert.ok(summary.causes.every(cause => cause.classification === "unknown"));
  assert.ok(summary.omittedCauseCount >= 9_993 && summary.omittedCauseCount <= 10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") < 2_048);
  assert.equal(JSON.stringify(summary).includes("private-path"), false);
});

test("10,000 repeated self-cycles stay within the same global cap", () => {
  const cyclic = new AggregateError([], "private-cycle");
  Object.defineProperty(cyclic, "errors", { value: [cyclic], configurable: true });
  const manyCycles = new AggregateError(Array(10_000).fill(cyclic), "private-outer");
  const summary = classifySourceBuildProbeFailure(manyCycles);
  function classifiedCount(value) {
    return value && typeof value === "object"
      ? (typeof value.classification === "string" ? 1 : 0) + Object.values(value).reduce((sum, child) => sum + classifiedCount(child), 0)
      : 0;
  }
  const serialized = JSON.stringify(summary);
  assert.ok(classifiedCount(summary) <= 8);
  assert.equal(summary.truncated, true);
  assert.ok(serialized.includes('"classification":"cycle"'));
  assert.ok(Buffer.byteLength(serialized, "utf8") < 2_048);
  assert.equal(serialized.includes("private-cycle"), false);
});

test("ordinary aggregate diagnostics omit raw error data", () => {
  const many = new AggregateError([new Error("private-path"), new Error("secret aggregate cause")], "secret aggregate");
  const summary = classifySourceBuildProbeFailure(many);
  const cyclic = new AggregateError([], "hidden");
  Object.defineProperty(cyclic, "errors", { value: [cyclic, new Error("secret")], configurable: true });
  const cycleSummary = classifySourceBuildProbeFailure(cyclic);
  assert.equal(cycleSummary.causes[0].classification, "cycle");
  assert.equal(cycleSummary.truncated, true);
  const diagnostics = createSourceBuildProbeDiagnostics({ now: () => 4 });
  diagnostics.observeFailure(many);
  const serialized = JSON.stringify(diagnostics.snapshot());
  for (const forbidden of ["private-path", "secret aggregate", "secret aggregate cause"]) assert.equal(serialized.includes(forbidden), false);
});

test("unknown errors stay private and known codes remain generic rather than asserting process cause", () => {
  const arbitrary = Object.assign(new Error("token=/private/tmp/private-body"), { code: "CUSTOM_SECRET" });
  const diagnostics = createSourceBuildProbeDiagnostics({ now: () => 10 });
  diagnostics.transition("cargo_build");
  const failureObservation = diagnostics.observeFailure(arbitrary);
  assert.equal(failureObservation.classification.classification, "unknown");
  const serialized = JSON.stringify(failureObservation);
  assert.equal(serialized.includes("private/tmp"), false);
  assert.equal(classifySourceBuildProbeFailure(Object.assign(new Error("denied"), { code: "EACCES" })).classification,
    "controlled_access_code");
});

test("invalid phases are rejected without changing the active phase", () => {
  const diagnostics = createSourceBuildProbeDiagnostics({ now: () => 0 });
  assert.throws(() => diagnostics.transition("native_something_else"), /Unknown source-build probe phase/);
  assert.equal(diagnostics.snapshot().phase, "preflight");
});
