import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { argsForStep, runPlan, validatePlan } from './source_build_runner.mjs';

const plan = { schemaVersion: 3, toolchain: {
  viteBackend: { kind: 'esbuild', binary: 'node_modules/vite/node_modules/esbuild/bin/esbuild' },
  testEsbuild: 'node_modules/esbuild/bin/esbuild',
}, steps: [
  { kind: 'typecheck', cli: 'node_modules/vue-tsc/bin/vue-tsc.js' },
  { kind: 'nodeTest', files: ['tests/a.test.cjs', 'tests/b.test.ts'] },
  { kind: 'viteBuild', cli: 'node_modules/vite/bin/vite.js' },
  { kind: 'nodeScript', script: 'scripts/prepare-dist.mjs' },
] };

test('accepts schema v3 backend paths and maps fixed argv without a shell', () => {
  assert.equal(validatePlan(plan), true);
  assert.deepEqual(argsForStep(plan.steps[0]), ['--max-old-space-size=256', 'node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit']);
  assert.deepEqual(argsForStep(plan.steps[1]), ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-concurrency=1', '--', 'tests/a.test.cjs', 'tests/b.test.ts']);
  assert.deepEqual(argsForStep(plan.steps[2]), ['--max-old-space-size=256', 'node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist', '--emptyOutDir']);
  assert.deepEqual(argsForStep(plan.steps[3]), ['--max-old-space-size=256', '--', 'scripts/prepare-dist.mjs']);
});

test('supports only installed package-local tsc and vue-tsc no-emit CLI paths', () => {
  const tscPlan = { schemaVersion: 3, toolchain: { viteBackend: plan.toolchain.viteBackend },
    steps: [{ kind: 'typecheck', cli: 'node_modules/typescript/bin/tsc' }, plan.steps[2]] };
  assert.equal(validatePlan(tscPlan), true);
  assert.deepEqual(argsForStep(tscPlan.steps[0]), ['--max-old-space-size=256', 'node_modules/typescript/bin/tsc', '--noEmit']);
  assert.equal(validatePlan({ ...tscPlan, steps: [{ kind: 'typecheck', cli: 'node_modules/other/bin/tsc' }, plan.steps[2]] }), false);
  assert.equal(validatePlan({ ...tscPlan, steps: [{ kind: 'typecheck', cli: 'node_modules/typescript/../../outside/tsc' }, plan.steps[2]] }), false);
  const environments = [];
  assert.equal(runPlan(tscPlan, (_exe, argv, options) => {
    environments.push({ argv, env: options.env });
    return { status: 0 };
  }), 0);
  assert.equal(environments[0].env.ESBUILD_BINARY_PATH, undefined);
  assert.deepEqual(environments[0].argv, argsForStep(tscPlan.steps[0]));
});

test('requires an exact per-plan backend shape and binds testEsbuild only to nodeTest plans', () => {
  assert.equal(validatePlan({ ...plan, schemaVersion: 1 }), false);
  assert.equal(validatePlan({ schemaVersion: 3, steps: plan.steps }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { ...plan.toolchain, extra: true } }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { ...plan.toolchain, viteBackend: { kind: 'esbuild', binary: '../esbuild' } } }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { ...plan.toolchain, viteBackend: { kind: 'esbuild', binary: 'node_modules/../outside/bin/esbuild' } } }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { ...plan.toolchain, testEsbuild: '/node_modules/esbuild/bin/esbuild' } }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { viteBackend: plan.toolchain.viteBackend } }), false);
  const withoutTests = { schemaVersion: 3, toolchain: { viteBackend: plan.toolchain.viteBackend },
    steps: [plan.steps[0], plan.steps[2], plan.steps[3]] };
  assert.equal(validatePlan(withoutTests), true);
  assert.equal(validatePlan({ ...withoutTests, toolchain: { ...withoutTests.toolchain, testEsbuild: plan.toolchain.testEsbuild } }), false);
  assert.equal(validatePlan({ ...withoutTests, toolchain: { viteBackend: { kind: 'esbuild', binary: 'node_modules/vite/esbuild' }, testEsbuild: plan.toolchain.testEsbuild } }), false);
});

test('clones the environment per step, selects only the configured backend binaries, and removes inherited overrides elsewhere', () => {
  const previous = process.env.ESBUILD_BINARY_PATH;
  process.env.ESBUILD_BINARY_PATH = '/inherited/untrusted/esbuild';
  const environments = [];
  try {
    assert.equal(runPlan(plan, (_exe, _argv, options) => {
      environments.push(options.env);
      return { status: 0 };
    }), 0);
    assert.equal(environments.length, 4);
    assert.notEqual(environments[0], environments[1]);
    assert.notEqual(environments[1], environments[2]);
    assert.equal(environments[0].ESBUILD_BINARY_PATH, undefined);
    assert.equal(environments[1].ESBUILD_BINARY_PATH, path.resolve(process.cwd(), plan.toolchain.testEsbuild));
    assert.equal(environments[2].ESBUILD_BINARY_PATH, path.resolve(process.cwd(), plan.toolchain.viteBackend.binary));
    assert.equal(environments[3].ESBUILD_BINARY_PATH, undefined);
    assert.equal(process.env.ESBUILD_BINARY_PATH, '/inherited/untrusted/esbuild');
  } finally {
    if (previous === undefined) delete process.env.ESBUILD_BINARY_PATH;
    else process.env.ESBUILD_BINARY_PATH = previous;
  }
});

