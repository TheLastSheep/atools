import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink
} from 'node:fs/promises'
import path from 'node:path'

function fail(message) {
  throw new Error(message)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    fail(`Could not read JSON ${filePath}: ${error.message}`)
  }
}

function verifyDeclaredRanges(packageManifest, expectedRanges, location) {
  const actual = { ...packageManifest.dependencies, ...packageManifest.devDependencies }
  for (const [name, range] of Object.entries(expectedRanges)) {
    if (actual[name] !== range) {
      fail(`Unexpected ${location} dependency range for ${name}: ${actual[name] ?? 'missing'}; expected ${range}`)
    }
  }
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}

async function assertRegularTrackedFile(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    fail(`Unsafe upstream input path: ${relativePath}`)
  }
  let current = root
  for (const segment of relativePath.split(/[\\/]/)) {
    if (!segment || segment === '.') continue
    current = path.join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch {
      fail(`Pinned upstream input is missing: ${relativePath}`)
    }
    if (info.isSymbolicLink()) fail(`Symlink is not allowed in pinned input: ${relativePath}`)
  }
  if (!(await lstat(current)).isFile()) fail(`Pinned upstream input is not a regular file: ${relativePath}`)
  const resolved = await realpath(current)
  if (!isInside(root, resolved)) fail(`Pinned upstream input escaped its checkout: ${relativePath}`)
  return current
}

export async function hashFiles(root, relativePaths) {
  const hash = createHash('sha256')
  let bytes = 0
  const sorted = [...relativePaths].sort(compareText)
  for (const relativePath of sorted) {
    const filePath = await assertRegularTrackedFile(root, relativePath)
    const content = await readFile(filePath)
    hash.update(relativePath.split(path.sep).join('/')).update('\0').update(content).update('\0')
    bytes += content.byteLength
  }
  return { sha256: hash.digest('hex'), files: sorted.length, bytes }
}

export async function verifyUpstream(upstreamPath, manifest) {
  if (!path.isAbsolute(upstreamPath)) fail('--upstream must be an absolute ZTools checkout path')
  const resolved = await realpath(upstreamPath)
  if (path.resolve(upstreamPath) !== resolved) fail('--upstream must not traverse a symlink')
  const topLevel = path.resolve(git(resolved, ['rev-parse', '--show-toplevel']).trim())
  if (topLevel !== resolved) fail('--upstream must point to the ZTools repository root')

  const commit = git(resolved, ['rev-parse', 'HEAD']).trim()
  if (commit !== manifest.source.commit) {
    fail(`Unexpected ZTools commit ${commit}; expected ${manifest.source.commit}`)
  }
  const dirty = git(resolved, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty.length > 0) fail('The ZTools checkout has local changes; build requires a clean pinned source tree')

  const listing = git(resolved, [
    'ls-files', '-z', '--',
    manifest.source.settingRoot,
    manifest.source.sharedRoot,
    ...manifest.source.metadataInputs
  ])
  const files = listing.split('\0').filter(Boolean).sort(compareText)
  const fileSet = new Set(files)
  for (const required of manifest.source.requiredFiles) {
    if (!fileSet.has(required)) fail(`Pinned source input is missing from Git: ${required}`)
  }
  for (const relativePath of files) await assertRegularTrackedFile(resolved, relativePath)

  const settingManifestPath = path.join(resolved, manifest.source.settingRoot, 'package.json')
  const settingPackage = await readJson(settingManifestPath)
  if (settingPackage.name !== manifest.source.packageName || settingPackage.version !== manifest.source.packageVersion) {
    fail(`Unexpected upstream setting package ${settingPackage.name}@${settingPackage.version}`)
  }
  verifyDeclaredRanges(settingPackage, manifest.upstreamDeclaredRanges.setting, 'setting')
  const rootPackage = await readJson(path.join(resolved, 'package.json'))
  if (rootPackage.name !== manifest.source.rootPackageName
    || rootPackage.version !== manifest.source.rootPackageVersion
    || rootPackage.license !== manifest.source.license) {
    fail(`Unexpected upstream package metadata: ${rootPackage.name}@${rootPackage.version}`)
  }
  verifyDeclaredRanges(rootPackage, manifest.upstreamDeclaredRanges.root, 'root')

  return {
    root: resolved,
    commit,
    files,
    sourceHash: await hashFiles(resolved, files),
    settingPackage,
    rootPackage
  }
}

