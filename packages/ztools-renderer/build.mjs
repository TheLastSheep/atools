#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { builtinModules, createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import {
  copyFile,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRendererPostMinifier } from './post-minifier.mjs'
import { publishBuildOutput } from './output-transaction.mjs'
import { createReviewedRendererCompatibilityPlugin } from './upstream-compatibility-patches.mjs'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const lockPath = path.join(packageRoot, 'source-manifest.json')
const expectedNodeVersion = 'v22.23.3'
const forbiddenBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = { upstream: process.env.ATOOLS_ZTOOLS_SOURCE, checkOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--upstream') {
      options.upstream = argv[index + 1]
      if (!options.upstream || options.upstream.startsWith('--')) fail('--upstream requires a path')
      index += 1
    } else if (token === '--check-only') {
      options.checkOnly = true
    } else {
      fail(`Unknown argument: ${token}`)
    }
  }
  if (!options.upstream) fail('Pass --upstream <ZTools checkout> or set ATOOLS_ZTOOLS_SOURCE')
  return options
}

function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function hashFiles(root, files) {
  const hash = createHash('sha256')
  let bytes = 0
  for (const relative of [...files].sort()) {
    const content = await readFile(path.join(root, relative))
    hash.update(relative).update('\0').update(content).update('\0')
    bytes += content.byteLength
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes }
}

async function trackedInputFiles(root) {
  const listing = execFileSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--', 'src/renderer', 'src/shared', 'LICENSE', 'package.json', 'pnpm-lock.yaml'],
    { encoding: 'utf8' }
  )
  const files = listing.split('\0').filter(Boolean)
  for (const required of ['src/renderer/index.html', 'src/renderer/src/main.ts', 'LICENSE', 'package.json']) {
    if (!files.includes(required)) fail(`Pinned source input is missing: ${required}`)
  }
  return files
}

async function resolvePackageRoot(upstreamRequire, packageName) {
  let resolved
  try {
    resolved = upstreamRequire.resolve(packageName)
  } catch {
    fail(`Required upstream dependency is not installed: ${packageName}`)
  }
  let current = path.dirname(resolved)
  while (true) {
    const manifest = path.join(current, 'package.json')
    try {
      const metadata = await readJson(manifest)
      if (metadata.name === packageName) return { root: await realpath(current), metadata, manifest }
    } catch {
      // Continue walking until the package root is found.
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail(`Could not locate package metadata for ${packageName}`)
}

async function resolveFuseBasicEntry(upstreamRequire) {
  const fusePackage = await resolvePackageRoot(upstreamRequire, 'fuse.js')
  const target = fusePackage.metadata.exports?.['./basic']?.import
  if (typeof target !== 'string' || !target.startsWith('./')) {
    fail('Pinned fuse.js must expose an ESM ./basic export')
  }
  const basicEntry = await realpath(path.resolve(fusePackage.root, target))
  const requireEntry = await realpath(upstreamRequire.resolve('fuse.js/basic'))
  for (const entry of [basicEntry, requireEntry]) {
    const relative = path.relative(fusePackage.root, entry)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail('Pinned fuse.js basic export must resolve inside the reused package')
    }
  }
  return basicEntry
}

async function hashPackageTree(root) {
  const files = []
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const childRelative = path.join(relative, entry.name)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute, childRelative)
      else if (entry.isFile()) files.push(childRelative)
    }
  }
  await walk(root)
  return hashFiles(root, files)
}

async function adapterSourceSnapshot(extensions, helpers) {
  const inputs = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && extensions.some(extension => entry.name.endsWith(extension))) {
        const bytes = await readFile(absolute)
        inputs.push({
          path: path.relative(packageRoot, absolute).split(path.sep).join('/'),
          sha256: sha256(bytes),
          bytes: bytes.byteLength
        })
      }
    }
  }
  await walk(path.join(packageRoot, 'src'))
  for (const helper of helpers) {
    const bytes = await readFile(path.join(packageRoot, helper))
    inputs.push({ path: helper, sha256: sha256(bytes), bytes: bytes.byteLength })
  }
  return inputs.sort((left, right) => left.path.localeCompare(right.path))
}

