import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_INPUTS = 3;
const MAX_CONCURRENT_HELPERS = 2;
const MAX_HELPERS_PER_SESSION = 16;
const MAX_HELPER_RUNTIME_MS = 15_000;
const HELPER_KILL_GRACE_MS = 750;
const NODE_HELPER_SHUTDOWN_MS = 1_000;
const NODE_HELPER_KILL_WAIT_MS = 1_000;
const MAX_TELEMETRY_EVENTS = 32;
const VALIDATED_OFFICE_CLI_POLICIES = new WeakSet();

function failure(message) {
  return Object.assign(new Error(message), { code: "ERR_ATOOLS_FIXTURE_OFFICECLI_POLICY" });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root, candidate) {
  const segment = relative(root, candidate);
  return segment === "" || (segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment));
}

function canonicalAbsolute(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw failure(`${label} must be an absolute canonical scratch path`);
  }
  return value;
}

async function canonicalScratchFile(value, label, scratchRoot, executable = false) {
  const checked = canonicalAbsolute(value, label);
  if (!inside(scratchRoot, checked) || checked === scratchRoot) {
    throw failure(`${label} must stay inside scratchRoot`);
  }
  let linkStat;
  let resolved;
  let fileStat;
  try {
    [linkStat, resolved, fileStat] = await Promise.all([lstat(checked), realpath(checked), stat(checked)]);
  } catch {
    throw failure(`${label} must exist inside scratchRoot`);
  }
  if (linkStat.isSymbolicLink() || resolved !== checked || !inside(scratchRoot, resolved)) {
    throw failure(`${label} must be a canonical non-symlink scratch file`);
  }
  if (!fileStat.isFile()) throw failure(`${label} must be a regular file`);
  if (executable) {
    try { await access(checked, constants.X_OK); }
    catch { throw failure(`${label} must be executable`); }
  }
  return checked;
}

async function sha256File(filePath) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const stream = createReadStream(filePath, { flags: constants.O_RDONLY | noFollow });
  const digest = createHash("sha256");
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}

/** Validate a fixed, hash-pinned OfficeCLI capability for the isolated converter fixture. */
export async function validateOfficeCliFixture(officeCli, pluginId, scratchRoot) {
  if (officeCli === undefined) return undefined;
  if (pluginId !== "format-converter") throw failure("officeCli is only supported for format-converter");
  if (!record(officeCli) || Object.keys(officeCli).sort().join(",") !== "binaryPath,inputPaths,sha256") {
    throw failure("officeCli must contain only binaryPath, sha256 and inputPaths");
  }
  const root = canonicalAbsolute(scratchRoot, "scratchRoot");
  let rootStat;
  let realRoot;
  try { [rootStat, realRoot] = await Promise.all([stat(root), realpath(root)]); }
  catch { throw failure("scratchRoot must exist before officeCli is configured"); }
  if (!rootStat.isDirectory() || realRoot !== root) throw failure("scratchRoot must be a canonical directory");

  const binaryPath = await canonicalScratchFile(officeCli.binaryPath, "officeCli.binaryPath", root, true);
  if (typeof officeCli.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(officeCli.sha256)) {
    throw failure("officeCli.sha256 must be a 64-character SHA-256 digest");
  }
  const actualSha256 = await sha256File(binaryPath);
  if (actualSha256 !== officeCli.sha256.toLowerCase()) {
    throw failure("officeCli binary SHA-256 does not match the supplied pin");
  }
  if (!Array.isArray(officeCli.inputPaths) || officeCli.inputPaths.length < 1 || officeCli.inputPaths.length > MAX_INPUTS) {
    throw failure(`officeCli.inputPaths must contain between one and ${MAX_INPUTS} files`);
  }
  const inputPaths = [];
  const seen = new Set();
  for (let index = 0; index < officeCli.inputPaths.length; index += 1) {
    if (!Object.hasOwn(officeCli.inputPaths, index)) throw failure(`officeCli.inputPaths[${index}] is missing`);
    const inputPath = await canonicalScratchFile(officeCli.inputPaths[index], `officeCli.inputPaths[${index}]`, root);
    if (seen.has(inputPath)) throw failure("officeCli.inputPaths must be unique");
    seen.add(inputPath);
    inputPaths.push(inputPath);
  }
  const policy = Object.freeze({
    binaryPath,
    sha256: actualSha256,
    inputPaths: Object.freeze(inputPaths),
    scratchRoot: root,
  });
  VALIDATED_OFFICE_CLI_POLICIES.add(policy);
  return policy;
}

