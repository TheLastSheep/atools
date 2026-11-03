import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(repositoryRoot, 'packages/ztools-renderer')
const helperPath = path.join(packageRoot, 'post-minifier.mjs')
const nodeModulesPath = path.join(packageRoot, 'node_modules')
const expectedVersion = '5.51.2'

async function importMinifierFactory(modulePath = helperPath) {
  const moduleUrl = new URL(pathToFileURL(modulePath))
  moduleUrl.searchParams.set('test-instance', `${Date.now()}-${Math.random()}`)
  return import(moduleUrl.href)
}

async function temporaryPackage(t, { copyHelper = false } = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'atools-renderer-minifier-'))
  const copiedPackageRoot = path.join(temporaryRoot, 'package')
  const copiedNodeModules = path.join(copiedPackageRoot, 'node_modules')
  await mkdir(copiedPackageRoot, { recursive: true })
  for (const file of ['package.json', 'package-lock.json']) {
    await cp(path.join(packageRoot, file), path.join(copiedPackageRoot, file))
  }
  await cp(nodeModulesPath, copiedNodeModules, {
    recursive: true,
    filter(source) {
      const relative = path.relative(nodeModulesPath, source)
      return relative === '' || relative.split(path.sep)[0] !== '.bin'
    }
  })
  let copiedHelperPath = helperPath
  if (copyHelper) {
    copiedHelperPath = path.join(temporaryRoot, 'post-minifier.mjs')
    await cp(helperPath, copiedHelperPath)
  }
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  return { packageRoot: copiedPackageRoot, nodeModules: copiedNodeModules, helperPath: copiedHelperPath }
}

