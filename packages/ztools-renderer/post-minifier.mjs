import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const helperPath = fileURLToPath(import.meta.url)
const minifierName = 'terser'
const excludedNodeModulesPaths = Object.freeze([
  '.bin/* execution symlinks; each target must be a file inside node_modules and is hashed at its package path'
])

function fail(message) {
  throw new Error(`Renderer post-minifier: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function normalizedRelative(file, root) {
  const relative = path.relative(root, file)
  if (!inside(root, file) || relative === '') fail('resolved dependency path is outside its expected directory')
  return relative.split(path.sep).join('/')
}

async function readRegularFile(file, label) {
  let metadata
  try {
    metadata = await lstat(file)
  } catch (error) {
    fail(`missing ${label}: ${error.message}`)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`)
  return readFile(file)
}

async function validateBinLinks(nodeModulesRoot) {
  const validatedLinks = new Map()
  const binPath = path.join(nodeModulesRoot, '.bin')
  let metadata
  try {
    metadata = await lstat(binPath)
  } catch (error) {
    if (error.code === 'ENOENT') return validatedLinks
    fail(`could not inspect node_modules/.bin: ${error.message}`)
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('node_modules/.bin must be an ordinary directory')

  for (const entry of await readdir(binPath, { withFileTypes: true })) {
    const linkPath = path.join(binPath, entry.name)
    const linkMetadata = await lstat(linkPath)
    if (linkMetadata.isSymbolicLink()) {
      const target = await realpath(linkPath)
      if (!inside(nodeModulesRoot, target) || !(await stat(target)).isFile()) {
        fail(`node_modules/.bin link escapes the installed tree: ${entry.name}`)
      }
      validatedLinks.set(linkPath, target)
    } else if (!linkMetadata.isFile()) {
      fail(`unexpected filesystem entry in node_modules/.bin: ${entry.name}`)
    }
  }
  return validatedLinks
}

async function hashNodeModules(packageRoot) {
  const nodeModulesRoot = path.join(packageRoot, 'node_modules')
  let rootMetadata
  try {
    rootMetadata = await lstat(nodeModulesRoot)
  } catch (error) {
    fail(`missing node_modules: ${error.message}`)
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('node_modules must be an ordinary directory')
  }
  const actualRoot = await realpath(nodeModulesRoot)
  if (actualRoot !== nodeModulesRoot) fail('node_modules resolves outside its package root')
  const validatedBinLinks = await validateBinLinks(actualRoot)

  const digest = createHash('sha256')
  let files = 0
  let bytes = 0
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const childRelative = relative ? path.join(relative, entry.name) : entry.name
      const normalized = childRelative.split(path.sep).join('/')
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) {
        const validatedTarget = relative === '.bin' ? validatedBinLinks.get(absolute) : null
        if (!validatedTarget) fail(`symlink is not allowed in installed dependency tree: ${normalized}`)
        const currentTarget = await realpath(absolute)
        if (currentTarget !== validatedTarget || !inside(actualRoot, currentTarget) || !(await stat(absolute)).isFile()) {
          fail(`node_modules/.bin link changed or escaped after validation: ${entry.name}`)
        }
        continue
      }
      if (metadata.isDirectory()) {
        digest.update('D\0').update(normalized).update('\0')
        await walk(absolute, childRelative)
      } else if (metadata.isFile()) {
        const content = await readFile(absolute)
        digest.update('F\0').update(normalized).update('\0').update(String(content.byteLength)).update('\0')
        digest.update(content).update('\0')
        files += 1
        bytes += content.byteLength
      } else {
        fail(`unsupported filesystem entry in installed dependency tree: ${normalized}`)
      }
    }
  }
  await walk(actualRoot)
  return { sha256: digest.digest('hex'), files, bytes }
}

