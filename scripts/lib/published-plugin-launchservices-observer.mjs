import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createNativeProcessResourceSampler, processIdentity, summarizeProcessIdentity } from "./native-process-resource-sampler.mjs";
import { countTaggedLaunchServicesProcesses, readLaunchServicesProcessSnapshot, trackLaunchServicesChildren } from "./published-plugin-launchservices-processes.mjs";
import { evaluateRegisteredLaunchServicesCleanupScope } from "./published-plugin-launchservices-cleanup-scope.mjs";
import { LaunchServicesLogStream } from "./published-plugin-launchservices-codec.mjs";

const RESOURCE_SAMPLE_INTERVAL_MS = 200;
const RESOURCE_SAMPLE_LIMIT = 600;

function startLaunchServicesResourceObservation(pid, executable, result) {
  const state = { stopping: false, sampler: null, identity: null, error: null, timer: null, wake: null };
  const promise = (async () => {
    const snapshot = await readLaunchServicesProcessSnapshot();
    const record = snapshot.get(Number(pid));
    if (!record) throw new Error("LaunchServices target PID is absent from the process table");
    const command = record.command;
    const expected = resolve(executable);
    if (command !== expected && !command.startsWith(expected + " ")) throw new Error("LaunchServices target command does not match staged executable");
    state.identity = Object.freeze({ ...processIdentity(record), executableAssertion: "canonical-path", executablePath: expected });
    state.sampler = createNativeProcessResourceSampler({ rootIdentity: state.identity, maxSamples: RESOURCE_SAMPLE_LIMIT,
      readSnapshot: readLaunchServicesProcessSnapshot });
    while (!state.stopping && state.sampler.report().coverage.sampleCount < RESOURCE_SAMPLE_LIMIT) {
      await state.sampler.sample();
      if (!state.stopping && state.sampler.report().coverage.sampleCount < RESOURCE_SAMPLE_LIMIT) {
        await new Promise(resolve => { state.wake = resolve; state.timer = setTimeout(resolve, RESOURCE_SAMPLE_INTERVAL_MS); });
        state.timer = null; state.wake = null;
      }
    }
  })().catch(error => { state.error = String(error); });
  return {
    requestStop() { state.stopping = true; if (state.timer) clearTimeout(state.timer); state.wake?.(); },
    async finish() {
      await promise;
      const report = state.sampler?.report() ?? null;
      result.resourceSampling = { requested: true, launchMode: "launchservices", processIdentity: summarizeProcessIdentity(state.identity),
        executableAssertion: state.identity?.executableAssertion ?? null, report, error: state.error,
        note: "Samples only the LaunchServices target PID; no exclusive process group is assumed." };
      if (!state.error && (!report || report.coverage.sampleCount === 0)) result.resourceSampling.error = "No target process samples were captured";
    },
  };
}


const MAX_ROUTED_LOG_BYTES = 512 * 1024;
const MAX_ROUTED_STDOUT_BYTES = 448 * 1024;
const MAX_ROUTED_STDERR_BYTES = MAX_ROUTED_LOG_BYTES - MAX_ROUTED_STDOUT_BYTES;
const OBSERVER_WAIT_AFTER_CANCEL_MS = 25_000;

export async function waitForLaunchServicesSignal(launchEvent, exited, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    launchEvent.then(() => finish("event"));
    exited.then(() => finish("exit"));
  });
}

