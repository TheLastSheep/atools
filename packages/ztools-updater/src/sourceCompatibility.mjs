import { createHash } from 'node:crypto';
const sha = source => createHash('sha256').update(source).digest('hex');
const path = 'src/renderer/src/components/updater/UpdateWindow.vue';
export const UPDATER_PATCH = Object.freeze({ id: 'original-updater-safe-host-v1', path,
    beforeSha256: '7bc61add51b8633b3929c00390867d3392147cc933c46a10efb044a3ce1041cf', version: 1 });
function replace(source, before, after) {
    if (source.split(before).length !== 2)
        throw new Error('Updater compatibility marker mismatch');
    return source.replace(before, after);
}
export function patchUpdater(source) {
    if (sha(source) !== UPDATER_PATCH.beforeSha256)
        throw new Error('Updater original source SHA mismatch');
    const before = source;
    const materialStart = source.indexOf('  // 监听窗口材质更新');
    const materialEnd = source.indexOf('  // 监听系统主题变化', materialStart);
    if (materialStart < 0 || materialEnd < 0) throw Error('Updater appearance marker mismatch');
    source = source.slice(0, materialStart) + `  // 监听真实owned popup材质与透明度，所有回调可取消
  stopUpdateListeners.push(getUpdaterAppearance().onMaterial(material => {
    document.documentElement.setAttribute('data-material', material)
    applyAcrylicOverlay()
  }))
  stopUpdateListeners.push(getUpdaterAppearance().onError(error => {
    if (error) console.warn('更新窗口部分外观信息不可用。')
  }))
  stopUpdateListeners.push(getUpdaterAppearance().onOpacity(data => {
    acrylicLightOpacity.value = data.lightOpacity
    acrylicDarkOpacity.value = data.darkOpacity
    applyAcrylicOverlay()
  }))

` + source.slice(materialEnd);

    source = replace(source, "import { computed, onBeforeUnmount, onMounted, ref } from 'vue'", "import { computed, onBeforeUnmount, onMounted, ref, watchPostEffect } from 'vue'");
    source = replace(source, "import { marked } from 'marked'", "import { renderSafeMarkdown } from '@atools-updater/safeMarkdown'\nimport { getUpdaterAppearance } from '@atools-updater/hostBridge'\nimport { bindUpdaterUi, openUpdaterLink, startUpdaterDrag, type UpdaterUiProjection } from '@atools-updater/uiProjection'");
    source = replace(source, 'return marked.parse(changelog.value)', 'return renderSafeMarkdown(changelog.value)');
    source = replace(source, "const isBusy = computed(() => status.value === 'downloading' || status.value === 'installing')", "const isBusy = computed(() => status.value === 'downloading' || status.value === 'installing' || ['downloading','installing','restarting'].includes(nativePhase.value) || nativeOperationBusy.value || actionPending.value)");
    const start = source.indexOf('const startUpdate = async (): Promise<void> => {');
    const end = source.indexOf('\nconst closeWindow =', start);
    if (start < 0 || end < 0)
        throw new Error('Updater action marker mismatch');
    source = source.slice(0, start) + `const startUpdate = async (): Promise<void> => {
  if (isBusy.value || !updateInfo.value) return
  actionPending.value = true
  const generation = uiProjectionGeneration
  updateError.value = ''
  try {
    const result = status.value === 'downloaded'
      ? await window.ztools.updater.installDownloadedUpdate()
      : await window.ztools.updater.startUpdate()
    if (!result.success && !updaterDisposed && generation === uiProjectionGeneration) {
      updateError.value = result.error || '更新失败，请重试'
      status.value = 'error'
    }
  } catch (error) {
    if (!updaterDisposed && generation === uiProjectionGeneration) {
      updateError.value = error instanceof Error ? error.message : '更新失败，请重试'
      status.value = 'error'
    }
  } finally { if (!updaterDisposed) actionPending.value = false }
}
` + source.slice(end);
    source = replace(source, `const handleKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && !isBusy.value) {
    closeWindow()
  } else if (e.key === 'Enter' && !isBusy.value) {
    void startUpdate()
  }
}`, `const handleKeydown = (e: KeyboardEvent): void => {
  if (e.isComposing || e.keyCode === 229) return
  if (e.repeat) { if (e.key === 'Enter') e.preventDefault(); return }
  if (e.key === 'Escape') { if (!isBusy.value) closeWindow(); return }
  if (e.key !== 'Enter') return
  const target = e.target as Element | null
  if (target?.closest?.('button,a,input,textarea,select,[contenteditable],[role="button"]')) return
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.getModifierState?.('AltGraph')) return
  if (!isBusy.value) { e.preventDefault(); void startUpdate() }
}`);
    source = replace(source, 'const primaryButtonText = computed(() => {', `const primaryButtonText = computed(() => {
  if (nativePhase.value === 'restart-pending') return '重试重启'
  if (nativePhase.value === 'install-unknown') return '确认重试安装'
  if (nativePhase.value === 'restarting') return '正在重启...'`);
    source = replace(source, 'const stopUpdateListeners: Array<() => void> = []', `const stopUpdateListeners: Array<() => void> = []
const nativePhase = ref('idle')
const actionPending = ref(false)
const nativeOperationBusy = ref(false)
let uiProjectionGeneration = 0
let stopProjection: (() => void) | undefined
const stopDomListeners: Array<() => void> = []`);
    source = replace(source, '  // 请求更新信息\n', `  stopDomListeners.push(watchPostEffect(() => {
    if (!updateInfo.value) {
      const title = el?.querySelector('.title')
      if (title) title.textContent = nativePhase.value === 'checking' ? '正在检查更新...' : nativePhase.value === 'idle' ? '正在读取更新信息...' : '当前没有可用更新'
    }
  }))
  stopProjection = bindUpdaterUi((state: UpdaterUiProjection) => {
    uiProjectionGeneration += 1
    nativeOperationBusy.value = state.busy
    if (!state.candidate) { updateInfo.value = null; version.value = ''; changelog.value = '' }
    nativePhase.value = state.phase
    status.value = state.status
    updateError.value = state.error
  })
  // 请求更新信息
`);
    source = replace(source, "  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {\n    applyAcrylicOverlay()\n  })", `  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onTheme = (): void => applyAcrylicOverlay()
  media.addEventListener('change', onTheme)
  stopDomListeners.push(() => media.removeEventListener('change', onTheme))
  const interceptLink = (event: MouseEvent): void => {
    const link = (event.target as Element | null)?.closest?.('.changelog a')
    if (!link) return
    event.preventDefault()
    event.stopPropagation()
    const href = link.getAttribute('href')
    if (href) openUpdaterLink(href)
  }
  el?.addEventListener('click', interceptLink, true)
  el?.addEventListener('auxclick', interceptLink, true)
  stopDomListeners.push(() => { el?.removeEventListener('click', interceptLink, true); el?.removeEventListener('auxclick', interceptLink, true) })
  const dragTitlebar = (event: PointerEvent): void => {
    const target = event.target as Element | null
    if (event.button !== 0 || !event.isPrimary || !target?.closest?.('.header.window-drag-region')) return
    if (target.closest('button,a,input,textarea,select,[contenteditable],.no-drag,[data-no-drag]')) return
    event.preventDefault()
    startUpdaterDrag()
  }
  el?.addEventListener('pointerdown', dragTitlebar)
  stopDomListeners.push(() => el?.removeEventListener('pointerdown', dragTitlebar))`);
    source = replace(source, 'onMounted(() => {', `onMounted(() => {
  window.addEventListener('pagehide', cleanupUpdater, { once: true })
  stopDomListeners.push(() => window.removeEventListener('pagehide', cleanupUpdater))`);
    source = replace(source, `onBeforeUnmount(() => {
  stopUpdateListeners.forEach((stop) => stop())
})`, `let updaterDisposed = false
function cleanupUpdater(): void {
  if (updaterDisposed) return
  updaterDisposed = true
  stopUpdateListeners.forEach(stop => { try { stop() } catch {} })
  try { stopProjection?.() } catch {}
  stopDomListeners.forEach(stop => { try { stop() } catch {} })
  document.getElementById('acrylic-overlay-style')?.remove()
}
onBeforeUnmount(cleanupUpdater)`);
    for (const tag of ['template', 'style']) {
        const expression = new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/' + tag + '>', 'g');
        if (JSON.stringify(before.match(expression)) !== JSON.stringify(source.match(expression)))
            throw new Error('Updater template/style changed');
    }
    return source;
}
export function updaterPatchReceipt(before, after) {
    return { ...UPDATER_PATCH, afterSha256: sha(after), beforeSha256: sha(before) };
}
