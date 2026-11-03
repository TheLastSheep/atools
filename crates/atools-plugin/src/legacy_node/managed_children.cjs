function installManagedNodeChildren() {
  const names = {
    controlSocket: 'ATOOLS_MANAGED_CHILD_CONTROL_SOCKET',
    eventSocket: 'ATOOLS_MANAGED_CHILD_EVENT_SOCKET',
    token: 'ATOOLS_MANAGED_CHILD_TOKEN',
    legacyControlFd: 'ATOOLS_MANAGED_CHILD_CONTROL_FD',
    legacyEventFd: 'ATOOLS_MANAGED_CHILD_EVENT_FD',
  };
  const values = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, process.env[name]]));
  const configured = Object.values(values).some((value) => value !== undefined);
  for (const name of Object.values(names)) delete process.env[name];
  if (!configured) return undefined;
  if (values.legacyControlFd !== undefined || values.legacyEventFd !== undefined) {
    return Promise.reject(createManagedChildError(
      'ERR_ATOOLS_MANAGED_CHILD_LEGACY_FD_CONFIG', 'inherited managed child fds are no longer supported'));
  }
  return createManagedChildTransport(values.controlSocket, values.eventSocket, values.token)
    .then((transport) => {
      try {
        return createManagedNodeChildAdapter({ childProcessModule: require('node:child_process'),
          processObject: process, transport, nodeVersion: process.versions.node });
      } catch (error) {
        try { transport.close(); } catch (_) {}
        throw error;
      }
    });
}

