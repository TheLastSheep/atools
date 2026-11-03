'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');

test('an output read failure reports error and closes after real terminal events', async (t) => {
  const directory = path.resolve(__dirname, '../../src/legacy_node');
  const sources = ['managed_child_transport.cjs', 'managed_child_streams.cjs', 'managed_children.cjs']
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'));
  const factory = new Module(__filename, module);
  factory.filename = __filename;
  factory.paths = Module._nodeModulePaths(__dirname);
  factory._compile(`${sources.join('\n')}\nmodule.exports = createManagedNodeChildAdapter;`, __filename);
  const events = new EventEmitter();
  let references = 0;
  const kills = [];
  const adapter = factory.exports({ childProcessModule: childProcess, processObject: process,
    nodeVersion: process.versions.node, transport: {
      request(request) {
        if (request.op === 'spawn') return { childId: '1', pid: 42101 };
        if (request.op === 'kill') kills.push(request);
        return { accepted: true };
      },
      onEvent(listener) { events.on('frame', listener); return () => events.off('frame', listener); },
      ref() { references++; }, unref() { references--; }, close() {},
    } });
  t.after(() => adapter.dispose());
  const child = childProcess.spawn('/fixture/tool', [], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sequence = [];
  child.on('error', (error) => sequence.push(`error:${error.code}`));
  child.on('exit', () => sequence.push('exit'));
  const closed = new Promise((resolve) => child.once('close', (...args) => {
    sequence.push('close'); resolve(args);
  }));
  events.emit('frame', { childId: '1', event: 'streamError', stream: 'stdout',
    error: { code: 'ERR_ATOOLS_CHILD_OUTPUT_READ', message: 'fixture output read failed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence, ['error:ERR_ATOOLS_CHILD_OUTPUT_READ']);
  assert.equal(references, 1, 'read failure alone does not prove process exit');
  events.emit('frame', { childId: '1', event: 'exit', code: null, signal: 'SIGKILL' });
  events.emit('frame', { childId: '1', event: 'close', code: null, signal: 'SIGKILL' });
  assert.deepEqual(await closed, [null, 'SIGKILL']);
  assert.deepEqual(sequence, ['error:ERR_ATOOLS_CHILD_OUTPUT_READ', 'exit', 'close']);
  assert.equal(references, 0);
  assert.ok(kills.some((request) => request.childId === '1' && request.group && request.signal === 9));
});