async function validateLockedPackages(nodeModulesRoot, lock) {
  const entries = Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => packagePath.startsWith('node_modules/'))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  if (entries.length === 0) fail('package-lock.json contains no installed package entries')

  for (const [packagePath, lockedPackage] of entries) {
    const relative = packagePath.slice('node_modules/'.length)
    const segments = relative.split('/')
    const installedPath = path.resolve(nodeModulesRoot, ...segments)
    if (!relative || !inside(nodeModulesRoot, installedPath) || lockedPackage.link) {
      fail(`package-lock.json contains an out-of-tree dependency path: ${packagePath}`)
    }
    let metadata
    try {
      metadata = await lstat(installedPath)
    } catch {
      fail(`locked dependency is missing from node_modules: ${packagePath}`)
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(`locked dependency must be an ordinary directory: ${packagePath}`)
    }
    const bytes = await readRegularFile(path.join(installedPath, 'package.json'), `${packagePath}/package.json`)
    let installedPackage
    try {
      installedPackage = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      fail(`installed dependency metadata is invalid for ${packagePath}: ${error.message}`)
    }
    if (installedPackage.version !== lockedPackage.version) {
      fail(`installed dependency version differs from package-lock.json: ${packagePath}`)
    }
  }
}

async function captureInputs(packageRoot, expectedVersion) {
  const packageFile = path.join(packageRoot, 'package.json')
  const lockFile = path.join(packageRoot, 'package-lock.json')
  const packageBytes = await readRegularFile(packageFile, 'package.json')
  const lockBytes = await readRegularFile(lockFile, 'package-lock.json')
  let packageManifest
  let lock
  try {
    packageManifest = JSON.parse(packageBytes.toString('utf8'))
    lock = JSON.parse(lockBytes.toString('utf8'))
  } catch (error) {
    fail(`package manifest or lock is invalid JSON: ${error.message}`)
  }
  if (packageManifest.devDependencies?.[minifierName] !== expectedVersion) {
    fail(`package.json must pin devDependency ${minifierName}@${expectedVersion}`)
  }
  if (lock.packages?.['']?.devDependencies?.[minifierName] !== expectedVersion) {
    fail(`package-lock.json root must pin devDependency ${minifierName}@${expectedVersion}`)
  }
  if (lock.packages?.[`node_modules/${minifierName}`]?.version !== expectedVersion) {
    fail(`package-lock.json must resolve ${minifierName}@${expectedVersion}`)
  }
  if (lock.name && packageManifest.name && lock.name !== packageManifest.name) {
    fail('package-lock.json belongs to a different package manifest')
  }

  const nodeModulesRoot = path.join(packageRoot, 'node_modules')
  const nodeModulesTree = await hashNodeModules(packageRoot)
  await validateLockedPackages(nodeModulesRoot, lock)
  const terserRoot = path.join(nodeModulesRoot, minifierName)
  const terserRootMetadata = await lstat(terserRoot).catch((error) => {
    fail(`missing installed ${minifierName}: ${error.message}`)
  })
  if (!terserRootMetadata.isDirectory() || terserRootMetadata.isSymbolicLink()) {
    fail(`installed ${minifierName} must be an ordinary package directory`)
  }
  const terserPackageBytes = await readRegularFile(path.join(terserRoot, 'package.json'), `${minifierName}/package.json`)
  let terserPackage
  try {
    terserPackage = JSON.parse(terserPackageBytes.toString('utf8'))
  } catch (error) {
    fail(`installed ${minifierName} package metadata is invalid JSON: ${error.message}`)
  }
  if (terserPackage.name !== minifierName || terserPackage.version !== expectedVersion) {
    fail(`installed ${minifierName} version does not match ${expectedVersion}`)
  }

  const localRequire = createRequire(packageFile)
  let entryPath
  let metadataPath
  try {
    entryPath = await realpath(localRequire.resolve(minifierName))
    metadataPath = await realpath(localRequire.resolve(`${minifierName}/package.json`))
  } catch (error) {
    fail(`could not resolve local ${minifierName}: ${error.message}`)
  }
  if (metadataPath !== path.join(terserRoot, 'package.json') || !inside(terserRoot, entryPath)) {
    fail(`local ${minifierName} resolution escaped its pinned package directory`)
  }
  const helperBytes = await readRegularFile(helperPath, 'post-minifier helper source')
  return {
    version: expectedVersion,
    packageManifestSha256: sha256(packageBytes),
    packageLockSha256: sha256(lockBytes),
    nodeModulesTreeSha256: nodeModulesTree.sha256,
    nodeModulesTreeFiles: nodeModulesTree.files,
    nodeModulesTreeBytes: nodeModulesTree.bytes,
    resolvedEntry: normalizedRelative(entryPath, nodeModulesRoot),
    helperSha256: sha256(helperBytes)
  }
}