async function verifySource(upstreamPath, lock) {
  const root = await realpath(upstreamPath)
  const topLevel = await realpath(runGit(root, ['rev-parse', '--show-toplevel']))
  if (topLevel !== root) fail('--upstream must point to the ZTools repository root')

  const commit = runGit(root, ['rev-parse', 'HEAD'])
  if (commit !== lock.source.commit) fail(`Unexpected ZTools commit ${commit}; expected ${lock.source.commit}`)
  const dirty = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty) fail('The ZTools checkout has local changes; build requires a clean pinned source tree')

  const upstreamPackage = await readJson(path.join(root, lock.source.preservedInputManifest))
  if (upstreamPackage.name !== lock.source.packageName || upstreamPackage.version !== lock.source.packageVersion) {
    fail(`Unexpected upstream package ${upstreamPackage.name}@${upstreamPackage.version}`)
  }
  if (upstreamPackage.license !== lock.source.license) fail(`Unexpected upstream license ${upstreamPackage.license}`)

  const files = await trackedInputFiles(root)
  const sourceHash = await hashFiles(root, files)
  const upstreamRequire = createRequire(path.join(root, 'package.json'))
  const dependencies = {}
  for (const name of lock.reusedDependencies) {
    const resolved = await resolvePackageRoot(upstreamRequire, name)
    dependencies[name] = {
      version: resolved.metadata.version,
      packageManifestSha256: sha256(await readFile(resolved.manifest)),
      packageTree: await hashPackageTree(resolved.root)
    }
  }
  return { root, commit, files, sourceHash, upstreamPackage, upstreamRequire, dependencies }
}

function packageEntryFromRequire(upstreamRequire, packageName) {
  return pathToFileURL(upstreamRequire.resolve(packageName)).href
}

function importedModuleIsForbidden(specifier) {
  const normalized = specifier.replace(/^node:/, '')
  const topLevel = normalized.split('/')[0]
  return normalized === 'electron' || forbiddenBuiltins.has(topLevel)
}

async function importDefault(upstreamRequire, packageName) {
  const loaded = await import(packageEntryFromRequire(upstreamRequire, packageName))
  return loaded.default ?? loaded
}

function cleanModuleId(id) {
  if (id.startsWith('\0')) return null
  const noQuery = id.split('?')[0]
  return path.resolve(noQuery)
}

function dependencyPathKey(file) {
  const parts = path.resolve(file).split(path.sep)
  const nodeModulesIndex = parts.indexOf('node_modules')
  return nodeModulesIndex < 0 ? null : parts.slice(nodeModulesIndex + 1).join('/')
}

function dependencyCapturePlugin(capturedFiles) {
  return {
    name: 'atools-capture-upstream-inputs',
    enforce: 'pre',
    async load(id) {
      const file = cleanModuleId(id)
      if (!file) return null
      const relative = dependencyPathKey(file)
      if (!relative) return null
      try {
        if ((await stat(file)).isFile()) {
          capturedFiles.set(file, { key: relative, sha256: sha256(await readFile(file)) })
        }
      } catch {
        fail(`Could not hash bundled dependency input: ${relative}`)
      }
      return null
    }
  }
}

function adapterInjectionPlugin(upstreamRoot, adapterFile) {
  const entryFile = path.resolve(upstreamRoot, 'src/renderer/src/main.ts')
  return {
    name: 'atools-inject-host-adapter',
    enforce: 'pre',
    transform(code, id) {
      if (cleanModuleId(id) !== entryFile) return null
      return `import ${JSON.stringify(adapterFile)};\n${code}`
    }
  }
}

function rejectRuntimeExternalPlugin() {
  return {
    name: 'atools-reject-electron-and-node-runtime',
    enforce: 'pre',
    resolveId(source) {
      if (importedModuleIsForbidden(source)) {
        fail(`Renderer runtime cannot bundle Electron/Node module: ${source}`)
      }
      return null
    }
  }
}

async function ensureModuleHashesUnchanged(files) {
  for (const [file, captured] of files) {
    const afterHash = sha256(await readFile(file))
    if (captured.sha256 !== afterHash) fail(`Dependency source changed during build: ${captured.key}`)
  }
}

async function ensurePackageTreesUnchanged(upstreamRequire, lock, before) {
  for (const name of lock.reusedDependencies) {
    const resolved = await resolvePackageRoot(upstreamRequire, name)
    const afterTree = await hashPackageTree(resolved.root)
    const beforeTree = before[name].packageTree
    if (beforeTree.sha256 !== afterTree.sha256 || beforeTree.files !== afterTree.files) {
      fail(`Reused dependency changed during build: ${name}`)
    }
  }
}

