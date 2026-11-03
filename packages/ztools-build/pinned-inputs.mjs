import { createRequire, builtinModules } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { sha256, hashFiles, isInside } from '../ztools-settings/src/build-integrity.mjs'
export { sha256, hashFiles, isInside }
export async function capturePinnedSource(root, commit, files) {
  if (!path.isAbsolute(root) || (await realpath(root)) !== path.resolve(root))
    throw new Error('Pinned root must be absolute and contain no symlinks')
  root = await realpath(root)
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  if (
    git(['rev-parse', '--show-toplevel']) !== root ||
    git(['rev-parse', 'HEAD']) !== commit ||
    git(['status', '--porcelain=v1', '--untracked-files=all'])
  )
    throw new Error('Pinned source identity or cleanliness mismatch')
  const tracked = new Set(
    execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0')
  )
  for (const file of files)
    if (!tracked.has(file)) throw new Error(`Untracked source input ${file}`)
  return { root, commit, files: [...files].sort(), snapshot: await hashFiles(root, files) }
}
export async function snapshotFiles(root, files) {
  const result = []
  for (const file of [...files].sort()) {
    const absolute = path.resolve(root, file)
    if (
      !isInside(root, absolute) ||
      (await realpath(absolute)) !== absolute ||
      !(await lstat(absolute)).isFile()
    )
      throw new Error(`Unsafe input ${file}`)
    const bytes = await readFile(absolute)
    result.push({ path: file, sha256: sha256(bytes), bytes: bytes.length })
  }
  return result
}
async function packageRoot(requireFrom, name) {
  let entry
  try {
    entry = requireFrom.resolve(name + '/package.json')
  } catch {
    entry = requireFrom.resolve(name)
  }
  let current = path.dirname(await realpath(entry))
  for (;;) {
    try {
      const meta = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'))
      if (meta.name === name) return { root: current, meta }
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`Package metadata missing ${name}`)
    current = parent
  }
}
/** Hash every installed file of the recursive build/runtime dependency closure. */
export async function captureDependencyClosure(upstream, directVersions) {
  const records = new Map(),
    unavailableOptional = [],
    moduleRoot = await realpath(path.join(upstream, 'node_modules'))
  async function visit(req, name, required, ancestry) {
    let pkg
    try {
      pkg = await packageRoot(req, name)
    } catch (error) {
      if (required) throw error
      unavailableOptional.push({ from: ancestry, name })
      return
    }
    if (!isInside(moduleRoot, pkg.root))
      throw new Error(`Dependency outside pinned node_modules: ${name}`)
    if (records.has(pkg.root)) return
    const files = []
    async function walk(dir) {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) files.push(path.relative(pkg.root, full))
        else throw new Error(`Nonregular dependency input: ${full}`)
      }
    }
    await walk(pkg.root)
    records.set(pkg.root, {
      name,
      version: pkg.meta.version,
      path: path.relative(moduleRoot, pkg.root).split(path.sep).join('/'),
      files: await snapshotFiles(pkg.root, files)
    })
    const childRequire = createRequire(path.join(pkg.root, 'package.json'))
    for (const dep of Object.keys(pkg.meta.dependencies ?? {}).sort())
      await visit(childRequire, dep, true, name)
    for (const dep of Object.keys(pkg.meta.optionalDependencies ?? {}).sort())
      await visit(childRequire, dep, false, name)
    for (const dep of Object.keys(pkg.meta.peerDependencies ?? {}).sort())
      await visit(childRequire, dep, !pkg.meta.peerDependenciesMeta?.[dep]?.optional, name)
  }
  const req = createRequire(path.join(upstream, 'package.json'))
  for (const [name, version] of Object.entries(directVersions)) {
    const pkg = await packageRoot(req, name)
    if (pkg.meta.version !== version) throw new Error(`Dependency version mismatch ${name}`)
    await visit(req, name, true, 'entry')
  }
  return {
    packages: [...records.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unavailableOptional: unavailableOptional.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    )
  }
}
const forbiddenRuntimeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
export function assertWebviewRuntimeSpecifier(specifier) {
  const normalized = specifier.replace(/^node:/, ''),
    top = normalized.split('/')[0]
  if (
    top === 'electron' ||
    forbiddenRuntimeModules.has(top) ||
    /^(?:https?|data):/i.test(normalized)
  )
    throw new Error(`Forbidden WebView runtime import ${specifier}`)
}

/** Capture actual bundled modules and reject accidental Electron/Node imports. */
export function guardedModuleCapture(moduleRoot, records) {
  return {
    name: 'atools-pinned-webview-inputs',
    enforce: 'pre',
    resolveId(id) {
      assertWebviewRuntimeSpecifier(id)
    },
    async load(id) {
      const file = id.split('?')[0]
      if (!path.isAbsolute(file) || !isInside(moduleRoot, file)) return null
      const bytes = await readFile(file)
      records.set(file, {
        path: path.relative(moduleRoot, file).split(path.sep).join('/'),
        sha256: sha256(bytes),
        bytes: bytes.length
      })
      return null
    }
  }
}
