import assert from 'node:assert/strict'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '../packages/ztools-settings/node_modules/typescript/lib/typescript.js'

import { verifyUpstream } from '../packages/ztools-settings/src/build-integrity.mjs'
import {
  applySettingsSourceCompatibility,
  PATCHED_UPSTREAM_FILES
} from '../packages/ztools-settings/src/source-compatibility.mjs'
import { settingsSourceCompatibilityPatches } from '../packages/ztools-settings/src/compatibility-patches/index.mjs'
import {
  assertCaptchaBehavior,
  assertTypeOnlyOutputUnchanged,
  vueStyleBytes,
  vueTemplateBytes
} from './ztools-settings-compatibility-test-helpers.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(repositoryRoot, 'packages/ztools-settings')
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'source-manifest.json'), 'utf8'))

function upstreamArgument(args) {
  const index = args.indexOf('--upstream')
  const value = index === -1 ? '/Users/harris/Desktop/ZTools' : args[index + 1]
  assert.ok(value, '--upstream requires an absolute path')
  assert.ok(path.isAbsolute(value), '--upstream requires an absolute path')
  return value
}

async function createFixture(upstreamRoot) {
  const buildRoot = await mkdtemp(path.join(packageRoot, '.ztools-settings-build-compat-'))
  const stageRoot = path.join(buildRoot, 'upstream')
  await mkdir(stageRoot)
  for (const relativePath of PATCHED_UPSTREAM_FILES) {
    const source = path.join(upstreamRoot, relativePath)
    const target = path.join(stageRoot, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  return { buildRoot, stageRoot }
}

async function snapshotFiles(stageRoot) {
  const snapshot = new Map()
  for (const relativePath of PATCHED_UPSTREAM_FILES) {
    const target = path.join(stageRoot, relativePath)
    const info = await lstat(target)
    snapshot.set(relativePath, {
      mode: info.mode & 0o777,
      kind: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'other',
      contents: info.isSymbolicLink() ? await readlink(target) : await readFile(target)
    })
  }
  return snapshot
}

async function assertRejectedWithoutWrites(upstreamRoot, mutate, expectedError) {
  const fixture = await createFixture(upstreamRoot)
  try {
    await mutate(fixture.stageRoot)
    const before = await snapshotFiles(fixture.stageRoot)
    await assert.rejects(
      () => applySettingsSourceCompatibility(fixture.stageRoot),
      expectedError
    )
    assert.deepEqual(
      await snapshotFiles(fixture.stageRoot),
      before,
      'a rejected all-file preflight must leave every staged source unchanged'
    )
  } finally {
    await rm(fixture.buildRoot, { recursive: true, force: true })
  }
}

async function verifySuccessfulPatch(upstreamRoot) {
  const fixture = await createFixture(upstreamRoot)
  try {
    const before = await snapshotFiles(fixture.stageRoot)
    const report = await applySettingsSourceCompatibility(fixture.stageRoot)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.templateUnchanged, false)
    assert.equal(report.stylesUnchanged, true)
    assert.equal(report.templateStyleUnchanged, false)
    assert.deepEqual(report.patchedFiles.map((file) => file.path), PATCHED_UPSTREAM_FILES)

    for (const file of report.patchedFiles) {
      assert.match(file.beforeSha256, /^[a-f0-9]{64}$/)
      assert.match(file.afterSha256, /^[a-f0-9]{64}$/)
      assert.ok(file.changes.length > 0)
      const launchAtLoginPatch = file.path.endsWith('/GeneralSetting.vue')
      assert.equal(file.templateUnchanged, !launchAtLoginPatch)
      assert.equal(file.stylesUnchanged, true)
      assert.equal(file.templateStyleUnchanged, !launchAtLoginPatch)
      const after = await readFile(path.join(fixture.stageRoot, file.path), 'utf8')
      const original = before.get(file.path).contents.toString('utf8')
      if (file.path.endsWith('.vue')) {
        assert.equal(vueStyleBytes(after, file.path), vueStyleBytes(original, file.path),
          `${file.path} style block bytes changed`)
        if (launchAtLoginPatch) {
          assert.notEqual(vueTemplateBytes(after, file.path), vueTemplateBytes(original, file.path),
            'the isolated General copy must replace the unsafe login-item row')
        } else {
          assert.equal(vueTemplateBytes(after, file.path), vueTemplateBytes(original, file.path),
            `${file.path} template bytes changed`)
        }
      }
      if (file.changes.every((change) => change.kind === 'type-only')) {
        assertTypeOnlyOutputUnchanged(file.path, original, after)
      }
    }

    const generalPath = PATCHED_UPSTREAM_FILES.find((file) => file.endsWith('/GeneralSetting.vue'))
    const generalPatch = report.patchedFiles.find((file) => file.path === generalPath)
    assert.equal(
      generalPatch.description,
      'Preserve General defaults and route login-item choices through the host while retaining original styling.'
    )
    assert.deepEqual(generalPatch.changes.map((change) => change.id), [
      'general-loads-clipboard-retention-default',
      'general-save-notifies-and-rethrows-failure',
      'general-hotkey-captures-committed-value',
      'general-hotkey-failure-reads-latest-committed-value',
      'general-hotkey-catch-reads-latest-committed-value',
      'general-loads-empty-current-shortcut',
      'general-launch-at-login-uses-unknown-safe-controller',
      'general-launch-at-login-routes-checkbox-write',
      'general-launch-at-login-does-not-read-during-db-load',
      'general-launch-at-login-controller-starts-with-settings',
      'general-launch-at-login-controller-disposes-with-view',
      'general-launch-at-login-template',
      'general-height-observes-drafts',
      'general-height-commit-and-restore-current-draft',
      'general-height-scopes-save-error-feedback',
      'general-height-ignores-obsolete-save-feedback'
    ])
    const generalSource = await readFile(path.join(fixture.stageRoot, generalPath), 'utf8')
    assert.ok(generalSource.includes("clipboardRetentionDays.value = data.clipboardRetentionDays ?? 180"))
    assert.ok(generalSource.includes("error('设置保存失败，请重新打开设置页后重试')"))
    assert.ok(generalSource.includes("console.error('保存设置失败:', saveError)\n    if (heightAttempt === undefined || isCurrentHeightAttempt(heightAttempt)) error("))
    assert.ok(generalSource.includes('    throw saveError\n  }\n}\n\nasync function initializeSettings'))
    assert.ok(generalSource.includes(
      'async function handleHotkeyChange(newHotkey: string): Promise<void> {\n  let previousHotkey: string | null = null\n  try {\n    previousHotkey = await window.ztools.internal.getCurrentShortcut()'
    ))
    assert.ok(generalSource.includes('hotkey.value = await window.ztools.internal.getCurrentShortcut()'))
    assert.ok(generalSource.includes('hotkey.value = currentShortcut\n'),
      'the General form must display the confirmed empty shortcut without substituting a default')
    assert.ok(!generalSource.includes('hotkey.value = currentShortcut || defaultHotkey.value'),
      'an unregistered shortcut must stay empty so the user can repair it explicitly')
    assert.ok(generalSource.includes('__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__'))
    assert.ok(generalSource.includes("type HostLaunchAtLoginApi = Parameters<NonNullable<Window['__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__']>>[0]"))
    assert.ok(generalSource.includes(
      'const launchAtLoginInternal = window.ztools.internal as unknown as HostLaunchAtLoginApi'
    ))
    assert.ok(generalSource.includes('launchAtLoginControllerFactory(launchAtLoginInternal)'))
    assert.ok(!generalSource.includes('__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__ as any'))
    assert.ok(generalSource.includes("launchAtLoginController.resolveLegacy(choice)"))
    assert.ok(generalSource.includes("launchAtLoginState.phase === 'legacy'"))
    assert.ok(generalSource.includes(':indeterminate="launchAtLoginState.enabled === null"'))
    assert.ok(generalSource.includes('class="setting-desc">状态未知</span>'))
    assert.ok(generalSource.includes("launchAtLoginState.enabled === null ? 'mixed'"))
    assert.ok(generalSource.includes(':disabled="launchAtLoginState.phase !== \'ready\'"'))
    assert.ok(generalSource.includes("launchAtLoginState.phase === 'legacy' || launchAtLoginState.phase === 'error'"))
    assert.ok(generalSource.includes("const launchAtLoginChoices = [\n  ['turnOff', '关闭旧启动项'],\n  ['migrate', '迁移到新机制'],\n  ['defer', '暂不处理']\n] as const"))
    assert.ok(generalSource.includes('typeof launchAtLoginChoices[number][0]'))
    assert.ok(generalSource.includes('v-for="choice in launchAtLoginChoices"'))
    assert.ok(generalSource.includes(':key="choice[0]"'))
    assert.ok(generalSource.includes('@click="handleLegacyLaunchAtLoginChoice(choice[0])"'))
    assert.ok(generalSource.includes("if (choice === 'defer') return launchAtLoginController.deferLegacy()"))
    assert.ok(generalSource.includes('class="setting-control-column" role="status" aria-live="polite"'))
    assert.ok(generalSource.includes('v-if="launchAtLoginState.phase === \'legacy\'" class="setting-control"'))
    assert.ok(generalSource.includes('class="btn btn-sm"'))
    assert.ok(generalSource.includes('v-if="launchAtLoginState.retryable"'))
    assert.ok(generalSource.includes('launchAtLoginController.dispose()'))
    assert.ok(!generalSource.includes('unsubscribeLaunchAtLogin'),
      'controller.dispose() owns subscriber cleanup, so a second unsubscribe is redundant')
    assert.ok(!generalSource.includes('v-model="launchAtLogin"'),
      'the unknown legacy status must not be presented as an unchecked editable boolean')
    assert.ok(!generalSource.includes('launchAtLogin.value = await window.ztools.internal.getLaunchAtLogin()'),
      'the old false default must not survive a failed operating-system read')
    await verifyEmptyShortcutLoad(generalSource)
    await verifyHotkeyFailureUsesLatestCommit(generalSource)

    const captchaPath = PATCHED_UPSTREAM_FILES.find((file) => file.endsWith('AliyunCaptcha.vue'))
    const captchaSource = await readFile(path.join(fixture.stageRoot, captchaPath), 'utf8')
    await assertCaptchaBehavior(captchaSource, path.join(fixture.stageRoot, captchaPath))
  } finally {
    await rm(fixture.buildRoot, { recursive: true, force: true })
  }
}

async function verifyHotkeyFailureUsesLatestCommit(source) {
  const start = source.indexOf('async function handleHotkeyChange')
  const end = source.indexOf('\nasync function applyHotkeyPreset', start)
  assert.ok(start >= 0 && end > start, 'patched General hotkey handler must remain available')
  const handler = source.slice(start, end)
  const output = ts.transpileModule(handler, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let exposeHandler
  try {
    exposeHandler = new Function(
      'window', 'hotkey', 'saveSettings', 'error', 'console', `${output}\nreturn handleHotkeyChange`
    )
  } catch (error) {
    assert.fail(`patched hotkey handler did not compile: ${String(error)}`)
  }

  let committed = 'Option+Z'
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let queue = Promise.resolve()
  const requested = []
  const messages = []
  const api = {
    getCurrentShortcut: async () => committed,
    updateShortcut(value) {
      requested.push(value)
      const operation = queue.then(async () => {
        if (value === 'Option+B') {
          await firstGate
          committed = value
          return { success: true }
        }
        return { success: false, error: 'occupied' }
      })
      queue = operation.then(() => {}, () => {})
      return operation
    }
  }
  const hotkey = { value: 'Option+B' }
  const handlerFunction = exposeHandler(
    { ztools: { internal: api } },
    hotkey,
    async () => {},
    (message) => messages.push(message),
    { log() {}, error() {} }
  )
  const first = handlerFunction('Option+B')
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(requested, ['Option+B'])

  hotkey.value = 'Option+C'
  const second = handlerFunction('Option+C')
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(requested, ['Option+B', 'Option+C'])

  releaseFirst()
  await Promise.all([first, second])
  assert.equal(committed, 'Option+B')
  assert.equal(hotkey.value, committed, 'a stale later failure must restore the latest committed shortcut')
  assert.equal(messages.length, 1)
}

async function verifyEmptyShortcutLoad(source) {
  const start = source.indexOf('async function loadSettings(): Promise<void>')
  const end = source.indexOf('\n// 保存设置', start)
  assert.ok(start >= 0 && end > start, 'patched General loadSettings must remain available')
  const output = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let exposeLoader
  try {
    exposeLoader = new Function(
      'window', 'console', 'hotkey', 'opacity', 'launchAtLogin', 'defaultHotkey',
      `${output}\nreturn loadSettings`
    )
  } catch (error) {
    assert.fail(`patched General loader did not compile: ${String(error)}`)
  }

  const hotkey = { value: 'Option+Z' }
  const loader = exposeLoader(
    { ztools: { internal: {
      dbGet: async () => null,
      getCurrentShortcut: async () => '',
      setWindowOpacity: async () => {},
      getLaunchAtLogin: async () => false
    } } },
    { log() {}, error() {} }, hotkey, { value: 1 }, { value: false }, { value: 'Option+Z' }
  )
  await loader()
  assert.equal(hotkey.value, '', 'the loaded UI must not replace the confirmed empty shortcut with a default')
}

async function main() {
  const upstream = await verifyUpstream(upstreamArgument(process.argv.slice(2)), manifest)
  await verifySuccessfulPatch(upstream.root)

  await assertRejectedWithoutWrites(upstream.root, async (stageRoot) => {
    const target = path.join(stageRoot, PATCHED_UPSTREAM_FILES.at(-1))
    await writeFile(target, '\n', { flag: 'a' })
  }, /source hash mismatch/)

  await assertRejectedWithoutWrites(upstream.root, async (stageRoot) => {
    const target = path.join(stageRoot, PATCHED_UPSTREAM_FILES[0])
    const duplicateAnchor = `\n${settingsSourceCompatibilityPatches[0].changes[0].before}`
    await writeFile(target, duplicateAnchor, { flag: 'a' })
  }, /anchor .* must occur exactly once/)

  await assertRejectedWithoutWrites(upstream.root, async (stageRoot) => {
    const patch = settingsSourceCompatibilityPatches.find((item) => item.path.endsWith('/setting/src/main.ts'))
    assert.ok(patch)
    await writeFile(path.join(stageRoot, patch.path), `\n${patch.changes[0].before}`, { flag: 'a' })
  }, /anchor settings-child-out-skips-general-remount must occur exactly once/)

  await assertRejectedWithoutWrites(upstream.root, async (stageRoot) => {
    const patch = settingsSourceCompatibilityPatches.find((item) => item.path.endsWith('/setting/src/main.ts'))
    assert.ok(patch)
    await writeFile(path.join(stageRoot, patch.path), '\n', { flag: 'a' })
  }, /source hash mismatch/)

  await assertRejectedWithoutWrites(upstream.root, async (stageRoot) => {
    const targetPath = PATCHED_UPSTREAM_FILES[0]
    const target = path.join(stageRoot, targetPath)
    const replacement = path.join(stageRoot, PATCHED_UPSTREAM_FILES[1])
    await rm(target)
    await symlink(replacement, target)
  }, /pinned source file traverses a symlink/)

  const generalPatch = settingsSourceCompatibilityPatches.find((patch) => (
    patch.path === 'internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue'
  ))
  assert.ok(generalPatch, 'the pinned General patch must be present for the scoped template test')
  const unauthorizedTemplateChange = {
    id: 'test-unauthorized-general-template-change',
    kind: 'general-save-reliability',
    before: '<span>自动清空搜索框</span>',
    after: '<span>自动清空搜索框（测试变更）</span>'
  }
  generalPatch.changes.push(unauthorizedTemplateChange)
  try {
    await assertRejectedWithoutWrites(upstream.root, async () => {}, /protected Vue template\/style bytes/)
  } finally {
    generalPatch.changes.pop()
  }

  await verifyUpstream(upstream.root, manifest)
  process.stdout.write('settings compatibility patch checks passed\n')
}

await main()
