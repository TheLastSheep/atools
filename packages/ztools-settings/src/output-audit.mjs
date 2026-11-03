import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

import { isInside, sha256 } from './build-integrity.mjs'

const SETTINGS_BUNDLE_BUDGET_METRIC = 'uncompressed_emitted_resources_bytes'

function fail(message) {
  throw new Error(message)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function isForbiddenModule(specifier, builtins) {
  const normalized = specifier.replace(/^node:/, '')
  const topLevel = normalized.split('/')[0]
  return normalized === 'electron' || builtins.has(topLevel)
}

function rejectRuntimeImports(source, filePath, builtins) {
  const importPattern = /\b(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(importPattern)) {
    if (isForbiddenModule(match[1], builtins)) {
      fail(`Runtime output ${filePath} references Node/Electron module ${match[1]}`)
    }
  }
}

export async function inspectEmittedResources(outputRoot, forbiddenPaths, builtins) {
  const resolvedOutput = await realpath(outputRoot)
  const resources = []

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) fail(`Build emitted a symlink: ${relativePath}`)
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) fail(`Build emitted an unsupported filesystem entry: ${relativePath}`)
      const resolvedFile = await realpath(absolutePath)
      if (!isInside(resolvedOutput, resolvedFile)) fail(`Build output escaped its destination: ${relativePath}`)
      const bytes = await readFile(absolutePath)
      for (const forbiddenPath of forbiddenPaths) {
        if (forbiddenPath && bytes.includes(Buffer.from(forbiddenPath))) {
          fail(`Build output ${relativePath} embeds an absolute workspace/source path`)
        }
      }
      if (/\.(?:m?js|html|css)$/i.test(relativePath)) {
        rejectRuntimeImports(bytes.toString('utf8'), relativePath, builtins)
      }
      resources.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) })
    }
  }

  await walk(resolvedOutput)
  resources.sort((left, right) => compareText(left.path, right.path))
  if (!resources.some((resource) => resource.path === 'index.html')) {
    fail('Settings build did not emit index.html')
  }
  if (!resources.some((resource) => /\.m?js$/i.test(resource.path))) {
    fail('Settings build did not emit a JavaScript application chunk')
  }
  const totalBytes = resources.reduce((total, resource) => total + resource.bytes, 0)
  return { resources, totalBytes }
}

function assertBudgetInteger(value, field, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    fail(`Settings bundle budget ${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`)
  }
  return value
}

function validateSettingsBundlePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('Settings bundle budget policy is missing or invalid')
  }
  const expectedKeys = ['baselineBytes', 'maxBytes', 'maxIncreaseBytes', 'metric'].sort()
  const actualKeys = Object.keys(policy).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail('Settings bundle budget policy must contain exactly metric, baselineBytes, maxIncreaseBytes, and maxBytes')
  }
  if (policy.metric !== SETTINGS_BUNDLE_BUDGET_METRIC) {
    fail(`Unsupported settings bundle budget metric: ${String(policy.metric)}`)
  }
  const baselineBytes = assertBudgetInteger(policy.baselineBytes, 'baselineBytes')
  const maxIncreaseBytes = assertBudgetInteger(policy.maxIncreaseBytes, 'maxIncreaseBytes', true)
  const maxBytes = assertBudgetInteger(policy.maxBytes, 'maxBytes')
  if (maxBytes < baselineBytes) fail('Settings bundle budget maxBytes may not be lower than baselineBytes')
  return { baselineBytes, maxIncreaseBytes, maxBytes }
}

function measuredEmittedResourceBytes(emitted) {
  if (!emitted || typeof emitted !== 'object' || Array.isArray(emitted)) {
    fail('Settings emitted resource manifest is missing or invalid')
  }
  if (!Array.isArray(emitted.resources) || emitted.resources.length === 0) {
    fail('Settings emitted resource manifest must contain at least one resource')
  }
  const declaredTotal = assertBudgetInteger(emitted.totalBytes, 'emitted.totalBytes', true)
  const paths = new Set()
  let actualBytes = 0
  let hasIndexHtml = false
  let hasJavaScript = false

  for (const resource of emitted.resources) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      fail('Settings emitted resource manifest contains an invalid resource record')
    }
    const resourcePath = resource.path
    if (
      typeof resourcePath !== 'string' ||
      resourcePath.length === 0 ||
      resourcePath.startsWith('/') ||
      resourcePath.includes('\\') ||
      /^[A-Za-z]:/.test(resourcePath) ||
      resourcePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      fail(`Settings emitted resource path is invalid: ${String(resourcePath)}`)
    }
    if (paths.has(resourcePath)) fail(`Settings emitted resource manifest contains duplicate path ${resourcePath}`)
    paths.add(resourcePath)
    const bytes = assertBudgetInteger(resource.bytes, `${resourcePath}.bytes`, true)
    if (typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(resource.sha256)) {
      fail(`Settings emitted resource ${resourcePath} has an invalid SHA-256 digest`)
    }
    actualBytes += bytes
    if (!Number.isSafeInteger(actualBytes)) fail('Settings emitted resource byte sum exceeds the safe integer range')
    if (resourcePath === 'index.html') hasIndexHtml = true
    if (/\.m?js$/i.test(resourcePath)) hasJavaScript = true
  }

  if (!hasIndexHtml || !hasJavaScript) {
    fail('Settings emitted resource manifest must include index.html and a JavaScript resource')
  }
  if (actualBytes !== declaredTotal) {
    fail(`Settings emitted resource totalBytes ${declaredTotal} does not match resource sum ${actualBytes}`)
  }
  return actualBytes
}

export function assertSettingsBundleBudget(emitted, policy) {
  const { baselineBytes, maxIncreaseBytes, maxBytes } = validateSettingsBundlePolicy(policy)
  const actualBytes = measuredEmittedResourceBytes(emitted)
  const increaseBytes = actualBytes - baselineBytes
  if (increaseBytes > maxIncreaseBytes || actualBytes > maxBytes) {
    fail(
      `Settings emitted resource budget exceeded: ${actualBytes} bytes ` +
      `(increase ${increaseBytes}; limits ${maxIncreaseBytes} increase / ${maxBytes} total)`
    )
  }
  return {
    metric: SETTINGS_BUNDLE_BUDGET_METRIC,
    actualBytes,
    baselineBytes,
    maxIncreaseBytes,
    maxBytes,
    increaseBytes,
    passed: true
  }
}

export async function measureDistribution(outputRoot) {
  const files = []
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) fail(`Distribution contains a symlink: ${relativePath}`)
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath)
        files.push({ path: relativePath, bytes: bytes.byteLength })
      } else {
        fail(`Distribution contains an unsupported filesystem entry: ${relativePath}`)
      }
    }
  }
  await walk(outputRoot)
  files.sort((left, right) => compareText(left.path, right.path))
  return {
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0)
  }
}
