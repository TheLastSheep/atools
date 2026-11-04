import assert from 'node:assert/strict'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isInside, sha256 } from '../packages/ztools-settings/src/build-integrity.mjs'
import { assertSettingsBundleBudget } from '../packages/ztools-settings/src/output-audit.mjs'
import { captureSettingsNativeSources } from './lib/ztools-settings-native-sources.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(repositoryRoot, 'packages/ztools-settings')
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'source-manifest.json'), 'utf8'))
const policy = manifest.build?.emittedResourceBudget
const legacyPolicy = Object.freeze({
  metric: 'uncompressed_emitted_resources_bytes',
  baselineBytes: 771693,
  maxIncreaseBytes: 8192,
  maxBytes: 786432
})
const disabledCommandsPolicy = Object.freeze({
  metric: 'uncompressed_emitted_resources_bytes',
  baselineBytes: 779464,
  maxIncreaseBytes: 4096,
  maxBytes: 786432
})
const mainHotkeyPolicy = Object.freeze({
  metric: 'uncompressed_emitted_resources_bytes',
  baselineBytes: 784315,
  maxIncreaseBytes: 2048,
  maxBytes: 786432
})
const launchAtLoginPolicy = Object.freeze({
  metric: 'uncompressed_emitted_resources_bytes',
  baselineBytes: 784315,
  maxIncreaseBytes: 6144,
  maxBytes: 790528
})
const allowedMetadataFiles = Object.freeze([
  'build-provenance.json',
  'ZTools-LICENSE',
  'upstream-package.json',
  'source-manifest.json'
])

function resource(resourcePath, bytes, digest = 'a'.repeat(64)) {
  return { path: resourcePath, bytes, sha256: digest }
}

function emitted(resources, totalBytes = resources.reduce((sum, item) => sum + item.bytes, 0)) {
  return { resources, totalBytes }
}

function emittedAtTotal(totalBytes, extraResources = []) {
  assert.ok(Number.isSafeInteger(totalBytes) && totalBytes >= 2)
  return emitted([
    resource('index.html', 1),
    resource('assets/app.js', 1),
    ...extraResources,
    resource('assets/fill.bin', totalBytes - 2 - extraResources.reduce((sum, item) => sum + item.bytes, 0))
  ])
}

async function enumerateRegularFiles(outputRoot) {
  const rootPath = path.resolve(outputRoot)
  const rootInfo = await lstat(rootPath)
  assert.ok(!rootInfo.isSymbolicLink() && rootInfo.isDirectory(), 'formal output root must be a regular directory')
  const realRoot = await realpath(rootPath)
  const files = new Map()

  async function walk(directory, relativeDirectory = '') {
    const resolvedDirectory = await realpath(directory)
    assert.ok(isInside(realRoot, resolvedDirectory), `${directory} resolves outside formal output root`)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const info = await lstat(absolutePath)
      assert.ok(!info.isSymbolicLink(), `${relativePath} is a symbolic link`)
      if (info.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      assert.ok(info.isFile(), `${relativePath} is not a regular file`)
      const resolvedFile = await realpath(absolutePath)
      assert.ok(isInside(realRoot, resolvedFile), `${relativePath} resolves outside formal output root`)
      const bytes = await readFile(absolutePath)
      const finalInfo = await lstat(absolutePath)
      assert.ok(finalInfo.isFile() && !finalInfo.isSymbolicLink(), `${relativePath} changed to a non-regular resource`)
      assert.ok(isInside(realRoot, await realpath(absolutePath)), `${relativePath} escaped formal output root`)
      files.set(relativePath, { bytes: bytes.byteLength, sha256: sha256(bytes) })
    }
  }

  await walk(rootPath)
  return files
}

async function assertOutputTreeMatchesResources(outputRoot, resources) {
  const actualFiles = await enumerateRegularFiles(outputRoot)
  const emittedPaths = resources.map((item) => item.path)
  const expectedPaths = new Set([...emittedPaths, ...allowedMetadataFiles])
  const actualPaths = new Set(actualFiles.keys())
  const missing = [...expectedPaths].filter((item) => !actualPaths.has(item)).sort()
  const extra = [...actualPaths].filter((item) => !expectedPaths.has(item)).sort()
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`formal output file set mismatch; missing=${missing.join(',')}; extra=${extra.join(',')}`)
  }
  for (const resourceRecord of resources) {
    const observed = actualFiles.get(resourceRecord.path)
    assert.equal(observed.bytes, resourceRecord.bytes, `${resourceRecord.path} byte count differs from provenance`)
    assert.equal(observed.sha256, resourceRecord.sha256, `${resourceRecord.path} digest differs from provenance`)
  }
  return actualFiles
}