function createManagedNodeChildAdapter(options) {
  const childProcessModule = options.childProcessModule || require('node:child_process');
  const processObject = options.processObject || process;
  const transport = options.transport;
  const nodeVersion = options.nodeVersion || processObject.versions.node;
  const ChildProcess = childProcessModule.ChildProcess;
  if (typeof ChildProcess !== 'function' || !transport || typeof transport.request !== 'function'
    || typeof transport.onEvent !== 'function') {
    throw createManagedChildError('ERR_ATOOLS_MANAGED_CHILD_INSTALL', 'managed child adapter dependencies are incomplete');
  }

  const prototype = ChildProcess.prototype;
  const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(prototype, 'spawn');
  const originalSpawn = options.nativeSpawn || originalSpawnDescriptor?.value;
  const originalProcessKillDescriptor = Object.getOwnPropertyDescriptor(processObject, '_kill');
  const originalProcessKill = originalProcessKillDescriptor?.value;
  const uv = typeof processObject.binding === 'function' ? processObject.binding('uv') : {};
  if (typeof originalSpawn !== 'function' || typeof originalProcessKill !== 'function') {
    throw createManagedChildError('ERR_ATOOLS_MANAGED_CHILD_INSTALL', 'product Node child process hooks are unavailable');
  }

  const originalSyncDescriptors = new Map();
  const childStates = new Set();
  const statesById = new Map();
  const statesByPid = new Map();
  const maxManagedPidExclusive = 4_194_304;
  let retiredPidBitmap = null;
  let highestRetiredChildId = null;
  const earlyEvents = [];
  const maxEarlyEvents = 32;
  const maxEarlyBytes = 1024 * 1024;
  let earlyBytes = 0;
  let disposed = false;
  const supportedProductNode = nodeVersion === '22.23.3';

  function errorCode(name, fallback) {
    const value = uv[`UV_${name}`];
    return Number.isInteger(value) ? value : fallback;
  }

  function closeEmptyNativeHandle(child) {
    const nativeHandle = child._handle;
    if (nativeHandle && typeof nativeHandle.close === 'function') nativeHandle.close();
    child._handle = null;
  }

  function unsupported(code, message) {
    return createManagedChildError(code, message);
  }

  function nodeSpawnError(error, child) {
    let code = error && typeof error.code === 'string' ? error.code : 'ERR_ATOOLS_MANAGED_CHILD_SPAWN';
    if (code === 'ERR_ATOOLS_CHILD_SPAWN_FAILED' && Number.isInteger(error.errno) && error.errno > 0) {
      try { code = require('node:util').getSystemErrorName(-error.errno); } catch (_) {}
    }
    const normalized = error instanceof Error ? error : createManagedChildError(code, String(error));
    const syscall = child.spawnfile ? `spawn ${child.spawnfile}` : 'spawn';
    normalized.code = code;
    if (Number.isInteger(normalized.errno) && normalized.errno > 0) normalized.errno = -normalized.errno;
    normalized.syscall = syscall;
    if (child.spawnfile) normalized.path = child.spawnfile;
    normalized.spawnargs = Array.isArray(child.spawnargs) ? child.spawnargs.slice(1) : [];
    normalized.message = `${syscall} ${code}`;
    return normalized;
  }

  function isValidChildId(value) {
    return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
      && (value.length < 20 || (value.length === 20 && value <= '18446744073709551615'));
  }

  function compareChildIds(left, right) {
    if (left.length !== right.length) return left.length - right.length;
    return left === right ? 0 : left < right ? -1 : 1;
  }

  function isValidManagedPid(value) {
    return Number.isSafeInteger(value) && value > 0 && value < maxManagedPidExclusive;
  }

  function ensureRetiredPidBitmap() {
    if (!retiredPidBitmap) retiredPidBitmap = new Uint32Array(131_072);
  }

  function rememberRetiredPid(pid) {
    if (!isValidManagedPid(pid)) return;
    ensureRetiredPidBitmap();
    retiredPidBitmap[pid >>> 5] |= 1 << (pid & 31);
  }

  function isRetiredPid(pid) {
    return isValidManagedPid(pid) && retiredPidBitmap !== null
      && (retiredPidBitmap[pid >>> 5] & (1 << (pid & 31))) !== 0;
  }

  function normalizeSupportedStdio(stdio) {
    if (stdio === undefined || stdio === null || stdio === 'pipe') return ['pipe', 'pipe', 'pipe'];
    if (stdio === 'ignore') return ['ignore', 'ignore', 'ignore'];
    if (!Array.isArray(stdio) || stdio.length !== 3 || stdio.some((mode) => mode !== 'pipe' && mode !== 'ignore')) {
      throw unsupported('ERR_ATOOLS_MANAGED_CHILD_UNSUPPORTED_STDIO', 'managed detached children support only pipe/ignore on fd 0, 1, and 2');
    }
    return stdio.slice();
  }

  function validateManagedOptions(options) {
    if (!options || typeof options !== 'object' || options.detached !== true) {
      throw unsupported('ERR_ATOOLS_MANAGED_CHILD_INVALID_OPTIONS', 'managed child interception requires normalized detached:true options');
    }
    if (options.shell || options.uid != null || options.gid != null || options.serialization !== undefined) {
      throw unsupported('ERR_ATOOLS_MANAGED_CHILD_UNSUPPORTED_OPTION', 'managed detached children do not support shell, uid/gid, or IPC serialization options');
    }
    if (typeof options.file !== 'string' || !Array.isArray(options.args) || !Array.isArray(options.envPairs)
      || (options.cwd !== undefined && options.cwd !== null && typeof options.cwd !== 'string')) {
      throw unsupported('ERR_ATOOLS_MANAGED_CHILD_INVALID_OPTIONS', 'managed child options are not in the expected Node 22 normalized shape');
    }
    if (options.args.some((argument) => typeof argument !== 'string')
      || options.envPairs.some((pair) => typeof pair !== 'string')) {
      throw unsupported('ERR_ATOOLS_MANAGED_CHILD_INVALID_OPTIONS', 'managed child args and environment pairs must be strings');
    }
    return normalizeSupportedStdio(options.stdio);
  }

  function routeSignal(state, signal, group) {
    if (!state.childId || state.closeSeen || state.exitSeen) return errorCode('ESRCH', -3);
    if (!Number.isInteger(signal) || (signal | 0) !== signal) return errorCode('EINVAL', -22);
    try {
      const result = transport.request({ op: 'kill', childId: state.childId, signal, group: Boolean(group) });
      if (result && result.accepted === true) return 0;
      const errno = result && Number.isInteger(result.errno) && result.errno > 0 ? result.errno : 3;
      return -errno;
    } catch (error) {
      return Number.isInteger(error && error.errno) && error.errno > 0 ? -error.errno : errorCode('EIO', -5);
    }
  }

  function setReferenced(state, referenced) {
    if (state.closeSeen || state.refed === referenced) return;
    state.refed = referenced;
    if (referenced) transport.ref?.();
    else transport.unref?.();
  }

  function createState(child, stdioModes, options) {
    const state = { child, childId: null, pid: null, spawnfile: options.file, spawnargs: options.args,
      stdioModes, streams: null, refed: false, exitSeen: false, remoteCloseSeen: false, closeSeen: false,
      spawnFailed: false, spawnErrorEmitted: false, closeEmitted: false, exitCode: null, signalCode: null, remoteCloseCode: null,
      remoteCloseSignal: null, protocolError: null, protocolErrorEmitted: false, handle: null,
      fail(error) {
        if (this.protocolError || this.closeSeen) return;
        this.protocolError = error instanceof Error ? error : new Error(String(error));
        if (this.streams) this.streams.fail(this.protocolError);
        processObject.nextTick(() => {
          this.protocolErrorEmitted = true;
          child.emit('error', this.protocolError);
          this.checkClose();
        });
        if (this.childId && !this.exitSeen) routeSignal(this, errorCode('SIGKILL', 9), true);
      },
      checkClose() {
        if (this.closeEmitted || !this.streams) return;
        if (this.spawnFailed) {
          if (!this.spawnErrorEmitted || !this.streams.allOutputsLocallyClosed()) return;
          if (this.childId && !this.remoteCloseSeen) return;
          this.finishClose(child.exitCode, child.signalCode);
          return;
        }
        if (this.protocolError && !this.protocolErrorEmitted) return;
        if (!(this.protocolError ? this.streams.allOutputsLocallyClosed() : this.streams.allOutputsClosed())) return;
        if (!this.exitSeen || !this.remoteCloseSeen) return;
        if (this.exitCode !== this.remoteCloseCode || this.signalCode !== this.remoteCloseSignal) {
          this.fail(unsupported('ERR_ATOOLS_MANAGED_CHILD_TERMINAL_MISMATCH', 'managed child exit and close events disagree'));
          return;
        }
        this.finishClose(this.exitCode, this.signalCode);
      },
      finishClose(code, signal) {
        if (this.closeEmitted) return;
        setReferenced(this, false);
        this.closeEmitted = true;
        this.closeSeen = true;
        if (this.streams) this.streams.closeStdinAfterExit();
        if (this.handle) this.handle.close();
        if (child._handle === this.handle) child._handle = null;
        if (this.childId) statesById.delete(this.childId);
        if (this.childId && (!highestRetiredChildId || compareChildIds(this.childId, highestRetiredChildId) > 0)) {
          highestRetiredChildId = this.childId;
        }
        if (Number.isInteger(this.pid)) {
          statesByPid.delete(this.pid);
          rememberRetiredPid(this.pid);
        }
        childStates.delete(this);
        child.emit('close', code, signal);
      },
      handleEvent(event) {
        if (this.closeSeen) return;
        try {
          if (event.event === 'data' || event.event === 'end' || event.event === 'writeAck') {
            this.streams.handleEvent(event);
          } else if (event.event === 'streamError') {
            if (!['stdout', 'stderr'].includes(event.stream) || !event.error
              || typeof event.error.code !== 'string' || typeof event.error.message !== 'string') {
              throw unsupported('ERR_ATOOLS_MANAGED_STREAM_ERROR', 'managed child stream error is invalid');
            }
            this.fail(createManagedChildError(event.error.code, event.error.message, event.error.errno));
          } else if (event.event === 'exit') {
            if (this.exitSeen || !((Number.isInteger(event.code) || event.code === null)
              && (typeof event.signal === 'string' || event.signal === null))) {
              throw unsupported('ERR_ATOOLS_MANAGED_CHILD_EXIT', 'managed child exit event is invalid or duplicated');
            }
            this.exitSeen = true;
            this.exitCode = event.signal === null ? event.code : null;
            this.signalCode = event.signal;
            if (!this.spawnFailed) {
              child.exitCode = this.exitCode;
              child.signalCode = this.signalCode;
            }
            this.streams.closeStdinAfterExit();
            if (!this.spawnFailed) child.emit('exit', this.exitCode, this.signalCode);
            this.streams.flushUnusedOutputs();
            this.checkClose();
          } else if (event.event === 'close') {
            if (this.remoteCloseSeen || !((Number.isInteger(event.code) || event.code === null)
              && (typeof event.signal === 'string' || event.signal === null))) {
              throw unsupported('ERR_ATOOLS_MANAGED_CHILD_CLOSE', 'managed child close event is invalid or duplicated');
            }
            this.remoteCloseSeen = true;
            this.remoteCloseCode = event.signal === null ? event.code : null;
            this.remoteCloseSignal = event.signal;
            this.checkClose();
          } else {
            throw unsupported('ERR_ATOOLS_MANAGED_CHILD_EVENT', `unknown managed child event ${event.event}`);
          }
        } catch (error) { this.fail(error); }
      },
    };
    state.handle = {
      kill(signal) { return routeSignal(state, signal, false); },
      ref() { setReferenced(state, true); },
      unref() { setReferenced(state, false); },
      close() { setReferenced(state, false); },
    };
    state.streams = createManagedChildStreams(child, state, transport, stdioModes);
    child.spawnfile = options.file;
    child.spawnargs = options.args;
    child.stdin = state.streams.stdin;
    child.stdout = state.streams.stdout;
    child.stderr = state.streams.stderr;
    child.stdio = state.streams.stdio;
    child._handle = state.handle;
    childStates.add(state);
    return state;
  }

  function dispatchEvent(event) {
    if (!event || typeof event !== 'object' || !isValidChildId(event.childId)) {
      throw unsupported('ERR_ATOOLS_MANAGED_CHILD_EVENT', 'managed child event is missing its opaque child id');
    }
    const state = statesById.get(event.childId);
    if (state) { state.handleEvent(event); return; }
    if (highestRetiredChildId && compareChildIds(event.childId, highestRetiredChildId) <= 0) throw unsupported(
      'ERR_ATOOLS_MANAGED_CHILD_LATE_EVENT', 'managed child event arrived after that child had closed');
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (earlyEvents.length >= maxEarlyEvents || earlyBytes + size > maxEarlyBytes) {
      throw unsupported('ERR_ATOOLS_MANAGED_EARLY_EVENT_BUDGET', 'managed child events arrived before registration beyond the buffer budget');
    }
    earlyEvents.push(event);
    earlyBytes += size;
  }

  function dispatchBufferedEvents(state) {
    const retained = [];
    const ready = [];
    for (const event of earlyEvents) {
      if (event.childId === state.childId) ready.push(event);
      else retained.push(event);
    }
    earlyEvents.splice(0, earlyEvents.length, ...retained);
    earlyBytes = retained.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
    if (ready.length) processObject.nextTick(() => {
      for (const event of ready) state.handleEvent(event);
    });
  }

  function onTransportEvent(event) {
    if (event && event.event === 'transportError') {
      for (const state of childStates) state.fail(event.error || unsupported(
        'ERR_ATOOLS_MANAGED_EVENT_CHANNEL', 'managed child event channel failed'));
      return;
    }
    try { dispatchEvent(event); }
    catch (error) { for (const state of childStates) state.fail(error); }
  }

  function managedSpawn(options) {
    if (!options || options.detached !== true) return originalSpawn.call(this, options);
    try {
      closeEmptyNativeHandle(this);
      if (!supportedProductNode) throw unsupported('ERR_ATOOLS_MANAGED_CHILD_NODE_VERSION',
        'managed detached children require the pinned product Node 22.23.3 runtime');
      const stdioModes = validateManagedOptions(options);
      const state = createState(this, stdioModes, options);
      let result;
      try {
        result = transport.request({ op: 'spawn', file: options.file, args: options.args,
          envPairs: options.envPairs, ...(options.cwd == null ? {} : { cwd: options.cwd }), stdio: stdioModes });
      } catch (error) {
        state.spawnFailed = true;
        const spawnError = nodeSpawnError(error, this);
        if (Number.isInteger(spawnError.errno)) this.exitCode = state.exitCode = spawnError.errno;
        state.streams.destroy();
        processObject.nextTick(() => {
          this.emit('error', spawnError);
          state.spawnErrorEmitted = true;
          state.checkClose();
        });
        return undefined;
      }
      if (!result || !isValidChildId(result.childId) || !isValidManagedPid(result.pid)) {
        state.spawnFailed = true;
        if (result && isValidChildId(result.childId)) {
          state.childId = result.childId;
          statesById.set(state.childId, state);
          try { transport.request({ op: 'kill', childId: result.childId, signal: errorCode('SIGKILL', 9), group: true }); }
          catch (_) {}
        }
        const error = nodeSpawnError(unsupported('ERR_ATOOLS_MANAGED_CHILD_SPAWN_RECEIPT',
          'managed child owner returned no valid positive pid receipt'), this);
        if (Number.isInteger(error.errno)) this.exitCode = state.exitCode = error.errno;
        state.streams.destroy();
        processObject.nextTick(() => {
          this.emit('error', error);
          state.spawnErrorEmitted = true;
          state.checkClose();
        });
        if (state.childId) dispatchBufferedEvents(state);
        return undefined;
      }
      state.childId = result.childId;
      state.pid = result.pid;
      ensureRetiredPidBitmap();
      this.pid = result.pid;
      statesById.set(state.childId, state);
      statesByPid.set(state.pid, state);
      setReferenced(state, true);
      processObject.nextTick(() => this.emit('spawn'));
      dispatchBufferedEvents(state);
      try { state.streams.primeCredits(); }
      catch (error) { state.fail(error); }
      return undefined;
    } catch (error) {
      if (this._handle) closeEmptyNativeHandle(this);
      throw error;
    }
  }

  function managedProcessKill(pid, signal) {
    if (typeof pid !== 'number' || (pid | 0) !== pid) return originalProcessKill.call(processObject, pid, signal);
    const trackedPid = pid < 0 ? -pid : pid;
    const state = statesByPid.get(trackedPid);
    if (state) return routeSignal(state, signal, pid < 0);
    if (isRetiredPid(trackedPid)) return errorCode('ESRCH', -3);
    return originalProcessKill.call(processObject, pid, signal);
  }

  function readSyncOptions(api, args) {
    if (api === 'execSync') return args[1];
    if (Array.isArray(args[1]) || args[1] == null) return args[2];
    if (typeof args[1] === 'object') return args[1];
    return args[2];
  }

  function rejectSynchronousDetached(api, args) {
    const syncOptions = readSyncOptions(api, args);
    if (!syncOptions || typeof syncOptions !== 'object') return;
    const descriptor = Object.getOwnPropertyDescriptor(syncOptions, 'detached');
    if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw unsupported('ERR_ATOOLS_MANAGED_SYNC_DETACHED_UNSUPPORTED', 'synchronous child APIs do not support accessor-based detached options');
    }
    if (descriptor && descriptor.value === true) throw unsupported(
      'ERR_ATOOLS_MANAGED_SYNC_DETACHED_UNSUPPORTED', `synchronous ${api} detached children are not managed`);
  }

  function installSyncGuard(api) {
    const descriptor = Object.getOwnPropertyDescriptor(childProcessModule, api);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    originalSyncDescriptors.set(api, descriptor);
    const original = descriptor.value;
    Object.defineProperty(childProcessModule, api, { ...descriptor, value: function(...args) {
      rejectSynchronousDetached(api, args);
      return original.apply(this, args);
    } });
  }

  const unsubscribe = transport.onEvent(onTransportEvent);
  Object.defineProperty(prototype, 'spawn', { ...originalSpawnDescriptor, value: managedSpawn });
  Object.defineProperty(processObject, '_kill', { ...originalProcessKillDescriptor, value: managedProcessKill });
  for (const api of ['spawnSync', 'execSync', 'execFileSync']) installSyncGuard(api);

  return {
    installed: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      if (prototype.spawn === managedSpawn) Object.defineProperty(prototype, 'spawn', originalSpawnDescriptor);
      if (processObject._kill === managedProcessKill) Object.defineProperty(processObject, '_kill', originalProcessKillDescriptor);
      for (const [api, descriptor] of originalSyncDescriptors) {
        const current = childProcessModule[api];
        if (current && current !== descriptor.value) Object.defineProperty(childProcessModule, api, descriptor);
      }
      for (const state of childStates) state.streams.destroy();
      transport.close?.();
    },
  };
}
