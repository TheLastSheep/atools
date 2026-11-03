'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');

const legacyNodeDirectory = path.resolve(__dirname, '../../src/legacy_node');

function loadManagedChildFactories(dependencies = {}) {
  const sources = ['managed_child_transport.cjs', 'managed_child_streams.cjs', 'managed_children.cjs']
    .map((name) => fs.readFileSync(path.join(legacyNodeDirectory, name), 'utf8'));
  const fixtureModule = new Module(__filename, module);
  fixtureModule.filename = __filename;
  fixtureModule.paths = Module._nodeModulePaths(__dirname);
  const originalRequire = fixtureModule.require.bind(fixtureModule);
  fixtureModule.require = (id) => id === 'node:fs' && dependencies.fs ? dependencies.fs
    : id === 'node:net' && dependencies.net ? dependencies.net : originalRequire(id);
  fixtureModule._compile(`${sources.join('\n')}\nmodule.exports = {
    installManagedNodeChildren,
    createManagedNodeChildAdapter,
    createManagedChildTransport,
    createManagedChildTransportFromSockets,
  };`, __filename);
  return fixtureModule.exports;
}

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function makeHandshakeDependencies() {
  const state = { outgoing: Buffer.alloc(0), incoming: Buffer.alloc(0), writes: [], sockets: [], greetings: [], controlRequests: [] };
  const responses = [
    { id: 1, ok: false, error: { code: 'EAGAIN', message: 'fixture writer full', errno: 11 } },
    { id: 2, ok: true, result: { accepted: true } },
  ];
  const fakeFs = {
    writeSync(fd, buffer, offset, length) {
      state.writes.push({ fd, length });
      const count = Math.min(length, 5);
      state.outgoing = Buffer.concat([state.outgoing, buffer.subarray(offset, offset + count)]);
      while (state.outgoing.length >= 4) {
        const frameSize = state.outgoing.readUInt32BE(0) + 4;
        if (state.outgoing.length < frameSize) break;
        const frame = state.outgoing.subarray(4, frameSize);
        const request = JSON.parse(frame.toString('utf8'));
        state.controlRequests.push(request);
        const response = responses.shift();
        if (response.id !== request.id) throw new Error('fixture response id mismatch');
        state.incoming = Buffer.concat([state.incoming, encodeFrame(response)]);
        state.outgoing = state.outgoing.subarray(frameSize);
      }
      return count;
    },
    readSync(fd, buffer, offset, length) {
      if (!state.incoming.length) throw Object.assign(new Error('fixture read would block'), { code: 'EAGAIN' });
      const count = Math.min(length, 3, state.incoming.length);
      state.incoming.copy(buffer, offset, 0, count);
      state.incoming = state.incoming.subarray(count);
      return count;
    },
  };
  class FakeSocket extends EventEmitter {
    constructor(socketPath) {
      super();
      this.path = socketPath;
      this.pauses = 0;
      this.references = 0;
      this._handle = { fd: socketPath.endsWith('control.sock') ? 51 : 52,
        setBlocking: (value) => { this._handle.blocking = value; } };
      state.sockets.push(this);
      setImmediate(() => this.emit('connect'));
    }
    pause() { this.pauses++; return this; }
    write(frame, callback) {
      const parsed = JSON.parse(frame.toString('utf8', 4));
      state.greetings.push({ path: this.path, frame: parsed });
      if (state.greetings.length === 2) {
        state.incoming = encodeFrame({ schemaVersion: 1, ready: true });
      }
      setImmediate(() => callback());
      return true;
    }
    ref() { this.references++; }
    unref() { this.references = Math.max(0, this.references - 1); }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const fakeNet = { createConnection({ path: socketPath }) { return new FakeSocket(socketPath); } };
  return { state, fs: fakeFs, net: fakeNet };
}

class FakeManagedTransport extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.nextPid = 42101;
    this.nextChildId = 1;
    this.refCount = 0;
    this.spawnError = null;
    this.spawnResult = null;
    this.spawnEvents = [];
  }

  request(message) {
    this.requests.push(message);
    if (message.op === 'spawn') {
      if (this.spawnError) throw this.spawnError;
      const result = this.spawnResult || { childId: String(this.nextChildId++), pid: this.nextPid++ };
      for (const event of this.spawnEvents) this.emit('managed-event', { ...event, childId: result.childId });
      return result;
    }
    if (message.op === 'kill') return { accepted: true };
    if (message.op === 'credit') return { accepted: true };
    if (message.op === 'write' || message.op === 'end') return { accepted: true };
    throw Object.assign(new Error(`unexpected operation ${message.op}`), { code: 'ERR_TEST_UNEXPECTED_OPERATION' });
  }

  onEvent(listener) {
    this.on('managed-event', listener);
    return () => this.off('managed-event', listener);
  }

  emitEvent(event) {
    setImmediate(() => this.emit('managed-event', event));
  }

  ref() { this.refCount++; }
  unref() { this.refCount = Math.max(0, this.refCount - 1); }
  close() {}
}

