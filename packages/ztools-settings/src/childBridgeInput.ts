import type {
  SettingsBridgeTarget,
  SettingsNativeInvoke,
  SettingsSubInputAction,
  SettingsSubInputDelivery,
  SettingsSubInputReply,
  SettingsViewConfig
} from './childBridgeTypes'
import {
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  boundedUtf8String,
  cloneJson,
  isExactRecord
} from './childBridgeProtocol'
import { createSettingsChildSerialQueue } from './childBridgeSerialQueue'

const MAX_PENDING_INPUT_OPERATIONS = 32
const MAX_INPUT_TEXT_BYTES = 16 * 1024
const MAX_INPUT_PLACEHOLDER_BYTES = 512
const MAX_INPUT_OPERATION_BYTES = 32 * 1024
const INPUT_OPERATION_FAILURE = '输入框状态未同步，请重试。'
const INPUT_QUEUE_FAILURE = '输入框操作较多，请稍后重试。'

interface SettingsChildInputOperation {
  action: SettingsSubInputAction
  generation: number
  sequence: number
  placeholder?: string
  focus?: boolean
  value?: string
}

interface SettingsChildInputRequest {
  operation: SettingsChildInputOperation
  resolve: (applied: boolean) => void
  settled: boolean
}

export interface SettingsChildInputApi {
  setSubInput: (callback?: unknown, placeholder?: unknown, focus?: unknown) => Promise<boolean>
  removeSubInput: () => Promise<boolean>
  setSubInputValue: (text: unknown) => Promise<boolean>
  subInputFocus: () => boolean
  subInputBlur: () => boolean
  subInputSelect: () => boolean
}

export interface SettingsChildInputBridge extends SettingsChildInputApi {
  attach(target: SettingsBridgeTarget): void
  stop(): void
  dispose(): void
}

export interface SettingsChildInputBridgeOptions {
  config: SettingsViewConfig
  invokeNative: (operation: Parameters<SettingsNativeInvoke>[0], payload: Record<string, unknown>) => Promise<unknown>
  isLive: () => boolean
  reportError: (message: string) => void
}

