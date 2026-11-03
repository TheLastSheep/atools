import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyReachableCommonJsClosure } from './builtin-runtime-package-closure.mjs';
import { scanCommonJsRequests } from './builtin-runtime-js-lexer.mjs';
import { inspectBuiltinTree, planBuiltinRuntimeStage, safeRelative, stageBuiltinRuntimeTree } from './builtin-runtime-staging.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(callback) {
  const created = await mkdtemp(path.join(tmpdir(), 'atools-builtin-stage-test-'));
  const root = await realpath(created);
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root, relative, value) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}
async function packageFixture(root, options = {}) {
  const source = path.join(root, 'source');
  const pkg = 'fixture/preload/node_modules/demo-lib';
  const entry = 'fixture/preload/processor.cjs';
  const metadata = Buffer.from(JSON.stringify({ name: 'demo-lib', version: '1.2.3', main: 'cjs/index.js', dependencies: { 'demo-dep': '1.0.0' } }));
  const consumer = Buffer.from('const library = require("demo-lib");\n');
  await put(source, `${pkg}/package.json`, metadata);
  await put(source, `${pkg}/cjs/index.js`, 'module.exports = require("./api");\n');
  await put(source, `${pkg}/cjs/api/index.js`, 'module.exports = require("demo-dep");\n');
  await put(source, `${pkg}/LICENSE.md`, 'license\n');
  await put(source, `${pkg}/README.md`, 'documentation\n');
  await put(source, `${pkg}/yarn.lock`, 'demo-lib@1.2.3\n');
  for (const directory of ['dist', 'es', 'src', 'ts3.4']) await put(source, `${pkg}/${directory}/payload.txt`, directory);
  await put(source, 'fixture/preload/node_modules/demo-dep/package.json', JSON.stringify({ name: 'demo-dep', version: '1.0.0', main: 'index.js',
    exports: { '.': { module: './module-only.js', import: './import-only.js', default: './index.js' }, './': './' } }));
  await put(source, 'fixture/preload/node_modules/demo-dep/index.js', 'module.exports = 1;\n');
  await put(source, entry, consumer);
  const dependencyClosure = ['demo-dep'];
  const rule = { id: 'fixture-demo-lib', kind: 'package-format-prune', enabled: true, packageRoot: pkg,
    package: { name: 'demo-lib', version: '1.2.3', main: 'cjs/index.js', packageJsonSha256: hash(metadata) },
    consumer: { path: entry, scopeRoot: 'fixture', sha256: hash(consumer), exactCalls: 1 }, otherReferences: [],
    dropDirectories: ['dist', 'es', 'src', 'ts3.4'], retainPaths: ['package.json', 'cjs/index.js', 'LICENSE.md', 'README.md', 'yarn.lock'], dependencyClosure };
  return { source, pkg, rule, entry };
}

test('lexical scan ignores comments and strings without hiding literal CommonJS imports', () => {
  const source = "/* import { PDFDocument } from 'pdf-lib'; require('node:fs'); */\nconst note = \"// require('child_process') /* import('x') */\"; // require('fs')\nmodule.exports = require('./kept');";
  assert.deepEqual(scanCommonJsRequests(source), ['./kept']);
});

test('lexical scan masks regex literals and preserves active dependency calls', () => {
  const source = "const escape = /[.*+?^${}()|[\\]\\\\]/g; const label = \"require('fs')\"; module.exports = require('node:path');";
  assert.deepEqual(scanCommonJsRequests(source), ['node:path']);
});

test('lexical scan fails closed on ambiguous brace division and escaped or Unicode identifiers', () => {
  for (const source of ["const ratio = {} / require('node:fs') / 2;", "const loader = requ\\u0069re; loader('node:fs');", 'const name = café;']) {
    assert.throws(() => scanCommonJsRequests(source), { code: 'BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN' });
  }
});

test('regex after a control parenthesis ignores string tokens that resemble parentheses', () => {
  const source = "if (')') /require\\('node:fs'\\)/.test(value); module.exports = require('node:path');";
  assert.deepEqual(scanCommonJsRequests(source), ['node:path']);
});

