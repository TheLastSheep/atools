import { patchAutoCheckPreference } from './src/autoCheckCompatibility.mjs'
import { createHash } from 'node:crypto'
import { MAIN_DROP_PATCH, patchMainDrop } from './src/mainDropCompatibility.mjs'
import path from 'node:path'
import { BUILTIN_SHORTCUT_STORE_PATCH, patchBuiltinShortcutStore } from './src/builtinShortcutsCompatibility.mjs'

const STORE_PATH = 'src/renderer/src/stores/commandDataStore.ts'
const SEARCH_RESULTS_PATH = 'src/renderer/src/components/search/SearchResults.vue'

export const RENDERER_COMPATIBILITY_PATCHES = Object.freeze([
  Object.freeze({
    id: 'local-shortcut-history-pin-path-identity',
    path: STORE_PATH,
    beforeSha256: 'dc59f420416b9632de0575d79f3d95d8d96791291aab1a7761d4bdddd1bd3882',
    afterSha256: 'b2fa074e6f5c093b63f1b42185fa60bde4b1060e4c0c9964d39528b53ccc9a55'
  }),
  Object.freeze({
    id: 'local-shortcut-and-app-global-shortcut-identity',
    path: SEARCH_RESULTS_PATH,
    beforeSha256: '772507d90d95e1cf7db91196967ab659ded5d958984e70203e2818f0c70dd033',
    afterSha256: '14bbf6725832cb4f25f805f51881871bd49801e5b61f1c9d6cd9e1fd2569e984'
  }),
  Object.freeze({ ...BUILTIN_SHORTCUT_STORE_PATCH,
    id: "builtin-shortcuts-and-auto-update-startup-generation",
    afterSha256: "54790416e8b0acf1b1a80e14432caf81aae363e54a10c7eef41de4b443b39837" }),
  MAIN_DROP_PATCH
])

const patchByPath = new Map(RENDERER_COMPATIBILITY_PATCHES.map((patch) => [patch.path, patch]))

function fail(message) {
  throw new Error(`Reviewed ZTools renderer compatibility patch: ${message}`)
}

function sha256(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function replaceExact(source, before, after, expectedCount = 1) {
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(before, offset)) !== -1) {
    count += 1
    offset += before.length
  }
  if (count !== expectedCount) {
    fail(`expected ${expectedCount} source marker matches, found ${count}`)
  }
  return source.replaceAll(before, after)
}

function patchCommandDataStore(source) {
  source = replaceExact(
    source,
    ' * - direct/app：先按 path + name 精确匹配，再按 path 回退，使 alias 删除后自动回退原名。',
    ' * - direct/app 与 direct/local-shortcut：先按 path + name 精确匹配，再按 path 回退以兼容别名变化。'
  )

  const genericMatch = `    return commands.value.find(
      (cmd) =>
        cmd.name === storedCommand.name &&
        cmd.type === storedCommand.type &&
        cmd.subType === storedCommand.subType &&
        cmd.featureCode === storedCommand.featureCode
    )`
  const localShortcutMatch = `    if (storedCommand.type === 'direct' && storedCommand.subType === 'local-shortcut') {
      const exactMatch = commands.value.find(
        (cmd) =>
          cmd.type === 'direct' &&
          cmd.subType === 'local-shortcut' &&
          cmd.path === storedCommand.path &&
          cmd.name === storedCommand.name
      )
      if (exactMatch) return exactMatch

      return commands.value.find(
        (cmd) =>
          cmd.type === 'direct' &&
          cmd.subType === 'local-shortcut' &&
          cmd.path === storedCommand.path
      )
    }

${genericMatch}`
  source = replaceExact(source, genericMatch, localShortcutMatch)
  source = replaceExact(
    source,
    " * direct/app 历史与固定支持两种旧数据形态：旧版可能写成 type: 'app'，新版为 type: 'direct' + subType: 'app'。",
    ' * direct/app 与 direct/local-shortcut 历史及固定都按身份类型保留持久化名称。'
  )
  return replaceExact(
    source,
    "(command.type as string) === 'app' || (command.type === 'direct' && command.subType === 'app')",
    "(command.type as string) === 'app' ||\n      (command.type === 'direct' && (command.subType === 'app' || command.subType === 'local-shortcut'))"
  )
}