async function scanOutput(outputRoot, upstreamRoot) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await walk(outputRoot)
  const importPattern = /\b(?:from\s*|import\s*\(|import\s*|require\s*\()\s*(['"])([^'"]+)\1/g
  for (const file of files) {
    const bytes = await readFile(file)
    if (bytes.includes(Buffer.from(upstreamRoot))) fail(`Output contains the absolute source path: ${path.basename(file)}`)
    // Preserved package metadata may document Electron scripts; it is not executable renderer code.
    if (!/\.(?:m?js|html)$/.test(file)) continue
    const source = bytes.toString('utf8')
    for (const match of source.matchAll(importPattern)) {
      if (importedModuleIsForbidden(match[2])) fail(`Runtime output ${path.basename(file)} references Node/Electron module ${match[2]}`)
    }
  }
}

function bundleMeasurements(result, upstreamRoot) {
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output ?? [])
  const chunks = outputs.filter((item) => item.type === 'chunk')
  const modules = chunks.flatMap((chunk) => Object.entries(chunk.modules).map(([id, module]) => {
    const file = cleanModuleId(id)
    if (!file) return null
    const dependency = dependencyPathKey(file)
    const relative = file.startsWith(`${upstreamRoot}${path.sep}`)
      ? `upstream/${path.relative(upstreamRoot, file)}`
      : `host/${path.relative(packageRoot, file)}`
    return { module: (dependency ?? relative).split(path.sep).join('/'), renderedBytes: module.renderedLength }
  }).filter(Boolean))
  return {
    entryJavaScriptBytes: chunks.filter((chunk) => chunk.isEntry)
      .reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0),
    totalJavaScriptBytes: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0),
    largestModules: modules.sort((left, right) => right.renderedBytes - left.renderedBytes).slice(0, 20)
  }
}

async function buildRenderer(verified, lock) {
  const rendererRoot = path.join(verified.root, 'src/renderer')
  const outputRoot = path.join(packageRoot, 'dist')
  const adapterFile = path.join(packageRoot, 'src/hostAdapter.ts')
  try {
    await stat(adapterFile)
  } catch {
    fail('Missing packages/ztools-renderer/src/hostAdapter.ts; the host adapter is owned by the integration task')
  }

  const sourceExtensions = lock.build.hostAdapterSourceExtensions
  if (JSON.stringify(sourceExtensions) !== JSON.stringify(['.ts', '.mjs'])) {
    fail('source manifest must bind TypeScript adapters and JavaScript compatibility helpers')
  }
  const helperModules = lock.build.hostBuildHelperModules
  if (JSON.stringify(helperModules) !== JSON.stringify(['upstream-compatibility-patches.mjs'])) {
    fail('source manifest must bind the reviewed root compatibility helper')
  }
  const hostAdapterSources = await adapterSourceSnapshot(sourceExtensions, helperModules)
  const minifierConfig = lock.build.postMinifier
  if (minifierConfig?.name !== 'terser' || typeof minifierConfig.version !== 'string') {
    fail('source manifest must pin the build-only Terser post-minifier name and version')
  }
  const postMinifier = await createRendererPostMinifier({ packageRoot, expectedVersion: minifierConfig.version })

  const vite = await importDefault(verified.upstreamRequire, 'vite')
  const vue = await importDefault(verified.upstreamRequire, '@vitejs/plugin-vue')
  const svgLoader = await importDefault(verified.upstreamRequire, 'vite-svg-loader')
  const vuePackage = await resolvePackageRoot(verified.upstreamRequire, 'vue')
  const draggablePackage = await resolvePackageRoot(verified.upstreamRequire, 'vuedraggable')
  const fuseBasicEntry = await resolveFuseBasicEntry(verified.upstreamRequire)
  const capturedDependencyFiles = new Map()
  const reviewedCompatibility = createReviewedRendererCompatibilityPlugin(verified.root)
  return publishBuildOutput({
    outputRoot,
    async buildStage(stageRoot) {
      await postMinifier.verifyUnchanged()
      const built = await vite.build({
        configFile: false,
        root: rendererRoot,
        base: './',
        publicDir: path.join(rendererRoot, 'public'),
        plugins: [
          rejectRuntimeExternalPlugin(),
          dependencyCapturePlugin(capturedDependencyFiles),
          reviewedCompatibility.plugin,
          vue(),
          svgLoader(),
          adapterInjectionPlugin(verified.root, adapterFile),
          postMinifier.plugin
        ],
        resolve: {
          alias: [
            { find: /^fuse\.js$/, replacement: fuseBasicEntry },
            { find: /^vue$/, replacement: path.join(vuePackage.root, 'dist/vue.runtime.esm-bundler.js') },
            { find: /^vuedraggable$/, replacement: path.join(draggablePackage.root, 'src/vuedraggable.js') },
            { find: '@renderer', replacement: path.join(rendererRoot, 'src') },
            { find: '@shared', replacement: path.join(verified.root, 'src/shared') }
          ],
          dedupe: ['vue']
        },
        // Remove informational production traces without dropping argument effects
        // or hiding warning/error diagnostics used by runtime acceptance.
        esbuild: { pure: ['console.log', 'console.debug'] },
        build: {
          outDir: stageRoot,
          emptyOutDir: true,
          sourcemap: false,
          rollupOptions: { input: path.join(rendererRoot, 'index.html') }
        },
        logLevel: 'info'
      })
      await postMinifier.verifyUnchanged()
      const upstreamCompatibilityPatches = reviewedCompatibility.assertApplied()

      const bundle = bundleMeasurements(built, verified.root)
      bundle.incrementalJavaScriptBytes = bundle.totalJavaScriptBytes - lock.build.previousTotalJavaScriptBytes
      if (bundle.totalJavaScriptBytes > lock.build.totalJavaScriptBudgetBytes) {
        fail(`Renderer JavaScript budget exceeded: ${bundle.totalJavaScriptBytes} > ${lock.build.totalJavaScriptBudgetBytes}`)
      }
      if (bundle.incrementalJavaScriptBytes > lock.build.maxIncrementalJavaScriptBytes) {
        fail(`Renderer JavaScript increment exceeded: ${bundle.incrementalJavaScriptBytes} > ${lock.build.maxIncrementalJavaScriptBytes}`)
      }

      await ensureModuleHashesUnchanged(capturedDependencyFiles)
      await ensurePackageTreesUnchanged(verified.upstreamRequire, lock, verified.dependencies)
      const afterSource = await hashFiles(verified.root, verified.files)
      if (afterSource.sha256 !== verified.sourceHash.sha256) fail('Pinned upstream source changed during build')
      if (JSON.stringify(await adapterSourceSnapshot(sourceExtensions, helperModules)) !== JSON.stringify(hostAdapterSources)) {
        fail('ATools host adapter source changed during build')
      }

      await copyFile(path.join(verified.root, 'LICENSE'), path.join(stageRoot, 'ZTools-LICENSE'))
      await copyFile(path.join(verified.root, 'package.json'), path.join(stageRoot, 'upstream-package.json'))
      await copyFile(lockPath, path.join(stageRoot, 'source-manifest.json'))
      const dependencyFileHash = createHash('sha256')
      for (const [, dependency] of [...capturedDependencyFiles].sort(([, left], [, right]) => left.key.localeCompare(right.key))) {
        dependencyFileHash.update(dependency.key).update('\0').update(dependency.sha256).update('\0')
      }
      await writeFile(path.join(stageRoot, 'build-provenance.json'), JSON.stringify({
        schemaVersion: 1,
        sourceCommit: verified.commit,
        sourceTreeSha256: verified.sourceHash.sha256,
        sourceFiles: verified.sourceHash.files,
        sourceBytes: verified.sourceHash.bytes,
        nodeVersion: process.version,
        hostAdapterSources,
        upstreamCompatibilityPatches,
        bundle,
        productionLogging: {
          pureCalls: ['console.log', 'console.debug'],
          preserves: ['argument side effects', 'console.warn', 'console.error']
        },
        postMinifier: postMinifier.provenance,
        postMinifierMeasurements: postMinifier.measurements(),
        dependencies: Object.fromEntries(Object.entries(verified.dependencies).map(([name, item]) => [name, {
          version: item.version,
          packageManifestSha256: item.packageManifestSha256,
          packageTreeSha256: item.packageTree.sha256,
          packageTreeFiles: item.packageTree.files
        }])),
        bundledDependencyFiles: capturedDependencyFiles.size,
        bundledDependencyFilesSha256: dependencyFileHash.digest('hex')
      }, null, 2) + '\n')
      await scanOutput(stageRoot, verified.root)
      await postMinifier.verifyUnchanged()
    }
  })
}