async function verifyFormalBuildProvenance() {
  const outputRoot = path.resolve(repositoryRoot, manifest.build.outputRoot)
  const nativeSources = await captureSettingsNativeSources(repositoryRoot, { settingsDist: outputRoot })
  const provenancePath = path.join(outputRoot, 'build-provenance.json')
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'))
  assert.equal(provenance.artifactOwner, '@atools/ztools-settings-source-build')
  assert.equal(provenance.status, 'strict/typecheck-passed')
  assert.equal(provenance.typecheckPassed, true)
  assert.ok(Array.isArray(provenance.emittedResources) && provenance.emittedResources.length > 0)
  assert.equal(provenance.emittedResourceCount, provenance.emittedResources.length)

  const measured = emitted(provenance.emittedResources, provenance.emittedResourceTotalBytes)
  const artifactManifest = JSON.parse(await readFile(path.join(outputRoot, 'source-manifest.json'), 'utf8'))
  const result = assertSettingsBundleBudget(measured, artifactManifest.build?.emittedResourceBudget)
  assert.deepEqual(provenance.bundleBudget, result)
  assert.equal(nativeSources.bundle.resourceCount, measured.resources.length)
  assert.equal(nativeSources.bundle.resourceBytes, result.actualBytes)

  const actualFiles = await assertOutputTreeMatchesResources(outputRoot, measured.resources)
  assert.equal(actualFiles.size, measured.resources.length + allowedMetadataFiles.length)
}

function verifyFrozenPolicy() {
  assert.equal(manifest.build.budgetMilestone, 'original-vue-app-global-shortcuts-settings-2026-11-02')
  assert.deepEqual(policy, { metric: 'uncompressed_emitted_resources_bytes', baselineBytes: 806371, maxIncreaseBytes: 16384, maxBytes: 822755 })
  assert.equal(Math.min(policy.baselineBytes + policy.maxIncreaseBytes, policy.maxBytes), 822755)
}

function verifyLegacyPolicyBoundary() {
  const boundary = legacyPolicy.baselineBytes + legacyPolicy.maxIncreaseBytes
  assert.equal(
    assertSettingsBundleBudget(emittedAtTotal(boundary), legacyPolicy).increaseBytes,
    legacyPolicy.maxIncreaseBytes
  )
  assert.throws(
    () => assertSettingsBundleBudget(emittedAtTotal(boundary + 1), legacyPolicy),
    /budget exceeded/
  )
}

function verifyDisabledCommandsPolicyBoundary() {
  const boundary = disabledCommandsPolicy.baselineBytes + disabledCommandsPolicy.maxIncreaseBytes
  assert.equal(
    assertSettingsBundleBudget(emittedAtTotal(boundary), disabledCommandsPolicy).increaseBytes,
    disabledCommandsPolicy.maxIncreaseBytes
  )
  assert.throws(
    () => assertSettingsBundleBudget(emittedAtTotal(boundary + 1), disabledCommandsPolicy),
    /budget exceeded/
  )
}

function verifyDeltaBoundaries() {
  const deltaBoundary = policy.baselineBytes + policy.maxIncreaseBytes
  const boundaryResult = assertSettingsBundleBudget(emittedAtTotal(deltaBoundary), policy)
  assert.equal(boundaryResult.increaseBytes, policy.maxIncreaseBytes)
  assert.equal(boundaryResult.passed, true)
  assert.throws(
    () => assertSettingsBundleBudget(emittedAtTotal(deltaBoundary + 1), policy),
    /budget exceeded/
  )
}

function verifyMainHotkeyEffectiveBoundary() {
  const boundary = Math.min(
    mainHotkeyPolicy.baselineBytes + mainHotkeyPolicy.maxIncreaseBytes,
    mainHotkeyPolicy.maxBytes
  )
  assert.equal(assertSettingsBundleBudget(emittedAtTotal(boundary), mainHotkeyPolicy).passed, true)
  assert.throws(
    () => assertSettingsBundleBudget(emittedAtTotal(boundary + 1), mainHotkeyPolicy),
    /budget exceeded/
  )
}

function verifyAbsoluteBoundary() {
  const absolutePolicy = {
    ...policy,
    maxIncreaseBytes: 40000,
    maxBytes: policy.baselineBytes + 20000
  }
  assert.equal(
    assertSettingsBundleBudget(emittedAtTotal(absolutePolicy.maxBytes), absolutePolicy).passed,
    true
  )
  assert.throws(
    () => assertSettingsBundleBudget(emittedAtTotal(absolutePolicy.maxBytes + 1), absolutePolicy),
    /budget exceeded/
  )
}

