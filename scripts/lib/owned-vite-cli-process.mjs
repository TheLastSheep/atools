import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertOwnedBoundAddress, normalizeProbeUrl, selectVitePort, waitForOwnedProbeUntilDeadline } from "./owned-vite-server.mjs";

const workerEntry = fileURLToPath(new URL("./owned-vite-cli-worker.mjs", import.meta.url));
const outputLimit = 32768;

function appendOutput(current, chunk) {
  return (current + chunk.toString()).slice(-outputLimit);
}

function isExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function boundedOperation(operation, deadline, code, message) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error(message);
    error.code = code;
    return Promise.reject(error);
  }
  let timer;
  const pending = Promise.resolve().then(operation);
  return Promise.race([
    pending,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = code;
        reject(error);
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForExit(child, timeoutMs) {
  if (isExited(child)) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const finish = exited => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(isExited(child)), timeoutMs);
    child.once("exit", onExit);
  });
}

function waitForWorkerReady(child, deadline, lifecycle) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("Timed out starting owned Vite worker"));
  return new Promise((resolveReady, rejectReady) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onMessage = message => {
      if (message?.type === "ready") finish(resolveReady, message);
      else if (message?.type === "error") finish(rejectReady, new Error(`Vite worker failed: ${message.message || "startup error"}`));
    };
    const onError = error => finish(rejectReady, error);
    const onExit = (code, signal) => finish(rejectReady,
      new Error(`Vite worker exited before readiness: code=${code} signal=${signal}`));
    const timer = setTimeout(() => finish(rejectReady, new Error("Timed out starting owned Vite worker")), remaining);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    lifecycle.processState = "starting";
  });
}

async function stopOwnedWorker(child, lifecycle, termGraceMs, killGraceMs) {
  if (!child || child.pid == null) {
    lifecycle.processState = "not_spawned";
    return true;
  }
  if (!isExited(child)) {
    lifecycle.processState = "terminating";
    lifecycle.terminationRequested = true;
    try { lifecycle.terminationSignalSent = child.kill("SIGTERM") === true; }
    catch (error) { lifecycle.terminationError = String(error?.message || error); }
    let exited = await waitForExit(child, termGraceMs);
    if (!exited && !isExited(child)) {
      lifecycle.killEscalated = true;
      try { lifecycle.killSignalSent = child.kill("SIGKILL") === true; }
      catch (error) { lifecycle.killError = String(error?.message || error); }
      exited = await waitForExit(child, killGraceMs);
    }
    if (!exited && !isExited(child)) {
      lifecycle.processState = "exit_unconfirmed";
      return false;
    }
  }
  lifecycle.processState = "exited";
  lifecycle.exitCode = child.exitCode;
  lifecycle.exitSignal = child.signalCode;
  return true;
}

async function removeOwnedCache(cachePath, lifecycle, removeImpl = rm, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  try {
    await boundedOperation(
      () => removeImpl(cachePath, { recursive: true, force: true }),
      deadline,
      "OWNED_VITE_CACHE_REMOVE_TIMEOUT",
      "Timed out removing owned Vite cache",
    );
  } catch (error) {
    lifecycle.cacheState = error.code === "OWNED_VITE_CACHE_REMOVE_TIMEOUT"
      ? "remove_timed_out" : "remove_failed";
    lifecycle.cacheError = error.message || String(error);
    throw error;
  }
  try {
    await boundedOperation(() => access(cachePath), deadline, "OWNED_VITE_CACHE_VERIFY_TIMEOUT",
      "Timed out verifying owned Vite cache removal");
    throw new Error("Owned Vite cache remains after removal");
  } catch (error) {
    if (error.code !== "ENOENT") {
      lifecycle.cacheState = error.code === "OWNED_VITE_CACHE_VERIFY_TIMEOUT"
        ? "verify_timed_out" : "remove_failed";
      lifecycle.cacheError = error.message || String(error);
      throw error;
    }
  }
  lifecycle.cacheState = "removed";
}

function startupError(message, cause, lifecycle, output) {
  const error = new Error(`${message}${output ? `\nVite output:\n${output}` : ""}`, { cause });
  error.atoolsLifecycle = { vite: lifecycle };
  return error;
}

