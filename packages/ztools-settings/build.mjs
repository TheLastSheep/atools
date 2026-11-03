#!/usr/bin/env node
import { builtinModules } from 'node:module'
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertSnapshotUnchanged,
  assertUpstreamUnchanged,
  createStagedSource,
  hashFiles,
  hashLocalFile,
  isInside,
  readJson,
  sha256,
  verifyLocalDependencies,
  verifyUpstream
} from './src/build-integrity.mjs'
import { assertSettingsBundleBudget, inspectEmittedResources, measureDistribution } from './src/output-audit.mjs'
import {
  runTypeChecks,
  typecheckCaptureComplete,
  typeChecksPassed,
  writeTypecheckLogs
} from './src/typecheck-runner.mjs'
import {
  applySettingsSourceCompatibility,
  SOURCE_COMPATIBILITY_INPUTS
} from './src/source-compatibility.mjs'
import {
  assertHostBridgeSourcesUnchanged,
  captureHostBridgeSources,
  hostBridgeSourcesProvenance,
  stageHostBridgeEntry
} from './src/host-bridge-build.mjs'
import { emitSettingsBundle } from './src/bundle-settings-stage.mjs'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(packageRoot, '../..')
const manifestPath = path.join(packageRoot, 'source-manifest.json')
const forbiddenBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = {
    upstream: process.env.ATOOLS_ZTOOLS_SOURCE,
    bridgeEntry: null,
    checkOnly: false,
    reviewBundle: false
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (seen.has(token)) fail(`Duplicate argument: ${token}`)
    seen.add(token)
    if (token === '--upstream' || token === '--bridge-entry') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail(`${token} requires an absolute path`)
      if (!path.isAbsolute(value)) fail(`${token} must be an absolute path`)
      if (token === '--upstream') options.upstream = value
      else options.bridgeEntry = value
      index += 1
    } else if (token === '--check-only') {
      options.checkOnly = true
    } else if (token === '--review-bundle') {
      options.reviewBundle = true
    } else {
      fail(`Unknown argument: ${token}`)
    }
  }
  if (!options.upstream) fail('Pass --upstream <absolute ZTools checkout> or set ATOOLS_ZTOOLS_SOURCE')
  if (options.checkOnly && options.reviewBundle) fail('--review-bundle cannot be combined with --check-only')
  return options
}

async function assertCapturedDependenciesUnchanged(capturedFiles) {
  for (const [filePath, expected] of capturedFiles) {
    const bytes = await readFile(filePath)
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
      fail(`Installed dependency source changed during build: ${expected.key}`)
    }
  }
}

function capturedDependencyDigest(capturedFiles) {
  const hashInput = [...capturedFiles.values()].sort((left, right) => (
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  ))
  const hash = sha256(Buffer.from(hashInput.map((item) => `${item.key}\0${item.sha256}\0`).join('')))
  return { files: hashInput.length, sha256: hash }
}