async function main() {
  if (process.version !== expectedNodeVersion) {
    fail(`Use the ATools product Node ${expectedNodeVersion}; current runtime is ${process.version}`)
  }
  const lock = await readJson(lockPath)
  for (const key of ['previousTotalJavaScriptBytes', 'maxIncrementalJavaScriptBytes', 'totalJavaScriptBudgetBytes']) {
    if (!Number.isSafeInteger(lock.build[key]) || lock.build[key] < 0) fail(`Invalid JavaScript budget: ${key}`)
  }
  const options = parseArgs(process.argv.slice(2))
  const verified = await verifySource(path.resolve(options.upstream), lock)
  if (options.checkOnly) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'check-only',
      sourceCommit: verified.commit,
      sourceTreeSha256: verified.sourceHash.sha256,
      sourceFiles: verified.sourceHash.files,
      nodeVersion: process.version,
      dependencies: Object.fromEntries(Object.entries(verified.dependencies).map(([name, item]) => [name, {
        version: item.version,
        packageManifestSha256: item.packageManifestSha256,
        packageTreeSha256: item.packageTree.sha256
      }]))
    }, null, 2))
    return
  }
  const output = await buildRenderer(verified, lock)
  console.log(`Built pinned ZTools renderer: ${output}`)
}

main().catch((error) => {
  console.error(`[ztools-renderer-build] ${error.message}`)
  process.exitCode = 1
})
