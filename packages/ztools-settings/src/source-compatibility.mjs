import { createHash, randomUUID } from 'node:crypto'
import { open, lstat, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from '@vue/compiler-sfc'
import { settingsSourceCompatibilityPatches } from './compatibility-patches/index.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectoryPrefix = '.ztools-settings-build-'

export const SOURCE_COMPATIBILITY_INPUTS = Object.freeze(
  [
    'packages/ztools-settings/src/source-compatibility.mjs',
    'packages/ztools-settings/src/compatibility-patches/index.mjs',
    'packages/ztools-settings/src/compatibility-patches/about-update.mjs',
    'packages/ztools-settings/src/compatibility-patches/app-global-shortcuts.mjs',
    'packages/ztools-settings/src/compatibility-patches/child-close-lifecycle.mjs',
    'packages/ztools-settings/src/compatibility-patches/hotkey-recording.mjs',
    'packages/ztools-settings/src/compatibility-patches/async-captcha.mjs',
    'packages/ztools-settings/src/compatibility-patches/selector-types.mjs',
    'packages/ztools-settings/src/compatibility-patches/command-types.mjs',
    'packages/ztools-settings/src/compatibility-patches/provider-types.mjs',
    'packages/ztools-settings/src/compatibility-patches/general-save.mjs',
    'packages/ztools-settings/src/compatibility-patches/native-local-drop.mjs',
    'packages/ztools-settings/src/compatibility-patches/builtin-shortcuts.mjs',
    'packages/ztools-settings/src/compatibility-patches/default-height.mjs'
  ]
)

export const PATCHED_UPSTREAM_FILES = Object.freeze(
  settingsSourceCompatibilityPatches.map((patch) => patch.path)
)

function fail(message) {
  throw new Error(`[settings-source-compatibility] ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function countExact(source, needle) {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = source.indexOf(needle, offset)
    if (index === -1) return count
    count += 1
    offset = index + needle.length
  }
}

function assertSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    relativePath.includes('\\')
  ) {
    fail(`unsafe staged source path: ${relativePath}`)
  }
}

async function assertOwnedStagedRoot(stagedRoot) {
  if (typeof stagedRoot !== 'string' || !path.isAbsolute(stagedRoot)) {
    fail('stagedRoot must be an absolute path')
  }
  const resolved = path.resolve(stagedRoot)
  if (resolved !== stagedRoot) fail('stagedRoot must be normalized and may not contain path traversal')

  const realPackageRoot = await realpath(packageRoot)
  if (realPackageRoot !== packageRoot) fail('package root traverses a symlink')
  const relative = path.relative(realPackageRoot, resolved)
  const segments = relative.split(path.sep)
  if (
    path.isAbsolute(relative) ||
    segments.length !== 2 ||
    !segments[0].startsWith(buildDirectoryPrefix) ||
    segments[0].length === buildDirectoryPrefix.length ||
    segments[1] !== 'upstream'
  ) {
    fail('stagedRoot must be an owned .ztools-settings-build-*/upstream directory')
  }

  let current = realPackageRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch {
      fail(`stagedRoot component is missing: ${current}`)
    }
    if (info.isSymbolicLink()) fail(`stagedRoot may not traverse symlinks: ${current}`)
    if (!info.isDirectory()) fail(`stagedRoot component is not a directory: ${current}`)
  }

  const realStagedRoot = await realpath(resolved)
  if (realStagedRoot !== resolved) fail('stagedRoot resolves through a symlink')
  return resolved
}

async function readRegularStagedFile(stagedRoot, relativePath) {
  assertSafeRelativePath(relativePath)
  const segments = relativePath.split('/')
  let current = stagedRoot
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    let info
    try {
      info = await lstat(current)
    } catch {
      fail(`pinned source file is missing: ${relativePath}`)
    }
    if (info.isSymbolicLink()) fail(`pinned source file traverses a symlink: ${relativePath}`)
    if (index < segments.length - 1 && !info.isDirectory()) {
      fail(`pinned source parent is not a directory: ${relativePath}`)
    }
    if (index === segments.length - 1 && !info.isFile()) {
      fail(`pinned source target is not a regular file: ${relativePath}`)
    }
  }

  const realFile = await realpath(current)
  if (!realFile.startsWith(`${stagedRoot}${path.sep}`)) {
    fail(`pinned source file escaped stagedRoot: ${relativePath}`)
  }
  const bytes = await readFile(current)
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`pinned source file is not valid UTF-8: ${relativePath}`)
  }
  return { absolutePath: current, bytes, source, mode: (await lstat(current)).mode & 0o777 }
}

function applyChanges(source, relativePath, changes) {
  let candidate = source
  for (const change of changes) {
    const count = countExact(candidate, change.before)
    if (count !== 1) {
      fail(`${relativePath}: anchor ${change.id} must occur exactly once (found ${count})`)
    }
    candidate = candidate.replace(change.before, change.after)
  }
  return candidate
}

function openingTagStart(source, block) {
  const contentStart = block.loc.start.offset
  if (source[contentStart - 1] !== '>') return -1
  let quote = null
  for (let index = contentStart - 2; index >= 0; index -= 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '<') {
      return index
    }
  }
  return -1
}

function fullBlockBytes(source, block, relativePath) {
  if (!block) return null
  const start = openingTagStart(source, block)
  if (start < 0) fail(`${relativePath}: could not locate the opening <${block.type}> tag`)
  if (!source.startsWith(`<${block.type}`, start)) {
    fail(`${relativePath}: opening tag did not match <${block.type}>`)
  }
  const openingEnd = block.loc.start.offset
  const openingTag = source.slice(start, openingEnd)
  if (/\/\s*>$/.test(openingTag)) return openingTag
  const closingStart = block.loc.end.offset
  if (!source.startsWith(`</${block.type}`, closingStart)) {
    fail(`${relativePath}: could not locate the closing </${block.type}> tag`)
  }
  const closingEnd = source.indexOf('>', closingStart)
  if (closingEnd < 0) fail(`${relativePath}: incomplete </${block.type}> tag`)
  return source.slice(start, closingEnd + 1)
}

function vueTemplateStyleBlocks(source, relativePath) {
  if (!relativePath.endsWith('.vue')) return null
  const { descriptor, errors } = parse(source, { filename: relativePath })
  if (errors.length > 0) fail(`${relativePath}: Vue SFC parse failed during compatibility patch`)
  return {
    template: fullBlockBytes(source, descriptor.template, relativePath),
    styles: descriptor.styles.map((style) => fullBlockBytes(source, style, relativePath))
  }
}

const HOST_LAUNCH_AT_LOGIN_TEMPLATE_CHANGE = Object.freeze({
  path: 'internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue',
  id: 'general-launch-at-login-template',
  kind: 'host-launch-at-login'
})

async function writeAtomic(targetPath, bytes, mode) {
  const temporaryPath = `${targetPath}.compat-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(temporaryPath, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, targetPath)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

async function restoreWrittenFiles(written) {
  const errors = []
  for (const plan of [...written].reverse()) {
    try {
      const current = await readRegularStagedFile(plan.stagedRoot, plan.path)
      if (sha256(current.bytes) !== plan.afterSha256) {
        throw new Error('file changed after compatibility patch; refusing rollback overwrite')
      }
      await writeAtomic(plan.absolutePath, plan.originalBytes, plan.mode)
    } catch (error) {
      errors.push(`${plan.path}: ${error.message}`)
    }
  }
  return errors
}

export async function applySettingsSourceCompatibility(stagedRoot) {
  const safeStagedRoot = await assertOwnedStagedRoot(stagedRoot)
  const patchPaths = new Set()
  const changeIds = new Set()
  const plans = []

  for (const patch of settingsSourceCompatibilityPatches) {
    assertSafeRelativePath(patch.path)
    if (patchPaths.has(patch.path)) fail(`duplicate patch file: ${patch.path}`)
    patchPaths.add(patch.path)
    if (!Array.isArray(patch.changes) || patch.changes.length === 0) {
      fail(`patch has no anchored changes: ${patch.path}`)
    }

    const file = await readRegularStagedFile(safeStagedRoot, patch.path)
    const candidate = applyChanges(file.source, patch.path, patch.changes)
    const beforeSha256 = sha256(file.bytes)
    if (beforeSha256 !== patch.beforeSha256) {
      fail(`${patch.path}: source hash mismatch; expected ${patch.beforeSha256}, got ${beforeSha256}`)
    }

    const beforeBlocks = vueTemplateStyleBlocks(file.source, patch.path)
    const afterBlocks = vueTemplateStyleBlocks(candidate, patch.path)
    const templateUnchanged = JSON.stringify(beforeBlocks?.template) === JSON.stringify(afterBlocks?.template)
    const stylesUnchanged = JSON.stringify(beforeBlocks?.styles) === JSON.stringify(afterBlocks?.styles)
    const templateStyleUnchanged = templateUnchanged && stylesUnchanged
    const hostTemplateChanges = patch.path === HOST_LAUNCH_AT_LOGIN_TEMPLATE_CHANGE.path
      ? patch.changes.filter((change) => change.id === HOST_LAUNCH_AT_LOGIN_TEMPLATE_CHANGE.id
        && change.kind === HOST_LAUNCH_AT_LOGIN_TEMPLATE_CHANGE.kind)
      : []
    if (hostTemplateChanges.length > 1) {
      fail(`${patch.path}: declared host login-item template change must occur exactly once`)
    }
    const hasApprovedTemplateChange = hostTemplateChanges.length === 1
    const expectedTemplate = hasApprovedTemplateChange
      ? vueTemplateStyleBlocks(
        applyChanges(file.source, patch.path, hostTemplateChanges),
        patch.path
      )?.template
      : beforeBlocks?.template
    const templateMatchesApprovedChange = hasApprovedTemplateChange
      && afterBlocks?.template === expectedTemplate
    if (!stylesUnchanged || (!templateUnchanged && !templateMatchesApprovedChange)) {
      fail(`${patch.path}: compatibility patch changed protected Vue template/style bytes`)
    }
    if (hasApprovedTemplateChange && templateUnchanged) {
      fail(`${patch.path}: declared host login-item template change did not change the template`)
    }

    for (const change of patch.changes) {
      if (!change.id || changeIds.has(change.id)) fail(`duplicate or empty change id: ${change.id}`)
      if (
        change.kind !== 'app-global-shortcuts' &&
        change.kind !== 'about-update' &&
        change.kind !== 'child-close-lifecycle' &&
        change.kind !== 'type-only' &&
        change.kind !== 'async-guard' &&
        change.kind !== 'general-save-reliability' &&
        change.kind !== 'native-local-drop' &&
        change.kind !== 'builtin-shortcuts' &&
        change.kind !== 'hotkey-recording' &&
        change.kind !== 'default-height' &&
        change.kind !== HOST_LAUNCH_AT_LOGIN_TEMPLATE_CHANGE.kind
      ) {
        fail(`${patch.path}: unsupported change kind ${change.kind}`)
      }
      changeIds.add(change.id)
    }

    const afterBytes = Buffer.from(candidate, 'utf8')
    plans.push({
      stagedRoot: safeStagedRoot,
      path: patch.path,
      absolutePath: file.absolutePath,
      originalBytes: file.bytes,
      afterBytes,
      beforeSha256,
      afterSha256: sha256(afterBytes),
      mode: file.mode,
      templateUnchanged,
      stylesUnchanged,
      templateStyleUnchanged,
      description: typeof patch.description === 'string' ? patch.description : null,
      changes: patch.changes.map(({ id, kind }) => ({ id, kind }))
    })
  }

  const written = []
  try {
    for (const plan of plans) {
      const current = await readRegularStagedFile(safeStagedRoot, plan.path)
      if (sha256(current.bytes) !== plan.beforeSha256) {
        fail(`${plan.path}: staged source changed after compatibility preflight`)
      }
      await writeAtomic(plan.absolutePath, plan.afterBytes, plan.mode)
      written.push(plan)
    }
  } catch (error) {
    const rollbackErrors = await restoreWrittenFiles(written)
    if (rollbackErrors.length > 0) {
      throw new Error(`${error.message}; compatibility rollback incomplete: ${rollbackErrors.join('; ')}`)
    }
    throw error
  }

  return {
    schemaVersion: 1,
    patchedFiles: plans.map(({
      path: relativePath,
      beforeSha256,
      afterSha256,
      changes,
      templateUnchanged,
      stylesUnchanged,
      templateStyleUnchanged,
      description
    }) => ({
      path: relativePath,
      beforeSha256,
      afterSha256,
      changes,
      templateUnchanged,
      stylesUnchanged,
      templateStyleUnchanged,
      ...(description ? { description } : {})
    })),
    templateUnchanged: plans.every((plan) => plan.templateUnchanged),
    stylesUnchanged: plans.every((plan) => plan.stylesUnchanged),
    templateStyleUnchanged: plans.every((plan) => plan.templateStyleUnchanged)
  }
}
