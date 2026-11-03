#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureSettingsNativeSources } from './lib/ztools-settings-native-sources.mjs';
import { fingerprintNativeExecutable } from './lib/ztools-renderer-native-source-binding.mjs';
import { stageRendererNativeApp } from './lib/ztools-renderer-native-runtime.mjs';
import { boundedLog } from './lib/ztools-manual-native-lifecycle.mjs';
import { BUILD_ARGS, OUTPUT, ROOT, TAURI_CONFIG, captureManualInputs, hashTree, identity,
  manualPaths, verifyWorkspace } from './lib/ztools-manual-native-evidence.mjs';

assert.deepEqual(process.argv.slice(2), [], 'Prepare accepts no options and never starts the app');
const workspace = await verifyWorkspace();
const runId = randomUUID().replaceAll('-', '');
const paths = manualPaths(runId);
await mkdir(OUTPUT, { recursive: true, mode: 0o700 });
await mkdir(paths.runDirectory, { mode: 0o700 });
const save = (name, value) => writeFile(join(paths.runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const before = await captureManualInputs();
await save('sources-before.json', before);
const stdout = boundedLog(128 * 1024), stderr = boundedLog(128 * 1024);
const startedAt = new Date().toISOString();
const build = spawn('cargo', BUILD_ARGS, { cwd: ROOT, env: { ...process.env, TAURI_CONFIG: JSON.stringify(TAURI_CONFIG) },
  stdio: ['ignore', 'pipe', 'pipe'], shell: false });
build.stdout.on('data', bytes => stdout.append(bytes)); build.stderr.on('data', bytes => stderr.append(bytes));
const result = await new Promise((resolve, reject) => { build.once('error', reject);
  build.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
await writeFile(join(paths.runDirectory, 'build.stdout.log'), stdout.bytes(), { mode: 0o600 });
await writeFile(join(paths.runDirectory, 'build.stderr.log'), stderr.bytes(), { mode: 0o600 });
await save('build-result.json', { command: ['cargo', ...BUILD_ARGS], config: TAURI_CONFIG, startedAt,
  finishedAt: new Date().toISOString(), ...result, stdout: stdout.metadata(), stderr: stderr.metadata() });
assert.equal(result.exitCode, 0, 'Fresh native Cargo build must pass');
const after = await captureManualInputs();
assert.deepEqual(after, before, 'Native/UI/runner inputs changed during build');
const binary = await fingerprintNativeExecutable(join(ROOT, 'target/debug/examples/ztools_renderer_desktop_smoke'));
await save('native-build-receipt.json', { schemaVersion: 1, observedAt: new Date().toISOString(),
  command: { program: 'cargo', args: BUILD_ARGS, config: TAURI_CONFIG }, binary,
  nativeSources: { ...before.native, stable: true }, manualInputs: before });
const staged = await stageRendererNativeApp({ binary: binary.path, runDirectory: paths.runDirectory,
  autoClear: 'never', runId, expectedSha256: binary.sha256, mode: 'settings',
  settingsSourceSnapshot: await captureSettingsNativeSources(ROOT) });
await rename(staged.bundlePath, paths.bundlePath);
const infoPath = join(paths.bundlePath, 'Contents/Info.plist');
const displayName = `ATools R72 Manual ${runId.slice(0, 8)}`;
const info = (await readFile(infoPath, 'utf8')).replaceAll(staged.identifier, paths.identifier)
  .replaceAll(staged.displayName, displayName);
await writeFile(infoPath, info, { mode: 0o600 });
await cp(join(ROOT, 'packages/ztools-renderer/dist'), paths.mainDist, { recursive: true, force: false, errorOnExist: true });
assert.deepEqual(await hashTree(paths.mainDist), before.mainDist, 'Staged Main must match formal Main exactly');
assert.deepEqual(await captureManualInputs(), before, 'Inputs changed during staging');
const executable = join(paths.bundlePath, 'Contents/MacOS/AToolsRendererSmoke');
assert.equal((await fingerprintNativeExecutable(executable)).sha256, binary.sha256);
const prepared = { schemaVersion: 1, journey: 'manual-ui', runId, workspace, ...paths, displayName,
  executable, binary, inputs: before, durationLimitMs: 600000, guiAcceptance: 'unverified',
  bundleIdentity: identity(await lstat(paths.bundlePath, { bigint: true })),
  bundleFiles: await hashTree(paths.bundlePath), mainDistFiles: before.mainDist,
  args: ['--journey', 'manual-ui', '--fixture-root', paths.fixtureRoot, '--renderer-dist', paths.mainDist,
    '--output', paths.nativeReport, '--auto-clear', 'never', '--run-id', runId] };
await save('prepared.json', prepared);
console.log(JSON.stringify({ prepared: join(paths.runDirectory, 'prepared.json'), bundlePath: paths.bundlePath,
  identifier: paths.identifier, appStarted: false, binarySha256: binary.sha256 }, null, 2));