function verifyAllResourceTypesAreCounted() {
  const overflow = policy.baselineBytes + policy.maxIncreaseBytes + 1
  for (const resourcePath of ['assets/theme.css', 'assets/background.png']) {
    const extra = [resource(resourcePath, overflow - 2)]
    assert.throws(
      () => assertSettingsBundleBudget(emittedAtTotal(overflow, extra), policy),
      /budget exceeded/,
      `${resourcePath} bytes must contribute to the complete emitted-resource sum`
    )
  }
}

function verifyMalformedInputsFailClosed() {
  const validEmitted = emittedAtTotal(policy.baselineBytes)
  assert.throws(() => assertSettingsBundleBudget(validEmitted, undefined), /policy is missing or invalid/)
  assert.throws(
    () => assertSettingsBundleBudget(validEmitted, { ...policy, metric: 'gzip_bytes' }),
    /Unsupported settings bundle budget metric/
  )
  assert.throws(
    () => assertSettingsBundleBudget(validEmitted, { ...policy, baselineBytes: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integer/
  )
  assert.throws(
    () => assertSettingsBundleBudget(validEmitted, { ...policy, maxBytes: policy.baselineBytes - 1 }),
    /maxBytes may not be lower/
  )
  const missingPolicyField = { ...policy }
  delete missingPolicyField.maxBytes
  assert.throws(() => assertSettingsBundleBudget(validEmitted, missingPolicyField), /must contain exactly/)

  assert.throws(
    () => assertSettingsBundleBudget(emitted(validEmitted.resources, validEmitted.totalBytes + 1), policy),
    /does not match resource sum/
  )
  assert.throws(
    () => assertSettingsBundleBudget(emitted([
      resource('index.html', 1),
      resource('assets/app.js', Number.MAX_SAFE_INTEGER + 1)
    ]), policy),
    /safe integer/
  )
  assert.throws(
    () => assertSettingsBundleBudget(emitted([
      resource('index.html', 1),
      resource('index.html', 1),
      resource('assets/app.js', 1)
    ]), policy),
    /duplicate path/
  )
}

async function createOutputFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'atools-settings-budget-fixture-'))
  const resources = [
    resource('index.html', Buffer.byteLength('<html></html>')),
    resource('assets/app.js', Buffer.byteLength('export const fixture = true'))
  ]
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'index.html'), '<html></html>')
  await writeFile(path.join(root, 'assets/app.js'), 'export const fixture = true')
  for (const metadataPath of allowedMetadataFiles) {
    await writeFile(path.join(root, metadataPath), `metadata:${metadataPath}`)
  }
  const provenance = resources.map((item) => {
    return { ...item, sha256: sha256(Buffer.from(item.path === 'index.html' ? '<html></html>' : 'export const fixture = true')) }
  })
  return { root, resources: provenance }
}

async function verifyOutputTreeRejectsExtrasAndSymlinks() {
  {
    const fixture = await createOutputFixture()
    try {
      await assertOutputTreeMatchesResources(fixture.root, fixture.resources)
      await writeFile(path.join(fixture.root, 'unlisted-extra.css'), '.extra { display: none; }')
      await assert.rejects(
        () => assertOutputTreeMatchesResources(fixture.root, fixture.resources),
        /formal output file set mismatch.*unlisted-extra\.css/
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }

  {
    const fixture = await createOutputFixture()
    try {
      const target = path.join(fixture.root, 'assets/app.js')
      const sameContent = path.join(fixture.root, 'assets/same-content.js')
      await writeFile(sameContent, await readFile(target))
      await rm(target)
      await symlink(sameContent, target)
      await assert.rejects(
        () => assertOutputTreeMatchesResources(fixture.root, fixture.resources),
        /assets\/app\.js is a symbolic link/
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
}

verifyFrozenPolicy()
verifyLegacyPolicyBoundary()
verifyDisabledCommandsPolicyBoundary()
await verifyFormalBuildProvenance()
verifyDeltaBoundaries()
verifyMainHotkeyEffectiveBoundary()
verifyAbsoluteBoundary()
verifyAllResourceTypesAreCounted()
verifyMalformedInputsFailClosed()
await verifyOutputTreeRejectsExtrasAndSymlinks()
process.stdout.write('settings emitted resource budget checks passed\n')
