import assert from 'node:assert/strict'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { measureDistribution } from '../ztools-settings/src/output-audit.mjs'
import { assertWebviewRuntimeSpecifier, sha256 } from './pinned-inputs.mjs'

/** Entry-neutral emitted-resource audit. Never manufactures an index alias or ignores a scan failure.
 * @param {string} outputRoot
 * @param {{entryHtml:string,expectedPaths:string[],forbiddenPaths?:string[]}} options
 */
export async function auditWebviewOutput(
  outputRoot,
  { entryHtml, expectedPaths, forbiddenPaths = [] }
) {
  const root = path.resolve(outputRoot)
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
    throw Error('WebView output must be an ordinary directory')
  const safe = (name) =>
    typeof name === 'string' &&
    !path.isAbsolute(name) &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name.split('/').every((part) => part && part !== '.' && part !== '..')
  if (!safe(entryHtml) || entryHtml.includes('/') || !entryHtml.endsWith('.html'))
    throw Error('Invalid WebView entry HTML')
  if (
    !Array.isArray(expectedPaths) ||
    expectedPaths.some((name) => !safe(name)) ||
    new Set(expectedPaths).size !== expectedPaths.length
  )
    throw Error('Invalid closed WebView resource paths')
  const measured = await measureDistribution(root)
  assert.deepEqual(
    measured.files.map((file) => file.path).sort(),
    [...expectedPaths].sort(),
    'WebView emitted resource set differs'
  )
  if (!expectedPaths.includes(entryHtml)) throw Error(`WebView did not emit ${entryHtml}`)
  if (!expectedPaths.some((name) => /\.m?js$/i.test(name)))
    throw Error('WebView did not emit a JavaScript application chunk')
  const resources = []
  for (const file of measured.files) {
    const bytes = await readFile(path.join(root, file.path))
    for (const forbidden of forbiddenPaths)
      if (forbidden && bytes.includes(Buffer.from(forbidden)))
        throw Error('WebView embeds an absolute source path')
    if (/\.(?:m?js|html|css)$/i.test(file.path)) {
      const text = bytes.toString('utf8')
      for (const match of text.matchAll(
        /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
      ))
        assertWebviewRuntimeSpecifier(match[1])
    }
    assert.equal(bytes.length, file.bytes, 'WebView resource size changed during audit')
    resources.push({ path: file.path, bytes: bytes.length, sha256: sha256(bytes) })
  }
  return { resources, totalBytes: resources.reduce((sum, file) => sum + file.bytes, 0) }
}
