import { formatConsoleArgs } from '../chrome-cdp-smoke-utils.mjs'

/** Limits are per collection; never discard overflow without marking the run failed. */
export function capDiagnostics(report) {
  const collections = {
    'console.exceptions':report.console.exceptions, 'console.errors':report.console.errors,
    'console.warnings':report.console.warnings, 'console.unhandled':report.console.unhandled,
    'network.requests':report.network.requests, 'network.denied':report.network.denied,
    'network.externalAttempts':report.network.externalAttempts, 'network.failures':report.network.failures,
  }
  report.diagnosticOverflow = {}
  for (const [name, collection] of Object.entries(collections)) {
    const limit = name === 'network.requests' ? 512 : 200, push = collection.push.bind(collection)
    report.diagnosticOverflow[name] = {limit, dropped:0}
    collection.push = (...items) => {
      for (const item of items) {
        if (collection.length < limit) { push(item) }
        else {
          const counter = report.diagnosticOverflow[name]
          if (counter.dropped++ === 0) report.cleanup.errors.push(`${name} diagnostic limit exceeded`)
        }
      }
      return collection.length
    }
  }
}
const routeOf = value => {
  try { const hash = new URL(value).hash; return ['#/about','#/allCommands','#/generalSetting'].includes(hash) ? hash : hash ? '#other' : 'none' }
  catch { return 'unknown' }
}
/** Timeline never records arbitrary paths or tokens. Route is last CDP-observed, not a claim about later async work. */
export function createAboutTimeline({ report, getStage, getSession, now = () => Date.now() }) {
  const entries = []; let lastRoute = 'unknown', conflictSession = null, lastSession = null, phase = 'not-open'
  report.aboutTimeline = { entries, limit:200, dropped:0 }
  function note(kind, details = {}) {
    if (entries.length >= 200) { if (report.aboutTimeline.dropped++ === 0) report.cleanup.errors.push('about timeline diagnostic limit exceeded'); return }
    const active = getSession(), session = active ?? lastSession
    entries.push({ at:now(), kind, stage:getStage(), session:session?.slice(0,8) ?? null,
      liveness:active ? 'active-synthetic-session' : 'no-active-synthetic-session', phase, route:lastRoute,
      conflictKnown:!!session && session === conflictSession, ...details })
  }
  return {
    note,
    route(url) { lastRoute = routeOf(url); note('route-observed') },
    opened() { lastSession=getSession(); phase='open'; note('child-opened') },
    closing() { phase='close-requested'; note('child-close-requested') },
    pagehide() { phase='pagehide'; note('child-pagehide') },
    closed() { phase='closed'; note('child-closed') },
    operation(operation, status, code, originSession = getSession()) {
      if (!['readGeneral','setAutoCheckUpdate','patchGeneral','getAppVersion','checkAppUpdate'].includes(operation)) return
      if (operation === 'setAutoCheckUpdate' && code === 'SETTINGS_REVISION_CONFLICT') conflictSession = originSession
      const active = getSession()
      note('about-operation', { session:originSession?.slice(0,8) ?? null, liveness:originSession && active === originSession ? 'active-synthetic-session' : 'not-current-synthetic-session', conflictKnown:!!originSession && originSession === conflictSession, operation, status, code:code === 'SETTINGS_REVISION_CONFLICT' ? code : null })
    },
    console(event) {
      if (!['error','assert'].includes(event.type)) return
      const text = formatConsoleArgs(event.args).slice(0,1600)
      const known = text.startsWith('加载设置失败:')
      const stack = (event.stackTrace?.callFrames ?? []).slice(0,8).map(f => ({ functionName:String(f.functionName ?? '').slice(0,80), line:f.lineNumber, column:f.columnNumber }))
      const described = text.split('\n').slice(1,9).map(line => { const match = line.match(/at\s+([^ (]{1,80})[^\n]*:(\d+):(\d+)\)?$/); return match ? {functionName:match[1],line:Number(match[2]),column:Number(match[3])} : null }).filter(Boolean)
      note('console-error', { source:known ? 'GeneralSetting.loadSettings' : 'other', operation:known ? 'loadSettings' : 'unknown', knownMessage:known ? '加载设置失败' : 'unclassified', stack:stack.length ? stack : described })
    },
  }
}