export function validateLaunchServicesOutcome({ ready, event, observer, environmentObservation, nativeReport, expected, cleanupScope, logFrames }) {
  const failures = [];
  if (!ready || ready.protocolError || ready.runId !== expected.runId) failures.push("stdio-reader-ready-event-missing-or-invalid");
  if (!event || event.protocolError) failures.push("launch-callback-event-missing-or-invalid");
  else {
    if (event.runId !== expected.runId || event.caseId !== expected.caseId) failures.push("launch-event-run-mismatch");
    if (event.bundleId !== expected.bundleId || event.bundleURL !== expected.bundlePath
      || event.executableURL !== expected.executablePath || event.executablePath !== expected.executablePath) failures.push("launch-event-bundle-or-executable-mismatch");
    if (!Number.isSafeInteger(event.targetPid) || event.targetPid <= 0 || event.targetPid === event.observerPid) failures.push("launch-event-process-identity-invalid");
    if (!event.launchDatePresent) failures.push("launch-date-unavailable");
  }
  if (!observer || observer.protocolError) failures.push("observer-report-missing-or-invalid");
  else {
    if (observer.run_id !== expected.runId || observer.case_id !== expected.caseId) failures.push("observer-report-run-mismatch");
    if (!observer.launch_callback_received) failures.push("launchservices-error-or-callback-unresolved");
    if (observer.target_pid !== event?.targetPid || observer.observer_pid !== event?.observerPid) failures.push("observer-target-identity-mismatch");
    const eventIdentity = event && { pid: event.targetPid, start_token: event.processStartToken,
      command_sha256: event.commandSha256, executable_path: event.executablePath };
    if (!eventIdentity || JSON.stringify(observer.target_process_identity) !== JSON.stringify(eventIdentity)) {
      failures.push("observer-process-identity-mismatch");
    }
    if (!observer.target_terminated || !observer.termination_identity_rechecked) failures.push("target-not-proven-terminal");
    if (observer.target_os_exit_code !== null || !String(observer.target_os_exit_code_source || "").includes("does not expose")) failures.push("unknown-target-exit-status-misrepresented");
    if (observer.error !== null) failures.push("observer-reported-error");
    if (!observer.log_route_complete || observer.log_overflow) failures.push("bounded-log-route-incomplete");
    if (!logFrames || observer.log_bytes !== logFrames.targetByteLength
      || observer.log_frame_count !== logFrames.targetFrameCount
      || observer.log_encoded_bytes !== logFrames.targetFrameEncodedBytes) {
      failures.push("observer-log-frame-counters-mismatch");
    }
  }
  if (!environmentObservation || environmentObservation.protocolError
    || environmentObservation.runId !== expected.runId
    || environmentObservation.requestedEnvironmentKeysComplete !== true
    || environmentObservation.requestedEnvironmentKeyCount !== expected.requestedEnvironmentKeyCount
    || !Number.isSafeInteger(environmentObservation.additionalEnvironmentKeyCount)
    || !/^[0-9a-f]{64}$/.test(environmentObservation.additionalEnvironmentKeyNamesSha256 || "")
    || environmentObservation.ambientEnvironmentInheritance !== "unknown"
    || environmentObservation.systemMayAddVariables !== true
    || environmentObservation.environmentValuesLogged !== false
    || environmentObservation.additionalEnvironmentNamesLogged !== false) {
    failures.push("target-environment-inheritance-observation-missing-or-invalid");
  }
  if (!nativeReport || nativeReport.runId !== expected.runId || nativeReport.profile?.caseId !== expected.caseId || nativeReport.passed !== true) {
    failures.push("fresh-native-report-not-passed-or-identity-mismatch");
  }
  if (!cleanupScope || cleanupScope.passed !== true
    || cleanupScope.arbitraryUnobservedDetachedDescendantCoverage !== "unknown") {
    failures.push("registered-cleanup-scope-not-proven-or-coverage-misrepresented");
  }
  return { passed: failures.length === 0, failures };
}

export function observerTerminationPassed({ observerExitObserved, observerExitCode, observerSignal, spawnError }) {
  return observerExitObserved === true && observerExitCode === 0 && observerSignal == null && spawnError == null;
}

