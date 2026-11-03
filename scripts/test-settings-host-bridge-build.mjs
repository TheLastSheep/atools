import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertHostBridgeSourcesUnchanged,
  captureHostBridgeSources,
  hostBridgeSourceGuardPlugin,
  stageHostBridgeEntry
} from '../packages/ztools-settings/src/host-bridge-build.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function makeSourceRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-host-bridge-test-'))
  const sourceRoot = path.join(root, 'packages/ztools-settings/src')
  await mkdir(path.join(sourceRoot, 'nested'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'hostBridgeEntry.ts'), 'export const entry = true\n')
  await writeFile(path.join(sourceRoot, 'nested/childBridge.ts'), 'export const child = true\n')
  return { root: await realpath(root), sourceRoot }
}

test('stages a real import ahead of typecheck and preserves the original entry body', async () => {
  const fixture = await makeSourceRoot()
  const stageRoot = path.join(fixture.root, 'stage')
  const stagedEntry = path.join(stageRoot, 'internal-plugins/setting/src/main.ts')
  const original = 'import { createApp } from "vue"\ncreateApp()\n'
  await mkdir(path.dirname(stagedEntry), { recursive: true })
  await writeFile(stagedEntry, original)
  try {
    const sources = await captureHostBridgeSources(fixture.root)
    const bridgeSnapshot = sources.files.find((file) => file.path.endsWith('/hostBridgeEntry.ts'))
    const audit = await stageHostBridgeEntry(stageRoot, bridgeSnapshot, sources)
    const staged = await readFile(stagedEntry, 'utf8')
    const bridgeWithoutExtension = bridgeSnapshot.absolutePath.slice(0, -'.ts'.length)

    assert.ok(staged.startsWith(`import ${JSON.stringify(bridgeWithoutExtension)};\n`))
    assert.equal(staged.slice(staged.indexOf('\n') + 1), original)
    assert.equal(audit.bridgePath, bridgeSnapshot.path)
    assert.equal(audit.beforeSha256.length, 64)
    assert.equal(audit.afterSha256.length, 64)

    const buildSource = await readFile(path.join(repositoryRoot, 'packages/ztools-settings/build.mjs'), 'utf8')
    assert.ok(buildSource.indexOf('stageHostBridgeEntry(') < buildSource.indexOf('runTypeChecks('))
    assert.doesNotMatch(buildSource, /bridgeInjectionPlugin/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('captures all local TypeScript sources and detects edits and additions', async () => {
  const fixture = await makeSourceRoot()
  try {
    const initial = await captureHostBridgeSources(fixture.root)
    assert.equal(initial.count, 2)
    assert.ok(initial.bytes > 0)
    assert.equal(initial.files.filter((file) => file.path.endsWith('.ts')).length, 2)

    await writeFile(path.join(fixture.sourceRoot, 'nested/childBridge.ts'), 'export const changed = true\n')
    await assert.rejects(assertHostBridgeSourcesUnchanged(initial), /changed during the build/)

    const afterEdit = await captureHostBridgeSources(fixture.root)
    await writeFile(path.join(fixture.sourceRoot, 'newBridge.ts'), 'export const added = true\n')
    await assert.rejects(assertHostBridgeSourcesUnchanged(afterEdit), /changed during the build/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects symlink source files and imports outside the locked source closure', async (t) => {
  const fixture = await makeSourceRoot()
  const outside = path.join(fixture.root, 'outside.mjs')
  await writeFile(outside, 'export const escaped = true\n')
  try {
    const sources = await captureHostBridgeSources(fixture.root)
    const entry = sources.files.find((file) => file.path.endsWith('/hostBridgeEntry.ts'))
    const stageRoot = path.join(fixture.root, 'stage')
    const nodeModulesRoot = path.join(fixture.root, 'node_modules')
    const plugin = hostBridgeSourceGuardPlugin({
      sources,
      stageRoot,
      upstreamFiles: [],
      nodeModulesRoot,
      runtimeImports: new Set()
    })
    await assert.rejects(
      plugin.resolveId.call({ resolve: async () => ({ id: outside, external: false }) }, './outside.mjs', entry.absolutePath),
      /escaped the captured source closure/
    )

    if (process.platform === 'win32') {
      t.skip('filesystem symlink creation is not available in this environment')
      return
    }
    await symlink(path.join(fixture.sourceRoot, 'hostBridgeEntry.ts'), path.join(fixture.sourceRoot, 'linked.ts'))
    await assert.rejects(captureHostBridgeSources(fixture.root), /Symlinks are not allowed/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed on an imported local mjs file outside the captured TypeScript set', async () => {
  const fixture = await makeSourceRoot()
  const runtimeHelper = path.join(fixture.root, 'packages/ztools-settings/src/runtime.mjs')
  await writeFile(runtimeHelper, 'export const runtime = true\n')
  try {
    const sources = await captureHostBridgeSources(fixture.root)
    const entry = sources.files.find((file) => file.path.endsWith('/hostBridgeEntry.ts'))
    const plugin = hostBridgeSourceGuardPlugin({
      sources,
      stageRoot: path.join(fixture.root, 'stage'),
      upstreamFiles: [],
      nodeModulesRoot: path.join(fixture.root, 'node_modules'),
      runtimeImports: new Set()
    })
    await assert.rejects(
      plugin.resolveId.call({ resolve: async () => ({ id: runtimeHelper, external: false }) }, './runtime.mjs', entry.absolutePath),
      /outside the captured TypeScript set/
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('allows the original Toast only from the pinned staged settings source', async () => {
  const fixture = await makeSourceRoot()
  const toastRelative = 'internal-plugins/setting/src/components/common/Toast/Toast.vue'
  const toast = path.join(fixture.root, 'stage', toastRelative)
  await mkdir(path.dirname(toast), { recursive: true })
  await writeFile(toast, '<template><div>toast</div></template>\n')
  try {
    const sources = await captureHostBridgeSources(fixture.root)
    const entry = sources.files.find((file) => file.path.endsWith('/hostBridgeEntry.ts'))
    const plugin = hostBridgeSourceGuardPlugin({
      sources,
      stageRoot: path.join(fixture.root, 'stage'),
      upstreamFiles: [toastRelative],
      nodeModulesRoot: path.join(fixture.root, 'node_modules'),
      runtimeImports: new Set()
    })
    const resolved = await plugin.resolveId.call(
      { resolve: async () => ({ id: toast, external: false }) },
      '@/components/common/Toast/Toast',
      entry.absolutePath
    )
    assert.equal(resolved, null)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