test('lexical scan rejects real dynamic loaders and ambiguous interpolated templates', () => {
  for (const source of ["module.exports = import('demo-lib');", "module.exports = require(name);"]) assert.throws(() => scanCommonJsRequests(source), {
    code: 'BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD'
  });
  assert.throws(() => scanCommonJsRequests("const value = `x ${require('demo-lib')}`;"), { code: 'BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD' });
});

test('stages a new tree, prunes only pinned non-CJS format roots, preserves package and dependency closure', async () => fixture(async root => {
  const value = await packageFixture(root), destination = path.join(root, 'staged');
  const before = await inspectBuiltinTree(value.source);
  const result = await stageBuiltinRuntimeTree(value.source, destination, { candidateRules: [value.rule], applyCandidateRules: true });
  const staged = await inspectBuiltinTree(destination), after = await inspectBuiltinTree(value.source);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(before.sha256, after.sha256);
  assert.equal(staged.sha256, result.stagedManifestSha256);
  assert.equal(result.bytesSaved, 'dist'.length + 'es'.length + 'src'.length + 'ts3.4'.length);
  for (const file of ['package.json', 'cjs/index.js', 'cjs/api/index.js', 'LICENSE.md', 'README.md', 'yarn.lock']) {
    await readFile(path.join(destination, value.pkg, file));
  }
  await readFile(path.join(destination, 'fixture/preload/node_modules/demo-dep/index.js'));
  for (const directory of value.rule.dropDirectories) await assert.rejects(readFile(path.join(destination, value.pkg, directory, 'payload.txt')), { code: 'ENOENT' });
}));

test('resolves ordered CommonJS root exports and rejects unsupported maps or targets', async () => fixture(async root => {
  const value = await packageFixture(root);
  const manifestPath = path.join(value.source, 'fixture/preload/node_modules/demo-dep/package.json');
  const normal = { name: 'demo-dep', version: '1.0.0', main: 'index.js' };
  await writeFile(manifestPath, JSON.stringify({ ...normal, exports: { '.': { default: './index.js', require: './require.cjs' } } }));
  await put(value.source, 'fixture/preload/node_modules/demo-dep/require.cjs', "module.exports = require('./missing-if-selected');\n");
  await planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true });

  const unsupported = [
    [{ '.': ['./index.js'] }, 'BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN'],
    [{ './*': './*.js' }, 'BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN'],
    [{ '.': { browser: './index.js', default: './index.js' } }, 'BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN'],
    [{ '.': '../outside.js' }, 'BUILTIN_STAGE_DEPENDENCY_ENTRY_UNKNOWN'],
    [{ '.': './index' }, 'BUILTIN_STAGE_DEPENDENCY_ENTRY_MISSING'],
    [{ '.': './missing.js' }, 'BUILTIN_STAGE_DEPENDENCY_ENTRY_MISSING']
  ];
  for (const [exports, code] of unsupported) {
    await writeFile(manifestPath, JSON.stringify({ ...normal, exports }));
    await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }), { code });
  }
  await writeFile(manifestPath, JSON.stringify({ ...normal, type: 'module', exports: { '.': './index.js' } }));
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN' });
}));

test('exports targets must be exact files contained outside configured prune roots', async () => fixture(async root => {
  const source = path.join(root, 'source'), packageRoot = 'fixture/preload/node_modules/demo-lib';
  const mainPath = `${packageRoot}/cjs/index.js`, depRoot = `${packageRoot}/node_modules/demo-dep`;
  await put(source, mainPath, "module.exports = require('demo-dep');\n");
  await put(source, `${depRoot}/package.json`, JSON.stringify({ name: 'demo-dep', version: '1.0.0', exports: { '.': './dist/index.js' } }));
  await put(source, `${depRoot}/dist/index.js`, 'module.exports = 1;\n');
  const manifest = { entries: [mainPath, `${depRoot}/package.json`, `${depRoot}/dist/index.js`].map(path => ({ path, kind: 'file' })) };
  await assert.rejects(verifyReachableCommonJsClosure({ packageRoot, mainPath, manifest,
    readFile: relative => readFile(path.join(source, relative)), excludedRoots: [`${depRoot}/dist`], ruleId: 'fixture-demo-lib' }), error => {
    assert.equal(error.code, 'BUILTIN_STAGE_CLOSURE_ESCAPES_PRUNED_ASSET');
    assert.equal(error.ruleId, 'fixture-demo-lib');
    assert.equal(error.relativePath, mainPath);
    return true;
  });
}));

