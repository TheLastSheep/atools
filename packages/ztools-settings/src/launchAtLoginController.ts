import {
  LAUNCH_AT_LOGIN_CONFLICT_CODE,
  LAUNCH_AT_LOGIN_LEGACY_CODE,
  LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE,
  LAUNCH_AT_LOGIN_UNSUPPORTED_CODE,
  LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE,
  launchAtLoginErrorMessage,
  parseLaunchAtLoginEnabled,
  parseLaunchAtLoginInspection
} from './launchAtLoginContract'
import type {
  LaunchAtLoginChoice,
  LaunchAtLoginInspection,
  LaunchAtLoginResolutionRequest
} from './launchAtLoginContract'

export {
  LAUNCH_AT_LOGIN_CONFLICT_CODE,
  LAUNCH_AT_LOGIN_LEGACY_CODE,
  launchAtLoginErrorMessage
} from './launchAtLoginContract'
export type {
  LaunchAtLoginChoice,
  LaunchAtLoginInspection,
  LaunchAtLoginResolutionRequest
} from './launchAtLoginContract'

export type LaunchAtLoginPhase = 'loading' | 'ready' | 'saving' | 'resolving' | 'legacy' | 'error'

export type LaunchAtLoginState = Readonly<{
  phase: LaunchAtLoginPhase
  enabled: boolean | null
  message: string
  retryable: boolean
  legacy: LaunchAtLoginInspection | null
}>

function makeState(
  phase: LaunchAtLoginPhase,
  message: string,
  enabled: boolean | null = null,
  retryable = false,
  legacy: LaunchAtLoginInspection | null = null
): LaunchAtLoginState {
  return { phase, enabled, message, retryable, legacy }
}

function invalidLoginItemResponse(): Error {
  return new Error('Invalid login-item response')
}

export type LaunchAtLoginPort = Readonly<{
  read(): Promise<unknown>
  change(request: Readonly<{ expected: boolean; enabled: boolean }>): Promise<unknown>
  inspectLegacy?(): Promise<unknown>
  resolveLegacy?(request: LaunchAtLoginResolutionRequest): Promise<unknown>
}>

export interface LaunchAtLoginHostApi {
  getLaunchAtLogin(): Promise<boolean>
  setLaunchAtLogin(enabled: boolean): Promise<void>
  inspectLegacyLaunchAtLogin(): Promise<LaunchAtLoginInspection>
  resolveLegacyLaunchAtLogin(request: LaunchAtLoginResolutionRequest): Promise<{ enabled: boolean }>
}

export function createLaunchAtLoginController(port: LaunchAtLoginPort) {
  let current = makeState('loading', '正在读取…')
  let generation = 0
  let started = false
  let inFlight = false
  let disposed = false
  const subscribers = new Set<(state: LaunchAtLoginState) => void>()

  function publish(
    phase: LaunchAtLoginPhase,
    message: string,
    enabled: boolean | null = null,
    retryable = false,
    legacy: LaunchAtLoginInspection | null = null
  ) {
    current = makeState(phase, message, enabled, retryable, legacy)
    for (const subscriber of subscribers) subscriber(current)
  }

  function publishFailure(error: unknown) {
    const code = errorCode(error)
    publish(
      'error',
      code && launchAtLoginErrorMessage(code) || LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE,
      null,
      code !== LAUNCH_AT_LOGIN_UNSUPPORTED_CODE && code !== LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE
    )
  }

  function assertLive(request: number): boolean {
    return !disposed && request === generation
  }

  async function read() {
    if (disposed || inFlight) return false
    const request = ++generation
    inFlight = true
    publish('loading', '正在读取…')
    try {
      const enabled = parseLaunchAtLoginEnabled(await port.read())
      if (enabled === null) throw invalidLoginItemResponse()
      if (!assertLive(request)) return false
      publish('ready', '', enabled)
      return true
    } catch (error) {
      if (!assertLive(request)) return false
      if (isLegacyOrUnknown(error) && port.inspectLegacy) {
        try {
          const legacy = parseLaunchAtLoginInspection(await port.inspectLegacy())
          if (!legacy) throw invalidLoginItemResponse()
          if (!assertLive(request)) return false
          publish(
            'legacy',
            legacy.modernEnabled
              ? '旧启动项存在；新启动项已启用。'
              : '旧启动项存在；新启动项未启用。',
            null,
            false,
            legacy
          )
          return true
        } catch (inspectionError) {
          if (!assertLive(request)) return false
          publishFailure(inspectionError)
          return false
        }
      }
      publishFailure(error)
      return false
    } finally {
      if (request === generation) inFlight = false
    }
  }

  async function write(
    phase: 'saving' | 'resolving',
    confirmedEnabled: boolean,
    legacy: LaunchAtLoginInspection | null,
    operation: () => Promise<unknown>
  ): Promise<boolean> {
    if (disposed || inFlight) return false
    const request = ++generation
    inFlight = true
    publish(
      phase,
      phase === 'saving' ? '正在更新…' : '正在处理…',
      null,
      false,
      legacy
    )
    try {
      const reply = parseLaunchAtLoginEnabled(await operation())
      if (!assertLive(request)) return false
      if (reply === null || reply !== confirmedEnabled) throw invalidLoginItemResponse()
      publish('ready', '', reply)
      return true
    } catch (error) {
      if (!assertLive(request)) return false
      publishFailure(error)
      return false
    } finally {
      if (request === generation) inFlight = false
    }
  }

  return {
    state: () => current,
    subscribe(subscriber: (state: LaunchAtLoginState) => void) {
      if (disposed) return () => {}
      subscribers.add(subscriber)
      subscriber(current)
      return () => subscribers.delete(subscriber)
    },
    start() {
      if (started || disposed) return Promise.resolve(false)
      started = true
      return read()
    },
    refresh: read,
    async setEnabled(enabled: boolean) {
      if (disposed || inFlight || current.phase !== 'ready' || current.enabled === null) return false
      const expected = current.enabled
      return write(
        'saving', enabled, null,
        () => port.change({ expected, enabled })
      )
    },
    async resolveLegacy(choice: LaunchAtLoginChoice) {
      const legacy = current.legacy
      if (disposed || inFlight || current.phase !== 'legacy' || !legacy || !port.resolveLegacy) return false
      return write(
        'resolving', choice === 'migrate', legacy,
        () => port.resolveLegacy!({
          choice,
          expectedModern: legacy.modernEnabled,
          revision: legacy.revision,
        })
      )
    },
    deferLegacy() {
      if (disposed || inFlight || current.phase !== 'legacy') return
      generation += 1
      publish('error', '未作更改，启动项状态未知。', null, true)
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      inFlight = false
      subscribers.clear()
    },
  }
}

export type LaunchAtLoginController = ReturnType<typeof createLaunchAtLoginController>

export function createLaunchAtLoginControllerForHost(api: LaunchAtLoginHostApi) {
  return createLaunchAtLoginController({
    read: async () => ({ enabled: await api.getLaunchAtLogin() }),
    change: async ({ enabled }) => {
      await api.setLaunchAtLogin(enabled)
      return { enabled }
    },
    inspectLegacy: () => api.inspectLegacyLaunchAtLogin(),
    resolveLegacy: (request) => api.resolveLegacyLaunchAtLogin(request),
  })
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function isLegacyOrUnknown(error: unknown): boolean {
  const code = errorCode(error)
  return code === LAUNCH_AT_LOGIN_LEGACY_CODE || code === LAUNCH_AT_LOGIN_CONFLICT_CODE
}

