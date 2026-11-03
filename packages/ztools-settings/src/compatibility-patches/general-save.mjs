export const generalSavePatches = [
  {
    path: 'internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue',
    description: 'Preserve General defaults and route login-item choices through the host while retaining original styling.',
    beforeSha256: '0ad80478c834f9455fa496e17d9d31571481f24a843fc4e73753f4b59ff19a2a',
    changes: [
      {
        id: 'general-loads-clipboard-retention-default',
        kind: 'general-save-reliability',
        before: `      searchMode.value = data.searchMode ?? 'aggregate'`,
        after: `      searchMode.value = data.searchMode ?? 'aggregate'\n      clipboardRetentionDays.value = data.clipboardRetentionDays ?? 180`
      },
      {
        id: 'general-save-notifies-and-rethrows-failure',
        kind: 'general-save-reliability',
        before: `  } catch (error) {\n    console.error('保存设置失败:', error)\n  }\n}\n\nasync function initializeSettings(): Promise<void> {`,
        after: `  } catch (saveError) {\n    console.error('保存设置失败:', saveError)\n    error('设置保存失败，请重新打开设置页后重试')\n    throw saveError\n  }\n}\n\nasync function initializeSettings(): Promise<void> {`
      },
      {
        id: 'general-hotkey-captures-committed-value',
        kind: 'general-save-reliability',
        before: `async function handleHotkeyChange(newHotkey: string): Promise<void> {\n  const previousHotkey = hotkey.value\n  try {`,
        after: `async function handleHotkeyChange(newHotkey: string): Promise<void> {\n  let previousHotkey: string | null = null\n  try {\n    previousHotkey = await window.ztools.internal.getCurrentShortcut()`
      },
      {
        id: 'general-hotkey-failure-reads-latest-committed-value',
        kind: 'general-save-reliability',
        before: `      // 设置失败（被占用等），还原为之前的快捷键\n      hotkey.value = previousHotkey`,
        after: `      // 设置失败（被占用等），还原为最后确认提交的快捷键\n      try {\n        hotkey.value = await window.ztools.internal.getCurrentShortcut()\n      } catch {\n        if (previousHotkey !== null) hotkey.value = previousHotkey\n      }`
      },
      {
        id: 'general-hotkey-catch-reads-latest-committed-value',
        kind: 'general-save-reliability',
        before: `  } catch (err: any) {\n    hotkey.value = previousHotkey\n    console.error('设置快捷键失败:', err)`,
        after: `  } catch (err: any) {\n    try {\n      hotkey.value = await window.ztools.internal.getCurrentShortcut()\n    } catch {\n      if (previousHotkey !== null) hotkey.value = previousHotkey\n    }\n    console.error('设置快捷键失败:', err)`
      },
      {
        id: 'general-loads-empty-current-shortcut',
        kind: 'general-save-reliability',
        before: `    hotkey.value = currentShortcut || defaultHotkey.value`,
        after: `    hotkey.value = currentShortcut`
      },
      {
        id: 'general-launch-at-login-uses-unknown-safe-controller',
        kind: 'host-launch-at-login',
        before: `const launchAtLogin = ref(false)`,
        after: `type HostLaunchAtLoginApi = Parameters<NonNullable<Window['__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__']>>[0]
const launchAtLoginControllerFactory = window.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__
if (typeof launchAtLoginControllerFactory !== 'function') throw new Error('Settings launch-at-login control is unavailable')
// Host bridge extends the pinned internal API; its upstream declaration cannot describe these two methods.
const launchAtLoginInternal = window.ztools.internal as unknown as HostLaunchAtLoginApi
const launchAtLoginController = launchAtLoginControllerFactory(launchAtLoginInternal)
const launchAtLoginState = ref(launchAtLoginController.state())
launchAtLoginController.subscribe((state) => {
  launchAtLoginState.value = state
})`
      },
      {
        id: 'general-launch-at-login-routes-checkbox-write',
        kind: 'host-launch-at-login',
        before: `async function handleLaunchAtLoginChange(): Promise<void> {
  try {
    await window.ztools.internal.setLaunchAtLogin(launchAtLogin.value)
    console.log('开机启动设置已更新:', launchAtLogin.value)
  } catch (error) {
    console.error('更新开机启动设置失败:', error)
    // 恢复状态
    launchAtLogin.value = !launchAtLogin.value
  }
}`,
        after: `function handleLaunchAtLoginChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  void launchAtLoginController.setEnabled(input.checked)
}

const launchAtLoginChoices = [
  ['turnOff', '关闭旧启动项'],
  ['migrate', '迁移到新机制'],
  ['defer', '暂不处理']
] as const

function handleLegacyLaunchAtLoginChoice(choice: typeof launchAtLoginChoices[number][0]): void {
  if (choice === 'defer') return launchAtLoginController.deferLegacy()
  void launchAtLoginController.resolveLegacy(choice)
}`
      },
      {
        id: 'general-launch-at-login-does-not-read-during-db-load',
        kind: 'host-launch-at-login',
        before: `    // 获取开机启动状态
    launchAtLogin.value = await window.ztools.internal.getLaunchAtLogin()`,
        after: `    // Launch-at-login state is read by its isolated host controller.`
      },
      {
        id: 'general-launch-at-login-controller-starts-with-settings',
        kind: 'host-launch-at-login',
        before: `  void initializeSettings()
})`,
        after: `  void initializeSettings()
  void launchAtLoginController.start()
})`
      },
      {
        id: 'general-launch-at-login-controller-disposes-with-view',
        kind: 'host-launch-at-login',
        before: `onUnmounted(() => {
  document.removeEventListener('click', handleQuickActionsClickOutside)
})`,
        after: `onUnmounted(() => {
  document.removeEventListener('click', handleQuickActionsClickOutside)
  launchAtLoginController.dispose()
})`
      },
      {
        id: 'general-launch-at-login-template',
        kind: 'host-launch-at-login',
        before: `      <div class="setting-item">
        <div class="setting-label">
          <span>开机自动启动</span>
          <span class="setting-desc">登录系统时自动启动应用</span>
        </div>
        <div class="setting-control">
          <label class="toggle">
            <input v-model="launchAtLogin" type="checkbox" @change="handleLaunchAtLoginChange" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>`,
        after: `      <div class="setting-item">
        <div class="setting-label">
          <span>开机自动启动</span>
          <span class="setting-desc">登录系统时自动启动应用</span>
        </div>
        <div class="setting-control">
          <span v-if="launchAtLoginState.enabled === null" class="setting-desc">状态未知</span>
          <label class="toggle" :style="{ display: launchAtLoginState.enabled === null ? 'none' : '' }">
            <input
              :checked="launchAtLoginState.enabled === true"
              :indeterminate="launchAtLoginState.enabled === null"
              type="checkbox"
              :aria-checked="launchAtLoginState.enabled === null ? 'mixed' : launchAtLoginState.enabled"
              :disabled="launchAtLoginState.phase !== 'ready'"
              @change="handleLaunchAtLoginChange"
            />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div v-if="launchAtLoginState.phase === 'legacy' || launchAtLoginState.phase === 'error'" class="setting-control-column" role="status" aria-live="polite">
          <span class="setting-desc">{{ launchAtLoginState.message }}</span>
          <div v-if="launchAtLoginState.phase === 'legacy'" class="setting-control">
            <button v-for="choice in launchAtLoginChoices" :key="choice[0]" type="button" class="btn btn-sm" @click="handleLegacyLaunchAtLoginChoice(choice[0])">{{ choice[1] }}</button>
          </div>
          <button v-if="launchAtLoginState.retryable" type="button" class="btn btn-sm" @click="launchAtLoginController.refresh()">重新读取</button>
        </div>
      </div>`
      }
    ]
  }
]
