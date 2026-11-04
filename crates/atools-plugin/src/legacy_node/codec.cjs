'use strict';
const util = require('node:util');
const nativeFs = require('node:fs');
// Capture native value types before any plugin module can alter their prototypes.
// fstat only inspects the already-open stdio pipe; it never scans plugin/user files.
const statsPrototype = nativeFs.Stats.prototype;
const bigIntStatsPrototype = Object.getPrototypeOf(nativeFs.fstatSync(0, { bigint: true }));
const direntConstructor = nativeFs.Dirent;
const direntPrototype = direntConstructor.prototype;
const direntSymbols = Object.getOwnPropertySymbols(new direntConstructor('', 0, ''));
const fsTypePredicates = ['isFile', 'isDirectory', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isCharacterDevice', 'isBlockDevice'];
const direntTypes = fsTypePredicates.map((_, index) => nativeFs.constants[
  ['UV_DIRENT_FILE', 'UV_DIRENT_DIR', 'UV_DIRENT_LINK', 'UV_DIRENT_FIFO', 'UV_DIRENT_SOCKET', 'UV_DIRENT_CHAR', 'UV_DIRENT_BLOCK'][index]
]);
const direntPredicates = fsTypePredicates.map((name) => direntPrototype[name]);
const fsPrototypes = new Map([statsPrototype, bigIntStatsPrototype, Object.getPrototypeOf(statsPrototype), direntPrototype]
  .map((prototype) => [prototype, Object.getOwnPropertyDescriptors(prototype)]));
const statsFields = new Set(['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks',
  ...['atime', 'mtime', 'ctime', 'birthtime'].flatMap((name) => [name, name + 'Ms', name + 'Ns'])]);
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 4096;
const MAX_HANDLES = 8192;
const forbiddenProperties = new Set(['__proto__', 'prototype', 'constructor']);
const handles = new Map();
const identities = new WeakMap();
const boundFunctions = new WeakMap();
const promiseStates = new Map();
const callbacks = new Map();
const events = [];
let eventBytes = 0;
let overflowed = false;
let nextHandle = 1;
let activeCallDepth = 0;

function fail(message) { throw new Error(message); }
function budget(context, value, depth) {
  if (++context.nodes > MAX_NODES || depth > 12) fail('ERR_ATOOLS_NODE_VALUE_BUDGET');
  if (typeof value === 'string') context.bytes += Buffer.byteLength(value);
  if (context.bytes > MAX_BYTES) fail('ERR_ATOOLS_NODE_VALUE_BUDGET');
}
function context() { return { nodes: 0, bytes: 0 }; }
function errorData(error) {
  const result = { message: String(error && error.message || error).slice(0, 4096) };
  const code = error && Object.getOwnPropertyDescriptor(error, 'code');
  if (code && 'value' in code) result.code = String(code.value).slice(0, 256);
  return result;
}
function handle(value, receiver) {
  let cache = identities;
  let key = value;
  if (typeof value === 'function' && receiver && (typeof receiver === 'object' || typeof receiver === 'function')) {
    cache = boundFunctions.get(value);
    if (!cache) { cache = new WeakMap(); boundFunctions.set(value, cache); }
    key = receiver;
  }
  const existing = cache.get(key);
  if (existing && handles.has(existing)) return existing;
  if (handles.size >= MAX_HANDLES) fail('ERR_ATOOLS_NODE_HANDLE_BUDGET');
  const id = nextHandle++;
  handles.set(id, { value, receiver });
  cache.set(key, id);
  return id;
}
function record(id) {
  if (!Number.isSafeInteger(id) || !handles.has(id)) fail('ERR_ATOOLS_NODE_UNKNOWN_HANDLE');
  return handles.get(id);
}
function nativeFsPrototypeUnchanged(prototype) {
  const expected = fsPrototypes.get(prototype);
  if (!expected) return false;
  const current = Object.getOwnPropertyDescriptors(prototype);
  const keys = Reflect.ownKeys(expected);
  return keys.length === Reflect.ownKeys(current).length && keys.every((key) => {
    const a = expected[key], b = current[key];
    return b && ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'].every((field) => a[field] === b[field]);
  });
}
function encodeFsValue(value, state, depth) {
  if (util.types.isProxy(value)) return;
  const prototype = Object.getPrototypeOf(value);
  const stats = prototype === statsPrototype || prototype === bigIntStatsPrototype;
  if (!stats && prototype !== direntPrototype) return;
  if (!nativeFsPrototypeUnchanged(prototype)
    || (stats && !nativeFsPrototypeUnchanged(Object.getPrototypeOf(statsPrototype)))) return;
  const descriptors = Object.getOwnPropertyDescriptors(value), properties = Object.create(null);
  if (Object.getOwnPropertySymbols(value).some((symbol) => stats || !direntSymbols.includes(symbol))) return;
  if (Object.getOwnPropertySymbols(value).some((symbol) => !('value' in descriptors[symbol])
    || typeof descriptors[symbol].value !== 'number')) return;
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = descriptors[name];
    if (!('value' in descriptor) || !(stats ? statsFields.has(name) : ['name', 'parentPath', 'path'].includes(name))) return;
    const item = descriptor.value;
    if (stats && !['number', 'bigint'].includes(typeof item) && !util.types.isDate(item)) return;
    if (!stats && typeof item !== 'string' && !Buffer.isBuffer(item)) return;
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    budget(state, name, depth + 1);
    properties[name] = encode(descriptors[name].value, state, depth + 1);
  }
  if (stats) return { kind: 'fsStats', properties };
  const index = direntPredicates.findIndex((predicate) => Reflect.apply(predicate, value, []));
  return { kind: 'fsDirent', properties, type: index < 0 ? nativeFs.constants.UV_DIRENT_UNKNOWN : direntTypes[index] };
}
function encode(value, state = context(), depth = 0, receiver) {
  budget(state, value, depth);
  if (value === undefined) return { kind: 'undefined' };
  if (value === null || ['boolean', 'string'].includes(typeof value)) return { kind: 'value', value };
  if (typeof value === 'number') return Number.isFinite(value)
    ? { kind: 'value', value } : { kind: 'number', value: String(value) };
  if (typeof value === 'bigint') return { kind: 'bigint', value: String(value) };
  if (typeof value === 'symbol') fail('ERR_ATOOLS_NODE_SYMBOL_UNSUPPORTED');
  if (Buffer.isBuffer(value)) return binary('buffer', value, state);
  if (util.types.isDate(value)) return { kind: 'date', value: value.toISOString() };
  if (util.types.isNativeError(value)) return { kind: 'error', name: String(value.name), ...errorData(value) };
  if (util.types.isAnyArrayBuffer(value)) return binary('typedArray', Buffer.from(value), state, 'ArrayBuffer');
  if (ArrayBuffer.isView(value)) {
    const constructor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'constructor');
    const name = constructor && constructor.value && constructor.value.name;
    return binary('typedArray', Buffer.from(value.buffer, value.byteOffset, value.byteLength), state, name);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_NODES) fail('ERR_ATOOLS_NODE_VALUE_BUDGET');
    return { kind: 'array', items: Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return encode(descriptor && 'value' in descriptor ? descriptor.value : undefined, state, depth + 1);
    }) };
  }
  const fsValue = encodeFsValue(value, state, depth);
  if (fsValue) return fsValue;
  const handleId = handle(value, receiver);
  if (util.types.isPromise(value)) {
    if (!promiseStates.has(handleId)) {
      promiseStates.set(handleId, { state: 'pending' });
      value.then((result) => {
        if (!handles.has(handleId)) return;
        // Keep the real result, not an encoded handle that a UI GC release could
        // invalidate before a later poll of this same Promise.
        promiseStates.set(handleId, { state: 'fulfilled', value: result });
      }, (error) => {
        if (handles.has(handleId)) promiseStates.set(handleId, { state: 'rejected', error: errorData(error) });
      });
    }
    return { kind: 'promise', handleId };
  }
  const keys = Object.getOwnPropertyNames(value).filter((key) => !forbiddenProperties.has(key));
  if (keys.length > MAX_NODES) fail('ERR_ATOOLS_NODE_VALUE_BUDGET');
  for (const key of keys) budget(state, key, depth + 1);
  const callableKeys = keys.filter((key) => {
    if (key === 'open' || key === 'read') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(
      descriptor
      && 'value' in descriptor
      && typeof descriptor.value === 'function'
      && !(descriptor.value.prototype && Object.getOwnPropertyNames(descriptor.value.prototype).length > 1)
    );
  });
  return {
    kind: 'handle',
    handleId,
    callable: typeof value === 'function',
    keys,
    ...(callableKeys.length ? { callableKeys } : {}),
  };
}
function binary(kind, bytes, state, name) {
  if (bytes.byteLength > MAX_BYTES * 0.7) fail('ERR_ATOOLS_NODE_VALUE_BUDGET');
  const data = bytes.toString('base64');
  budget(state, data, 0);
  return { kind, ...(name ? { name } : {}), data };
}
function decode(input, state = context(), depth = 0) {
  budget(state, null, depth);
  if (!input || typeof input !== 'object') fail('ERR_ATOOLS_NODE_INVALID_VALUE');
  switch (input.kind) {
    case 'undefined': return undefined;
    case 'value':
      if (input.value !== null && !['string', 'number', 'boolean'].includes(typeof input.value)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
      budget(state, input.value, depth);
      return input.value;
    case 'number':
      if (!['NaN', 'Infinity', '-Infinity'].includes(input.value)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
      return Number(input.value);
    case 'bigint': return BigInt(input.value);
    case 'buffer': return decodeBinary(input.data, state);
    case 'date': return new Date(input.value);
    case 'error': { const error = new Error(String(input.message || '')); error.name = String(input.name || 'Error'); if (input.code) error.code = input.code; return error; }
    case 'typedArray': {
      const bytes = decodeBinary(input.data, state);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (input.name === 'ArrayBuffer') return buffer;
      if (input.name === 'DataView') return new DataView(buffer);
      const allowed = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
      if (!allowed.includes(input.name)) fail('ERR_ATOOLS_NODE_TYPED_ARRAY_UNSUPPORTED');
      return new globalThis[input.name](buffer);
    }
    case 'array':
      if (!Array.isArray(input.items)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
      return input.items.map((item) => decode(item, state, depth + 1));
    case 'object': {
      if (!input.properties || typeof input.properties !== 'object' || Array.isArray(input.properties)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
      const object = {};
      for (const [key, value] of Object.entries(input.properties)) {
        budget(state, key, depth + 1);
        Object.defineProperty(object, key, { value: decode(value, state, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return object;
    }
    case 'fsStats':
    case 'fsDirent': {
      if (!input.properties || typeof input.properties !== 'object' || Array.isArray(input.properties)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
      const fields = Object.entries(input.properties);
      const object = input.kind === 'fsStats'
        ? Object.create(input.properties.mode && input.properties.mode.kind === 'bigint' ? bigIntStatsPrototype : statsPrototype)
        : new direntConstructor(undefined, input.type, undefined);
      if (input.kind === 'fsDirent' && ![nativeFs.constants.UV_DIRENT_UNKNOWN, ...direntTypes].includes(input.type)) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
      for (const [name, encoded] of fields) {
        budget(state, name, depth + 1);
        if (!(input.kind === 'fsStats' ? statsFields.has(name) : ['name', 'parentPath', 'path'].includes(name))) fail('ERR_ATOOLS_NODE_INVALID_VALUE');
        Object.defineProperty(object, name, { value: decode(encoded, state, depth + 1), writable: true, enumerable: true, configurable: true });
      }
      return object;
    }
    case 'handle': return record(input.handleId).value;
    case 'callback': {
      if (typeof input.id !== 'string' || input.id.length > 256) fail('ERR_ATOOLS_NODE_INVALID_CALLBACK');
      if (!callbacks.has(input.id)) {
        if (callbacks.size >= 256) fail('ERR_ATOOLS_NODE_CALLBACK_BUDGET');
        const callback = (...args) => {
          // A native API may retain the closure after unsubscribe. Explicit
          // release revokes it, including when the same ID is later registered.
          if (callbacks.get(input.id) !== callback) return;
          if (activeCallDepth > 0) fail('ERR_ATOOLS_NODE_SYNC_CALLBACK_UNSUPPORTED');
          try {
            const state = context();
            const event = { callbackId: input.id, args: args.map((arg) => encode(arg, state)) };
            const bytes = Buffer.byteLength(JSON.stringify(event));
            if (events.length >= 256 || eventBytes + bytes > MAX_BYTES * 0.7) { overflowed = true; return; }
            events.push(event); eventBytes += bytes;
          } catch (_) { overflowed = true; }
        };
        callbacks.set(input.id, callback);
      }
      return callbacks.get(input.id);
    }
    default: fail('ERR_ATOOLS_NODE_INVALID_VALUE_KIND');
  }
}
function decodeBinary(data, state) {
  if (typeof data !== 'string' || data.length > MAX_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('ERR_ATOOLS_NODE_INVALID_BINARY');
  budget(state, data, 0);
  return Buffer.from(data, 'base64');
}