test('unapproved or unknown package rules preserve every source entry', async () => fixture(async root => {
  const value = await packageFixture(root), before = await inspectBuiltinTree(value.source);
  const plan = await planBuiltinRuntimeStage(value.source, { candidateRules: [{ ...value.rule, enabled: false }], applyCandidateRules: true });
  assert.equal(plan.stagedTreeSha256, before.sha256);
  const unknown = { ...value.rule, package: { ...value.rule.package, packageJsonSha256: '0'.repeat(64) } };
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [unknown], applyCandidateRules: true }), { code: 'BUILTIN_STAGE_PACKAGE_PIN_MISMATCH' });
}));

test('preserves both target siblings for universal and unknown targets, prunes only the non-selected pinned target', async () => fixture(async root => {
  const source = path.join(root, 'source'), loaderPath = 'plugin/preload/sidecarClient.js', callerPath = 'plugin/preload/index.js';
  const loader = Buffer.from("const path=require('node:path'); function pick(){return process.platform+process.arch;} path.join(__dirname, 'bin', filename);\n");
  const caller = Buffer.from("const { createSidecarClient } = require('./sidecarClient'); createSidecarClient({ extractDir: root });\n");
  const arm = Buffer.from('arm64 executable bytes'), x64 = Buffer.from('x64 executable bytes');
  await put(source, loaderPath, loader); await put(source, callerPath, caller);
  await put(source, 'plugin/preload/bin/cc-switch-sidecar-darwin-arm64', arm);
  await put(source, 'plugin/preload/bin/cc-switch-sidecar-darwin-x64', x64);
  const rule = { id: 'fixture-target', kind: 'target-file-set', enabled: true, platform: 'darwin',
    loader: { path: loaderPath, sha256: hash(loader) }, caller: { path: callerPath, sha256: hash(caller) }, assets: [
      { platform: 'darwin', arch: 'arm64', path: 'plugin/preload/bin/cc-switch-sidecar-darwin-arm64', bytes: arm.length, sha256: hash(arm) },
      { platform: 'darwin', arch: 'x64', path: 'plugin/preload/bin/cc-switch-sidecar-darwin-x64', bytes: x64.length, sha256: hash(x64) }
    ] };
  const universal = await planBuiltinRuntimeStage(source, { candidateRules: [rule], applyCandidateRules: true, target: { platform: 'darwin', arch: 'universal' } });
  const unspecified = await planBuiltinRuntimeStage(source, { candidateRules: [rule], applyCandidateRules: true });
  const armPlan = await planBuiltinRuntimeStage(source, { candidateRules: [rule], applyCandidateRules: true, target: { platform: 'darwin', arch: 'arm64' } });
  assert.equal(universal.stagedEntries.length, universal.source.publicEntries.length);
  assert.equal(unspecified.stagedEntries.length, unspecified.source.publicEntries.length);
  assert.equal(armPlan.excluded[0], 'plugin/preload/bin/cc-switch-sidecar-darwin-x64');
}));

test('refuses pre-existing symlinks and never follows them into external files', async () => fixture(async root => {
  const source = path.join(root, 'source'), outside = path.join(root, 'outside');
  await mkdir(source); await writeFile(outside, 'private'); await symlink(outside, path.join(source, 'link'));
  await assert.rejects(inspectBuiltinTree(source), { code: 'BUILTIN_STAGE_SYMLINK' });
}));

