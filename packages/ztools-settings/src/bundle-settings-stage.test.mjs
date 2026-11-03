import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createSettingsViteOptions,
  SETTINGS_PURE_DIAGNOSTIC_CALLS
} from './bundle-settings-stage.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRequire = createRequire(path.join(packageRoot, 'package.json'))
const esbuild = localRequire('esbuild')

function makeOptions() {
  const stage = {
    settingRoot: '/tmp/settings-stage/setting',
    root: '/tmp/settings-stage/upstream'
  }
  const hostBridgeSources = { files: [] }
  const hostBridgeRuntimeImports = new Set()
  const packages = {
    vite: {},
    vuePlugin: () => ({ name: 'vue' }),
    unoCss: () => ({ name: 'unocss' })
  }
  const options = createSettingsViteOptions({
    stage,
    manifest: { build: { base: './', entryHtml: 'index.html' } },
    temporaryRoot: '/tmp/settings-stage',
    temporaryOutput: '/tmp/settings-stage/dist',
    nodeModulesRoot: '/tmp/settings-package/node_modules',
    upstream: { files: [] },
    hostBridgeSources,
    capturedFiles: new Map(),
    hostBridgeRuntimeImports,
    packages
  })
  return { options, hostBridgeRuntimeImports }
}

test('build emission preserves plugin order and uses pure diagnostic calls only', () => {
  const { options } = makeOptions()
  assert.deepEqual(options.plugins.map((plugin) => plugin.name), [
    'atools-settings-reject-node-runtime',
    'atools-settings-capture-dependency-inputs',
    'atools-settings-host-bridge-source-guard',
    'vue',
    'unocss'
  ])
  assert.deepEqual(options.esbuild.pure, [
    'console.log',
    'console.debug',
    'console.info'
  ])
  assert.equal(options.esbuild.drop, undefined)
  assert.deepEqual(SETTINGS_PURE_DIAGNOSTIC_CALLS, options.esbuild.pure)
  assert.deepEqual(options.resolve.dedupe, ['vue'])
  assert.equal(options.base, './')
  assert.equal(options.build.sourcemap, false)
})

test('esbuild removes diagnostic calls while retaining argument side effects and warnings', async () => {
  const { options } = makeOptions()
  const transformed = await esbuild.transform(`
    function retain(value) { globalThis.sideEffects.push(value) }
    console.log(retain('log'))
    console.debug(retain('debug'))
    console.info(retain('info'))
    console.warn(retain('warn'))
    console.error(retain('error'))
  `, {
    loader: 'js',
    minify: true,
    pure: options.esbuild.pure
  })

  assert.doesNotMatch(transformed.code, /console\.(?:log|debug|info)\(/)
  for (const value of ['log', 'debug', 'info', 'warn', 'error']) {
    assert.match(transformed.code, new RegExp(`retain\\(["']${value}["']\\)`))
  }
  assert.match(transformed.code, /console\.warn\(/)
  assert.match(transformed.code, /console\.error\(/)
})
