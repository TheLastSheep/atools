import { createHash } from 'node:crypto'

const path = 'src/renderer/src/components/search/SearchBox.vue'
const beforeSha256 = 'de0235b2918b3e4763fb909ccbbf1a47bf27aed317f686d56a358bd34a593c83'
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Main drop compatibility marker mismatch')
  return source.replace(before, after)
}
export function patchMainDrop(source) {
  source = replace(source, 'const dragCounter = ref(0) // 拖动计数器，处理嵌套元素的 dragenter/dragleave', `const dragCounter = ref(0) // 拖动计数器，处理嵌套元素的 dragenter/dragleave
let mainDrop: { setActive(active: boolean): void; dispose(): void } | undefined
watch(() => props.currentView, view => mainDrop?.setActive(view === 'search'))`)
  for (const name of ['handleDragEnter', 'handleDragLeave', 'handleDrop']) {
    const start = name === 'handleDrop' ? `async function ${name}(event: DragEvent): Promise<void>` : `function ${name}(event: DragEvent): void`
    source = replace(source, `${start} {\n  event.preventDefault()\n  event.stopPropagation()`, `${start} {\n  event.preventDefault()\n  event.stopPropagation()\n  if (mainDrop) return`)
  }
  source = replace(source, 'onMounted(() => {\n  // 初始化输入框宽度', `onMounted(() => {
  const api = window.ztools as unknown as { onNativeMainFileDrop?: (element: HTMLElement, callback: (event: { phase: string; hovered?: boolean; files?: FileItem[] }) => void) => { setActive(active: boolean): void; dispose(): void } }
  if (searchBoxRef.value && typeof api.onNativeMainFileDrop === 'function') {
    mainDrop = api.onNativeMainFileDrop(searchBoxRef.value, event => {
      if (event.phase === 'hover') isDraggingOver.value = event.hovered === true
      else {
        if (event.phase === 'drop' && event.files?.length) {
          emit('update:pastedFiles', event.files)
          emit('update:modelValue', '')
        }
      }
    })
    mainDrop.setActive(props.currentView === 'search')
  }
  // 初始化输入框宽度`)
  return replace(source, 'onUnmounted(() => {\n  resizeObserver?.disconnect()', `onUnmounted(() => {
  mainDrop?.dispose()
  mainDrop = undefined
  resizeObserver?.disconnect()`)
}
export const MAIN_DROP_PATCH = Object.freeze({ id: 'main-native-file-drop', path, beforeSha256, afterSha256: '51aaebbf9e595b448e93662a250cf64e875839173add4a5fe2e8f2ff42d6b2c8' })
export function patchedMainDropSha(source) { return createHash('sha256').update(patchMainDrop(source)).digest('hex') }
