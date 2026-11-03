import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNativeSourceSnapshot } from './ztools-renderer-native-source-binding.mjs';
import { createZtoolsRendererBrowserSourceLock } from './ztools-renderer-browser-source-lock.mjs';
import { assertRendererHostSources } from './ztools-renderer-host-sources.mjs';
import { validateRendererNativeProvenance } from './ztools-renderer-native-provenance.mjs';
import { captureSettingsNativeSources, summarizeSettingsNativeSources } from './ztools-settings-native-sources.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const OUTPUT = join(ROOT, 'output/renderer-hotkey-native-r72-2026-11-02');
export const PRODUCT_NODE = join(ROOT, 'src-tauri/binaries/node-aarch64-apple-darwin');
export const TAURI_CONFIG = { build: { beforeDevCommand: null, devUrl: null,
  beforeBuildCommand: null, frontendDist: '../packages/ztools-renderer/dist' } };
export const BUILD_ARGS = ['build', '-p', 'atools', '--example', 'ztools_renderer_desktop_smoke',
  '--features', 'legacy-node-smoke,ztools-multiwebview', '--locked', '--offline', '-j', '2'];
export const SCRIPT_INPUTS = [
  'scripts/prepare-ztools-manual-native.mjs', 'scripts/run-ztools-manual-native.mjs',
  'scripts/lib/ztools-manual-native-evidence.mjs', 'scripts/lib/ztools-manual-native-lifecycle.mjs',
  'scripts/lib/ztools-renderer-native-runtime.mjs', 'scripts/lib/ztools-renderer-native-source-binding.mjs',
  'scripts/lib/ztools-renderer-browser-source-lock.mjs', 'scripts/lib/ztools-renderer-host-sources.mjs',
  'scripts/lib/ztools-renderer-native-provenance.mjs', 'scripts/lib/ztools-settings-native-sources.mjs',
  'scripts/lib/ztools-settings-resource-budget.mjs', 'packages/ztools-settings/src/host-bridge-build.mjs',
  'packages/ztools-renderer/upstream-compatibility-patches.mjs',
];
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export const identity = info => `${info.dev}:${info.ino}`;

export async function verifyWorkspace() {
  assert.equal(await realpath(ROOT), '/Users/harris/Desktop/atools');
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('branch', '--show-current'), 'codex/atools-ztools-parity');
  assert.equal(git('rev-parse', 'HEAD'), 'c34789c0e3d19b3bf7c05d396540d891ff126abc');
  assert.equal(await realpath(process.execPath), await realpath(PRODUCT_NODE));
  return { root: ROOT, branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain=v1', '-uno') };
}

export async function hashTree(directory) {
  const files = {};
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Staged resources reject symlinks');
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else { assert.ok(entry.isFile()); files[relative(directory, absolute)] = sha(await readFile(absolute)); }
      assert.ok(Object.keys(files).length <= 256, 'Resource tree exceeds fixture bound');
    }
  }
  await walk(directory);
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

export async function captureManualInputs() {
  const packageRoot = join(ROOT, 'packages/ztools-renderer');
  const distRoot = join(packageRoot, 'dist');
  const lock = createZtoolsRendererBrowserSourceLock({ root: ROOT, upstream: '/Users/harris/Desktop/ZTools',
    packageRoot, distRoot, fixtureFiles: SCRIPT_INPUTS });
  const manifest = await readJson(join(packageRoot, 'source-manifest.json'));
  const provenance = await readJson(join(distRoot, 'build-provenance.json'));
  const upstream = await lock.hashUpstreamTree();
  await assertRendererHostSources(packageRoot, provenance);
  const mainDist = await hashTree(distRoot);
  let mainJavaScriptBytes = 0;
  for (const path of Object.keys(mainDist).filter(path => path.endsWith('.js'))) {
    mainJavaScriptBytes += (await lstat(join(distRoot, path))).size;
  }
  validateRendererNativeProvenance(manifest, provenance, upstream, mainJavaScriptBytes);
  assert.equal(mainJavaScriptBytes, 604426, 'R72 must use the frozen R69 Main');
  assert.equal(manifest.build.totalJavaScriptBudgetBytes, 606381);
  const settings = await captureSettingsNativeSources(ROOT);
  const settingsSummary = summarizeSettingsNativeSources(settings);
  assert.equal(settingsSummary.resourceBytes, 801929, 'R72 must use the frozen R71 Settings resources');
  assert.equal((await readJson(join(ROOT, 'packages/ztools-settings/source-manifest.json'))).build.emittedResourceBudget.maxBytes, 801964);
  return { native: await captureNativeSourceSnapshot(ROOT), scriptsAndAdapters: await lock.sourceHashes(),
    mainDist, upstream, mainProvenanceSha256: sha(await readFile(join(distRoot, 'build-provenance.json'))),
    mainJavaScriptBytes, settings: settingsSummary };
}

export function manualPaths(runId) {
  assert.match(runId, /^[0-9a-f]{32}$/);
  const runDirectory = join(OUTPUT, `run-${runId}`);
  const bundleName = `ATools R72 Manual ${runId.slice(0, 8)}.app`;
  return { runDirectory, bundleName, bundlePath: join(runDirectory, bundleName),
    identifier: `dev.atools.renderer-manual.${runId}`,
    fixtureRoot: `/private/tmp/atools-renderer-manual-${runId}`,
    mainDist: join(runDirectory, 'main-dist'), nativeReport: `/private/tmp/atools-renderer-manual-${runId}/report.json` };
}
