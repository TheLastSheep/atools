import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAboutNativeArgs, buildAboutNativeArgs, assertAboutSettingsFreeze } from './ztools-about-native-protocol.mjs';
import { parseUpdaterNativeArgs } from './ztools-updater-native-protocol.mjs';
import { assertUpdaterNativeTerminal } from './ztools-updater-native-case.mjs';
const args = ['--binary', '/private/tmp/binary', '--build-receipt', '/private/tmp/receipt', '--journey', 'updater', '--auto-clear', 'never'];
test('About explicit mode has a separate closed CLI; R78 default parser stays unchanged', () => {
  assert.equal(parseAboutNativeArgs([...args, '--updater-mode', 'about', '--preflight']).preflight, true);
  assert.equal(parseUpdaterNativeArgs(args).preflight, false);
  for (const extra of [[], ['--updater-mode', 'popup'], ['--updater-mode', 'about', '--profile', 'settings'],
    ['--updater-mode', 'about', '--updater-mode', 'about'], ['--updater-mode', 'about', '--preflight', '--preflight']])
    assert.throws(() => parseAboutNativeArgs([...args, ...extra]));
  assert.throws(() => parseUpdaterNativeArgs([...args, '--updater-mode', 'about']));
});
test('actual child receives exact About selection and owned run root', () => {
  const runId = 'a'.repeat(32), fixtureRoot = `/private/tmp/atools-renderer-updater-${runId}`;
  const result = buildAboutNativeArgs({ runId, fixtureRoot, rendererDist: '/private/tmp/main', output: '/private/tmp/report' });
  assert.deepEqual(result.slice(-4), ['--journey', 'updater', '--updater-mode', 'about']);
  assert.throws(() => buildAboutNativeArgs({ runId, fixtureRoot: '/tmp/foreign', rendererDist: '/private/tmp/main', output: '/private/tmp/report' }));
  assert.throws(() => buildAboutNativeArgs({ runId: 'A'.repeat(32), fixtureRoot, rendererDist: '/private/tmp/main', output: '/private/tmp/report' }));
});
test('old Settings and absent frozen record cannot grant About acceptance', () => {
  assert.throws(() => assertAboutSettingsFreeze({ bundle: { provenanceSha256: '134e' } }, null));
  assert.throws(() => assertAboutSettingsFreeze({ bundle: { provenanceSha256: '134e' } }, { provenanceSha256: 'b'.repeat(64) }));
  assert.doesNotThrow(() => assertAboutSettingsFreeze({ bundle: { provenanceSha256: 'b'.repeat(64) } }, { provenanceSha256: 'b'.repeat(64) }));
});
test('process terminal must be observed, successful and never watchdog termination', () => {
  const good = { spawned: true, terminalObserved: true, pid: 123, timedOut: false, exitCode: 0, signal: null };
  for (const bad of [{ terminalObserved: false }, { spawned: false }, { timedOut: true }, { exitCode: 1 }, { signal: 'SIGTERM' }, { pid: null }])
    assert.throws(() => assertUpdaterNativeTerminal({ ...good, ...bad }));
});