function makeAdapter(t, overrides = {}) {
  const { createManagedNodeChildAdapter } = loadManagedChildFactories();
  const transport = overrides.transport || new FakeManagedTransport();
  const adapter = createManagedNodeChildAdapter({
    childProcessModule: childProcess,
    processObject: process,
    transport,
    nodeVersion: process.versions.node,
    ...overrides,
  });
  t.after(() => adapter.dispose());
  return { adapter, transport };
}

test('missing socket environment leaves the browser fixture on the native Node path', async () => {
  const { installManagedNodeChildren } = loadManagedChildFactories();
  const names = ['ATOOLS_MANAGED_CHILD_CONTROL_SOCKET', 'ATOOLS_MANAGED_CHILD_EVENT_SOCKET',
    'ATOOLS_MANAGED_CHILD_TOKEN', 'ATOOLS_MANAGED_CHILD_CONTROL_FD', 'ATOOLS_MANAGED_CHILD_EVENT_FD'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  for (const name of names) delete process.env[name];
  try {
    const result = installManagedNodeChildren();
    assert.equal(result, undefined);
    assert.equal(childProcess.ChildProcess.prototype.spawn, originalSpawn);
    process.env.ATOOLS_MANAGED_CHILD_CONTROL_SOCKET = '/private/tmp/control.sock';
    const incomplete = installManagedNodeChildren();
    assert.ok(incomplete instanceof Promise);
    for (const name of names) assert.equal(process.env[name], undefined);
    await assert.rejects(incomplete, { code: 'ERR_ATOOLS_MANAGED_SOCKET_CONFIG' });
    assert.equal(childProcess.ChildProcess.prototype.spawn, originalSpawn);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('socket handshake gates sync control framing and keeps event frames asynchronous', async (t) => {
  const dependencies = makeHandshakeDependencies();
  const { installManagedNodeChildren } = loadManagedChildFactories(dependencies);
  const names = ['ATOOLS_MANAGED_CHILD_CONTROL_SOCKET', 'ATOOLS_MANAGED_CHILD_EVENT_SOCKET',
    'ATOOLS_MANAGED_CHILD_TOKEN', 'ATOOLS_MANAGED_CHILD_CONTROL_FD', 'ATOOLS_MANAGED_CHILD_EVENT_FD'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  process.env.ATOOLS_MANAGED_CHILD_CONTROL_SOCKET = '/private/tmp/fixture/control.sock';
  process.env.ATOOLS_MANAGED_CHILD_EVENT_SOCKET = '/private/tmp/fixture/events.sock';
  process.env.ATOOLS_MANAGED_CHILD_TOKEN = 'fixture-token-012345678901234567890123456789';
  let adapter;
  try {
    const ready = installManagedNodeChildren();
    assert.ok(ready instanceof Promise);
    for (const name of names) assert.equal(process.env[name], undefined);
    assert.equal(childProcess.ChildProcess.prototype.spawn, originalSpawn);
    adapter = await ready;
    t.after(() => adapter?.dispose());
    assert.ok(adapter.installed);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const { state } = dependencies;
  const controlSocket = state.sockets.find((socket) => socket.path.endsWith('control.sock'));
  const eventSocket = state.sockets.find((socket) => socket.path.endsWith('events.sock'));
  assert.deepEqual(state.greetings.map((entry) => entry.frame).sort((a, b) => a.role.localeCompare(b.role)), [
    { schemaVersion: 1, role: 'control', token: 'fixture-token-012345678901234567890123456789' },
    { schemaVersion: 1, role: 'events', token: 'fixture-token-012345678901234567890123456789' },
  ]);
  assert.equal(controlSocket.pauses > 0, true);
  assert.equal(controlSocket._handle.blocking, true);
  assert.equal(controlSocket.listenerCount('data'), 0);
  assert.equal(eventSocket.listenerCount('data'), 1);
  assert.equal(state.writes.length, 0);
  adapter.dispose();
});

test('control and event channels use bounded framed JSON without making remote errors terminal', async () => {
  const dependencies = makeHandshakeDependencies();
  const { createManagedChildTransport } = loadManagedChildFactories(dependencies);
  const state = dependencies.state;
  const transport = await createManagedChildTransport('/private/tmp/fixture/control.sock',
    '/private/tmp/fixture/events.sock', 'fixture-token-012345678901234567890123456789');
  const observed = [];
  transport.onEvent((event) => observed.push(event));
  assert.throws(() => transport.request({ op: 'write', childId: 'opaque', writeId: 1, data: 'YQ==' }),
    { code: 'EAGAIN', errno: 11 });
  assert.deepEqual(transport.request({ op: 'credit', childId: 'opaque', stream: 'stdout', count: 1 }), { accepted: true });
  const eventFrame = encodeFrame({ childId: 'opaque', event: 'exit', code: 0, signal: null });
  const eventSocket = state.sockets.find((socket) => socket.path.endsWith('events.sock'));
  eventSocket.emit('data', eventFrame.subarray(0, 7));
  eventSocket.emit('data', eventFrame.subarray(7));
  assert.deepEqual(observed, [{ childId: 'opaque', event: 'exit', code: 0, signal: null }]);
  assert.ok(state.writes.every((write) => write.fd === 51));
  assert.deepEqual(state.controlRequests, [
    { op: 'write', childId: 'opaque', writeId: 1, data: 'YQ==', id: 1 },
    { op: 'credit', childId: 'opaque', stream: 'stdout', count: 1, id: 2 },
  ]);
  transport.close();
  assert.equal(eventSocket.destroyed, true);
  assert.equal(state.sockets.find((socket) => socket.path.endsWith('control.sock')).destroyed, true);
});

test('managed spawn preserves Node ChildProcess, stdio, stream, and terminal event contracts', async (t) => {
  const { transport } = makeAdapter(t);
  const child = childProcess.spawn('/fixture/tool', ['--mode', 'fixture'], {
    detached: true,
    cwd: '/fixture/work',
    env: { FIXTURE_ONLY: 'yes' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(child instanceof childProcess.ChildProcess);
  assert.equal(child.pid, 42101);
  assert.equal(child.spawnfile, '/fixture/tool');
  assert.deepEqual(child.spawnargs, ['/fixture/tool', '--mode', 'fixture']);
  assert.equal(child.stdin, null);
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  assert.deepEqual(child.stdio, [null, child.stdout, child.stderr]);
  assert.deepEqual(transport.requests.filter((request) => request.op === 'spawn')[0], {
    op: 'spawn', file: '/fixture/tool', args: ['/fixture/tool', '--mode', 'fixture'],
    envPairs: ['FIXTURE_ONLY=yes'], cwd: '/fixture/work', stdio: ['ignore', 'pipe', 'pipe'],
  });

  const sequence = [];
  const stdout = [];
  const stderr = [];
  child.on('spawn', () => sequence.push('spawn'));
  child.stdout.on('data', (chunk) => { sequence.push('stdout'); stdout.push(chunk); });
  child.stderr.on('data', (chunk) => { sequence.push('stderr'); stderr.push(chunk); });
  child.on('exit', (code, signal) => { sequence.push(`exit:${code}:${signal}`); });
  const closed = once(child, 'close').then(([code, signal]) => { sequence.push(`close:${code}:${signal}`); });
  transport.emitEvent({ childId: '1', event: 'data', stream: 'stdout', data: Buffer.from('out').toString('base64') });
  transport.emitEvent({ childId: '1', event: 'data', stream: 'stderr', data: Buffer.from('err').toString('base64') });
  transport.emitEvent({ childId: '1', event: 'end', stream: 'stdout' });
  transport.emitEvent({ childId: '1', event: 'end', stream: 'stderr' });
  transport.emitEvent({ childId: '1', event: 'exit', code: 0, signal: null });
  transport.emitEvent({ childId: '1', event: 'close', code: 0, signal: null });
  await closed;
  assert.equal(Buffer.concat(stdout).toString(), 'out');
  assert.equal(Buffer.concat(stderr).toString(), 'err');
  assert.deepEqual(sequence, ['spawn', 'stdout', 'stderr', 'exit:0:null', 'close:0:null']);
  assert.ok(transport.requests.some((request) => request.op === 'credit' && request.stream === 'stdout'));
  assert.ok(transport.requests.some((request) => request.op === 'credit' && request.stream === 'stderr'));
});

test('stdout credits pause at the readable high-water mark and resume after consumption', async (t) => {
  const { transport } = makeAdapter(t);
  const child = childProcess.spawn('/fixture/backpressure', [], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => {});
  const countStdoutCredits = () => transport.requests.filter((request) => request.op === 'credit'
    && request.childId === '1' && request.stream === 'stdout').length;
  assert.equal(countStdoutCredits(), 1);
  const chunk = Buffer.alloc(16 * 1024, 0x61).toString('base64');
  transport.emitEvent({ childId: '1', event: 'data', stream: 'stdout', data: chunk });
  transport.emitEvent({ childId: '1', event: 'data', stream: 'stdout', data: chunk });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(countStdoutCredits(), 1);
  child.stdout.resume();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(countStdoutCredits(), 2);
  const closed = new Promise((resolve) => child.once('close', resolve));
  transport.emitEvent({ childId: '1', event: 'end', stream: 'stdout' });
  transport.emitEvent({ childId: '1', event: 'exit', code: 0, signal: null });
  transport.emitEvent({ childId: '1', event: 'close', code: 0, signal: null });
  await closed;
});

test('managed stdin waits for write acknowledgements and child kill/ref reach only the opaque owner', async (t) => {
  const { transport } = makeAdapter(t);
  const child = childProcess.spawn('/fixture/tool', [], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  const writeComplete = new Promise((resolve, reject) => {
    child.stdin.write(Buffer.from('input'), (error) => error ? reject(error) : resolve());
  });
  const writeRequest = transport.requests.find((request) => request.op === 'write');
  assert.ok(writeRequest);
  assert.equal(Buffer.from(writeRequest.data, 'base64').toString(), 'input');
  transport.emitEvent({ childId: '1', event: 'writeAck', writeId: writeRequest.writeId });
  await writeComplete;
  assert.equal(child.kill('SIGTERM'), true);
  assert.equal(child.killed, true);
  assert.equal(process.kill(-child.pid, 'SIGTERM'), true);
  assert.ok(transport.requests.some((request) => request.op === 'kill'
    && request.childId === '1' && request.signal === 15 && request.group === false));
  assert.ok(transport.requests.some((request) => request.op === 'kill'
    && request.childId === '1' && request.signal === 15 && request.group === true));
  child.unref();
  child.ref();
  assert.ok(transport.refCount >= 1);
  const endComplete = once(child.stdin, 'finish');
  child.stdin.end();
  const endRequest = transport.requests.find((request) => request.op === 'end');
  assert.ok(endRequest);
  transport.emitEvent({ childId: '1', event: 'writeAck', writeId: endRequest.writeId });
  await endComplete;
  const closed = once(child, 'close');
  transport.emitEvent({ childId: '1', event: 'exit', code: 0, signal: null });
  transport.emitEvent({ childId: '1', event: 'close', code: 0, signal: null });
  await closed;
  assert.equal(transport.refCount, 0, 'closed child must release its transport reference');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('retired managed PIDs use an exact bounded bitmap without raw kill fallback', async (t) => {
  const nativeKillCalls = [];
  const fakeProcess = {
    versions: process.versions,
    binding: process.binding.bind(process),
    nextTick: process.nextTick.bind(process),
    _kill(pid, signal) { nativeKillCalls.push({ pid, signal }); return process.binding('uv').UV_ESRCH; },
  };
  const transport = new FakeManagedTransport();
  transport.nextPid = 4_194_303;
  transport.spawnEvents = [
    { event: 'exit', code: 0, signal: null },
    { event: 'close', code: 0, signal: null },
  ];
  const { createManagedNodeChildAdapter } = loadManagedChildFactories();
  const adapter = createManagedNodeChildAdapter({ childProcessModule: childProcess,
    processObject: fakeProcess, transport, nodeVersion: process.versions.node });
  t.after(() => adapter.dispose());
  const child = childProcess.spawn('/fixture/pid-boundary', [], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  assert.equal(child.pid, 4_194_303);
  assert.equal(fakeProcess._kill(child.pid, 15), 0);
  await new Promise((resolve) => child.once('close', resolve));
  assert.equal(fakeProcess._kill(4_194_303, 0), process.binding('uv').UV_ESRCH);
  assert.deepEqual(nativeKillCalls, []);
  assert.equal(fakeProcess._kill(123_456, 0), process.binding('uv').UV_ESRCH);
  assert.deepEqual(nativeKillCalls, [{ pid: 123_456, signal: 0 }]);

  const outOfRange = childProcess.spawn('/fixture/pid-out-of-range', [], { detached: true, stdio: 'ignore' });
  const spawnError = new Promise((resolve) => outOfRange.once('error', resolve));
  const close = new Promise((resolve) => outOfRange.once('close', (...args) => resolve(args)));
  const error = await spawnError;
  const closeArgs = await close;
  assert.equal(error.code, 'ERR_ATOOLS_MANAGED_CHILD_SPAWN_RECEIPT');
  assert.equal(outOfRange.pid, undefined);
  assert.deepEqual(closeArgs, [null, null]);
  assert.ok(transport.requests.some((request) => request.op === 'kill' && request.childId === '2'));
  assert.deepEqual(nativeKillCalls, [{ pid: 123_456, signal: 0 }]);
});

test('remote spawn errors keep pid/spawn events absent and close after error', async (t) => {
  const transport = new FakeManagedTransport();
  transport.spawnError = Object.assign(new Error('fixture executable missing'), { code: 'ERR_ATOOLS_CHILD_SPAWN_FAILED', errno: 2 });
  makeAdapter(t, { transport });
  const child = childProcess.spawn('/fixture/missing', [], { detached: true });
  const sequence = [];
  child.on('spawn', () => sequence.push('spawn'));
  child.on('error', (error) => {
    sequence.push('error');
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.errno, -2);
    assert.equal(error.syscall, 'spawn /fixture/missing');
    assert.equal(error.path, '/fixture/missing');
    assert.deepEqual(error.spawnargs, []);
  });
  const closed = new Promise((resolve) => child.once('close', (...args) => {
    sequence.push(`close:${args[0]}:${args[1]}`);
    resolve();
  }));
  await closed;
  assert.equal(child.pid, undefined);
  assert.equal(child.exitCode, -2);
  assert.deepEqual(sequence, ['error', 'close:-2:null']);
});

test('invalid owner spawn receipts never invent a PID or emit spawn', async (t) => {
  const transport = new FakeManagedTransport();
  transport.spawnResult = { childId: '1', pid: 0 };
  transport.spawnEvents = [
    { event: 'exit', code: 0, signal: null },
    { event: 'close', code: 0, signal: null },
  ];
  makeAdapter(t, { transport });
  const child = childProcess.spawn('/fixture/invalid-receipt', [], { detached: true, stdio: 'ignore' });
  let spawnEmitted = false;
  child.on('spawn', () => { spawnEmitted = true; });
  const childError = new Promise((resolve) => child.once('error', resolve));
  const close = new Promise((resolve) => child.once('close', (...args) => resolve(args)));
  const error = await childError;
  const closeArgs = await close;
  assert.equal(error.code, 'ERR_ATOOLS_MANAGED_CHILD_SPAWN_RECEIPT');
  assert.equal(child.pid, undefined);
  assert.equal(spawnEmitted, false);
  assert.deepEqual(closeArgs, [null, null]);
  assert.ok(transport.requests.some((request) => request.op === 'kill' && request.childId === '1'));
});

test('synchronous terminal events buffered during spawn are delivered after spawn', async (t) => {
  const transport = new FakeManagedTransport();
  transport.spawnEvents = [
    { event: 'end', stream: 'stdout' },
    { event: 'end', stream: 'stderr' },
    { event: 'exit', code: 0, signal: null },
    { event: 'close', code: 0, signal: null },
  ];
  makeAdapter(t, { transport });
  const child = childProcess.spawn('/fixture/instant', [], { detached: true });
  const sequence = [];
  child.on('spawn', () => sequence.push('spawn'));
  child.on('exit', () => sequence.push('exit'));
  const closed = once(child, 'close').then(() => sequence.push('close'));
  await closed;
  assert.deepEqual(sequence, ['spawn', 'exit', 'close']);
});

test('non-detached children retain Node spawn and other Node versions reject managed mode', (t) => {
  const { createManagedNodeChildAdapter } = loadManagedChildFactories();
  const transport = new FakeManagedTransport();
  let nativeSpawnCalls = 0;
  const nativeAdapter = createManagedNodeChildAdapter({
    childProcessModule: childProcess,
    processObject: process,
    transport,
    nodeVersion: '22.23.3',
    nativeSpawn(options) {
      nativeSpawnCalls++;
      assert.equal(options.detached, false);
      return 17;
    },
  });
  t.after(() => nativeAdapter.dispose());
  const nativeChild = new childProcess.ChildProcess();
  assert.equal(nativeChild.spawn({ file: '/fixture/native', args: [], envPairs: [], detached: false }), 17);
  assert.equal(nativeSpawnCalls, 1);
  nativeChild._handle.close();

  const unpinned = makeAdapter(t, { nodeVersion: '22.23.4', transport: new FakeManagedTransport() });
  assert.throws(() => childProcess.spawn('/fixture/tool', [], { detached: true }),
    { code: 'ERR_ATOOLS_MANAGED_CHILD_NODE_VERSION' });
  assert.equal(unpinned.transport.requests.length, 0);
});

test('unsupported detached modes and synchronous detached APIs fail before native spawn', (t) => {
  const { transport } = makeAdapter(t);
  assert.throws(() => childProcess.spawn('/fixture/tool', [], { detached: true, stdio: 'inherit' }),
    { code: 'ERR_ATOOLS_MANAGED_CHILD_UNSUPPORTED_STDIO' });
  assert.throws(() => childProcess.spawn('/fixture/tool', [], { detached: true, uid: 123 }),
    { code: 'ERR_ATOOLS_MANAGED_CHILD_UNSUPPORTED_OPTION' });
  assert.throws(() => childProcess.fork(__filename, [], { detached: true }),
    { code: 'ERR_ATOOLS_MANAGED_CHILD_UNSUPPORTED_STDIO' });
  for (const invoke of [
    () => childProcess.spawnSync('/fixture/tool', [], { detached: true }),
    () => childProcess.execSync('/fixture/tool', { detached: true }),
    () => childProcess.execFileSync('/fixture/tool', [], { detached: true }),
  ]) assert.throws(invoke, { code: 'ERR_ATOOLS_MANAGED_SYNC_DETACHED_UNSUPPORTED' });
  assert.equal(transport.requests.filter((request) => request.op === 'spawn').length, 0);
});