export function createSettingsChildInputBridge(
  options: SettingsChildInputBridgeOptions
): SettingsChildInputBridge {
  let target: SettingsBridgeTarget | null = null
  let previousDeliveryHook: SettingsBridgeTarget['__ATOOLS_SETTINGS_DELIVER_INPUT__']
  let disposed = false
  let stopped = false
  let generation = 0
  let sequence = 0
  let lastRevision = 0
  let lastDeliveryRevision = 0
  let visible = false
  let callback: ((payload: { text: string }) => unknown) | null = null
  let inFlight: SettingsChildInputRequest | null = null
  let pendingCount = 0
  const operationQueue = createSettingsChildSerialQueue<SettingsChildInputRequest>(canOperate, processOperation)

  function canOperate(): boolean {
    if (disposed || stopped) return false
    return options.isLive()
  }

  function report(message = INPUT_OPERATION_FAILURE): void {
    if (!canOperate()) return
    try {
      options.reportError(message)
    } catch {}
  }

  function nextSequence(): number | null {
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      report()
      return null
    }
    sequence += 1
    return sequence
  }

  function nextGeneration(): number | null {
    if (generation >= Number.MAX_SAFE_INTEGER) {
      report()
      return null
    }
    generation += 1
    return generation
  }

  function setSubInput(rawCallback?: unknown, rawPlaceholder?: unknown, rawFocus?: unknown): Promise<boolean> {
    if (!canOperate()) return Promise.resolve(false)
    if ((rawCallback !== undefined && typeof rawCallback !== 'function') ||
      (rawPlaceholder !== undefined && !boundedUtf8String(rawPlaceholder, MAX_INPUT_PLACEHOLDER_BYTES)) ||
      (rawFocus !== undefined && typeof rawFocus !== 'boolean')) {
      report()
      return Promise.resolve(false)
    }
    const next = nextGeneration()
    if (next === null) return Promise.resolve(false)
    callback = typeof rawCallback === 'function'
      ? rawCallback as (payload: { text: string }) => unknown
      : null
    visible = true
    const placeholder = typeof rawPlaceholder === 'string' && rawPlaceholder.length > 0 ? rawPlaceholder : '搜索'
    const focus = rawFocus === undefined ? true : rawFocus as boolean
    return enqueue({ action: 'set', generation: next, placeholder, focus })
  }

  function removeSubInput(): Promise<boolean> {
    if (!canOperate()) return Promise.resolve(false)
    const next = nextGeneration()
    callback = null
    visible = false
    if (next === null) return Promise.resolve(false)
    return enqueue({ action: 'remove', generation: next })
  }

  function setSubInputValue(rawText: unknown): Promise<boolean> {
    if (!canOperate()) return Promise.resolve(false)
    if (!boundedUtf8String(rawText, MAX_INPUT_TEXT_BYTES) || !visible) {
      report()
      return Promise.resolve(false)
    }
    const nextSequenceValue = nextSequence()
    if (nextSequenceValue === null) return Promise.resolve(false)
    return enqueueWithSequence({
      action: 'value', generation, sequence: nextSequenceValue, value: rawText
    })
  }

  function subInputFocus(): boolean {
    return enqueueControl('focus')
  }

  function subInputBlur(): boolean {
    return enqueueControl('blur')
  }

  function subInputSelect(): boolean {
    return enqueueControl('select')
  }

  function enqueueControl(action: 'focus' | 'blur' | 'select'): boolean {
    if (!canOperate()) return false
    const nextSequenceValue = nextSequence()
    if (nextSequenceValue === null || !visible || generation < 1) return false
    return enqueueWithSequence({ action, generation, sequence: nextSequenceValue }, true)
  }

  function enqueue(operation: Omit<SettingsChildInputOperation, 'sequence'>): Promise<boolean> {
    const nextSequenceValue = nextSequence()
    if (nextSequenceValue === null) return Promise.resolve(false)
    return enqueueWithSequence({ ...operation, sequence: nextSequenceValue })
  }

  function enqueueWithSequence(operation: SettingsChildInputOperation, synchronous: true): boolean
  function enqueueWithSequence(operation: SettingsChildInputOperation, synchronous?: false): Promise<boolean>
  function enqueueWithSequence(
    operation: SettingsChildInputOperation,
    synchronous = false
  ): Promise<boolean> | boolean {
    if (!canOperate()) return synchronous ? false : Promise.resolve(false)
    let payload: SettingsChildInputOperation
    try {
      payload = cloneJson(operation)
      assertJsonByteBudget(payload, MAX_INPUT_OPERATION_BYTES)
    } catch {
      report()
      return synchronous ? false : Promise.resolve(false)
    }
    if (!canOperate() || pendingCount >= MAX_PENDING_INPUT_OPERATIONS) {
      report(INPUT_QUEUE_FAILURE)
      return synchronous ? false : Promise.resolve(false)
    }

    let resolvePromise!: (applied: boolean) => void
    const promise = new Promise<boolean>((resolve) => { resolvePromise = resolve })
    const request: SettingsChildInputRequest = {
      operation: payload,
      resolve: resolvePromise,
      settled: false
    }
    pendingCount += 1
    operationQueue.enqueue(request)
    if (synchronous) {
      void promise.catch(() => {})
      return true
    }
    return promise
  }

  async function processOperation(request: SettingsChildInputRequest): Promise<void> {
    inFlight = request
    try {
      const raw = await options.invokeNative('updateSubInput', { ...request.operation })
      if (!canOperate()) {
        settle(request, false)
        return
      }
      const reply = validateReply(raw, request.operation.generation)
      if (reply.revision > lastRevision) lastRevision = reply.revision
      if (!reply.applied) report()
      settle(request, reply.applied)
    } catch {
      if (canOperate()) report()
      settle(request, false)
    } finally {
      if (inFlight === request) inFlight = null
    }
  }

  function settle(request: SettingsChildInputRequest, applied: boolean): void {
    if (request.settled) return
    request.settled = true
    pendingCount -= 1
    request.resolve(applied)
  }

  function deliverInput(raw: unknown): boolean {
    if (!canOperate() || !isExactRecord(raw, [
      'version', 'sessionId', 'bundleRevision', 'generation', 'revision', 'text'
    ])) return false
    let packet: SettingsSubInputDelivery
    try {
      packet = validateDelivery(raw)
    } catch {
      return false
    }
    if (packet.sessionId !== options.config.sessionId ||
      packet.bundleRevision !== options.config.bundleRevision ||
      packet.generation !== generation || !callback || packet.revision < lastRevision ||
      packet.revision <= lastDeliveryRevision) return false
    lastRevision = packet.revision
    lastDeliveryRevision = packet.revision
    try {
      const returned = callback({ text: packet.text })
      if (returned !== null && typeof returned === 'object' && 'then' in returned) {
        void Promise.resolve(returned).catch(() => {})
      }
      return true
    } catch {
      return false
    }
  }

  function attach(nextTarget: SettingsBridgeTarget): void {
    if (disposed || stopped || target) throw new SettingsBridgeProtocolError()
    target = nextTarget
    previousDeliveryHook = nextTarget.__ATOOLS_SETTINGS_DELIVER_INPUT__
    nextTarget.__ATOOLS_SETTINGS_DELIVER_INPUT__ = deliverInput
  }

  function stop(): void {
    if (disposed || stopped) return
    stopped = true
    callback = null
    visible = false
    for (const request of operationQueue.drain()) settle(request, false)
    if (inFlight) settle(inFlight, false)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stopped = true
    callback = null
    visible = false
    for (const request of operationQueue.drain()) settle(request, false)
    if (inFlight) settle(inFlight, false)
    if (target && target.__ATOOLS_SETTINGS_DELIVER_INPUT__ === deliverInput) {
      target.__ATOOLS_SETTINGS_DELIVER_INPUT__ = previousDeliveryHook
    }
    target = null
  }

  return {
    attach,
    setSubInput,
    removeSubInput,
    setSubInputValue,
    subInputFocus,
    subInputBlur,
    subInputSelect,
    stop,
    dispose
  }
}

function validateReply(value: unknown, expectedGeneration: number): SettingsSubInputReply {
  if (!isExactRecord(value, ['version', 'generation', 'revision', 'valueVersion', 'applied']) ||
    value.version !== 1 || value.generation !== expectedGeneration ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0 ||
    !Number.isSafeInteger(value.valueVersion) || (value.valueVersion as number) < 0 ||
    typeof value.applied !== 'boolean') throw new SettingsBridgeProtocolError()
  return value as SettingsSubInputReply
}

function validateDelivery(value: Record<string, any>): SettingsSubInputDelivery {
  if (value.version !== 1 || typeof value.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(value.sessionId) ||
    typeof value.bundleRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.bundleRevision) ||
    !Number.isSafeInteger(value.generation) || value.generation <= 0 ||
    !Number.isSafeInteger(value.revision) || value.revision <= 0 ||
    !boundedUtf8String(value.text, MAX_INPUT_TEXT_BYTES)) throw new SettingsBridgeProtocolError()
  return value as SettingsSubInputDelivery
}