/** Owns the CLI-compatible Vite child, its readiness deadline, and its isolated cache. */
export async function launchOwnedViteCli(options = {}) {
  const root = resolve(options.cwd || new URL("../..", import.meta.url).pathname);
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? 1420);
  const timeoutMs = options.timeoutMs ?? 20000;
  const cachePrefix = options.cachePrefix ?? "atools-owned-vite-cli-";
  const termGraceMs = options.termGraceMs ?? 3000;
  const killGraceMs = options.killGraceMs ?? 1000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1000;
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Vite port must be an integer between 0 and 65535");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, "Vite startup timeout must be a positive integer");
  assert.ok(Number.isInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0,
    "Vite cache cleanup timeout must be a positive integer");
  assert.match(cachePrefix, /^[a-z0-9-]{1,48}-$/i, "Vite cache prefix must be a short path-safe label");

  const lifecycle = { state: "starting", host, requestedPort: port, selectedPort: null, boundAddress: null,
    processState: "not_spawned", closeState: "not_attempted", killEscalated: false, killSignalSent: false,
    cachePath: null, cacheState: "not_created" };
  let output = "";
  let child;
  let unexpectedExit = null;
  let closeErrorCode = null;
  try {
    lifecycle.selectedPort = await selectVitePort(host, port);
    lifecycle.cachePath = await mkdtemp(join(tmpdir(), cachePrefix));
    lifecycle.cacheState = "created";
    const forkImpl = options.forkImpl || fork;
    child = forkImpl(options.workerEntry || workerEntry, options.workerArgs || [], {
      cwd: root,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.on("data", chunk => { output = appendOutput(output, chunk); });
    child.stderr?.on("data", chunk => { output = appendOutput(output, chunk); });
    child.on("error", error => { lifecycle.processError = String(error?.message || error); });
    child.on("message", message => {
      if (message?.type === "close-error" && message.code === "VITE_CLOSE_FAILED") {
        closeErrorCode = message.code;
        lifecycle.workerCloseErrorCode = message.code;
      }
    });
    child.once("exit", (code, signal) => {
      lifecycle.observedExit = { code, signal, afterTerminationRequest: lifecycle.terminationRequested === true };
      if (lifecycle.state === "ready" && !lifecycle.terminationRequested) {
        unexpectedExit = `Vite worker exited unexpectedly: code=${code} signal=${signal}`;
        lifecycle.state = "worker_exited";
      }
    });
    const deadline = Date.now() + timeoutMs;
    lifecycle.processState = "spawned";
    const readyPromise = waitForWorkerReady(child, deadline, lifecycle);
    child.send({ type: "start", root, host, port: lifecycle.selectedPort, cachePath: lifecycle.cachePath }, error => {
      if (error) lifecycle.ipcError = String(error?.message || error);
    });
    const ready = await readyPromise;
    const address = assertOwnedBoundAddress(ready.address, host, lifecycle.selectedPort);
    lifecycle.boundAddress = { address: address.address, family: address.family, port: address.port };
    lifecycle.state = "worker_listening";
    const probeInput = options.probeUrl || `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}/?parity=1`;
    const ownedProbeUrl = normalizeProbeUrl(probeInput, address.address, address.port);
    await waitForOwnedProbeUntilDeadline(ownedProbeUrl, deadline, options.fetchImpl || fetch);
    if (isExited(child)) throw new Error("Owned Vite worker exited while its bound-socket probe was running");
    lifecycle.state = "ready";
  } catch (failure) {
    lifecycle.state = "start_failed";
    const exited = await stopOwnedWorker(child, lifecycle, termGraceMs, killGraceMs);
    if (exited && lifecycle.cachePath) {
      try { await removeOwnedCache(lifecycle.cachePath, lifecycle, options.removeCacheImpl || rm, cleanupTimeoutMs); }
      catch (cleanupFailure) { lifecycle.cleanupError = String(cleanupFailure?.message || cleanupFailure); }
    } else if (lifecycle.cachePath) lifecycle.cacheState = "retained_until_worker_exit";
    throw startupError(`Owned Vite startup failed: ${failure?.message || failure}`, failure, lifecycle, output);
  }

  let closePromise;
  return {
    lifecycle,
    origin: `http://${lifecycle.boundAddress.address.includes(":") ? `[${lifecycle.boundAddress.address}]` : lifecycle.boundAddress.address}:${lifecycle.boundAddress.port}`,
    close() {
      if (!closePromise) closePromise = (async () => {
        lifecycle.state = "closing";
        lifecycle.closeState = "attempted";
        const exited = await stopOwnedWorker(child, lifecycle, termGraceMs, killGraceMs);
        if (!exited) {
          lifecycle.state = "close_failed";
          lifecycle.closeState = "failed";
          throw startupError("Owned Vite worker did not exit after SIGTERM and SIGKILL", null, lifecycle, output);
        }
        try { await removeOwnedCache(lifecycle.cachePath, lifecycle, options.removeCacheImpl || rm, cleanupTimeoutMs); }
        catch (failure) {
          lifecycle.state = "close_failed";
          lifecycle.closeState = "failed";
          if (!lifecycle.cacheError) lifecycle.cacheError = String(failure?.message || failure);
          throw startupError(`Owned Vite cache cleanup failed: ${failure?.message || failure}`, failure, lifecycle, output);
        }
        const gracefulExit = lifecycle.exitCode === 0 && lifecycle.exitSignal === null
          && lifecycle.observedExit?.afterTerminationRequest === true
          && lifecycle.terminationSignalSent === true;
        const escalatedExit = lifecycle.exitSignal === "SIGKILL" && lifecycle.killSignalSent === true;
        if (closeErrorCode || (!gracefulExit && !escalatedExit) || unexpectedExit) {
          lifecycle.state = "close_failed";
          lifecycle.closeState = "failed";
          const detail = closeErrorCode ? `worker reported ${closeErrorCode}`
            : unexpectedExit || `unexpected worker exit code=${lifecycle.exitCode} signal=${lifecycle.exitSignal}`;
          throw startupError(`Owned Vite worker close failed: ${detail}`, null, lifecycle, output);
        }
        lifecycle.state = "closed";
        lifecycle.closeState = "closed";
      })();
      return closePromise;
    },
  };
}