test('rejects existing destination and unsafe relative paths before copying', async () => fixture(async root => {
  const source = path.join(root, 'source'), destination = path.join(root, 'existing');
  await mkdir(source); await put(source, 'keep.txt', 'value'); await mkdir(destination);
  await assert.rejects(stageBuiltinRuntimeTree(source, destination), { code: 'EEXIST' });
  for (const unsafe of ['../escape', '/absolute', 'a\\b', 'a//b', 'a/./b']) assert.throws(() => safeRelative(unsafe), { code: 'BUILTIN_STAGE_UNSAFE_PATH' });
}));

test('blocks package consumers through ESM and package subpaths', async () => fixture(async root => {
  const value = await packageFixture(root);
  const esm = Buffer.from("import { value } from 'demo-lib';\n");
  await writeFile(path.join(value.source, value.entry), esm);
  value.rule.consumer.sha256 = hash(esm);
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CONSUMER_MODE_MISMATCH' });
  const subpath = Buffer.from("module.exports = require('demo-lib/subpath');\n");
  await writeFile(path.join(value.source, value.entry), subpath);
  value.rule.consumer.sha256 = hash(subpath);
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CONSUMER_SUBPATH_UNKNOWN' });
  const pinnedConsumer = Buffer.from('const library = require("demo-lib");\n');
  await writeFile(path.join(value.source, value.entry), pinnedConsumer);
  value.rule.consumer.sha256 = hash(pinnedConsumer);
  await put(value.source, 'fixture/plugin/index.html', '<script src="./node_modules/demo-lib/browser.js"></script>');
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CONSUMER_REFERENCE_UNKNOWN' });
}));

test('blocks runtime closure when a reachable dependency entry is missing or dynamic', async () => fixture(async root => {
  const value = await packageFixture(root), dependencyManifest = path.join(value.source, 'fixture/preload/node_modules/demo-dep/package.json');
  await writeFile(dependencyManifest, JSON.stringify({ name: 'demo-dep', version: '1.0.0', main: 'missing.js' }));
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_DEPENDENCY_ENTRY_MISSING' });
  await writeFile(dependencyManifest, JSON.stringify({ name: 'demo-dep', version: '1.0.0', main: 'index.js' }));
  await writeFile(path.join(value.source, 'fixture/preload/node_modules/demo-dep/index.js'), 'module.exports = require(name);\n');
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD' });
  await writeFile(path.join(value.source, 'fixture/preload/node_modules/demo-dep/index.js'), 'module.exports = require("node:fs");\n');
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CLOSURE_ASSET_ACCESS' });
  await writeFile(path.join(value.source, 'fixture/preload/node_modules/demo-dep/index.js'), 'module.exports = require("fs");\n');
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CLOSURE_ASSET_ACCESS' });
  await writeFile(path.join(value.source, 'fixture/preload/node_modules/demo-dep/index.js'), 'module.exports = require("node:child_process");\n');
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CLOSURE_ASSET_ACCESS' });
  await writeFile(path.join(value.source, 'fixture/preload/node_modules/demo-dep/index.js'), 'module.exports = require("./fixture.node");\n');
  await writeFile(path.join(value.source, 'fixture/preload/node_modules/demo-dep/fixture.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }),
    { code: 'BUILTIN_STAGE_CLOSURE_NATIVE_ADDON' });
}));

test('allows only pinned foreign relative gaps and blocks paths into candidate prune roots', async () => fixture(async root => {
  const value = await packageFixture(root);
  const foreignPath = 'fixture/other/tests/file.cjs';
  const foreignBytes = Buffer.from("module.exports = require('../preload/node_modules/demo-lib');\n");
  await put(value.source, foreignPath, foreignBytes);
  const foreignTarget = 'fixture/other/preload/node_modules/demo-lib';
  const aliasPath = 'fixture/other/tests/alias.cjs';
  const aliasBytes = Buffer.from("module.exports = require('../../shared/vendor/library');\n");
  await put(value.source, aliasPath, aliasBytes);
  const aliasTarget = 'fixture/shared/vendor/library';
  const aliasMetadata = Buffer.from(JSON.stringify({ name: 'demo-lib', version: '1.2.3', main: 'index.js', exports: { '.': './alternate.js' } }));
  await put(value.source, `${aliasTarget}/package.json`, aliasMetadata);
  await put(value.source, `${aliasTarget}/index.js`, 'module.exports = 1;\n');
  await put(value.source, `${aliasTarget}/alternate.js`, 'module.exports = 3;\n');
  await put(value.source, 'fixture/other/helpers/local.cjs', 'module.exports = 2;\n');
  await put(value.source, 'fixture/other/tests/unrelated.cjs', "module.exports = require('../helpers/local.cjs');\n");
  value.rule.otherRelativeReferences = [{ path: foreignPath, sha256: hash(foreignBytes), mode: 'relative-require',
    request: '../preload/node_modules/demo-lib', calls: 1, domain: 'foreign', targetPath: foreignTarget,
    status: 'missing', resolvedModule: null, note: 'pinned unresolved path under a different fixture anchor' },
  { path: aliasPath, sha256: hash(aliasBytes), mode: 'relative-require', request: '../../shared/vendor/library', calls: 1,
    domain: 'foreign', targetPath: aliasTarget, status: 'present', resolvedModule: `${aliasTarget}/index.js`,
    packageName: 'demo-lib', note: 'pinned package identity resolves from package metadata despite an aliased relative path' }];
  const plan = await planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true });
  assert.equal(plan.decisions[0].verifiedForeignRelativeReferences, 2);
  assert.equal(plan.excluded.includes(`${value.pkg}/es`), true);

  const unpinnedAlias = 'fixture/other/tests/unpinned-alias.cjs';
  await put(value.source, unpinnedAlias, "module.exports = require('../../shared/vendor/library');\n");
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }), error => {
    assert.equal(error.code, 'BUILTIN_STAGE_RELATIVE_FOREIGN_UNPINNED');
    assert.equal(error.ruleId, 'fixture-demo-lib');
    assert.equal(error.relativePath, unpinnedAlias);
    return true;
  });
}));