test('Rolldown binds a declared native library but never exports it as an esbuild or process-exec path', () => {
  const plan = { schemaVersion: 3, toolchain: { viteBackend: {
    kind: 'rolldown', binding: 'node_modules/@rolldown/binding-darwin-arm64/rolldown-binding.darwin-arm64.node',
  } }, steps: [{ kind: 'viteBuild', cli: 'node_modules/vite/bin/vite.js' }] };
  assert.equal(validatePlan(plan), true);
  assert.equal(validatePlan({ ...plan, toolchain: { viteBackend: { kind: 'rolldown', binding: 'node_modules/rogue.node', extra: true } } }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { viteBackend: { kind: 'rolldown', binding: 'node_modules/rolldown/package.json' } } }), false);
  assert.equal(validatePlan({ ...plan, toolchain: { viteBackend: { kind: 'unknown', binary: 'node_modules/anything' } } }), false);
  const previous = process.env.ESBUILD_BINARY_PATH;
  process.env.ESBUILD_BINARY_PATH = '/inherited/untrusted/esbuild';
  let observed;
  try {
    assert.equal(runPlan(plan, (_executable, _argv, options) => {
      observed = options.env.ESBUILD_BINARY_PATH;
      return { status: 0 };
    }), 0);
    assert.equal(observed, undefined);
    assert.equal(process.env.ESBUILD_BINARY_PATH, '/inherited/untrusted/esbuild');
  } finally {
    if (previous === undefined) delete process.env.ESBUILD_BINARY_PATH;
    else process.env.ESBUILD_BINARY_PATH = previous;
  }
});