test('post-minifies ESM while preserving observable renderer semantics', async () => {
  const { createRendererPostMinifier } = await importMinifierFactory()
  const minifier = await createRendererPostMinifier({ packageRoot, expectedVersion })
  assert.equal(minifier.plugin.renderChunk.order, 'post')
  assert.match(minifier.provenance.nodeModulesTreeSha256, /^[0-9a-f]{64}$/)
  assert.match(minifier.provenance.packageLockSha256, /^[0-9a-f]{64}$/)
  assert.match(minifier.provenance.helperSha256, /^[0-9a-f]{64}$/)
  assert.equal(await minifier.verifyUnchanged(), true)

  const source = `/*! renderer fixture license */
    const events = globalThis.__rendererMinifierEvents;
    function record(value) { events.push(value); }
    function pureCall(value) { return value; }
    const sourceObject = { get value() { record('getter'); return '设置😀'; } };
    export const readValue = sourceObject.value;
    /*@__PURE__*/ pureCall(record('pure-call-argument'));
    try { throw new Error('kept'); } catch (error) { record('caught:' + error.message); }
    globalThis.__rendererSettingsInputHook = value => record('hook:' + value);
    globalThis.__rendererPublicObject = { 'public-key': 'visible' };
    console.warn('warning-preserved');
    console.error('error-preserved');
    export const rendererExport = 'stable-export';
    export async function start(callback) {
      await Promise.resolve();
      callback('async-callback');
    }
  `
  const transformed = await minifier.plugin.renderChunk.handler(source, { fileName: 'fixture.js' }, { format: 'es' })
  assert.equal(transformed.map, null)
  assert.equal(typeof transformed.code, 'string')
  assert.ok(!transformed.code.includes('pureCall'), 'the annotated pure call should be removed')
  assert.ok(transformed.code.includes('/*! renderer fixture license */'), 'legal comments should remain')
  assert.deepEqual(minifier.measurements(), {
    measurementScope: 'renderChunk post hook; input follows ordinary hooks such as Vite esbuild',
    byteEncoding: 'UTF-8',
    chunks: [{
      fileName: 'fixture.js',
      inputBytes: Buffer.byteLength(source, 'utf8'),
      outputBytes: Buffer.byteLength(transformed.code, 'utf8'),
      savedBytes: Buffer.byteLength(source, 'utf8') - Buffer.byteLength(transformed.code, 'utf8')
    }],
    inputJavaScriptBytes: Buffer.byteLength(source, 'utf8'),
    outputJavaScriptBytes: Buffer.byteLength(transformed.code, 'utf8'),
    savedJavaScriptBytes: Buffer.byteLength(source, 'utf8') - Buffer.byteLength(transformed.code, 'utf8')
  })

  globalThis.__rendererMinifierEvents = []
  const consoleCalls = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...args) => consoleCalls.push(`warn:${args.join(' ')}`)
  console.error = (...args) => consoleCalls.push(`error:${args.join(' ')}`)
  try {
    const fixture = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`)
    assert.deepEqual(Object.keys(fixture).sort(), ['readValue', 'rendererExport', 'start'])
    assert.equal(fixture.readValue, '设置😀')
    assert.equal(fixture.rendererExport, 'stable-export')
    assert.equal(globalThis.__rendererPublicObject['public-key'], 'visible')
    assert.equal(typeof globalThis.__rendererSettingsInputHook, 'function')
    globalThis.__rendererSettingsInputHook('已更新')
    let callbackValue = null
    await fixture.start(value => { callbackValue = value })
    assert.equal(callbackValue, 'async-callback')
    assert.deepEqual(globalThis.__rendererMinifierEvents, [
      'getter',
      'pure-call-argument',
      'caught:kept',
      'hook:已更新'
    ])
    assert.deepEqual(consoleCalls, ['warn:warning-preserved', 'error:error-preserved'])
  } finally {
    console.warn = originalWarn
    console.error = originalError
    delete globalThis.__rendererMinifierEvents
    delete globalThis.__rendererSettingsInputHook
    delete globalThis.__rendererPublicObject
  }
})

test('rejects mismatched local package and lock versions', async (t) => {
  const { createRendererPostMinifier: createActual } = await importMinifierFactory()
  await assert.rejects(createActual({ packageRoot, expectedVersion: '5.51.1' }), /package\.json must pin devDependency/)

  const fixture = await temporaryPackage(t)
  const { createRendererPostMinifier } = await importMinifierFactory()
  const manifestPath = path.join(fixture.packageRoot, 'package.json')
  const lockPath = path.join(fixture.packageRoot, 'package-lock.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.devDependencies.terser = '5.51.1'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await assert.rejects(createRendererPostMinifier({ packageRoot: fixture.packageRoot, expectedVersion }), /package\.json must pin devDependency/)

  manifest.devDependencies.terser = expectedVersion
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.packages[''].devDependencies.terser = '5.51.1'
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  await assert.rejects(createRendererPostMinifier({ packageRoot: fixture.packageRoot, expectedVersion }), /package-lock\.json root must pin devDependency/)
})

test('rejects lock, transitive file, and helper drift using only a temporary copy', async (t) => {
  const fixture = await temporaryPackage(t, { copyHelper: true })
  const { createRendererPostMinifier } = await importMinifierFactory(fixture.helperPath)
  const minifier = await createRendererPostMinifier({ packageRoot: fixture.packageRoot, expectedVersion })
  assert.equal(await minifier.verifyUnchanged(), true)

  const dependencyFile = path.join(fixture.nodeModules, 'commander/index.js')
  const dependencyBytes = await readFile(dependencyFile)
  await writeFile(dependencyFile, Buffer.concat([dependencyBytes, Buffer.from('\n// drift fixture\n')]))
  await assert.rejects(minifier.verifyUnchanged(), /installed dependency tree.*changed during build/)
  await writeFile(dependencyFile, dependencyBytes)
  assert.equal(await minifier.verifyUnchanged(), true)

  const lockPath = path.join(fixture.packageRoot, 'package-lock.json')
  const lockBytes = await readFile(lockPath)
  await writeFile(lockPath, Buffer.concat([lockBytes, Buffer.from('\n')]))
  await assert.rejects(minifier.verifyUnchanged(), /package files, lock, installed dependency tree/)
  await writeFile(lockPath, lockBytes)
  assert.equal(await minifier.verifyUnchanged(), true)

  const helperBytes = await readFile(fixture.helperPath)
  await writeFile(fixture.helperPath, Buffer.concat([helperBytes, Buffer.from('\n// helper drift fixture\n')]))
  await assert.rejects(minifier.verifyUnchanged(), /package files, lock, installed dependency tree/)
})

test('allows validated .bin execution links and rejects dependency symlinks', async (t) => {
  const fixture = await temporaryPackage(t)
  const binPath = path.join(fixture.nodeModules, '.bin')
  await mkdir(binPath)
  await symlink('../terser/bin/terser', path.join(binPath, 'terser'))
  const commandShim = path.join(binPath, 'terser.cmd')
  await writeFile(commandShim, '@echo off\r\nterser %*\r\n')
  const { createRendererPostMinifier } = await importMinifierFactory()
  const minifier = await createRendererPostMinifier({ packageRoot: fixture.packageRoot, expectedVersion })
  assert.equal(await minifier.verifyUnchanged(), true)
  assert.ok(minifier.provenance.excludedNodeModulesPaths.some(item => item.startsWith('.bin/')))

  const target = path.join(fixture.nodeModules, 'terser/bin/terser')
  const targetBytes = await readFile(target)
  await writeFile(target, Buffer.concat([targetBytes, Buffer.from('\n// target drift fixture\n')]))
  await assert.rejects(minifier.verifyUnchanged(), /installed dependency tree.*changed during build/)
  await writeFile(target, targetBytes)
  assert.equal(await minifier.verifyUnchanged(), true)

  const shimBytes = await readFile(commandShim)
  await writeFile(commandShim, Buffer.concat([shimBytes, Buffer.from('rem drift fixture\r\n')]))
  await assert.rejects(minifier.verifyUnchanged(), /installed dependency tree.*changed during build/)
  await writeFile(commandShim, shimBytes)
  assert.equal(await minifier.verifyUnchanged(), true)

  const outsideFile = path.join(fixture.packageRoot, 'outside-script')
  await writeFile(outsideFile, 'outside')
  await symlink(outsideFile, path.join(binPath, 'escape'))
  await assert.rejects(minifier.verifyUnchanged(), /node_modules\/.bin link escapes the installed tree/)

  await rm(path.join(binPath, 'escape'))
  await symlink('terser', path.join(fixture.nodeModules, 'unexpected-link'))
  await assert.rejects(minifier.verifyUnchanged(), /symlink is not allowed in installed dependency tree/)
})

test('rejects missing dependencies and installed tree roots that escape the package', async (t) => {
  const missing = await temporaryPackage(t)
  await rm(path.join(missing.nodeModules, 'terser'), { recursive: true })
  const { createRendererPostMinifier } = await importMinifierFactory()
  await assert.rejects(
    createRendererPostMinifier({ packageRoot: missing.packageRoot, expectedVersion }),
    /locked dependency is missing from node_modules: node_modules\/terser/
  )

  const missingTransitive = await temporaryPackage(t)
  await rm(path.join(missingTransitive.nodeModules, 'commander'), { recursive: true })
  await assert.rejects(
    createRendererPostMinifier({ packageRoot: missingTransitive.packageRoot, expectedVersion }),
    /locked dependency is missing from node_modules: node_modules\/commander/
  )

  const escaped = await temporaryPackage(t)
  await rm(escaped.nodeModules, { recursive: true })
  await symlink(nodeModulesPath, escaped.nodeModules)
  await assert.rejects(
    createRendererPostMinifier({ packageRoot: escaped.packageRoot, expectedVersion }),
    /node_modules must be an ordinary directory/
  )
})
