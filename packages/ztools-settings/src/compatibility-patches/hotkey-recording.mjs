export const hotkeyRecordingPatches = [{
  path: 'internal-plugins/setting/src/components/common/HotkeyInput/HotkeyInput.vue',
  beforeSha256: '650c85558160e0eac86a26fb4713d2083eccaedbd3acd481f63a60ea15d0f230',
  description: 'Bound native recording to a single original widget and its mounted recording epoch.',
  changes: [
    {
      id: 'hotkey-recording-single-widget-owner', kind: 'hotkey-recording',
      before: '<script setup lang="ts">',
      after: `<script lang="ts">
let activeHotkeyWidget: (() => Promise<boolean>) | undefined
</script>

<script setup lang="ts">`
    },
    {
      id: 'hotkey-recording-widget-generation', kind: 'hotkey-recording',
      before: 'async function startRecording(): Promise<void> {',
      after: `type NativeRecordingHooks = {
  stopHotkeyRecording: () => Promise<void>
  onHotkeyRecorded?: (callback: (shortcut: string) => void) => (() => void) | void
  onHotkeyRecordingStopped?: (callback: () => void) => () => void
}
const recordingHooks = window.ztools.internal as unknown as NativeRecordingHooks
let recordingMounted = true
let recordingEpoch = 0

async function startRecording(): Promise<void> {
  if (!recordingMounted) return
  const cleanup = activeHotkeyWidget?.()
  activeHotkeyWidget = stopRecording
  const epoch = ++recordingEpoch`
    },
    {
      id: 'hotkey-recording-waits-for-previous-owner', kind: 'hotkey-recording',
      before: `    const result = await window.ztools.internal.startHotkeyRecording()`,
      after: `    if (cleanup && !(await cleanup)) throw new Error('录制未停止')
    if (epoch !== recordingEpoch) return
    const result = await window.ztools.internal.startHotkeyRecording()`
    },
    {
      id: 'hotkey-recording-shortcuts-fail-closed-result', kind: 'hotkey-recording',
      before: `      console.warn('启动后端快捷键监听失败，使用前端监听:', result.error)`,
      after: `      if (/^#\\/shortcuts(?:[?#]|$)/i.test(window.location.hash)) { await stopRecording(); warning('快捷键录制未能开始'); return }
      console.warn('启动后端快捷键监听失败，使用前端监听:', result.error)`
    },
    {
      id: 'hotkey-recording-shortcuts-fail-closed-error', kind: 'hotkey-recording',
      before: `    console.error('启动后端快捷键监听异常，使用前端监听:', error)`,
      after: `    if (/^#\\/shortcuts(?:[?#]|$)/i.test(window.location.hash)) { await stopRecording(); warning('快捷键录制未能开始'); return }
    console.error('启动后端快捷键监听异常，使用前端监听:', error)`
    },
    {
      id: 'hotkey-recording-no-late-dom-listeners', kind: 'hotkey-recording',
      before: `  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('keyup', handleKeyUp)`,
      after: `  if (!recordingMounted || !isRecording.value || epoch !== recordingEpoch) return
  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('keyup', handleKeyUp)`
    },
    {
      id: 'hotkey-recording-stop-owned-native-lease', kind: 'hotkey-recording',
      before: 'function stopRecording(): void {',
      after: `async function stopRecording(): Promise<boolean> {
  const stopEpoch = ++recordingEpoch`
    },
    {
      id: 'hotkey-recording-stop-ack-return', kind: 'hotkey-recording',
      before: `  document.removeEventListener('keyup', handleKeyUp)
}`,
      after: `  document.removeEventListener('keyup', handleKeyUp)
  if (activeHotkeyWidget !== stopRecording) return true
  try {
    await recordingHooks.stopHotkeyRecording()
    if (activeHotkeyWidget === stopRecording && stopEpoch === recordingEpoch) activeHotkeyWidget = undefined
    return true
  } catch { return false }
}`
    },
    {
      id: 'hotkey-recording-async-confirmation', kind: 'hotkey-recording',
      before: 'function confirmShortcut(shortcut: string): void {',
      after: 'async function confirmShortcut(shortcut: string): Promise<void> {'
    },
    {
      id: 'hotkey-recording-stop-before-save', kind: 'hotkey-recording',
      before: `  emit('update:modelValue', shortcut)
  emit('change', shortcut)
  stopRecording()`,
      after: `  const cleanup = stopRecording()
  const epoch = recordingEpoch
  if (!(await cleanup)) { warning('快捷键录制未完成'); return }
  if (!recordingMounted || epoch !== recordingEpoch || activeHotkeyWidget) return
  emit('update:modelValue', shortcut)
  emit('change', shortcut)`
    },
    {
      id: 'hotkey-recording-orphan-space-release', kind: 'hotkey-recording',
      before: 'function handleKeyUp(e: KeyboardEvent): void {',
      after: `function handleKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space' && !mainKeyPressed.value) return`
    },
    {
      id: 'hotkey-recording-subscription-and-unmount-cleanup', kind: 'hotkey-recording',
      before: `if (window.ztools.internal.onHotkeyRecorded) {
  window.ztools.internal.onHotkeyRecorded(handleHotkeyRecorded)
}

onUnmounted(() => {
  stopRecording()
})`,
      after: `const removeRecorded = recordingHooks.onHotkeyRecorded?.(handleHotkeyRecorded)
const removeStopped = recordingHooks.onHotkeyRecordingStopped?.(() => stopRecording())
onUnmounted(() => {
  recordingMounted = false
  stopRecording()
  if (activeHotkeyWidget === stopRecording) activeHotkeyWidget = undefined
  if (typeof removeRecorded === 'function') removeRecorded()
  removeStopped?.()
})`
    }
  ]
}]
