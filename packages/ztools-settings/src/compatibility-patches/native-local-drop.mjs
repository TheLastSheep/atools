export const nativeLocalDropPatches = [
  {
    path: 'internal-plugins/setting/src/views/LocalLaunchSetting/LocalLaunchSetting.vue',
    description: 'Route native file-drop lifecycle/results to the original local-launch view with path-free result notices.',
    beforeSha256: '56638a7934aefd08853b00ba8474c273f6e27fb303b327e16cd594850933e8cb',
    changes: [
      {
        id: 'local-shortcut-native-drop-lifecycle',
        kind: 'native-local-drop',
        before: `import { computed, nextTick, onMounted, ref } from 'vue'`,
        after: `import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'`
      },
      {
        id: 'local-shortcut-native-drop-handler',
        kind: 'native-local-drop',
        before: `// 组件挂载时加载数据
onMounted(() => {
  loadShortcuts()
})`,
        after: `type NativeLocalDropEvent = {
  version: 1
  sessionId: string
  revision: number
  phase: 'enter' | 'leave' | 'result'
  added: number
  failed: number
  busy: boolean
  rejected: boolean
}

type NativeLocalDropInternal = {
  onNativeLocalDrop?: (callback: (event: NativeLocalDropEvent) => void) => () => void
}

let nativeLocalDropViewActive = false
let nativeLocalDropUnsubscribe: (() => void) | undefined
let nativeLocalDropSubscriptionRevision = 0

function isNativeLocalDropRoute(): boolean {
  const match = /^#\\/localLaunch(?:\\?_t=([1-9][0-9]{0,15}))?$/.exec(window.location.hash)
  return match !== null && (match[1] === undefined || Number.isSafeInteger(Number(match[1])))
}

function subscribeNativeLocalDrop(): void {
  if (!nativeLocalDropViewActive || nativeLocalDropUnsubscribe || !isNativeLocalDropRoute()) return

  // The pinned upstream declaration predates this host-owned extension.
  const internal = window.ztools.internal as unknown as NativeLocalDropInternal
  if (typeof internal.onNativeLocalDrop !== 'function') return

  const subscriptionRevision = ++nativeLocalDropSubscriptionRevision
  nativeLocalDropUnsubscribe = internal.onNativeLocalDrop((event) => {
    if (!nativeLocalDropViewActive || subscriptionRevision !== nativeLocalDropSubscriptionRevision) return
    if (event.phase === 'enter') {
      isDragging.value = true
      return
    }
    if (event.phase === 'leave') {
      isDragging.value = false
      return
    }

    if (event.busy) {
      error('上一批处理中，请稍后再试')
      return
    }
    if (event.added > 0) success('添加成功')
    if (event.failed > 0 || event.rejected) error('添加失败')
    void loadShortcuts()
  })
}

function clearNativeLocalDropSubscription(): void {
  nativeLocalDropSubscriptionRevision += 1
  const unsubscribe = nativeLocalDropUnsubscribe
  nativeLocalDropUnsubscribe = undefined
  unsubscribe?.()
}

function handleNativeLocalDropRouteChange(): void {
  isDragging.value = false
  clearNativeLocalDropSubscription()
  const routeChangeRevision = nativeLocalDropSubscriptionRevision
  // Wait until the host's hashchange handler has cleared its prior route subscription.
  void Promise.resolve().then(() => {
    if (routeChangeRevision === nativeLocalDropSubscriptionRevision) subscribeNativeLocalDrop()
  })
}

// 组件挂载时加载数据
onMounted(() => {
  nativeLocalDropViewActive = true
  window.addEventListener('hashchange', handleNativeLocalDropRouteChange)
  subscribeNativeLocalDrop()
  loadShortcuts()
})

onUnmounted(() => {
  nativeLocalDropViewActive = false
  window.removeEventListener('hashchange', handleNativeLocalDropRouteChange)
  clearNativeLocalDropSubscription()
  isDragging.value = false
})`
      }
    ]
  }
]