export function isValidatedOfficeCliFixture(policy) {
  return record(policy) && VALIDATED_OFFICE_CLI_POLICIES.has(policy);
}

/** Build the narrow child_process gate installed before the original CJS preload graph loads. */
export function createOfficeCliProcessPolicySource(policy, marker) {
  if (!isValidatedOfficeCliFixture(policy) || typeof marker !== "string" || !/^[A-Z0-9]+$/u.test(marker)) {
    throw failure("validated officeCli policy and diagnostic marker are required");
  }
  const encodedPolicy = JSON.stringify(policy);
  const encodedMarker = JSON.stringify(`${marker}_OFFICECLI_EVENT `);
  return `(() => {
const policy = ${encodedPolicy};
const marker = ${encodedMarker};
const MAX_CONCURRENT = ${MAX_CONCURRENT_HELPERS};
const MAX_TOTAL = ${MAX_HELPERS_PER_SESSION};
const DEADLINE_MS = ${MAX_HELPER_RUNTIME_MS};
const KILL_GRACE_MS = ${HELPER_KILL_GRACE_MS};
const SHUTDOWN_MS = ${NODE_HELPER_SHUTDOWN_MS};
const KILL_WAIT_MS = ${NODE_HELPER_KILL_WAIT_MS};
const EVENT_LIMIT = ${MAX_TELEMETRY_EVENTS};
const guardedModules = new WeakMap();
const stats = { attempts: 0, versionCalls: 0, viewCalls: 0, started: 0, exited: 0, closed: 0, active: 0,
  errors: 0, nonzeroExits: 0, killRequests: 0, killed: 0, denials: 0, deadlines: 0, cleanupFailures: 0,
  pids: [], events: [] };
const helpers = new Set();
let pendingSpawns = 0;
let totalAccepted = 0;
let shuttingDown = false;
let shutdownPromise;

function emit(event, operation, state, fields = {}) {
  const entry = { event, operation };
  if (state && Number.isSafeInteger(state.pid)) entry.pid = state.pid;
  Object.assign(entry, fields);
  stats.events.push(entry);
  if (stats.events.length > EVENT_LIMIT) stats.events.splice(0, stats.events.length - EVENT_LIMIT);
  try { process.stderr.write(marker + JSON.stringify({ pluginId: 'format-converter', ...entry }) + '\\n'); } catch {}
}

function snapshot() {
  return { enabled: true, binaryPath: policy.binaryPath, sha256: policy.sha256,
    environmentPolicy: { privateFixtureEnv: true, noAutoResident: true, skipUpdate: true,
      workingDirectoryPolicy: 'scratchRoot' },
    childLifecycleScope: 'direct-child-only',
    ...stats, pids: stats.pids.slice(), events: stats.events.map(event => ({ ...event })),
    active: stats.active, closeConfirmed: stats.active === 0 && stats.cleanupFailures === 0
      && stats.attempts === stats.closed && stats.started === stats.exited };
}

function denial(operation, reason, deny, method) {
  stats.denials += 1;
  emit('denied', operation, null, { reason });
  const result = deny(method);
  return typeof result === 'function' ? result() : result;
}

function callbackDenial(reason, callback, deny, method) {
  stats.denials += 1;
  emit('denied', 'other', null, { reason });
  let error;
  try {
    const result = deny(method);
    if (typeof result === 'function') result();
  } catch (denialError) { error = denialError; }
  if (!(error instanceof Error)) {
    error = Object.assign(new Error('ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED'),
      { code: 'ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED' });
  }
  queueMicrotask(() => callback(error, '', ''));
  return undefined;
}

function exactOperation(method, command, args) {
  if (command !== policy.binaryPath || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return null;
  if (method === 'execFile' && args.length === 1 && args[0] === '--version') return 'version';
  if (method === 'spawn' && args.length === 5 && args[0] === 'view' && policy.inputPaths.includes(args[1])
    && args[2] === 'text' && args[3] === '--max-lines' && args[4] === '100000') return 'view';
  return null;
}

function optionsAreRecord(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return false;
  const prototype = Object.getPrototypeOf(options);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function privateEnvironment() {
  const env = Object.assign(Object.create(null), process.env);
  env.OFFICECLI_NO_AUTO_RESIDENT = '1';
  env.OFFICECLI_SKIP_UPDATE = '1';
  return env;
}

function reserve(operation, deny, method) {
  if (shuttingDown) return denial(operation, 'closing', deny, method);
  if (totalAccepted >= MAX_TOTAL) return denial(operation, 'budget', deny, method);
  if (pendingSpawns + stats.active >= MAX_CONCURRENT) return denial(operation, 'concurrency', deny, method);
  totalAccepted += 1;
  pendingSpawns += 1;
  stats.attempts += 1;
  if (operation === 'version') stats.versionCalls += 1;
  if (operation === 'view') stats.viewCalls += 1;
  emit('attempt', operation);
  return { operation, pending: true, spawned: false, closed: false, pid: undefined, child: undefined,
    resolveClosed: undefined, closedPromise: undefined, deadlineTimer: undefined, killTimer: undefined };
}

function releasePending(state) {
  if (!state.pending) return;
  state.pending = false;
  pendingSpawns = Math.max(0, pendingSpawns - 1);
}

function killOwned(state, signal, reason) {
  if (state.closed || !state.child) return;
  clearTimeout(state.deadlineTimer);
  if (reason !== 'deadline') clearTimeout(state.killTimer);
  return recordKill(state, signal, reason, () => state.rawKill(signal));
}

function recordKill(state, signal, reason, send) {
  stats.killRequests += 1;
  let accepted = false;
  try { accepted = send() === true; } catch {}
  if (accepted) stats.killed += 1;
  emit('kill', state.operation, state, { signal, reason, accepted });
  return accepted;
}

function trackChild(child, state, timeoutMs) {
  state.child = child;
  state.rawKill = child.kill.bind(child);
  child.kill = (...args) => recordKill(state, args[0] ?? 'SIGTERM', 'child-reference',
    () => state.rawKill(...args));
  state.closedPromise = new Promise(resolve => { state.resolveClosed = resolve; });
  helpers.add(state);
  child.once('spawn', () => {
    if (state.closed || state.spawned) return;
    state.spawned = true;
    releasePending(state);
    state.pid = Number.isSafeInteger(child.pid) ? child.pid : undefined;
    stats.started += 1;
    stats.active += 1;
    if (state.pid && stats.pids.length < MAX_TOTAL) stats.pids.push(state.pid);
    emit('spawn', state.operation, state);
  });
  child.once('error', error => {
    stats.errors += 1;
    if (!state.spawned) releasePending(state);
    emit('error', state.operation, state, { code: String(error?.code ?? 'ERR_CHILD_PROCESS') });
  });
  child.once('exit', (code, signal) => {
    stats.exited += 1;
    if (code !== 0) stats.nonzeroExits += 1;
    emit('exit', state.operation, state, { code: code ?? null, signal: signal ?? null });
  });
  child.once('close', (code, signal) => {
    if (state.closed) return;
    state.closed = true;
    clearTimeout(state.deadlineTimer);
    clearTimeout(state.killTimer);
    releasePending(state);
    if (state.spawned) stats.active = Math.max(0, stats.active - 1);
    stats.closed += 1;
    emit('close', state.operation, state, { code: code ?? null, signal: signal ?? null, stdioClosed: true });
    helpers.delete(state);
    state.resolveClosed();
  });
  state.deadlineTimer = setTimeout(() => {
    if (state.closed) return;
    stats.deadlines += 1;
    emit('deadline', state.operation, state);
    killOwned(state, 'SIGTERM', 'deadline');
    state.killTimer = setTimeout(() => killOwned(state, 'SIGKILL', 'deadline'), KILL_GRACE_MS);
  }, Math.min(DEADLINE_MS, timeoutMs));
  return child;
}

function startAllowed(target, method, original, args, label, deny) {
  const command = args[0];
  let vector;
  let options;
  let callback;
  let timeoutMs = DEADLINE_MS;
  if (method === 'execFile') {
    if (typeof args[args.length - 1] === 'function') callback = args[args.length - 1];
    if (args.length === 4 && Array.isArray(args[1]) && optionsAreRecord(args[2]) && typeof args[3] === 'function') {
      vector = args[1]; options = args[2]; callback = args[3];
    }
    const allowedKeys = new Set(['windowsHide', 'timeout', 'encoding']);
    if (!options || Object.keys(options).some(key => !allowedKeys.has(key)) || options.windowsHide !== true
      || options.encoding !== 'utf8' || !Number.isFinite(options.timeout) || options.timeout < 1 || options.timeout > DEADLINE_MS) {
      return typeof callback === 'function'
        ? callbackDenial('options', callback, deny, label + '.execFile')
        : denial('other', 'options', deny, label + '.execFile');
    }
    timeoutMs = Math.min(options.timeout, DEADLINE_MS);
  } else if (method === 'spawn') {
    if (args.length === 3 && Array.isArray(args[1]) && optionsAreRecord(args[2])) {
      vector = args[1]; options = args[2];
    }
    const allowedKeys = new Set(['cwd', 'env', 'shell', 'windowsHide', 'detached', 'stdio']);
    if (!options || Object.keys(options).some(key => !allowedKeys.has(key)) || options.shell !== false
      || options.windowsHide !== true || typeof options.detached !== 'boolean'
      || (options.cwd !== undefined && options.cwd !== policy.scratchRoot)
      || !optionsAreRecord(options.env)
      || options.env.OFFICECLI_NO_AUTO_RESIDENT !== '1' || options.env.OFFICECLI_SKIP_UPDATE !== '1'
      || !Array.isArray(options.stdio) || options.stdio.length !== 3
      || options.stdio[0] !== 'ignore' || options.stdio[1] !== 'pipe' || options.stdio[2] !== 'pipe') {
      return denial('other', 'options', deny, label + '.spawn');
    }
  }
  const operation = exactOperation(method, command, vector);
  if (!operation) {
    if (method === 'execFile' && typeof callback === 'function') {
      return callbackDenial('path-or-args', callback, deny, label + '.execFile');
    }
    return denial('other', 'path-or-args', deny, label + '.' + method);
  }
  const state = reserve(operation, deny, label + '.' + method);
  if (!state || !state.operation) return state;
  const safeOptions = method === 'execFile'
    ? { windowsHide: true, timeout: 0, encoding: 'utf8', maxBuffer: 64 * 1024, shell: false,
      cwd: policy.scratchRoot, env: privateEnvironment() }
    : { shell: false, windowsHide: true, detached: options.detached, stdio: ['ignore', 'pipe', 'pipe'],
      cwd: policy.scratchRoot, env: privateEnvironment() };
  try {
    const child = method === 'execFile'
      ? Reflect.apply(original, target, [policy.binaryPath, vector.slice(), safeOptions, callback])
      : Reflect.apply(original, target, [policy.binaryPath, vector.slice(), safeOptions]);
    return trackChild(child, state, timeoutMs);
  } catch (error) {
    releasePending(state);
    stats.errors += 1;
    emit('error', operation, null, { code: String(error?.code ?? 'ERR_CHILD_PROCESS') });
    throw error;
  }
}

function guardChildProcess(target, label, deny) {
  let byLabel = guardedModules.get(target);
  if (!byLabel) { byLabel = new Map(); guardedModules.set(target, byLabel); }
  if (byLabel.has(label)) return byLabel.get(label);
  const functionCache = new Map();
  const getterCache = new Map();
  function secureValue(key, value) {
    if (key === 'promises' && value && typeof value === 'object') return guardChildProcess(value, label + '.promises', deny);
    if (typeof value !== 'function') return value;
    const cached = functionCache.get(key);
    if (cached && cached.original === value) return cached.wrapper;
    const wrapper = (label === 'child_process' || label === 'node:child_process') && (key === 'execFile' || key === 'spawn')
      ? (...args) => startAllowed(target, String(key), value, args, label, deny)
      : (...args) => denial('other', 'method', deny, label + '.' + String(key));
    functionCache.set(key, { original: value, wrapper });
    return wrapper;
  }
  function safeDescriptor(object, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return descriptor;
    if ('value' in descriptor) {
      const value = secureValue(key, descriptor.value);
      if (value === descriptor.value) return descriptor;
      if (descriptor.configurable || descriptor.writable) return { ...descriptor, value };
      throw new TypeError('Cannot safely wrap fixed child_process export: ' + String(key));
    }
    if (typeof descriptor.get === 'function') {
      if (!descriptor.configurable) throw new TypeError('Cannot safely wrap fixed child_process accessor: ' + String(key));
      const cached = getterCache.get(key);
      const getter = cached && cached.original === descriptor.get ? cached.wrapper : function() {
        return secureValue(key, Reflect.apply(descriptor.get, target, []));
      };
      getterCache.set(key, { original: descriptor.get, wrapper: getter });
      return { ...descriptor, get: getter };
    }
    return descriptor;
  }
  const proxy = new Proxy(target, {
    get(object, key) { return secureValue(key, Reflect.get(object, key, object)); },
    getOwnPropertyDescriptor: safeDescriptor,
  });
  byLabel.set(label, proxy);
  return proxy;
}

function guardBuiltinModule(guard, deny) {
  if (typeof process.getBuiltinModule !== 'function') return;
  const original = process.getBuiltinModule;
  process.getBuiltinModule = function(name, ...args) {
    const result = Reflect.apply(original, this, [name, ...args]);
    if (String(name) === 'child_process' || String(name) === 'node:child_process') {
      return guard(result, String(name), deny);
    }
    return result;
  };
}

function guardProcessKill(deny) {
  if (typeof process.kill !== 'function') return;
  process.kill = function() { return denial('other', 'numeric-pid-signal', deny, 'process.kill'); };
}

function waitForClose(states, milliseconds) {
  if (!states.length) return Promise.resolve(true);
  let timer;
  return Promise.race([
    Promise.all(states.map(state => state.closedPromise)).then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    let states = [...helpers];
    for (const state of states) killOwned(state, 'SIGTERM', 'node-signal');
    let allClosed = await waitForClose(states, SHUTDOWN_MS);
    if (!allClosed) {
      states = [...helpers];
      for (const state of states) killOwned(state, 'SIGKILL', 'node-signal');
      allClosed = await waitForClose(states, KILL_WAIT_MS);
    }
    if (!allClosed || helpers.size) {
      stats.cleanupFailures += 1;
      emit('cleanupUnconfirmed', 'other', null, { reason: 'child-close-unconfirmed' });
    }
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    await new Promise(resolve => { try { process.stderr.write('', resolve); } catch { resolve(); } });
    process.exit(exitCode);
    return snapshot();
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
return { guardChildProcess, guardBuiltinModule, guardProcessKill, shutdown, snapshot };
})()`;
}