export async function observeLaunchServicesNativeProcess(executable, args, options) {
  const ls = options.launchServices;
  if (!ls) throw new Error("LaunchServices observer configuration is required");
  const { controlDir, runId, caseId, bundlePath, bundleId, executablePath, targetEnv, timeoutMs = 90000 } = ls;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)
    || !["local-plain-text", "local-json-editor"].includes(caseId)) throw new Error("LaunchServices mode is restricted to the two run-bound editor cases");
  await mkdir(controlDir, { recursive: false, mode: 0o700 });
  await chmod(controlDir, 0o700);
  const directory = await lstat(controlDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || process.getuid && directory.uid !== process.getuid() || directory.mode & 0o077) {
    throw new Error("LaunchServices control directory must be private, owned, and non-symlink");
  }
  const observerReportPath = join(controlDir, `observer-${runId}.json`);
  const nativeReportPath = ls.nativeReportPath;
  const tag = "atools-native-smoke-" + randomUUID();
  const requestedEnvironmentKeys = [...new Set([...Object.keys(targetEnv), "ATOOLS_NATIVE_STDIO_FIFO",
    "ATOOLS_NATIVE_SMOKE_PROCESS_TAG", "ATOOLS_NATIVE_REQUESTED_ENV_KEYS"])].sort();
  const configPath = join(controlDir, `launch-${runId}.json`);
  const config = { run_id: runId, case_id: caseId, bundle_path: bundlePath, bundle_id: bundleId,
    executable_path: executablePath, target_args: [...args, "--native-launchservices-fixture"], target_env: { ...targetEnv },
    control_dir: controlDir, observer_report_path: observerReportPath, native_report_path: nativeReportPath,
    process_tag: tag, launch_timeout_ms: timeoutMs };
  await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  const tagObserver = "atools-native-observer-" + randomUUID();
  const child = spawn(executable, ["--atools-native-launchservices-observer", "--launch-config", configPath], {
    cwd: options.cwd, env: { ...(options.env || process.env), ATOOLS_NATIVE_SMOKE_PROCESS_TAG: tagObserver },
    stdio: ["pipe", "pipe", "pipe"], detached: false,
  });
  const result = { startedAt: new Date().toISOString(), pid: child.pid ?? null, observerPid: child.pid ?? null,
    pidSource: "directly spawned LaunchServices observer only", targetPid: null, exitObserved: false,
    observerExitObserved: false, exitCode: null, exitCodeSource: "unknown: LaunchServices target exit status is not exposed",
    observerExitCode: null, signal: null, observerSignal: null, targetOsExitCode: null,
    targetOsExitCodeSource: "unknown: NSRunningApplication does not expose exit status", timedOut: false,
    interrupted: false, spawnError: null, cleanupErrors: [], targetTerminated: false,
    descendantCleanupAttempted: false, descendantCleanupCompleted: false, descendantCoverage: "unknown" };
  const stdoutStream = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: MAX_ROUTED_STDOUT_BYTES });
  const stderrStream = new LaunchServicesLogStream({ channel: "stderr", runId, maxEncodedBytes: MAX_ROUTED_STDERR_BYTES });
  let launchEvent = null, readyEvent = null, environmentEvent = null, finalEvent = null, children = null, resourceObservation = null, termination;
  let resolveExit, resolveLaunchEvent;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const launchEventAvailable = new Promise(resolve => { resolveLaunchEvent = resolve; });
  let resolveStreamsClosed;
  const outputStreamsClosed = new Promise(resolve => { resolveStreamsClosed = resolve; });
  let stdoutEnded = false, stderrEnded = false;
  const captureState = () => {
    const stdout = stdoutStream.snapshot();
    const stderrState = stderrStream.snapshot();
    readyEvent ||= stdout.readyEvent;
    launchEvent ||= stdout.launchEvent;
    environmentEvent ||= stdout.environmentEvent;
    finalEvent ||= stdout.resultEvent;
    if (launchEvent) resolveLaunchEvent(launchEvent);
    return { stdout, stderr: stderrState };
  };
  child.stdout.on("data", chunk => { stdoutStream.push(chunk); captureState(); });
  child.stderr.on("data", chunk => { stderrStream.push(chunk); captureState(); });
  child.stdout.once("end", () => { stdoutEnded = true; stdoutStream.end(); captureState(); if (stderrEnded) resolveStreamsClosed(); });
  child.stderr.once("end", () => { stderrEnded = true; stderrStream.end(); captureState(); if (stdoutEnded) resolveStreamsClosed(); });
  child.once("error", error => { result.spawnError = String(error); });
  child.once("exit", (code, signal) => {
    result.exitObserved = true; result.observerExitObserved = true; result.observerExitCode = code;
    result.observerSignal = signal; result.signal = signal;
  });
  child.once("close", () => { captureState(); resolveExit(); });
  const cancel = () => {
    if (termination) return termination;
    result.timedOut ||= false;
    termination = (async () => {
      try { child.stdin.write("CANCEL\n"); } catch (error) { result.cleanupErrors.push(String(error)); }
      const bounded = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), OBSERVER_WAIT_AFTER_CANCEL_MS))]);
      if (!bounded && child.exitCode === null && child.signalCode === null) {
        result.cleanupErrors.push("observer did not converge after bounded cancel; target cleanup remains unverified");
        try { child.kill("SIGKILL"); } catch (error) { result.cleanupErrors.push(String(error)); }
        return;
      }
      try { child.stdin.end(); } catch {}
    })();
    return termination;
  };
  const onInterrupt = () => { result.interrupted = true; void cancel(); };
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onInterrupt);
  const timer = setTimeout(() => { result.timedOut = true; void cancel(); }, timeoutMs + OBSERVER_WAIT_AFTER_CANCEL_MS);
  try {
    const launchSignal = await waitForLaunchServicesSignal(launchEventAvailable, exited, timeoutMs + OBSERVER_WAIT_AFTER_CANCEL_MS);
    if (launchSignal === "timeout") {
      result.timedOut = true;
      await cancel();
    } else if (launchSignal === "exit" && !launchEvent) {
      await outputStreamsClosed;
    }
    if (launchEvent) {
      result.targetPid = Number.isSafeInteger(launchEvent.targetPid) ? launchEvent.targetPid : null;
      const expectedId = `dev.atools.fixture.dialog.${runId.replaceAll("-", "")}`;
      if (!result.targetPid || result.targetPid === result.observerPid || launchEvent.runId !== runId || launchEvent.caseId !== caseId
        || launchEvent.bundleId !== expectedId || launchEvent.executablePath !== resolve(executablePath) || !launchEvent.launchDatePresent) {
        result.cleanupErrors.push("LaunchServices event identity did not match the active run");
        await cancel();
      } else {
        children = await trackLaunchServicesChildren(result.targetPid, executablePath, tag);
        result.descendantCleanupAttempted = true;
        if (options.sampleResources) resourceObservation = startLaunchServicesResourceObservation(result.targetPid, executablePath, result);
        await exited;
      }
    } else await exited;
    if (termination) await termination;
  } catch (error) {
    // A process-table failure or unexpected protocol error must not abandon a
    // live observer after it has launched the native target. Ask the observer
    // to run its identity-bound target cleanup, then retain the failure.
    result.cleanupErrors.push(`LaunchServices observation failed: ${String(error)}`);
    await cancel();
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt);
  }
  if (children) {
    try {
      const cleanup = await children.cleanup();
      result.descendantCleanup = cleanup; result.descendantCoverage = cleanup.coverage;
      result.descendantCleanupCompleted = cleanup.survivors.length === 0 && cleanup.unresolvedCount === 0;
    } catch (error) { result.cleanupErrors.push(String(error)); }
  }
  let taggedResidualCount = null;
  try {
    taggedResidualCount = countTaggedLaunchServicesProcesses(await readLaunchServicesProcessSnapshot(), tag);
    if (taggedResidualCount !== 0) result.cleanupErrors.push("run-tagged sidecars remain after owned descendant cleanup");
  } catch (error) { result.cleanupErrors.push(`final run-tagged process scan failed: ${String(error)}`); }
  resourceObservation?.requestStop();
  if (resourceObservation) await resourceObservation.finish();
  await outputStreamsClosed;
  const stdoutState = stdoutStream.snapshot(), stderrState = stderrStream.snapshot();
  for (const error of stdoutState.errors) result.cleanupErrors.push(`observer stdout stream: ${error}`);
  for (const error of stderrState.errors) result.cleanupErrors.push(`observer stderr stream: ${error}`);
  if (!stdoutState.readyEvent) result.cleanupErrors.push("observer stdio-reader-ready event missing");
  if (!stdoutState.resultEvent) result.cleanupErrors.push("observer result control line missing");
  try {
    const fileEvent = JSON.parse(await readFile(observerReportPath, "utf8"));
    if (!stdoutState.resultEvent || JSON.stringify(fileEvent) !== JSON.stringify(stdoutState.resultEvent)) {
      result.cleanupErrors.push("observer result control line disagrees with fresh report file");
    }
    finalEvent = fileEvent;
  }
  catch (error) { result.cleanupErrors.push(`observer report missing or invalid: ${String(error)}`); }
  if (finalEvent) {
    if (!Number.isSafeInteger(result.targetPid) && Number.isSafeInteger(finalEvent.target_pid)) {
      result.targetPid = finalEvent.target_pid;
      result.targetPidSource = "callback-bound observer report; process identity not proven for descendant signaling";
    }
    result.targetTerminated = finalEvent.target_terminated === true && finalEvent.termination_identity_rechecked === true;
    result.observerReport = finalEvent;
    if (finalEvent.target_pid !== result.targetPid || finalEvent.run_id !== runId || finalEvent.case_id !== caseId) result.cleanupErrors.push("final observer report identity mismatch");
    if (!finalEvent.log_route_complete || finalEvent.log_overflow) result.cleanupErrors.push("fixture log route incomplete or over budget");
    if (finalEvent.error !== null) result.cleanupErrors.push("observer reported a target launch or lifecycle error");
  }
  result.targetEnvironmentObservation = environmentEvent ? { ...environmentEvent,
    requestedEnvironmentKeys } : null;
  if (!environmentEvent) result.cleanupErrors.push("target environment observation frame missing");
  const nativeReport = await readFile(ls.nativeReportPath, "utf8").then(JSON.parse).catch(() => null);
  const cleanupScope = evaluateRegisteredLaunchServicesCleanupScope({ caseId, packageSha256: ls.expectedPackageSha256,
    verifiedFileHashes: ls.verifiedFileHashes, nativeReport, targetTerminated: result.targetTerminated,
    descendantCleanup: result.descendantCleanup, descendantCoverage: result.descendantCoverage, taggedResidualCount });
  result.cleanupScope = cleanupScope;
  result.launchServicesOutcome = validateLaunchServicesOutcome({ ready: stdoutState.readyEvent, event: launchEvent, observer: finalEvent, environmentObservation: environmentEvent,
    nativeReport,
    expected: { runId, caseId, bundleId: `dev.atools.fixture.dialog.${runId.replaceAll("-", "")}`,
      bundlePath: resolve(bundlePath), executablePath: resolve(executablePath), requestedEnvironmentKeyCount: requestedEnvironmentKeys.length },
    cleanupScope, logFrames: stdoutState });
  result.routedLogs = { stdoutBytes: stdoutState.encodedBytes, stderrBytes: stderrState.encodedBytes, combinedLimitBytes: MAX_ROUTED_LOG_BYTES,
    stdoutOverflow: stdoutState.overflow, stderrOverflow: stderrState.overflow,
    output: stdoutState.targetText + stdoutState.ordinaryText, errorOutput: stderrState.ordinaryText };
  result.passed = observerTerminationPassed(result) && !result.timedOut && !result.interrupted
    && result.targetTerminated && result.cleanupErrors.length === 0 && result.descendantCleanupCompleted
    && result.launchServicesOutcome.passed && cleanupScope.passed && !stdoutState.overflow && !stderrState.overflow
    && (!options.sampleResources || result.resourceSampling?.error === null);
  result.finishedAt = new Date().toISOString();
  return result;
}
