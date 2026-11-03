export const aboutUpdatePatches = [{
  path: "internal-plugins/setting/src/views/AboutSetting/AboutSetting.vue",
  description: "Use the scoped updater and restore confirmed preference state without changing template or styling.",
  beforeSha256: "8e7b289b7e22c820620322413b7abceb4b7c73e38bb067a882ec501e07105a89",
  changes: [{ id: "about-update-scoped-controller", kind: "about-update", before: `<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useToast } from '@/components'

const { info, error, confirm } = useToast()

const appVersion = ref('')
const isCheckingUpdate = ref(false)
const autoCheckUpdate = ref(true)
const currentYear = new Date().getFullYear()

onMounted(async () => {
  await getAppVersion()
  await loadAutoCheckSetting()
})

async function getAppVersion(): Promise<void> {
  try {
    appVersion.value = await window.ztools.internal.getAppVersion()
  } catch (err) {
    console.error('获取版本失败:', err)
    appVersion.value = '未知'
  }
}

async function handleCheckUpdate(): Promise<void> {
  if (isCheckingUpdate.value) return
  isCheckingUpdate.value = true

  try {
    const result = await window.ztools.internal.updaterCheckUpdate()
    if (result.migrationRequired) {
      const shouldOpenRelease = await confirm({
        title: '需要更新 ZTools',
        message:
          '当前版本使用的是较早的更新方式，请安装一次最新完整版本。您的数据、设置和插件都会保留。',
        type: 'info',
        confirmText: '下载最新版本',
        cancelText: '稍后'
      })
      if (shouldOpenRelease) {
        window.ztools.shellOpenExternal(
          result.releaseUrl || 'https://github.com/ZToolsCenter/ZTools/releases/latest'
        )
      }
      return
    }
    if (!result.hasUpdate) {
      if (result.error) {
        error('检查更新出错: ' + result.error)
      } else {
        info('当前已是最新版本')
      }
    }
  } catch (err: any) {
    console.error('检查更新失败:', err)
    error('检查更新失败: ' + (err.message || '未知错误'))
  } finally {
    isCheckingUpdate.value = false
  }
}

function openQQGroup(): void {
  window.ztools.shellOpenExternal('https://qm.qq.com/q/fXCzbh3Txe')
}

function openGithub(): void {
  window.ztools.shellOpenExternal('https://github.com/ZToolsCenter/ZTools')
}

function openSponsor(): void {
  window.ztools.shellOpenExternal('https://afdian.com/a/ZTools')
}

async function loadAutoCheckSetting(): Promise<void> {
  try {
    const data = await window.ztools.internal.dbGet('settings-general')
    if (data) {
      autoCheckUpdate.value = data.autoCheckUpdate ?? true
    }
  } catch (err) {
    console.error('加载自动更新设置失败:', err)
  }
}

async function handleAutoCheckUpdateChange(): Promise<void> {
  try {
    // 更新数据库中的设置
    const data = (await window.ztools.internal.dbGet('settings-general')) || {}
    data.autoCheckUpdate = autoCheckUpdate.value
    await window.ztools.internal.dbPut('settings-general', data)
    // 通知主进程
    await window.ztools.internal.updaterSetAutoCheck(autoCheckUpdate.value)
  } catch (err) {
    console.error('更新自动检查更新设置失败:', err)
  }
}
</script>`, after: `<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useToast } from '@/components'

const { info, error } = useToast()
const appVersion = ref('')
const isCheckingUpdate = ref(false)
const autoCheckUpdate = ref(true)
const currentYear = new Date().getFullYear()
// Only the scoped Child facade exposes these three methods.
const aboutApi = window.ztools.internal as unknown as {
  getAppVersion(): Promise<string>
  updaterCheckUpdate(): Promise<{ success: true; hasUpdate: boolean }>
  updaterSetAutoCheck(enabled: boolean): Promise<{
    value: { autoCheckUpdate: boolean }; runtimeApplied: boolean; notificationDelivered: boolean
  }>
  dbGet(key: 'settings-general'): Promise<{ autoCheckUpdate: boolean }>
}
let alive = true
let confirmedAuto = true
let autoGeneration = 0
let autoBlocked = false
let autoQueue = Promise.resolve()
let settingsLoad: Promise<void> | undefined
onBeforeUnmount(() => { alive = false; autoGeneration += 1 })
onMounted(() => { void getAppVersion(); void loadAutoCheckSetting() })

async function getAppVersion(): Promise<void> {
  try {
    const version = await aboutApi.getAppVersion()
    if (alive) appVersion.value = version
  } catch {
    if (alive) appVersion.value = '未知'
  }
}

async function handleCheckUpdate(): Promise<void> {
  if (!alive || isCheckingUpdate.value) return
  isCheckingUpdate.value = true
  try {
    const result = await aboutApi.updaterCheckUpdate()
    if (alive && !result.hasUpdate) info('当前已是最新版本')
  } catch (err: any) {
    if (alive) error('检查更新失败: ' + (err.message || '未知错误'))
  } finally {
    if (alive) isCheckingUpdate.value = false
  }
}

function openQQGroup(): void {
  window.ztools.shellOpenExternal('https://qm.qq.com/q/fXCzbh3Txe')
}
function openGithub(): void {
  window.ztools.shellOpenExternal('https://github.com/ZToolsCenter/ZTools')
}
function openSponsor(): void {
  window.ztools.shellOpenExternal('https://afdian.com/a/ZTools')
}

function loadAutoCheckSetting(): Promise<void> {
  if (settingsLoad) return settingsLoad
  const generation = autoGeneration
  settingsLoad = (async () => {
    try {
      const data = await aboutApi.dbGet('settings-general')
      if (!alive) return
      confirmedAuto = data.autoCheckUpdate
      if (generation === autoGeneration) autoCheckUpdate.value = confirmedAuto
    } catch {
      autoBlocked = true
      if (alive) error('加载自动更新设置失败，请重新打开设置')
    }
  })()
  return settingsLoad
}

function handleAutoCheckUpdateChange(): Promise<void> {
  const enabled = autoCheckUpdate.value
  const generation = ++autoGeneration
  autoQueue = autoQueue.then(async () => {
    await loadAutoCheckSetting()
    if (!alive) return
    if (autoBlocked) { autoCheckUpdate.value = confirmedAuto; return }
    try {
      const reply = await aboutApi.updaterSetAutoCheck(enabled)
      if (!alive) return
      confirmedAuto = reply.value.autoCheckUpdate
      if (!reply.runtimeApplied || !reply.notificationDelivered) {
        autoBlocked = true
        autoGeneration += 1
        autoCheckUpdate.value = confirmedAuto
        error('设置已保存，但更新检查或主窗口通知未确认，请重新打开设置')
      } else if (generation === autoGeneration) autoCheckUpdate.value = confirmedAuto
    } catch {
      if (!alive) return
      autoBlocked = true
      autoGeneration += 1
      autoCheckUpdate.value = confirmedAuto
      error('自动检查设置未确认，请重新打开设置')
    }
  })
  return autoQueue
}
</script>` }]
}]
