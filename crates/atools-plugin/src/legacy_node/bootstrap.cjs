const Module = require('node:module');
const readline = require('node:readline');
const requireFromPlugin = Module.createRequire(process.env.ATOOLS_PRELOAD_ENTRY);
const protocolWrite = process.stdout.write.bind(process.stdout);
let managedChildrenReady = null;
try {
  const installation = installManagedNodeChildren();
  if (installation !== undefined) {
    if (!installation || typeof installation.then !== 'function') {
      throw new Error('ERR_ATOOLS_MANAGED_CHILD_INITIALIZATION_FAILED: installer did not return readiness');
    }
    managedChildrenReady = Promise.resolve(installation);
    // Keep initialization failures observable through the ordered RPC response
    // path instead of triggering an unhandled rejection before the first request.
    managedChildrenReady.catch(() => {});
  }
} catch (error) {
  managedChildrenReady = Promise.reject(error);
  managedChildrenReady.catch(() => {});
}
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[method] = (...args) => process.stderr.write(util.inspect(args, { depth: 2, maxStringLength: 1024, getters: false }).slice(0, 4096) + '\n');
}
function getProperty(handleId, property) {
  if (typeof property !== 'string' || property.length > 1024 || forbiddenProperties.has(property)) fail('ERR_ATOOLS_NODE_PROPERTY_DENIED');
  const target = record(handleId).value;
  let owner = target;
  for (let depth = 0; owner && depth < 16; depth++, owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (!descriptor) continue;
    const value = 'value' in descriptor ? descriptor.value : descriptor.get ? descriptor.get.call(target) : undefined;
    return encode(value, context(), 0, typeof value === 'function' ? target : undefined);
  }
  return { kind: 'undefined' };
}
function rejectAssignedCallbacks(input, state = context(), depth = 0) {
  budget(state, null, depth);
  if (!input || typeof input !== 'object') fail('ERR_ATOOLS_NODE_INVALID_VALUE');
  if (input.kind === 'callback') fail('ERR_ATOOLS_NODE_SET_CALLBACK_UNSUPPORTED');
  const children = input.kind === 'array' ? input.items
    : ['object', 'fsStats', 'fsDirent'].includes(input.kind) ? Object.values(input.properties || {}) : [];
  if (!Array.isArray(children)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
  for (const child of children) rejectAssignedCallbacks(child, state, depth + 1);
}
function setProperty(handleId, property, encoded) {
  if (typeof property !== 'string' || property.length > 1024 || forbiddenProperties.has(property)) fail('ERR_ATOOLS_NODE_PROPERTY_DENIED');
  const target = record(handleId).value;
  rejectAssignedCallbacks(encoded);
  const value = decode(encoded);
  if (typeof value === 'function') fail('ERR_ATOOLS_NODE_SET_CALLBACK_UNSUPPORTED');
  activeCallDepth++;
  try { return Reflect.set(target, property, value, target); }
  finally { activeCallDepth--; }
}
function pollPromiseState(handleId) {
  const state = promiseStates.get(handleId);
  if (!state) fail('ERR_ATOOLS_NODE_NOT_PROMISE');
  if (state.state !== 'fulfilled') return state;
  try { return { state: 'fulfilled', value: encode(state.value) }; }
  catch (error) {
    const rejected = { state: 'rejected', error: errorData(error) };
    promiseStates.set(handleId, rejected);
    return rejected;
  }
}
function pollPromises(params) {
  const handleIds = params.handleIds;
  if (Object.keys(params).length !== 1 || !Object.prototype.hasOwnProperty.call(params, 'handleIds')
    || !Array.isArray(handleIds) || handleIds.length < 1 || handleIds.length > 32) {
    fail('ERR_ATOOLS_NODE_INVALID_PROMISE_BATCH');
  }

  const seen = new Set();
  for (const id of handleIds) {
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) fail('ERR_ATOOLS_NODE_INVALID_PROMISE_BATCH');
    seen.add(id);
  }
  // Check every identity before reading or encoding any Promise state. An invalid
  // member must not turn an earlier fulfilled Promise into an encoding rejection.
  for (const id of handleIds) {
    record(id);
    if (!promiseStates.has(id)) fail('ERR_ATOOLS_NODE_NOT_PROMISE');
  }

  const states = [];
  const fallback = [];
  const reservedResultBytes = Buffer.byteLength(
    JSON.stringify({ states: [], fallback: handleIds }),
    'utf8',
  );
  let stateContentBytes = 0;
  for (const handleId of handleIds) {
    const state = pollPromiseState(handleId);
    const entryBytes = Buffer.byteLength(JSON.stringify({ handleId, state }), 'utf8');
    const separatorBytes = states.length ? 1 : 0;
    const candidateBytes = reservedResultBytes + stateContentBytes + separatorBytes + entryBytes;
    if (candidateBytes + 4096 <= MAX_BYTES) {
      states.push({ handleId, state });
      stateContentBytes += separatorBytes + entryBytes;
    } else {
      fallback.push(handleId);
    }
  }
  return { states, fallback };
}
function dispatch(method, params) {
  switch (method) {
    case 'initialize': return { protocolVersion: 1, pid: process.pid, nodeVersion: process.versions.node };
    case 'require': {
      const specifier = params.specifier;
      if (typeof specifier !== 'string' || !specifier || specifier.length > 1024) fail('ERR_ATOOLS_NODE_INVALID_MODULE');
      if (['electron', 'node:electron', '@electron/remote'].includes(specifier)) fail('ERR_ATOOLS_HOST_API_UNAVAILABLE: electron');
      return encode(requireFromPlugin(specifier));
    }
    case 'readPngPath': return encode(readBoundedPngPath(params));
    case 'get': return getProperty(params.handleId, params.property);
    case 'set': return setProperty(params.handleId, params.property, params.value);
    case 'callMethod': {
      const property = params.property;
      if (typeof property !== 'string' || property.length > 1024 || forbiddenProperties.has(property)) fail('ERR_ATOOLS_NODE_PROPERTY_DENIED');
      const target = record(params.handleId).value;
      if (!Array.isArray(params.args) || params.args.length > 256) fail('ERR_ATOOLS_NODE_INVALID_CALL');
      let fn;
      let owner = target;
      for (let depth = 0; owner && depth < 16; depth++, owner = Object.getPrototypeOf(owner)) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, property);
        if (!descriptor) continue;
        fn = 'value' in descriptor ? descriptor.value : descriptor.get ? descriptor.get.call(target) : undefined;
        break;
      }
      if (typeof fn !== 'function') fail('ERR_ATOOLS_NODE_INVALID_CALL');
      const state = context();
      const args = params.args.map((arg) => decode(arg, state));
      activeCallDepth++;
      try {
        return encode(Reflect.apply(fn, target, args));
      } finally { activeCallDepth--; }
    }
    case 'call':
    case 'construct': {
      const target = record(params.handleId);
      if (typeof target.value !== 'function' || !Array.isArray(params.args) || params.args.length > 256) fail('ERR_ATOOLS_NODE_INVALID_CALL');
      const state = context();
      const args = params.args.map((arg) => decode(arg, state));
      activeCallDepth++;
      try {
        return encode(method === 'construct' ? Reflect.construct(target.value, args) : Reflect.apply(target.value, target.receiver, args));
      } finally { activeCallDepth--; }
    }
    case 'poll': {
      const result = { events: events.splice(0), overflowed };
      eventBytes = 0; overflowed = false;
      return result;
    }
    case 'pollPromise': {
      record(params.handleId);
      return pollPromiseState(params.handleId);
    }
    case 'pollPromises': return pollPromises(params);
    case 'release': {
      const handleIds = params.handleIds === undefined ? [] : params.handleIds;
      const callbackIds = params.callbackIds === undefined ? [] : params.callbackIds;
      if (!Array.isArray(handleIds) || !Array.isArray(callbackIds) || handleIds.length + callbackIds.length > MAX_NODES
        || handleIds.some((id) => !Number.isSafeInteger(id))
        || callbackIds.some((id) => typeof id !== 'string' || id.length > 256)) fail('ERR_ATOOLS_NODE_INVALID_RELEASE');
      let released = 0;
      for (const id of handleIds) {
        if (handles.delete(id)) released++;
        promiseStates.delete(id);
      }
      let callbacksReleased = 0;
      for (const id of callbackIds) if (callbacks.delete(id)) callbacksReleased++;
      if (callbackIds.length) {
        const releasedIds = new Set(callbackIds);
        const retained = events.filter((event) => !releasedIds.has(event.callbackId));
        events.splice(0, events.length, ...retained);
        eventBytes = retained.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
      }
      return { released, callbacksReleased };
    }
    default: fail('ERR_ATOOLS_NODE_METHOD_NOT_FOUND');
  }
}
function respond(id, result, error) {
  let response = error
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: errorData(error).message } }
    : { jsonrpc: '2.0', id, result };
  let line = JSON.stringify(response);
  if (Buffer.byteLength(line) > MAX_BYTES) {
    line = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'ERR_ATOOLS_NODE_RESPONSE_BUDGET' } });
  }
  protocolWrite(line + '\n');
}
function respondNativeImageSource(id, bytes) {
  const result = {
    kind: 'atools.nativeImageSource.v1',
    encoding: 'base64',
    byteLength: bytes.byteLength,
    base64: nativeImageBytesToBase64(bytes),
  };
  const line = JSON.stringify({ jsonrpc: '2.0', id, result });
  // 4 MiB raw bytes expand to about 5.6 MiB Base64, below the existing 8 MiB
  // stdio line limit. This method does not enlarge generic value responses.
  if (line.length > 8 * 1024 * 1024) {
    respond(id, null, new Error('ERR_ATOOLS_NODE_NATIVE_IMAGE_FRAME_BUDGET'));
    return;
  }
  protocolWrite(line + '\n');
}
function respondInitializationFailure(id, error) {
  const detail = errorData(error).message;
  respond(id, null, new Error(`ERR_ATOOLS_MANAGED_CHILD_INITIALIZATION_FAILED: ${detail}`));
}
function dispatchRequest(request) {
  try {
    if (request.method === 'readNativeImagePath') {
      respondNativeImageSource(request.id, readBoundedNativeImagePath(request.params || {}));
    } else {
      respond(request.id, dispatch(request.method, request.params || {}));
    }
  } catch (error) {
    respond(request.id, null, error);
  }
}
let managedRequestQueue = Promise.resolve();
readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  if (Buffer.byteLength(line) > MAX_BYTES) { process.exit(1); return; }
  let request;
  try { request = JSON.parse(line); }
  catch (_) { process.exit(1); return; }
  if (!Object.prototype.hasOwnProperty.call(request, 'id')) return;
  // The no-managed-child path stays synchronous, preserving existing fixture
  // timing. With managed children configured, serialize requests behind the
  // transport handshake so even early initialize calls cannot race it.
  if (!managedChildrenReady) {
    dispatchRequest(request);
    return;
  }
  managedRequestQueue = managedRequestQueue.then(
    () => managedChildrenReady.then(
      () => dispatchRequest(request),
      (error) => respondInitializationFailure(request.id, error),
    ),
    (error) => respondInitializationFailure(request.id, error),
  );
});