function sameSnapshot(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key])
}

function minifierOptions() {
  return {
    module: true,
    ecma: 2020,
    compress: { passes: 2, pure_getters: false, unsafe: false },
    mangle: { properties: false },
    format: { ascii_only: false, comments: 'some' }
  }
}

export async function createRendererPostMinifier({ packageRoot, expectedVersion }) {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) {
    fail('packageRoot must be an absolute path')
  }
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    fail('expectedVersion must be a non-empty exact version')
  }
  const resolvedPackageRoot = await realpath(packageRoot).catch((error) => {
    fail(`could not resolve packageRoot: ${error.message}`)
  })
  const packageRootMetadata = await lstat(resolvedPackageRoot)
  if (!packageRootMetadata.isDirectory() || packageRootMetadata.isSymbolicLink()) {
    fail('packageRoot must resolve to an ordinary directory')
  }

  const initial = await captureInputs(resolvedPackageRoot, expectedVersion)
  const localRequire = createRequire(path.join(resolvedPackageRoot, 'package.json'))
  const entryPath = localRequire.resolve(minifierName)
  let terser
  try {
    terser = await import(pathToFileURL(entryPath).href)
  } catch (error) {
    fail(`could not load local ${minifierName}@${expectedVersion}: ${error.message}`)
  }
  const minify = terser.minify ?? terser.default?.minify
  if (typeof minify !== 'function') fail(`local ${minifierName} does not expose minify()`)

  const provenance = Object.freeze({
    name: minifierName,
    version: expectedVersion,
    hook: 'renderChunk',
    hookOrder: 'post',
    input: 'ESM',
    options: Object.freeze({
      module: true,
      ecma: 2020,
      compress: Object.freeze({ passes: 2, pure_getters: false, unsafe: false }),
      mangle: Object.freeze({ properties: false }),
      format: Object.freeze({ ascii_only: false, comments: 'some' })
    }),
    packageManifestSha256: initial.packageManifestSha256,
    packageLockSha256: initial.packageLockSha256,
    nodeModulesTreeSha256: initial.nodeModulesTreeSha256,
    nodeModulesTreeFiles: initial.nodeModulesTreeFiles,
    nodeModulesTreeBytes: initial.nodeModulesTreeBytes,
    resolvedEntry: initial.resolvedEntry,
    helperSha256: initial.helperSha256,
    excludedNodeModulesPaths
  })
  const chunkMeasurements = []

  async function verifyUnchanged() {
    const current = await captureInputs(resolvedPackageRoot, expectedVersion)
    if (!sameSnapshot(initial, current)) {
      fail('package files, lock, installed dependency tree, resolved entry, or helper changed during build')
    }
    return true
  }

  function measurements() {
    const chunks = chunkMeasurements.map((item) => ({ ...item }))
    const inputJavaScriptBytes = chunks.reduce((sum, item) => sum + item.inputBytes, 0)
    const outputJavaScriptBytes = chunks.reduce((sum, item) => sum + item.outputBytes, 0)
    return {
      measurementScope: 'renderChunk post hook; input follows ordinary hooks such as Vite esbuild',
      byteEncoding: 'UTF-8',
      chunks,
      inputJavaScriptBytes,
      outputJavaScriptBytes,
      savedJavaScriptBytes: inputJavaScriptBytes - outputJavaScriptBytes
    }
  }

  const plugin = {
    name: 'atools-renderer-post-minifier',
    renderChunk: {
      order: 'post',
      async handler(code, chunk) {
        const inputBytes = Buffer.byteLength(code, 'utf8')
        let result
        try {
          result = await minify(code, minifierOptions())
        } catch (error) {
          fail(`minify failed: ${error.message}`)
        }
        if (typeof result?.code !== 'string') fail('minify returned no JavaScript code')
        const outputBytes = Buffer.byteLength(result.code, 'utf8')
        chunkMeasurements.push({
          fileName: typeof chunk?.fileName === 'string' ? chunk.fileName : null,
          inputBytes,
          outputBytes,
          savedBytes: inputBytes - outputBytes
        })
        return { code: result.code, map: null }
      }
    }
  }

  await verifyUnchanged()
  return { plugin, provenance, verifyUnchanged, measurements }
}
