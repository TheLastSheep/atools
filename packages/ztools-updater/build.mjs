#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, readdir, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  capturePinnedSource,
  captureDependencyClosure,
  snapshotFiles,
  sha256,
  guardedModuleCapture
} from '../ztools-build/pinned-inputs.mjs'
import { createRendererPostMinifier } from '../ztools-renderer/post-minifier.mjs'
import { publishBuildOutput } from '../ztools-renderer/output-transaction.mjs'
import { auditWebviewOutput } from '../ztools-build/webview-output.mjs'
import {
  runTypeChecks,
  typeChecksPassed,
  writeTypecheckLogs
} from '../ztools-settings/src/typecheck-runner.mjs'
import { createUpdaterStage } from './src/buildStage.mjs'
import { assertUpdaterBudget } from './src/buildPolicy.mjs'
const packageRoot = path.dirname(fileURLToPath(import.meta.url)),
  repository = path.resolve(packageRoot, '../..')
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'source-manifest.json'), 'utf8'))
assert.equal(process.version, manifest.build.nodeVersion)
assert.equal(manifest.owner, 'atools')
assert.equal(manifest.role, 'original-updater')
assert.equal(manifest.build.output, 'dist-ztools-updater')
assert.equal(manifest.source.commit, '9b15fb1a2a9f3ec886016632761c7bb21e39557a')
const args = process.argv.slice(2),
  allowed = new Set(['--upstream', '--check-only'])