test('classifies relative candidates before pin checks and preserves fail-closed boundaries', async () => fixture(async root => {
  const value = await packageFixture(root);
  const unresolved = 'fixture/preload/missing-entry.cjs';
  await put(value.source, unresolved, "module.exports = require('./node_modules/demo-lib/no-entry');\n");
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }), error => {
    assert.equal(error.code, 'BUILTIN_STAGE_RELATIVE_CANDIDATE_UNRESOLVED');
    assert.equal(error.relativePath, unresolved);
    return true;
  });
  await rm(path.join(value.source, unresolved));

  const dynamic = 'fixture/preload/dynamic-relative.cjs';
  await put(value.source, dynamic, "module.exports = require('./node_modules/demo-lib/' + suffix);\n");
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }), error => {
    assert.equal(error.code, 'BUILTIN_STAGE_CONSUMER_REFERENCE_UNKNOWN');
    assert.equal(error.relativePath, dynamic);
    return true;
  });
  await rm(path.join(value.source, dynamic));

  const nativePath = `${value.pkg}/addon.node`;
  await put(value.source, nativePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const nativeConsumer = 'fixture/preload/native-relative.cjs';
  await put(value.source, nativeConsumer, "module.exports = require('./node_modules/demo-lib/addon.node');\n");
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }), error => {
    assert.equal(error.code, 'BUILTIN_STAGE_CLOSURE_NATIVE_ADDON');
    assert.equal(error.relativePath, nativeConsumer);
    return true;
  });
  await rm(path.join(value.source, nativeConsumer));
  await rm(path.join(value.source, nativePath));

  const candidatePath = 'fixture/preload/child/consumer.cjs';
  await put(value.source, candidatePath, "module.exports = require('../node_modules/demo-lib/es');\n");
  await assert.rejects(planBuiltinRuntimeStage(value.source, { candidateRules: [value.rule], applyCandidateRules: true }), error => {
    assert.equal(error.code, 'BUILTIN_STAGE_RELATIVE_TARGET_PRUNED');
    assert.equal(error.ruleId, 'fixture-demo-lib');
    assert.equal(error.relativePath, candidatePath);
    return true;
  });
}));
