import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Synthetic Native transport decorator; never OS drag/drop or a path-stat service. */
function installMainDropFixture() {
  const transport = window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__;
  const originalInvoke = transport.invoke.bind(transport), originalListen = transport.listen.bind(transport);
  const listeners = new Set(), pending = [], calls = [];
  let context = null, lease = null, target = null, sequence = 0, holding = false, failNext = false;
  let listens = 0, unlistens = 0;
  const uuid = () => crypto.randomUUID().replaceAll('-', '');
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  function handle(args) {
    if (!exact(args, ['request'])) throw new Error('Synthetic drop outer shape');
    const r = args.request;
    if (exact(r, ['op']) && r.op === 'context') return { contextId: context ??= uuid() };
    if (!exact(r, ['op', 'contextId', 'leaseId', 'target']) || r.op !== 'set' || r.contextId !== context
        || r.leaseId !== lease) throw new Error('Synthetic drop stale context/lease or request shape');
    if (r.target === null) { target = null; lease = null; return { leaseId: null }; }
    if (!exact(r.target, ['x', 'y', 'width', 'height']) || !Object.values(r.target).every(Number.isFinite)
        || r.target.width <= 0 || r.target.height <= 0) throw new Error('Synthetic drop invalid rectangle');
    target = { ...r.target }; lease ??= uuid(); return { leaseId: lease };
  }
  transport.invoke = function(command, args) {
    if (command !== 'set_renderer_main_drop_target') {
      if (command === 'open_renderer_settings') { context = null; lease = null; target = null; }
      return originalInvoke(command, args);
    }
    calls.push(structuredClone(args));
    return new Promise((resolve, reject) => {
      const run = () => {
        try { if (failNext) { failNext = false; throw new Error('Synthetic drop registration failure'); } resolve(handle(args)); }
        catch (error) { reject(error); }
      };
      if (holding && args?.request?.op === 'set' && args.request.target !== null) pending.push(run); else run();
    });
  };
  transport.listen = async function(event, handler) {
    if (event !== 'renderer-main-file-drop') return originalListen(event, handler);
    listens++; listeners.add(handler); let removed = false;
    return () => { if (!removed) { removed = true; listeners.delete(handler); unlistens++; } };
  };
  window.__ATOOLS_MAIN_DROP_FIXTURE__ = {
    snapshot: () => ({ context, lease, target, sequence, listens, unlistens, activeListeners: listeners.size,
      pending: pending.length, calls: structuredClone(calls), syntheticTransport: true }),
    hold(value) { holding = value; },
    release() { const jobs = pending.splice(0); jobs.forEach(run => run()); return jobs.length; },
    failNext() { failNext = true; },
    raw(payload) { for (const callback of listeners) callback(structuredClone(payload)); return listeners.size; },
    emit(phase, fields = {}, seq = ++sequence, leaseId = lease) {
      sequence = Math.max(sequence, seq);
      return this.raw({ version: 1, leaseId, sequence: seq, phase, ...fields });
    },
  };
}
export function decorateMainFileDropBootstrap(source) {
  return `${source}\n;(${installMainDropFixture.toString()})();`;
}

export const MAIN_DROP_RECEIPT_PATH = 'output/renderer-main-file-drop-r77-2026-11-02/frontend/p3-valid-path-characters/formal-build/formal-artifacts.json';
export const MAIN_DROP_RECEIPT_SHA = 'ac859a55cf60413209b3f7ee24c324bfb7dab214e950df8872e1c69ac6fbd3b2';
export const MAIN_DROP_PROVENANCE_SHA = '3f48995a5865c8f2686e7bab4111a66c8645eb18de398bba6278e03fa6df25f8';
/** An unchanged arbitrary dist is insufficient: bind the reviewed formal build's complete artifact. */
export function assertMainFileDropFormalReceipt(bytes, mainTree) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), MAIN_DROP_RECEIPT_SHA, 'R77 formal receipt changed');
  const receipt = JSON.parse(bytes.toString()), prefix = 'packages/ztools-renderer/dist/';
  const declared = receipt['packages/ztools-renderer/dist'];
  assert.equal(declared.count, 12); assert.equal(Object.keys(declared.files).length, 12);
  assert.equal(receipt.provenanceSha256, MAIN_DROP_PROVENANCE_SHA);
  assert.equal(receipt.mainJavaScriptBytes, 609908);
  assert.deepEqual(receipt.sourceAndSettingsMismatches, []);
  assert.equal(mainTree.exists, true);
  const actual = Object.fromEntries(Object.entries(mainTree.files).map(([path, entry]) => [prefix + path, entry.sha256]));
  assert.deepEqual(actual, declared.files, 'R77 Main differs from the reviewed formal artifact');
  assert.equal(actual[prefix + 'build-provenance.json'], MAIN_DROP_PROVENANCE_SHA);
  const bytesMeasured = Object.entries(mainTree.files).filter(([path]) => path.endsWith('.js')).reduce((n, [, entry]) => n + entry.bytes, 0);
  assert.equal(bytesMeasured, 609908);
  return { receiptSha256: MAIN_DROP_RECEIPT_SHA, provenanceSha256: MAIN_DROP_PROVENANCE_SHA,
    mainFiles: 12, mainJavaScriptBytes: bytesMeasured };
}

export const CORE_GENERAL_SOURCE_PATH = 'crates/atools-core/src/db/renderer_general_settings.rs';
/** Bind the bytes parsed by the static ESM import to each run-time identity snapshot. */
export function assertParsedGeneralSourceDigest(identity, importTimeSha256) {
  assert.match(importTimeSha256, /^[0-9a-f]{64}$/, 'Invalid imported General source digest');
  const captured = identity?.authoredFiles?.[CORE_GENERAL_SOURCE_PATH];
  assert.ok(captured && Number.isSafeInteger(captured.bytes) && captured.bytes > 0, 'Core General source missing from identity');
  assert.equal(captured.sha256, importTimeSha256, 'Core General source differs from bytes parsed at module import');
  return { path: CORE_GENERAL_SOURCE_PATH, importTimeSha256, capturedSha256: captured.sha256, bytes: captured.bytes };
}