function patchSearchResults(source) {
  source = replaceExact(source,
    "id: `add-global-shortcut:${JSON.stringify({ name: app.name, pluginTitle: app.pluginTitle || app.pluginName })}`",
    "id: `add-global-shortcut:${JSON.stringify({ path: app.path, name: app.name, subType: app.subType === 'app' && app.type === 'direct' ? 'app' : undefined })}`")
  source = replaceExact(source,
    "const { name, pluginTitle } = JSON.parse(jsonStr)\n      // 构建目标指令字符串（使用插件标题/指令名称格式）\n      const targetCommand = pluginTitle ? `${pluginTitle}/${name}` : name",
    "const { path, name, subType } = JSON.parse(jsonStr)\n      if (subType !== 'app' || typeof path !== 'string' || typeof name !== 'string') return\n      const targetCommand = { path, name, subType: 'app' }")
  return replaceExact(
    source,
    "app.type === 'direct' && app.subType === 'app'",
    "app.type === 'direct' && (app.subType === 'app' || app.subType === 'local-shortcut')",
    3
  )
}

export function applyReviewedRendererCompatibilityPatch(relativePath, source) {
  const descriptor = patchByPath.get(relativePath)
  if (!descriptor) return null
  if (typeof source !== 'string') fail(`source for ${relativePath} must be text`)

  const beforeSha256 = sha256(source)
  if (beforeSha256 !== descriptor.beforeSha256) {
    fail(`unexpected before hash for ${relativePath}: ${beforeSha256}`)
  }

  const patched = relativePath === STORE_PATH
    ? patchCommandDataStore(source)
    : relativePath === SEARCH_RESULTS_PATH ? patchSearchResults(source)
      : relativePath === MAIN_DROP_PATCH.path ? patchMainDrop(source) : patchAutoCheckPreference(patchBuiltinShortcutStore(source))
  const afterSha256 = sha256(patched)
  if (afterSha256 !== descriptor.afterSha256) {
    fail(`unexpected after hash for ${relativePath}: ${afterSha256}`)
  }
  return {
    code: patched,
    patch: { ...descriptor, beforeSha256, afterSha256 }
  }
}

export function createReviewedRendererCompatibilityPlugin(upstreamRoot) {
  const targetIds = new Map(
    RENDERER_COMPATIBILITY_PATCHES.map((patch) => [
      path.resolve(upstreamRoot, patch.path),
      patch.path
    ])
  )
  const applied = new Map()

  const plugin = {
    name: 'atools-reviewed-ztools-renderer-compatibility',
    enforce: 'pre',
    transform(code, id) {
      // Match only each original source module ID. Vue's derived query modules
      // must never receive the SFC-wide reviewed hash or transformation.
      const relativePath = targetIds.get(id)
      if (!relativePath) return null
      const result = applyReviewedRendererCompatibilityPatch(relativePath, code)
      if (!result) fail(`missing reviewed patch for ${relativePath}`)
      if (applied.has(relativePath)) fail(`duplicate transform for ${relativePath}`)
      applied.set(relativePath, result.patch)
      return result.code
    }
  }

  function assertApplied() {
    const missing = RENDERER_COMPATIBILITY_PATCHES
      .filter((patch) => !applied.has(patch.path))
      .map((patch) => patch.path)
    if (missing.length > 0) fail(`required source modules were not transformed: ${missing.join(', ')}`)
    return RENDERER_COMPATIBILITY_PATCHES.map((patch) => ({ ...applied.get(patch.path) }))
  }

  return { plugin, assertApplied }
}