export async function verifyLocalDependencies(packageRoot, manifest) {
  const localNodeModulesPath = path.join(packageRoot, 'node_modules')
  let localNodeModules
  try {
    localNodeModules = await realpath(localNodeModulesPath)
  } catch {
    fail(`Isolated dependencies are missing: ${localNodeModulesPath}`)
  }
  if (!isInside(packageRoot, localNodeModules)) {
    fail('Settings build dependencies must resolve inside packages/ztools-settings/node_modules')
  }

  const adapterPackage = await readJson(path.join(packageRoot, 'package.json'))
  const expectedVersions = manifest.dependencyVersions
  const declared = { ...adapterPackage.dependencies, ...adapterPackage.devDependencies }
  const names = Object.keys(expectedVersions).sort(compareText)
  if (JSON.stringify(Object.keys(declared).sort(compareText)) !== JSON.stringify(names)) {
    fail('packages/ztools-settings/package.json dependency set differs from source-manifest.json')
  }

  const lockPath = path.join(packageRoot, 'package-lock.json')
  const packageLock = await readJson(lockPath)
  const lockRoot = packageLock.packages?.['']
  if (!lockRoot) fail('Isolated npm package-lock.json is missing its root package record')
  const lockDeclared = { ...lockRoot.dependencies, ...lockRoot.devDependencies }
  const packageRecords = {}
  for (const name of names) {
    const version = expectedVersions[name]
    if (declared[name] !== version || lockDeclared[name] !== version) {
      fail(`Dependency ${name} must be pinned to ${version} in package.json and package-lock.json`)
    }
    const linkedPath = path.join(packageRoot, 'node_modules', ...name.split('/'))
    let resolvedRoot
    try {
      resolvedRoot = await realpath(linkedPath)
    } catch {
      fail(`Isolated dependency is not installed: ${name}@${version}`)
    }
    if (!isInside(localNodeModules, resolvedRoot)) {
      fail(`Dependency ${name} resolves outside the isolated node_modules tree`)
    }
    const metadata = await readJson(path.join(resolvedRoot, 'package.json'))
    if (metadata.name !== name || metadata.version !== version) {
      fail(`Installed dependency mismatch for ${name}: found ${metadata.name}@${metadata.version}, expected ${version}`)
    }
    packageRecords[name] = {
      version,
      packageManifestSha256: sha256(await readFile(path.join(resolvedRoot, 'package.json'))),
      bin: metadata.bin,
      root: resolvedRoot
    }
  }

  return {
    packageRecords,
    packageLockSha256: sha256(await readFile(lockPath))
  }
}

export async function createStagedSource(upstream, packageRoot, temporaryRoot) {
  const stageRoot = path.join(temporaryRoot, 'upstream')
  await mkdir(stageRoot)
  for (const relativePath of upstream.files) {
    const sourcePath = path.join(upstream.root, relativePath)
    const destination = path.join(stageRoot, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(sourcePath, destination)
  }

  const stagedHash = await hashFiles(stageRoot, upstream.files)
  if (stagedHash.sha256 !== upstream.sourceHash.sha256 || stagedHash.files !== upstream.sourceHash.files) {
    fail('Staged setting/shared inputs do not match the pinned upstream source hash')
  }

  await symlink(await realpath(path.join(packageRoot, 'node_modules')), path.join(stageRoot, 'node_modules'), 'dir')
  return {
    root: stageRoot,
    settingRoot: path.join(stageRoot, 'internal-plugins/setting'),
    sourceHash: stagedHash
  }
}

export async function hashLocalFile(repositoryRoot, filePath) {
  const resolved = await realpath(filePath)
  if (!isInside(repositoryRoot, resolved)) fail(`Local adapter input must be inside the ATools checkout: ${filePath}`)
  const info = await lstat(filePath)
  if (info.isSymbolicLink() || !info.isFile()) fail(`Local adapter input must be a regular file: ${filePath}`)
  const bytes = await readFile(resolved)
  return {
    path: path.relative(repositoryRoot, resolved).split(path.sep).join('/'),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    content: bytes
  }
}

export async function assertSnapshotUnchanged(snapshot, filePath) {
  const current = await readFile(filePath)
  if (sha256(current) !== snapshot.sha256 || current.byteLength !== snapshot.bytes) {
    fail(`Build input changed while compiling: ${snapshot.path}`)
  }
}

export async function assertUpstreamUnchanged(upstream) {
  const dirty = git(upstream.root, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty.length > 0) fail('The pinned ZTools checkout became dirty during the build')
  const commit = git(upstream.root, ['rev-parse', 'HEAD']).trim()
  if (commit !== upstream.commit) fail('The pinned ZTools commit changed during the build')
  const after = await hashFiles(upstream.root, upstream.files)
  if (after.sha256 !== upstream.sourceHash.sha256 || after.files !== upstream.sourceHash.files) {
    fail('Pinned setting/shared inputs changed during the build')
  }
}
