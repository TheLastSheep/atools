export const defaultHeightChanges = [
  {
    id: 'general-height-observes-drafts', kind: 'default-height',
    before: "import { computed, onMounted, onUnmounted, ref } from 'vue'",
    after: "import { computed, onMounted, onUnmounted, ref, watch } from 'vue'"
  },
  {
    id: 'general-height-commit-and-restore-current-draft', kind: 'default-height',
    before: `// 处理窗口默认高度变化
async function handleWindowDefaultHeightChange(): Promise<void> {
  try {
    // 验证输入值
    if (!windowDefaultHeight.value || windowDefaultHeight.value < 200) {
      windowDefaultHeight.value = 541
    }
    await saveSettings()
    // 通知主进程更新
    await window.ztools.internal.setWindowDefaultHeight(windowDefaultHeight.value)
    console.log('插件默认高度已更新:', windowDefaultHeight.value)
  } catch (error) {
    console.error('设置插件默认高度失败:', error)
  }
}

// 重置窗口默认高度
async function resetWindowDefaultHeight(): Promise<void> {
  try {
    windowDefaultHeight.value = 541
    await saveSettings()
    await window.ztools.internal.setWindowDefaultHeight(541)
    console.log('插件默认高度已重置')
  } catch (error) {
    console.error('重置插件默认高度失败:', error)
  }
}`,
    after: `let heightEditGeneration = 0
let heightFormMounted = true
watch(windowDefaultHeight, () => { heightEditGeneration += 1 }, { flush: 'sync' })
onUnmounted(() => { heightFormMounted = false; heightEditGeneration += 1 })
function isCurrentHeightAttempt(attempt: number): boolean {
  return heightFormMounted && attempt === heightEditGeneration
}
async function commitWindowDefaultHeight(height: number): Promise<void> {
  const attempt = ++heightEditGeneration
  let saved = false
  try {
    await saveSettings(undefined, attempt)
    if (!isCurrentHeightAttempt(attempt)) return
    saved = true
    await window.ztools.internal.setWindowDefaultHeight(height)
  } catch {
    if (!isCurrentHeightAttempt(attempt)) return
    if (saved) error('默认高度设置失败，请重试。')
    try {
      const confirmed = await window.ztools.internal.dbGet('settings-general')
      if (isCurrentHeightAttempt(attempt)) windowDefaultHeight.value = confirmed?.windowDefaultHeight ?? 541
    } catch {}
  }
}
async function handleWindowDefaultHeightChange(): Promise<void> {
  if (!windowDefaultHeight.value || windowDefaultHeight.value < 200) windowDefaultHeight.value = 541
  await commitWindowDefaultHeight(windowDefaultHeight.value)
}
async function resetWindowDefaultHeight(): Promise<void> {
  windowDefaultHeight.value = 541
  await commitWindowDefaultHeight(541)
}`
  },
  {
    id: 'general-height-scopes-save-error-feedback', kind: 'default-height',
    before: 'async function saveSettings(): Promise<void> {',
    after: 'async function saveSettings(_event?: unknown, heightAttempt?: number): Promise<void> {'
  },
  {
    id: 'general-height-ignores-obsolete-save-feedback', kind: 'default-height',
    before: "    error('设置保存失败，请重新打开设置页后重试')",
    after: "    if (heightAttempt === undefined || isCurrentHeightAttempt(heightAttempt)) error('设置保存失败，请重新打开设置页后重试')"
  }
]