async function replaceGeneratedDistribution(temporaryOutput, distributionPath, artifactOwner) {
  let info
  try {
    info = await lstat(distributionPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await rename(temporaryOutput, distributionPath)
    return
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('Refusing to replace packages/ztools-settings/dist because it is not a regular directory')
  }
  const previousMarker = path.join(distributionPath, 'build-provenance.json')
  const previousMarkerInfo = await lstat(previousMarker).catch(() => null)
  if (!previousMarkerInfo || previousMarkerInfo.isSymbolicLink() || !previousMarkerInfo.isFile()) {
    fail('Refusing to replace dist without a regular build-provenance.json ownership marker')
  }
  const previous = await readJson(previousMarker).catch(() => null)
  if (previous?.artifactOwner !== artifactOwner) {
    fail('Refusing to replace dist without this builder\'s ownership marker')
  }

  const backupPath = path.join(packageRoot, `.ztools-settings-dist-backup-${process.pid}`)
  try {
    await lstat(backupPath)
    fail(`Refusing to reuse existing build backup path: ${backupPath}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await rename(distributionPath, backupPath)
  try {
    await rename(temporaryOutput, distributionPath)
  } catch (error) {
    await rename(backupPath, distributionPath)
    throw error
  }
  await rm(backupPath, { recursive: true, force: true })
}

async function buildSettings(reviewBundle, manifest, upstream, dependencies, bridgeSnapshot, hostBridgeSources, localInputs) {
  const outputRelative = reviewBundle ? manifest.build.reviewOutputRoot : manifest.build.outputRoot
  const distributionPath = path.resolve(repositoryRoot, outputRelative)
  if (!isInside(packageRoot, distributionPath) || distributionPath === packageRoot) {
    fail('Build output must stay under packages/ztools-settings')
  }
  const artifactOwner = reviewBundle
    ? '@atools/ztools-settings-review-bundle'
    : '@atools/ztools-settings-source-build'
  const temporaryRoot = await mkdtemp(path.join(packageRoot, '.ztools-settings-build-'))
  const temporaryOutput = path.join(temporaryRoot, 'dist')
  try {
    const stage = await createStagedSource(upstream, packageRoot, temporaryRoot)
    const sourceCompatibility = await applySettingsSourceCompatibility(stage.root)
    const stagedBridge = await stageHostBridgeEntry(stage.root, bridgeSnapshot, hostBridgeSources)
    await assertHostBridgeSourcesUnchanged(hostBridgeSources)
    const effectiveSourceHash = await hashFiles(stage.root, upstream.files)
    const typecheckRuns = runTypeChecks(stage.root, dependencies.packageRecords, manifest)
    const typecheckPassed = typeChecksPassed(typecheckRuns)
    if (!typecheckCaptureComplete(typecheckRuns)) {
      console.log(JSON.stringify({
        ok: false,
        mode: reviewBundle ? 'review-bundle' : 'strict',
        typecheckPassed: false,
        candidateCreated: false,
        typeChecks: typecheckRuns.map(({ stdout, stderr, ...summary }) => summary)
      }, null, 2))
      fail('Typecheck output was incomplete; Vite was not run and no distribution was written')
    }
    if (!typecheckPassed && !reviewBundle) {
      console.log(JSON.stringify({
        ok: false,
        mode: 'strict',
        typecheckPassed: false,
        candidateCreated: false,
        typeChecks: typecheckRuns.map(({ stdout, stderr, ...summary }) => summary)
      }, null, 2))
      fail('Strict typecheck failed; Vite was not run and no dist output was written')
    }
    if (reviewBundle && !typecheckPassed) {
      console.log(JSON.stringify({
        ok: false,
        mode: 'review-bundle',
        status: 'review-only/typecheck-failed',
        typecheckPassed: false,
        candidateCreated: false,
        typeChecks: typecheckRuns.map(({ stdout, stderr, ...summary }) => summary)
      }, null, 2))
    }

    const { capturedFiles, hostBridgeRuntimeImports } = await emitSettingsBundle({
      packageRoot,
      stage,
      manifest,
      temporaryRoot,
      temporaryOutput,
      upstream,
      hostBridgeSources
    })

    await assertUpstreamUnchanged(upstream)
    await assertCapturedDependenciesUnchanged(capturedFiles)
    await assertHostBridgeSourcesUnchanged(hostBridgeSources)
    const stagedAfterBuild = await hashFiles(stage.root, upstream.files)
    if (stagedAfterBuild.sha256 !== effectiveSourceHash.sha256
      || stagedAfterBuild.files !== effectiveSourceHash.files
      || stagedAfterBuild.bytes !== effectiveSourceHash.bytes) {
      fail('The isolated compatibility-patched staging copy changed while compiling')
    }
    for (const input of localInputs) await assertSnapshotUnchanged(input.snapshot, input.absolutePath)
    const dependenciesAfterBuild = await verifyLocalDependencies(packageRoot, manifest)
    if (dependenciesAfterBuild.packageLockSha256 !== dependencies.packageLockSha256) {
      fail('The isolated npm lock changed during the build')
    }
    for (const [name, dependency] of Object.entries(dependencies.packageRecords)) {
      if (dependenciesAfterBuild.packageRecords[name]?.packageManifestSha256 !== dependency.packageManifestSha256) {
        fail(`Installed dependency manifest changed during the build: ${name}`)
      }
    }

    const emitted = await inspectEmittedResources(
      temporaryOutput,
      [upstream.root, repositoryRoot, temporaryRoot],
      new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
    )
    const bundleBudget = assertSettingsBundleBudget(emitted, manifest.build.emittedResourceBudget)
    const typeChecks = reviewBundle
      ? await writeTypecheckLogs(temporaryOutput, typecheckRuns)
      : typecheckRuns.map(({ stdout, stderr, ...summary }) => summary)
    await copyFile(path.join(stage.root, 'LICENSE'), path.join(temporaryOutput, 'ZTools-LICENSE'))
    await copyFile(path.join(stage.root, 'package.json'), path.join(temporaryOutput, 'upstream-package.json'))
    await copyFile(manifestPath, path.join(temporaryOutput, 'source-manifest.json'))

    const dependencyModuleFiles = capturedDependencyDigest(capturedFiles)
    const packageLock = dependencies.packageLockSha256
    const buildProvenance = {
      schemaVersion: 1,
      artifactOwner,
      status: reviewBundle
        ? (typecheckPassed ? 'review-only/typecheck-passed' : 'review-only/typecheck-failed')
        : 'strict/typecheck-passed',
      typecheckPassed,
      source: {
        repository: manifest.source.repository,
        commit: upstream.commit,
        workingTreeClean: true,
        inputRoots: [manifest.source.settingRoot, manifest.source.sharedRoot],
        metadataInputs: manifest.source.metadataInputs,
        inputFiles: upstream.sourceHash.files,
        inputBytes: upstream.sourceHash.bytes,
        inputSha256: upstream.sourceHash.sha256
      },
      sourceCompatibility: {
        ...sourceCompatibility,
        effectiveInput: {
          files: effectiveSourceHash.files,
          bytes: effectiveSourceHash.bytes,
          sha256: effectiveSourceHash.sha256
        }
      },
      build: {
        outputRoot: outputRelative,
        nodeVersion: process.version,
        typecheckPassed,
        packageLockSha256: packageLock,
        typeChecks,
        bridgeEntry: {
          ...stagedBridge,
          path: bridgeSnapshot.path,
          bytes: bridgeSnapshot.bytes,
          sha256: bridgeSnapshot.sha256,
          status: 'staged before strict typecheck; host API behavior remains unverified'
        },
        hostBridgeSources: hostBridgeSourcesProvenance(hostBridgeSources, hostBridgeRuntimeImports, bridgeSnapshot.path),
        localBuildInputs: localInputs.map(({ snapshot }) => ({
          path: snapshot.path,
          bytes: snapshot.bytes,
          sha256: snapshot.sha256
        }))
      },
      dependencies: Object.fromEntries(Object.entries(dependencies.packageRecords)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, item]) => [name, {
          version: item.version,
          packageManifestSha256: item.packageManifestSha256
        }])),
      capturedDependencyModuleFiles: dependencyModuleFiles,
      bundleBudget,
      emittedResources: emitted.resources,
      emittedResourceCount: emitted.resources.length,
      emittedResourceTotalBytes: emitted.totalBytes
    }
    await writeFile(path.join(temporaryOutput, 'build-provenance.json'), `${JSON.stringify(buildProvenance, null, 2)}\n`)
    const distribution = await measureDistribution(temporaryOutput)
    await replaceGeneratedDistribution(temporaryOutput, distributionPath, artifactOwner)
    console.log(JSON.stringify({
      ok: typecheckPassed,
      status: buildProvenance.status,
      reviewOnly: reviewBundle,
      typecheckPassed,
      candidateCreated: reviewBundle,
      output: outputRelative,
      sourceCommit: upstream.commit,
      inputFiles: upstream.sourceHash.files,
      inputBytes: upstream.sourceHash.bytes,
      inputSha256: upstream.sourceHash.sha256,
      effectiveInputSha256: effectiveSourceHash.sha256,
      compatibilityPatchedFiles: sourceCompatibility.patchedFiles.length,
      bridgeEntry: bridgeSnapshot.path,
      bridgeSha256: bridgeSnapshot.sha256,
      emittedResourceCount: emitted.resources.length,
      emittedResourceBytes: emitted.totalBytes,
      bundleBudget,
      distributionFileCount: distribution.files.length,
      distributionBytes: distribution.totalBytes,
      dependencyVersions: manifest.dependencyVersions
    }, null, 2))
    return { typecheckPassed }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function snapshotLocalBuildInputs() {
  const relativePaths = new Set([
    'packages/ztools-settings/build.mjs',
    'packages/ztools-settings/source-manifest.json',
    'packages/ztools-settings/package.json',
    'packages/ztools-settings/package-lock.json',
    'packages/ztools-settings/src/build-integrity.mjs',
    'packages/ztools-settings/src/output-audit.mjs',
    'packages/ztools-settings/src/typecheck-runner.mjs',
    'packages/ztools-settings/src/source-compatibility.mjs',
    'packages/ztools-settings/src/host-bridge-build.mjs',
    'packages/ztools-settings/src/bundle-settings-stage.mjs',
    ...SOURCE_COMPATIBILITY_INPUTS
  ])
  const snapshots = []
  for (const relative of relativePaths) {
    const absolutePath = path.join(repositoryRoot, relative)
    snapshots.push({ snapshot: await hashLocalFile(repositoryRoot, absolutePath), absolutePath })
  }
  return snapshots
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await readJson(manifestPath)
  if (process.version !== manifest.build.nodeVersion) {
    fail(`Use the product Node ${manifest.build.nodeVersion}; current runtime is ${process.version}`)
  }
  const localInputs = await snapshotLocalBuildInputs()
  const hostBridgeSources = await captureHostBridgeSources(repositoryRoot)
  const defaultBridgePath = path.join(repositoryRoot, manifest.build.bridgeEntry)
  const bridgePath = options.bridgeEntry ?? defaultBridgePath
  if (!path.isAbsolute(bridgePath)) fail('--bridge-entry must be an absolute path')
  const bridgeSnapshot = await hashLocalFile(repositoryRoot, bridgePath)
  if (!hostBridgeSources.files.some((file) => file.path === bridgeSnapshot.path)) {
    fail('Bridge entry must be inside the captured packages/ztools-settings/src TypeScript set')
  }
  const upstream = await verifyUpstream(options.upstream, manifest)
  const dependencies = await verifyLocalDependencies(packageRoot, manifest)

  if (options.checkOnly) {
    for (const input of localInputs) await assertSnapshotUnchanged(input.snapshot, input.absolutePath)
    await assertHostBridgeSourcesUnchanged(hostBridgeSources)
    console.log(JSON.stringify({
      ok: true,
      mode: 'check-only',
      sourceCommit: upstream.commit,
      sourceFiles: upstream.sourceHash.files,
      sourceBytes: upstream.sourceHash.bytes,
      sourceSha256: upstream.sourceHash.sha256,
      nodeVersion: process.version,
      bridgeEntry: bridgeSnapshot.path,
      bridgeBytes: bridgeSnapshot.bytes,
      bridgeSha256: bridgeSnapshot.sha256,
      packageLockSha256: dependencies.packageLockSha256,
      dependencyVersions: manifest.dependencyVersions
    }, null, 2))
    return
  }

  const result = await buildSettings(
    options.reviewBundle,
    manifest,
    upstream,
    dependencies,
    bridgeSnapshot,
    hostBridgeSources,
    localInputs
  )
  if (options.reviewBundle && !result.typecheckPassed) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[ztools-settings-build] ${error.message}`)
  process.exitCode = 1
})
