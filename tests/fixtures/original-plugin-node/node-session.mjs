import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createOriginalPluginHostPorts } from "./host-ports.mjs";
import { createOriginalPluginNodeLaunch, normalizeOriginalPluginFixtureEnv, originalPluginDiagnosticPrefix } from "./node-policy.mjs";
import { validateOfficeCliFixture } from "./office-cli-policy.mjs";
import { createOfficeCliTelemetryLineParser } from "./office-cli-telemetry.mjs";

const fixtureRequire = createRequire(import.meta.url);

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const RPC_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 4000;
const STOP_GRACE_MS = 1500;
const CLOSE_TIMEOUT_MS = 2000;
const STDERR_TAIL_BYTES = 16_000;

function failure(message, code = "ERR_ATOOLS_ORIGINAL_PLUGIN_FIXTURE") {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root, candidate) {
  const segment = relative(root, candidate);
  return segment === "" || (segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment));
}

function absoluteRoot(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw failure(`${label} must be an absolute canonical path`);
  }
  return value;
}

function validateOrigin(value) {
  if (value === "null") return value;
  if (typeof value !== "string" || value.length > 512) throw failure("origin must be an exact browser origin");
  let parsed;
  try { parsed = new URL(value); } catch { throw failure("origin must be an exact browser origin"); }
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw failure("origin must be an exact browser origin");
  }
  return value;
}

function validatePrivatePath(value, label, scratchRoot, pluginDataRoot) {
  const checked = absoluteRoot(value, label);
  if (!inside(scratchRoot, checked) && !inside(pluginDataRoot, checked)) {
    throw failure(`${label} must stay inside a fixture scratch/data root`);
  }
  return checked;
}

function validateInputSelections(value, scratchRoot, pluginDataRoot) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) {
    throw failure("inputSelections must contain at most ten fixed file selection groups");
  }
  const result = [];
  for (let groupIndex = 0; groupIndex < value.length; groupIndex++) {
    if (!Object.hasOwn(value, groupIndex)) throw failure(`inputSelections[${groupIndex}] is missing`);
    const group = value[groupIndex];
    if (!Array.isArray(group) || group.length === 0 || group.length > 50) {
      throw failure(`inputSelections[${groupIndex}] must contain between one and fifty fixed paths`);
    }
    const paths = [];
    for (let pathIndex = 0; pathIndex < group.length; pathIndex++) {
      if (!Object.hasOwn(group, pathIndex)) throw failure(`inputSelections[${groupIndex}][${pathIndex}] is missing`);
      paths.push(validatePrivatePath(group[pathIndex], `inputSelections[${groupIndex}][${pathIndex}]`,
        scratchRoot, pluginDataRoot));
    }
    result.push(paths);
  }
  return result;
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function count(table, key) {
  Object.defineProperty(table, key, { value: (Object.hasOwn(table, key) ? table[key] : 0) + 1,
    writable: true, enumerable: true, configurable: true });
}

function createOfficeCliTelemetry(policy) {
  return {
    enabled: true,
    binaryPath: policy.binaryPath, sha256: policy.sha256,
    environmentPolicy: { privateFixtureEnv: true, noAutoResident: true, skipUpdate: true,
      workingDirectoryPolicy: "scratchRoot" },
    childLifecycleScope: "direct-child-only",
    attempts: 0, versionCalls: 0, viewCalls: 0, started: 0, exited: 0, closed: 0,
    errors: 0, nonzeroExits: 0, killRequests: 0, killed: 0, denials: 0, deadlines: 0,
    cleanupFailures: 0, pids: [], events: [], activePids: new Set(),
  };
}

function snapshotOfficeCliTelemetry(telemetry) {
  if (!telemetry) return undefined;
  const { activePids, ...publicStats } = telemetry;
  const active = activePids.size;
  return structuredClone({ ...publicStats, active,
    closeConfirmed: active === 0 && telemetry.cleanupFailures === 0
      && telemetry.attempts === telemetry.closed && telemetry.started === telemetry.exited });
}

function snapshotStats(stats, state) {
  const helperProcesses = snapshotOfficeCliTelemetry(stats.helperProcesses);
  return structuredClone({
    requests: stats.requests,
    pluginId: stats.pluginId,
    methods: stats.methods,
    rpcMethods: stats.rpcMethods,
    rpcRequests: stats.rpcRequests,
    nodeCallParamTail: stats.nodeCallParamTail,
    dialogs: stats.dialogs,
    denials: stats.denials,
    nodeModules: [...stats.nodeModules].sort(),
    nativeTextPort: { ...stats.nativeTextPort },
    nodeVersion: stats.nodeVersion,
    nodePid: stats.nodePid,
    nodeRuntimeMs: stats.nodeStartedAt ? (stats.nodeStoppedAt || performance.now()) - stats.nodeStartedAt : 0,
    pendingRpcCount: state.pending.size,
    activeSocketCount: state.activeSocketCount(),
    nodeExitEventObserved: state.nodeExitEventObserved,
    listenerClosed: state.listenerClosed,
    databaseClosed: state.databaseClosed,
    ...(helperProcesses ? { helperProcesses } : {}),
    stderrTail: stats.stderrTail,
  });
}

