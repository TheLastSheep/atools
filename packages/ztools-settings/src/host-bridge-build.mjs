import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_SOURCE_FILES = 64
const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_SCAN_ENTRIES = 128
const MAX_PATH_DEPTH = 8
const MAX_PATH_BYTES = 512
const HOST_SOURCE_DIRECTORY = 'packages/ztools-settings/src'

function fail(message) {
  throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative))
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function cleanModuleId(id) {
  if (typeof id !== 'string' || id.startsWith('\0')) return null
  const withoutQuery = id.split('?')[0]
  return path.isAbsolute(withoutQuery) ? path.resolve(withoutQuery) : null
}

async function canonicalDirectory(directory, description) {
  let resolved
  try {
    resolved = await realpath(directory)
  } catch {
    fail(`${description} is unavailable`)
  }
  if (path.resolve(directory) !== resolved) fail(`${description} must not use symlinks`)
  const info = await lstat(resolved)
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${description} must be a directory`)
  return resolved
}

function validateRelativePath(relativePath) {
  if (!relativePath || Buffer.byteLength(relativePath) > MAX_PATH_BYTES
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('Host bridge source path is unsafe')
  }
  if (relativePath.split('/').length > MAX_PATH_DEPTH) fail('Host bridge source path is too deep')
}

async function walkHostSources(sourceRoot) {
  const files = []
  let visited = 0
  let totalBytes = 0

  async function visit(directory, relativeDirectory, depth) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_SCAN_ENTRIES) fail('Host bridge source tree has too many entries')
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      validateRelativePath(relativePath)
      const absolutePath = path.join(directory, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) fail('Symlinks are not allowed in host bridge sources')
      if (info.isDirectory()) {
        if (depth + 1 > MAX_PATH_DEPTH) fail('Host bridge source tree is too deep')
        await visit(absolutePath, relativePath, depth + 1)
        continue
      }
      if (!info.isFile()) fail('Host bridge source tree contains an unsupported file')
      if (path.extname(entry.name) !== '.ts') continue
      if (files.length >= MAX_SOURCE_FILES) fail('Host bridge source tree exceeds the file limit')
      if (totalBytes + info.size > MAX_SOURCE_BYTES) fail('Host bridge sources exceed the byte limit')
      const bytes = await readFile(absolutePath)
      if (bytes.byteLength !== info.size) fail('Host bridge source changed while being captured')
      totalBytes += bytes.byteLength
      files.push({ relativePath, absolutePath, bytes: bytes.byteLength, sha256: sha256(bytes) })
    }
  }

  await visit(sourceRoot, '', 0)
  files.sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ))
  if (files.length === 0) fail('Host bridge source tree contains no TypeScript files')
  return { files, bytes: totalBytes }
}

function sourceDigest(files) {
  const input = files.map((file) => (
    `${file.path}\0${file.bytes}\0${file.sha256}\0`
  )).join('')
  return sha256(Buffer.from(input))
}

export async function captureHostBridgeSources(repositoryRoot) {
  const root = await canonicalDirectory(repositoryRoot, 'ATools repository root')
  const sourceRoot = path.join(root, HOST_SOURCE_DIRECTORY)
  const resolvedSourceRoot = await canonicalDirectory(sourceRoot, 'Host bridge source directory')
  if (resolvedSourceRoot !== sourceRoot) fail('Host bridge source directory is not canonical')

  const scanned = await walkHostSources(sourceRoot)
  const files = scanned.files.map((file) => ({
    path: toPosix(path.relative(root, file.absolutePath)),
    absolutePath: file.absolutePath,
    bytes: file.bytes,
    sha256: file.sha256
  }))
  const snapshot = {
    repositoryRoot: root,
    sourceRoot,
    rootPath: HOST_SOURCE_DIRECTORY,
    files,
    count: files.length,
    bytes: scanned.bytes,
    sha256: sourceDigest(files)
  }
  if (snapshot.count > MAX_SOURCE_FILES || snapshot.bytes > MAX_SOURCE_BYTES) {
    fail('Host bridge source tree exceeds its capture budget')
  }
  return snapshot
}

export async function assertHostBridgeSourcesUnchanged(snapshot) {
  const current = await captureHostBridgeSources(snapshot.repositoryRoot)
  if (current.count !== snapshot.count
    || current.bytes !== snapshot.bytes
    || current.sha256 !== snapshot.sha256) {
    fail('Host bridge sources changed during the build')
  }
}

export function hostBridgeSourcesProvenance(snapshot, runtimeImports, bridgePath) {
  const allowed = new Set(snapshot.files.map((file) => file.path))
  const imported = [...runtimeImports].sort()
  if (!imported.includes(bridgePath)) fail('Host bridge entry was not bundled')
  if (imported.some((file) => !allowed.has(file))) {
    fail('Bundled host bridge sources are outside the captured set')
  }
  return {
    root: snapshot.rootPath,
    count: snapshot.count,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    files: snapshot.files.map(({ path: sourcePath, bytes, sha256: digest }) => ({
      path: sourcePath,
      bytes,
      sha256: digest
    })),
    runtimeImports: imported
  }
}

export async function stageHostBridgeEntry(stageRoot, bridgeSnapshot, sources) {
  const bridgeSource = sources.files.find((file) => file.path === bridgeSnapshot.path)
  if (!bridgeSource
    || bridgeSource.bytes !== bridgeSnapshot.bytes
    || bridgeSource.sha256 !== bridgeSnapshot.sha256
    || path.extname(bridgeSource.absolutePath) !== '.ts') {
    fail('Host bridge entry is not part of the captured TypeScript source set')
  }

  const resolvedStageRoot = await canonicalDirectory(stageRoot, 'Staged source root')
  const entryPath = path.join(resolvedStageRoot, 'internal-plugins/setting/src/main.ts')
  const entryInfo = await lstat(entryPath).catch(() => null)
  if (!entryInfo || entryInfo.isSymbolicLink() || !entryInfo.isFile()) {
    fail('Staged settings entry is unavailable')
  }
  const resolvedEntry = await realpath(entryPath)
  if (resolvedEntry !== entryPath || !isInside(resolvedStageRoot, resolvedEntry)) {
    fail('Staged settings entry is not a regular confined file')
  }

  const original = await readFile(entryPath)
  let originalText
  try {
    originalText = new TextDecoder('utf-8', { fatal: true }).decode(original)
  } catch {
    fail('Staged settings entry is not UTF-8')
  }
  const bridgeSpecifier = bridgeSource.absolutePath.slice(0, -'.ts'.length)
  const importLine = `import ${JSON.stringify(bridgeSpecifier)};\n`
  if (originalText.includes(importLine.trim())) fail('Host bridge import is already present in the staged entry')
  const updated = Buffer.concat([Buffer.from(importLine), original])
  await writeFile(entryPath, updated)

  return {
    entryPath: 'internal-plugins/setting/src/main.ts',
    beforeSha256: sha256(original),
    afterSha256: sha256(updated),
    bridgePath: bridgeSnapshot.path
  }
}

export function hostBridgeSourceGuardPlugin({
  sources,
  stageRoot,
  upstreamFiles,
  nodeModulesRoot,
  runtimeImports
}) {
  const capturedPaths = new Set(sources.files.map((file) => file.path))
  const upstreamPathSet = new Set(upstreamFiles)
  const stageAbsolute = path.resolve(stageRoot)
  const nodeModulesAbsolute = path.resolve(nodeModulesRoot)

  return {
    name: 'atools-settings-host-bridge-source-guard',
    enforce: 'pre',
    async resolveId(source, importer) {
      const importerPath = cleanModuleId(importer)
      if (!importerPath) return null
      const importerRealPath = await realpath(importerPath).catch(() => null)
      const importerIsHostSource = importerRealPath !== null
        && isInside(sources.sourceRoot, importerRealPath)
      if (importerIsHostSource && path.resolve(importerPath) !== importerRealPath) {
        fail('Symlink host bridge importer is not allowed')
      }
      if (!importerIsHostSource) return null

      let resolved
      try {
        resolved = await this.resolve(source, importer, { skipSelf: true })
      } catch {
        if (importerIsHostSource) fail('Host bridge import could not be resolved locally')
        return null
      }
      if (!resolved || resolved.external) {
        if (importerIsHostSource) fail('Host bridge import cannot be external')
        return null
      }
      const targetPath = cleanModuleId(resolved.id)
      if (!targetPath) {
        if (importerIsHostSource) fail('Host bridge import must resolve to a local file')
        return null
      }
      const targetRealPath = await realpath(targetPath).catch(() => null)
      if (!targetRealPath) {
        if (importerIsHostSource) fail('Host bridge import target is unavailable')
        return null
      }

      if (isInside(sources.sourceRoot, targetRealPath)) {
        if (path.resolve(targetPath) !== targetRealPath) fail('Symlink host bridge import is not allowed')
        const sourcePath = toPosix(path.relative(sources.repositoryRoot, targetRealPath))
        if (!capturedPaths.has(sourcePath) || path.extname(targetRealPath) !== '.ts') {
          fail('Bundled host bridge import is outside the captured TypeScript set')
        }
        runtimeImports.add(sourcePath)
        return null
      }

      if (isInside(nodeModulesAbsolute, targetRealPath)) return null
      if (isInside(stageAbsolute, targetRealPath)) {
        const upstreamPath = toPosix(path.relative(stageAbsolute, targetRealPath))
        if (!upstreamPathSet.has(upstreamPath) || path.extname(targetRealPath) === '.mjs') {
          fail('Host bridge import escaped the pinned TypeScript and upstream sources')
        }
        return null
      }
      fail('Host bridge import escaped the captured source closure')
    },
    async load(id) {
      const modulePath = cleanModuleId(id)
      if (!modulePath) return null
      const resolvedModule = await realpath(modulePath).catch(() => null)
      if (!resolvedModule || !isInside(sources.sourceRoot, resolvedModule)) return null
      if (path.resolve(modulePath) !== resolvedModule) fail('Symlink host bridge import is not allowed')
      const sourcePath = toPosix(path.relative(sources.repositoryRoot, resolvedModule))
      if (!capturedPaths.has(sourcePath) || path.extname(resolvedModule) !== '.ts') {
        fail('Bundled host bridge import is outside the captured TypeScript set')
      }
      runtimeImports.add(sourcePath)
      return null
    }
  }
}