test('each managed Node step receives the fixed heap cap in a real child process', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atools-source-build-heap-'));
  const reportPath = path.join(root, 'observations.json');
  const previousReport = process.env.ATOOLS_HEAP_PROBE_REPORT;
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousBuildBinary = process.env.ESBUILD_BINARY_PATH;
  const originalCwd = process.cwd();
  const script = name => `import { appendFileSync } from 'node:fs';\nimport v8 from 'node:v8';\nappendFileSync(process.env.ATOOLS_HEAP_PROBE_REPORT, JSON.stringify({name:${JSON.stringify(name)},execArgv:process.execArgv,heapLimit:v8.getHeapStatistics().heap_size_limit,esbuild:process.env.ESBUILD_BINARY_PATH??null})+'\\n');\n`;
  try {
    mkdirSync(path.join(root, 'node_modules/vue-tsc/bin'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules/vite/bin'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules/tsx'), { recursive: true });
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/tsx/package.json'), JSON.stringify({ name: 'tsx', version: '0.0.0', exports: './index.js' }));
    writeFileSync(path.join(root, 'node_modules/tsx/index.js'), '');
    writeFileSync(path.join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'), script('typecheck'));
    writeFileSync(path.join(root, 'node_modules/vite/bin/vite.js'), script('viteBuild'));
    writeFileSync(path.join(root, 'tests/heap-probe.test.mjs'), `import test from 'node:test';\n${script('nodeTest')}test('probe',()=>{});\n`);
    writeFileSync(path.join(root, 'scripts/postbuild.mjs'), script('nodeScript'));
    writeFileSync(path.join(root, 'heap-control.mjs'), "import v8 from 'node:v8'; process.stdout.write(JSON.stringify({execArgv:process.execArgv,heapLimit:v8.getHeapStatistics().heap_size_limit}));\n");
    process.env.ATOOLS_HEAP_PROBE_REPORT = reportPath;
    delete process.env.NODE_TEST_CONTEXT;
    process.chdir(root);
    const control = flags => spawnSync(process.execPath, [...flags, 'heap-control.mjs'], {
      cwd: root, env: process.env, shell: false, windowsHide: true, encoding: 'utf8',
    });
    const cappedControl = control(['--max-old-space-size=256']);
    assert.equal(cappedControl.status, 0, cappedControl.stderr);
    const capped = JSON.parse(cappedControl.stdout);
    assert.equal(capped.execArgv[0], '--max-old-space-size=256');
    const defaultControl = control([]);
    assert.equal(defaultControl.status, 0, defaultControl.stderr);
    const uncapped = JSON.parse(defaultControl.stdout);
    assert.ok(uncapped.heapLimit > capped.heapLimit, 'the fixed old-space option changes the same-binary V8 heap limit');
    const probePlan = { schemaVersion: 3, steps: [
      { kind: 'typecheck', cli: 'node_modules/vue-tsc/bin/vue-tsc.js' },
      { kind: 'nodeTest', files: ['tests/heap-probe.test.mjs'] },
      { kind: 'viteBuild', cli: 'node_modules/vite/bin/vite.js' },
      { kind: 'nodeScript', script: 'scripts/postbuild.mjs' },
    ], toolchain: {
      viteBackend: { kind: 'esbuild', binary: 'node_modules/vite/node_modules/esbuild/bin/esbuild' },
      testEsbuild: 'node_modules/esbuild/bin/esbuild',
    } };
    process.env.ESBUILD_BINARY_PATH = '/inherited/untrusted/esbuild';
    assert.equal(runPlan(probePlan), 0);
    const observations = readFileSync(reportPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(observations.map(item => item.name), ['typecheck', 'nodeTest', 'viteBuild', 'nodeScript']);
    const expectedBinaries = [null, path.resolve(process.cwd(), probePlan.toolchain.testEsbuild),
      path.resolve(process.cwd(), probePlan.toolchain.viteBackend.binary), null];
    for (const [index, item] of observations.entries()) {
      const heapFlags = item.execArgv.filter(argument => argument.startsWith('--max-old-space-size'));
      assert.deepEqual(heapFlags, ['--max-old-space-size=256'], item.name);
      if (item.name !== 'nodeTest') assert.equal(item.execArgv[0], '--max-old-space-size=256', item.name);
      assert.equal(item.heapLimit, capped.heapLimit, item.name);
      assert.equal(item.esbuild, expectedBinaries[index], item.name);
    }
    assert.equal(process.env.ESBUILD_BINARY_PATH, '/inherited/untrusted/esbuild');
  } finally {
    process.chdir(originalCwd);
    if (previousReport === undefined) delete process.env.ATOOLS_HEAP_PROBE_REPORT;
    else process.env.ATOOLS_HEAP_PROBE_REPORT = previousReport;
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousBuildBinary === undefined) delete process.env.ESBUILD_BINARY_PATH;
    else process.env.ESBUILD_BINARY_PATH = previousBuildBinary;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs in order and stops immediately after the first nonzero exit', () => {
  const calls = [];
  const status = runPlan(plan, (_exe, argv, options) => {
    calls.push({ argv, options });
    return { status: calls.length === 2 ? 7 : 0 };
  });
  assert.equal(status, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('fails closed for extra keys, shell-like paths, duplicate tests, missing Vite, and oversized plans', () => {
  for (const steps of [
    [{ ...plan.steps[0], extra: 'x' }, plan.steps[2]],
    [{ kind: 'nodeScript', script: 'scripts/prepare.mjs;evil' }, plan.steps[2]],
    [{ kind: 'nodeScript', script: '--require=evil.mjs' }, plan.steps[2]],
    [{ kind: 'nodeScript', script: 'scripts/bad\nname.mjs' }, plan.steps[2]],
    [{ kind: 'nodeScript', script: 'scripts/bad\u0085name.mjs' }, plan.steps[2]],
    [{ kind: 'nodeTest', files: ['--require=evil.test.ts'] }, plan.steps[2]],
    [{ kind: 'nodeTest', files: ['tests/-flagged.test.ts'] }, plan.steps[2]],
    [{ kind: 'nodeScript', script: 'scripts/-post.mjs' }, plan.steps[2]],
    [{ kind: 'nodeScript', script: 'scripts/back\\slash.mjs' }, plan.steps[2]],
    [{ kind: 'nodeScript', script: '../outside.mjs' }, plan.steps[2]],
    [{ kind: 'nodeTest', files: ['tests/a.test.ts', 'tests/a.test.ts'] }, plan.steps[2]],
    [plan.steps[0]],
    [...Array(12)].map(() => plan.steps[2]),
  ]) assert.equal(validatePlan({ schemaVersion: 3, toolchain: plan.toolchain, steps }), false);
  assert.equal(validatePlan({ ...plan, unexpected: true }), false);
  const aggregate129 = { schemaVersion: 3, toolchain: plan.toolchain, steps: [
    { kind: 'nodeTest', files: Array.from({ length: 65 }, (_, i) => `tests/a${i}.test.ts`) },
    { kind: 'nodeTest', files: Array.from({ length: 64 }, (_, i) => `tests/b${i}.test.ts`) },
    plan.steps[2],
  ] };
  assert.equal(validatePlan(aggregate129), false);
  const aggregate128 = { schemaVersion: 3, toolchain: plan.toolchain, steps: [
    { kind: 'nodeTest', files: Array.from({ length: 64 }, (_, i) => `tests/a${i}.test.ts`) },
    { kind: 'nodeTest', files: Array.from({ length: 64 }, (_, i) => `tests/b${i}.test.ts`) },
    plan.steps[2],
  ] };
  assert.equal(validatePlan(aggregate128), true);
  assert.equal(validatePlan({ schemaVersion: 3, toolchain: plan.toolchain, steps: [
    { kind: 'nodeTest', files: ['tests/a.test.ts'] },
    { kind: 'nodeTest', files: ['tests/a.test.ts'] },
    plan.steps[2],
  ] }), false);
});