/** Start a pinned Node sidecar and private ports for one supported original plugin. */
export async function startOriginalPluginNodeSession({ pluginId, root, pluginRoot, preloadPath, scratchRoot, pluginDataRoot,
  fixtureEnv, origin, saveAsPath, openFilePath, openDirectoryPath, inputSelections, officeCli }) {
  const diagnosticPrefix = originalPluginDiagnosticPrefix(pluginId);
  root = absoluteRoot(root, "root");
  pluginRoot = absoluteRoot(pluginRoot, "pluginRoot");
  preloadPath = absoluteRoot(preloadPath, "preloadPath");
  scratchRoot = absoluteRoot(scratchRoot, "scratchRoot");
  pluginDataRoot = absoluteRoot(pluginDataRoot, "pluginDataRoot");
  fixtureEnv = normalizeOriginalPluginFixtureEnv(fixtureEnv);
  origin = validateOrigin(origin);
  saveAsPath = absoluteRoot(saveAsPath, "saveAsPath");
  if (openFilePath !== undefined) openFilePath = validatePrivatePath(openFilePath, "openFilePath", scratchRoot, pluginDataRoot);
  if (openDirectoryPath !== undefined) {
    openDirectoryPath = validatePrivatePath(openDirectoryPath, "openDirectoryPath", scratchRoot, pluginDataRoot);
  }
  inputSelections = validateInputSelections(inputSelections, scratchRoot, pluginDataRoot);
  if (!inside(scratchRoot, pluginRoot) || !inside(pluginRoot, preloadPath) || !inside(scratchRoot, saveAsPath)) {
    throw failure("pluginRoot and saveAsPath must stay inside scratchRoot, and preloadPath inside pluginRoot");
  }
  const privateRoots = [fixtureEnv.HOME, fixtureEnv.XDG_DATA_HOME];
  if (![scratchRoot, pluginDataRoot].every(candidate => privateRoots.some(privateRoot => inside(privateRoot, candidate)))) {
    throw failure("scratchRoot and pluginDataRoot must stay inside isolated HOME/data");
  }
  const officeCliPolicy = await validateOfficeCliFixture(officeCli, pluginId, scratchRoot);
  if (officeCliPolicy) {
    const helperDirectory = dirname(officeCliPolicy.binaryPath);
    if (fixtureEnv.PATH.split(delimiter)[0] !== helperDirectory) {
      throw failure("officeCli binary directory must be first in the private fixture PATH");
    }
    const selectedInputPaths = new Set([...(openFilePath ? [openFilePath] : []), ...(inputSelections ?? []).flat()]);
    if (officeCliPolicy.inputPaths.some(path => !selectedInputPaths.has(path))) {
      throw failure("officeCli inputs must be fixed file-picker selections in this fixture session");
    }
  }

  const databasePath = join(pluginDataRoot, `${pluginId}.sqlite`);
  const stats = {
    pluginId, requests: 0, methods: {}, rpcMethods: {}, rpcRequests: 0, dialogs: [], nodeModules: new Set(),
    nodeCallParamTail: [],
    denials: { route: 0, requestLimit: 0, childProcess: 0, externalNetwork: 0, nativeTextFallback: 0 },
    nativeTextPort: { readRequests: 0, writeRequests: 0, handled: false, implementation: "hosted-Node-fallback",
      rustNativeAcceptance: false, acceptanceNote: "Hosted Node fallback only; not Rust/native acceptance",
      pathHistogram: { paths: [], omittedCalls: 0 } },
    helperProcesses: officeCliPolicy ? createOfficeCliTelemetry(officeCliPolicy) : undefined,
    nodeStartedAt: 0, nodeStoppedAt: 0, nodeVersion: "", nodePid: 0, stderrTail: "",
  };
  const pending = new Map();
  let pluginData;
  let ports;
  let child;
  let nextRpcId = 0;
  let stopping;
  let pluginDataClosed = false;
  let listenerClosed = false;
  let nodeExitEventObserved = false;
  let childSpawned = false;
  let spawnOutcomeSettled = false;
  let stopRequestedBeforeSpawn = false;
  let nodeTermination;
  let lateNodeCleanup;
  let resolveExit, resolveClose, resolveSpawnOutcome;
  const nodeExit = new Promise(resolveEvent => { resolveExit = resolveEvent; });
  const nodeClose = new Promise(resolveEvent => { resolveClose = resolveEvent; });
  const spawnOutcome = new Promise(resolveEvent => { resolveSpawnOutcome = resolveEvent; });

  function settleSpawnOutcome(outcome) {
    if (spawnOutcomeSettled) return;
    spawnOutcomeSettled = true;
    resolveSpawnOutcome(outcome);
  }

  function rejectPending(error) {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  }

  const officeCliStderrParser = createOfficeCliTelemetryLineParser(stats, diagnosticPrefix);

  function noteStderr(chunk) {
    const text = chunk.toString("utf8");
    stats.stderrTail = (stats.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    officeCliStderrParser.push(text);
  }

  function processRpcLine(line) {
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_RESPONSE_BYTES) {
      rejectPending(failure("Node RPC response exceeds fixture byte budget", "ERR_ATOOLS_FIXTURE_RPC_LIMIT"));
      child?.kill("SIGKILL");
      return;
    }
    let response;
    try { response = JSON.parse(line); }
    catch {
      rejectPending(failure("Product Node wrote a non-JSON stdout line", "ERR_ATOOLS_FIXTURE_RPC_PROTOCOL"));
      child?.kill("SIGKILL");
      return;
    }
    if (!isRecord(response) || response.jsonrpc !== "2.0" || !Number.isSafeInteger(response.id)) {
      rejectPending(failure("Product Node wrote an invalid JSON-RPC response", "ERR_ATOOLS_FIXTURE_RPC_PROTOCOL"));
      child?.kill("SIGKILL");
      return;
    }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.error) {
      waiter.reject(Object.assign(new Error(String(response.error.message ?? "Node RPC failed")), { code: response.error.code }));
    } else waiter.resolve(response.result);
  }

  function rpc(method, params = {}) {
    if (!child || !childSpawned || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(failure("Product Node process is unavailable", "ERR_ATOOLS_FIXTURE_NODE_UNAVAILABLE"));
    }
    const id = ++nextRpcId;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
      return Promise.reject(failure("Node RPC request exceeds fixture byte budget", "ERR_ATOOLS_FIXTURE_RPC_LIMIT"));
    }
    count(stats.rpcMethods, method);
    stats.rpcRequests++;
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRpc(failure(`Product Node RPC timed out (${method}): ${stats.stderrTail}`, "ERR_ATOOLS_FIXTURE_RPC_TIMEOUT"));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc, timer });
      try {
        child.stdin.write(`${line}\n`, error => {
          if (!error || !pending.has(id)) return;
          const waiter = pending.get(id);
          pending.delete(id); clearTimeout(waiter.timer); waiter.reject(error);
        });
      } catch (error) {
        pending.delete(id); clearTimeout(timer); rejectRpc(error);
      }
    });
  }

  function terminateSpawnedNode() {
    if (nodeTermination) return nodeTermination;
    nodeTermination = (async () => {
      if (!childSpawned) throw failure("Node process spawn was not confirmed", "ERR_ATOOLS_FIXTURE_NODE_EXIT_UNCONFIRMED");
      if (!nodeExitEventObserved) {
        try { child.kill("SIGTERM"); } catch { /* Confirm exit below instead of trusting the signal result. */ }
        try { await bounded(nodeExit, STOP_GRACE_MS, "Product Node SIGTERM exit"); }
        catch {
          if (!nodeExitEventObserved) {
            try { child.kill("SIGKILL"); } catch { /* The exit event remains the cleanup proof. */ }
            await bounded(nodeExit, STOP_GRACE_MS, "Product Node SIGKILL exit");
          }
        }
      }
      if (!nodeExitEventObserved) throw failure("Node exit event was not observed", "ERR_ATOOLS_FIXTURE_NODE_EXIT_UNCONFIRMED");
      return await bounded(nodeClose, CLOSE_TIMEOUT_MS, "Product Node stdio close");
    })();
    return nodeTermination;
  }

  function recordLateNodeCleanupError(error) {
    const line = `${diagnosticPrefix}_NODE_CLEANUP ${String(error?.code ?? "ERR_ATOOLS_FIXTURE_NODE_EXIT_UNCONFIRMED")}: ${String(error?.message ?? error)}\n`;
    stats.stderrTail = (stats.stderrTail + line).slice(-STDERR_TAIL_BYTES);
  }

  async function startNode() {
    const launch = await createOriginalPluginNodeLaunch({ pluginId, root, pluginRoot, preloadPath,
      scratchRoot, pluginDataRoot, fixtureEnv, officeCli: officeCliPolicy });
    stats.nodeStartedAt = performance.now();
    child = spawn(launch.nodeBinary, launch.args, {
      cwd: pluginRoot, env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    child.once("spawn", () => {
      childSpawned = true;
      settleSpawnOutcome({ kind: "spawn" });
      if (stopRequestedBeforeSpawn) {
        lateNodeCleanup = terminateSpawnedNode();
        lateNodeCleanup.catch(recordLateNodeCleanupError);
      }
    });
    child.once("error", error => {
      if (!childSpawned) settleSpawnOutcome({ kind: "error", error });
      rejectPending(error);
    });
    child.once("exit", (code, signal) => {
      nodeExitEventObserved = true;
      stats.nodeStoppedAt = performance.now();
      resolveExit({ code, signal });
      rejectPending(failure(`Product Node exited (${code ?? signal ?? "unknown"})`, "ERR_ATOOLS_FIXTURE_NODE_EXIT"));
    });
    child.once("close", (code, signal) => resolveClose({ code, signal }));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", processRpcLine);
    child.stderr.on("data", noteStderr);
    const spawnResult = await bounded(spawnOutcome, STARTUP_TIMEOUT_MS, "Product Node spawn");
    if (spawnResult.kind !== "spawn") throw spawnResult.error;
    const initialization = await bounded(rpc("initialize"), STARTUP_TIMEOUT_MS, "Product Node initialization");
    if (!isRecord(initialization) || initialization.nodeVersion !== "22.23.3" || initialization.protocolVersion !== 1
      || initialization.pid !== child.pid) {
      throw failure("Product Node initialization did not match pinned version/protocol/process", "ERR_ATOOLS_FIXTURE_NODE_VERSION");
    }
    stats.nodeVersion = initialization.nodeVersion;
    stats.nodePid = initialization.pid;
    return structuredClone(initialization);
  }

  async function stopNode() {
    if (!child) return { notStarted: true, exitEventObserved: false };
    if (!childSpawned) {
      stopRequestedBeforeSpawn = true;
      let outcome;
      try { outcome = await bounded(spawnOutcome, CLOSE_TIMEOUT_MS, "Product Node spawn outcome before cleanup"); }
      catch {
        throw failure("Product Node spawn outcome was not confirmed; late spawn cleanup remains armed", "ERR_ATOOLS_FIXTURE_NODE_EXIT_UNCONFIRMED");
      }
      if (outcome.kind === "error" && !childSpawned) {
        return { notStarted: true, exitEventObserved: false, spawnError: String(outcome.error?.message ?? outcome.error) };
      }
    }
    const stopped = await bounded(terminateSpawnedNode(), STOP_GRACE_MS * 2 + CLOSE_TIMEOUT_MS + 500, "Product Node shutdown");
    return { ...stopped, exitEventObserved: nodeExitEventObserved, closeEventObserved: true };
  }

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      rejectPending(failure(`${pluginId} Node session is closing`, "ERR_ATOOLS_FIXTURE_NODE_CLOSING"));
      const failures = [];
      let nodeExitResult;
      try { nodeExitResult = await stopNode(); }
      catch (error) { failures.push(error); }
      const helperProcesses = snapshotOfficeCliTelemetry(stats.helperProcesses);
      if (helperProcesses && !helperProcesses.closeConfirmed) {
        failures.push(failure("OfficeCLI helper close was not confirmed by exit and stdio-close events",
          "ERR_ATOOLS_FIXTURE_OFFICECLI_EXIT_UNCONFIRMED"));
      }
      try {
        if (ports) {
          const listener = await ports.close();
          listenerClosed = listener.listenerClosed;
        } else listenerClosed = true;
      } catch (error) { failures.push(error); }
      try {
        if (pluginData && !pluginDataClosed) { pluginData.close(); pluginDataClosed = true; }
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `${pluginId} fixture cleanup did not complete all resources`);
      return { nodeExit: nodeExitResult, nodeExitEventObserved, listenerClosed, databaseClosed: pluginDataClosed };
    })();
    return stopping;
  }

  try {
    await Promise.all([mkdir(scratchRoot, { recursive: true, mode: 0o700 }), mkdir(pluginDataRoot, { recursive: true, mode: 0o700 })]);
    const { PersistentPluginData } = fixtureRequire("../paste-startup/persistent-data.mjs");
    pluginData = new PersistentPluginData(databasePath);
    ports = createOriginalPluginHostPorts({ pluginId, origin, saveAsPath, openFilePath, openDirectoryPath,
      inputSelections, scratchRoot, pluginDataRoot, pluginData, forwardNode: rpc, stats });
    const endpoints = await ports.listen();
    const initialization = await startNode();
    return {
      endpoints, initialization,
      snapshot: () => snapshotStats(stats, { pending, activeSocketCount: ports.activeSocketCount,
        nodeExitEventObserved, listenerClosed, databaseClosed: pluginDataClosed }),
      stop,
    };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `${pluginId} session startup and cleanup failed`); }
    throw error;
  }
}