let upstream = process.env.ATOOLS_ZTOOLS_SOURCE,
  checkOnly = false
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown build argument ${args[i]}`)
  if (args[i] === '--upstream') {
    upstream = args[++i]
    if (!upstream || !path.isAbsolute(upstream)) throw new Error('Absolute upstream path required')
  } else checkOnly = true
}
if (!upstream) throw new Error('Pass --upstream or ATOOLS_ZTOOLS_SOURCE')
const evidence = path.join(repository, 'output/renderer-updater-r78-2026-11-02/build', randomUUID())
await mkdir(evidence, { recursive: true })
const temporary = await mkdtemp(path.join(repository, '.scratch/updater-build-'))
try {
  const requiredBuildInputs = new Set([
    'package.json',
    'pnpm-lock.yaml',
    'packages/ztools-updater/source-manifest.json',
    'packages/ztools-updater/package.json'
  ])
  async function addBuildClosure(file) {
    const relative = path.relative(repository, file).split(path.sep).join('/')
    if (requiredBuildInputs.has(relative)) return
    requiredBuildInputs.add(relative)
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) {
        const target = path.resolve(path.dirname(file), match[1])
        if (target.endsWith('.mjs')) await addBuildClosure(target)
      }
    }
  }
  await addBuildClosure(fileURLToPath(import.meta.url))
  for (const file of await readdir(path.join(packageRoot, 'src')))
    if (/\.(ts|mjs)$/.test(file)) await addBuildClosure(path.join(packageRoot, 'src', file))
  const sourceBefore = await capturePinnedSource(
    upstream,
    manifest.source.commit,
    manifest.source.files
  )
  const hostBefore = await snapshotFiles(repository, [...requiredBuildInputs])
  const depsBefore = await captureDependencyClosure(sourceBefore.root, manifest.reusedDependencies)
  const repositoryDepsBefore = await captureDependencyClosure(
    repository,
    manifest.repositoryDependencies
  )
  const localRequire = createRequire(path.join(repository, 'package.json'))
  const upstreamRequire = createRequire(path.join(sourceBefore.root, 'package.json'))
  const apiRoot = path.dirname(localRequire.resolve('@tauri-apps/api/package.json'))
  const stage = await createUpdaterStage(sourceBefore, packageRoot, temporary, apiRoot)
  const vueTscRoot = path.dirname(upstreamRequire.resolve('vue-tsc/package.json'))
  const checks = runTypeChecks(
    stage.root,
    { 'vue-tsc': { root: vueTscRoot, bin: { 'vue-tsc': 'bin/vue-tsc.js' } } },
    {
      build: {
        typeChecks: [
          {
            package: 'vue-tsc',
            binary: 'vue-tsc',
            args: ['--noEmit', '--project', 'tsconfig.json']
          }
        ]
      }
    }
  )
  await writeTypecheckLogs(evidence, checks)
  await writeFile(
    path.join(evidence, 'strict-results.json'),
    JSON.stringify(
      checks.map(({ stdout, stderr, ...rest }) => rest),
      null,
      2
    )
  )
  if (!typeChecksPassed(checks)) throw new Error('Updater strict/noUnused type checks failed')
  const stagePaths = [
    ...sourceBefore.files.map((f) => 'upstream/' + f),
    'upstream/tsconfig.json',
    ...(await readdir(stage.host)).map((f) => 'host/' + f),
    'vue-global-types.d.ts'
  ]
  const stagedBefore = await snapshotFiles(temporary, stagePaths)
  async function verifyInputs() {
    assert.deepEqual(
      await capturePinnedSource(upstream, manifest.source.commit, manifest.source.files),
      sourceBefore,
      'Upstream drift'
    )
    assert.deepEqual(
      await snapshotFiles(repository, [...requiredBuildInputs]),
      hostBefore,
      'Host/build helper drift'
    )
    assert.deepEqual(
      await snapshotFiles(temporary, stagePaths),
      stagedBefore,
      'Compiled stage drift'
    )
    assert.deepEqual(
      await captureDependencyClosure(sourceBefore.root, manifest.reusedDependencies),
      depsBefore,
      'Upstream dependency drift'
    )
    assert.deepEqual(
      await captureDependencyClosure(repository, manifest.repositoryDependencies),
      repositoryDepsBefore,
      'Repository dependency drift'
    )
  }
  const dependencies = [...depsBefore.packages, ...repositoryDepsBefore.packages].map((record) => ({
    name: record.name,
    version: record.version,
    path: record.path,
    files: record.files.length,
    bytes: record.files.reduce((n, f) => n + f.bytes, 0),
    sha256: sha256(JSON.stringify(record.files))
  }))
  if (checkOnly) {
    await verifyInputs()
    console.log(
      JSON.stringify({
        checkOnly: true,
        strict: true,
        source: sourceBefore.snapshot,
        dependencies: dependencies.length,
        evidence
      })
    )
  } else {
    const post = await createRendererPostMinifier({
      packageRoot: path.join(repository, manifest.build.postMinifier.packageRoot),
      expectedVersion: manifest.build.postMinifier.version
    })
    const vite = await import(pathToFileURL(upstreamRequire.resolve('vite')))
    const vue = (await import(pathToFileURL(upstreamRequire.resolve('@vitejs/plugin-vue')))).default
    const captures = new Map(),
      repoCaptures = new Map()
    let completedReceipt = null
    await publishBuildOutput({
      outputRoot: path.join(repository, manifest.build.output),
      async buildStage(output) {
        const result = await vite.build({
          configFile: false,
          root: stage.renderer,
          base: './',
          publicDir: false,
          cacheDir: path.join(temporary, 'vite-cache'),
          plugins: [
            guardedModuleCapture(path.join(sourceBefore.root, 'node_modules'), captures),
            guardedModuleCapture(path.join(repository, 'node_modules'), repoCaptures),
            vue(),
            post.plugin
          ],
          resolve: {
            alias: [
              { find: '@atools-updater', replacement: stage.host },
              { find: /^@tauri-apps\/api\/core$/, replacement: path.join(apiRoot, 'core.js') },
              { find: /^@tauri-apps\/api\/event$/, replacement: path.join(apiRoot, 'event.js') }
            ]
          },
          build: {
            outDir: output,
            emptyOutDir: true,
            sourcemap: false,
            rollupOptions: { input: path.join(stage.renderer, 'updater.html') }
          },
          logLevel: 'info'
        })
        const mime = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png'
        }
        const resources = result.output.map((item) => {
          const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source),
            type = mime[path.extname(item.fileName)]
          if (!type) throw new Error('Unknown updater resource MIME')
          return { path: item.fileName, bytes: bytes.length, sha256: sha256(bytes), mime: type }
        })
        const bundle = {
          totalJavaScriptBytes: resources
            .filter((f) => f.path.endsWith('.js'))
            .reduce((n, f) => n + f.bytes, 0),
          totalResourceBytes: resources.reduce((n, f) => n + f.bytes, 0),
          resources
        }
        await writeFile(
          path.join(evidence, 'candidate-measurements.json'),
          JSON.stringify({ published: false, bundle }, null, 2)
        )
        assert.equal(resources.length, 4, 'Updater must emit exactly four runtime resources')
        for (const type of ['text/html', 'text/javascript', 'text/css', 'image/png'])
          assert.equal(
            resources.filter((resource) => resource.mime === type).length,
            1,
            'Updater resource kinds changed'
          )
        const budget = assertUpdaterBudget(bundle, manifest.build)
        const logo = resources.find((f) => f.path.endsWith('.png'))
        assert.equal(
          logo?.sha256,
          sha256(await readFile(path.join(sourceBefore.root, 'src/renderer/src/assets/logo.png')))
        )
        assert.equal(logo?.bytes, 170073)
        assert.equal(
          resources.filter((f) => f.path.endsWith('.css')).reduce((n, f) => n + f.bytes, 0),
          9325
        )
        await verifyInputs()
        await post.verifyUnchanged()
        for (const [file, record] of [...captures, ...repoCaptures])
          assert.equal(sha256(await readFile(file)), record.sha256, 'Bundled dependency changed')
        const audited = await auditWebviewOutput(output, {
          entryHtml: 'updater.html',
          expectedPaths: resources.map((resource) => resource.path),
          forbiddenPaths: [sourceBefore.root, temporary, repository]
        })
        assert.deepEqual(
          audited.resources,
          resources
            .map(({ mime, ...resource }) => resource)
            .sort((a, b) => a.path.localeCompare(b.path))
        )
        assert.equal(audited.totalBytes, bundle.totalResourceBytes)
        const provenance = {
          schemaVersion: 1,
          owner: 'atools',
          role: 'original-updater',
          sourceCommit: manifest.source.commit,
          sourceTreeSha256: sourceBefore.snapshot.sha256,
          sourceFiles: sourceBefore.snapshot.files,
          sourceBytes: sourceBefore.snapshot.bytes,
          nodeVersion: process.version,
          hostAdapterSources: hostBefore,
          build: { localBuildInputs: hostBefore.filter((input) => !input.path.endsWith('.ts')) },
          compiledStageInputs: stagedBefore,
          upstreamCompatibilityPatches: [stage.patch],
          dependencies,
          bundledDependencyFiles: [...captures.values(), ...repoCaptures.values()],
          postMinifier: post.provenance,
          bundle,
          budget,
          typeChecks: checks.map((c) => ({
            binary: c.binary,
            args: c.args,
            exitCode: c.exitCode,
            success: c.success
          }))
        }
        await copyFile(path.join(sourceBefore.root, 'LICENSE'), path.join(output, 'ZTools-LICENSE'))
        await copyFile(
          path.join(packageRoot, 'source-manifest.json'),
          path.join(output, 'source-manifest.json')
        )
        await writeFile(
          path.join(output, 'build-provenance.json'),
          JSON.stringify(provenance, null, 2)
        )
        await writeFile(
          path.join(evidence, 'build-provenance.json'),
          JSON.stringify(provenance, null, 2)
        )
        completedReceipt = {
          passed: true,
          published: true,
          output: manifest.build.output,
          provenanceSha256: sha256(JSON.stringify(provenance, null, 2)),
          bundle
        }
      }
    })
    assert.ok(completedReceipt, 'Published updater receipt missing')
    await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(completedReceipt, null, 2))
    console.log(JSON.stringify({ passed: true, output: manifest.build.output, evidence }))
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
