import { spawn } from "node:child_process";
import { observeLaunchServicesNativeProcess } from "./published-plugin-launchservices-observer.mjs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { trackNativeDescendants } from "./native-smoke-descendants.mjs";
import { captureNativeProcessIdentity, createNativeProcessResourceSampler, readNativeProcessSnapshot, processIdentity, summarizeProcessIdentity } from "./native-process-resource-sampler.mjs";

const RESOURCE_SAMPLE_INTERVAL_MS = 200;
const RESOURCE_SAMPLE_LIMIT = 600;

function startResourceObservation(child, executable, result, readSnapshot) {
  const state = { stopping: false, sampler: null, identity: null, error: null, timer: null, wake: null };
  const waitForNextSample = () => new Promise(resolve => {
    const finish = () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.wake = null;
      resolve();
    };
    state.wake = finish;
    state.timer = setTimeout(finish, RESOURCE_SAMPLE_INTERVAL_MS);
  });
  const promise = (async () => {
    if (!child.pid) throw new Error("Cannot sample native process resources without a spawned PID");
    const samplerReadSnapshot = readSnapshot
      ? () => readSnapshot({ pid: child.pid, expectedPgid: child.pid, expectedExecutable: executable })
      : undefined;
    state.identity = await captureNativeProcessIdentity(child.pid, {
      expectedPgid: child.pid,
      expectedExecutable: executable,
      ...(samplerReadSnapshot ? { readSnapshot: samplerReadSnapshot } : {}),
    });
    state.sampler = createNativeProcessResourceSampler({
      rootIdentity: state.identity,
      maxSamples: RESOURCE_SAMPLE_LIMIT,
      ...(samplerReadSnapshot ? { readSnapshot: samplerReadSnapshot } : {}),
    });
    while (!state.stopping && state.sampler.report().coverage.sampleCount < RESOURCE_SAMPLE_LIMIT) {
      await state.sampler.sample();
      if (!state.stopping && state.sampler.report().coverage.sampleCount < RESOURCE_SAMPLE_LIMIT) await waitForNextSample();
    }
  })().catch(error => { state.error = String(error); });

  return {
    requestStop() {
      state.stopping = true;
      state.wake?.();
    },
    async finish() {
      await promise;
      const report = state.sampler?.report() ?? null;
      result.resourceSampling = {
        requested: true,
        sampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
        maxSamples: RESOURCE_SAMPLE_LIMIT,
        processIdentity: summarizeProcessIdentity(state.identity),
        executableAssertion: state.identity?.executableAssertion ?? null,
        report,
        error: state.error,
      };
      if (!state.error && (!report || report.coverage.sampleCount === 0)) {
        result.resourceSampling.error = "Resource sampling completed without a process sample";
      }
    },
  };
}



/** Native fixture observer. Nonzero exits and cleanup failures stay in the report. */
export async function observePublishedNativeProcess(executable, args, options = {}) {
  if (options.launchServices) return observeLaunchServicesNativeProcess(executable, args, options);
  const { timeoutMs = 90000, trackDescendants = true, sampleResources = false,
    resourceSamplerReadSnapshot, ...spawnOptions } = options;
  const tag = "atools-native-smoke-" + randomUUID(), startedAt = new Date().toISOString();
  const child = spawn(executable, args, { stdio: "inherit", ...spawnOptions,
    env: { ...(spawnOptions.env || process.env), ATOOLS_NATIVE_SMOKE_PROCESS_TAG: tag },
    detached: process.platform !== "win32" });
  const stop = trackDescendants && process.platform !== "win32" && child.pid ? trackNativeDescendants(child, tag) : null;
  const result = { startedAt, pid: child.pid ?? null, exitObserved: false, exitCode: null, signal: null,
    timedOut: false, interrupted: false, spawnError: null, cleanupErrors: [],
    descendantCleanupAttempted: !!stop, descendantCleanupCompleted: false };
  const resourceObservation = sampleResources
    ? startResourceObservation(child, executable, result, resourceSamplerReadSnapshot)
    : null;
  let timer, complete, termination;
  const exited = new Promise(resolve => { complete = resolve; });
  const terminate = () => {
    if (termination) return termination;
    termination = (async () => {
      // Signal the sampler without waiting for an in-flight ps snapshot; process
      // group termination must not be delayed by observation work.
      resourceObservation?.requestStop();
      if (stop) try { await stop(); } catch (error) { result.cleanupErrors.push(String(error)); }
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") result.cleanupErrors.push(String(error)); }
      }
    })();
    return termination;
  };
  const interrupted = () => { result.interrupted = true; void terminate(); };
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  child.once("error", error => { result.spawnError = String(error); complete(); });
  child.once("exit", (code, signal) => {
    result.exitObserved = true; result.exitCode = code; result.signal = signal; complete();
  });
  timer = setTimeout(() => { result.timedOut = true; void terminate(); }, timeoutMs);
  try {
    await exited;
    clearTimeout(timer);
    if (termination) await termination;
    if (stop) {
      try { await stop(); result.descendantCleanupCompleted = true; }
      catch (error) { result.cleanupErrors.push(String(error)); }
    }
    resourceObservation?.requestStop();
    if (resourceObservation) {
      try { await resourceObservation.finish(); }
      catch (error) {
        result.resourceSampling = { requested: true, sampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
          maxSamples: RESOURCE_SAMPLE_LIMIT, processIdentity: null, executableAssertion: null,
          report: null, error: String(error) };
      }
    }
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  }
  result.finishedAt = new Date().toISOString();
  result.passed = result.exitObserved && result.exitCode === 0 && !result.signal && !result.spawnError
    && !result.timedOut && !result.interrupted && result.cleanupErrors.length === 0
    && (!sampleResources || (result.resourceSampling?.error === null && result.resourceSampling?.report?.coverage?.sampleCount > 0))
    && (!trackDescendants || result.descendantCleanupCompleted);
  return result;
}
