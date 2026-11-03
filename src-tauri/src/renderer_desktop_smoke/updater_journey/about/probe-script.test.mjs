import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./probe.js', import.meta.url), 'utf8')
const token = 'a'.repeat(32)
function setup(role, options = {}) {
  const sent = [], nativeCalls = [], state = { version:null, checked:false, disabled:false, disposed:false, opened:0, closed:0 }
  const checkbox = { get checked() { return state.checked }, click() { state.checked = !state.checked; void window.ztools.internal.updaterSetAutoCheck(state.checked) } }
  const button = { get disabled() { return state.disabled }, click() { state.disabled=true; void window.ztools.internal.updaterCheckUpdate().then(() => {state.disabled=false}, () => {state.disabled=false}) } }
  const version = { get textContent() { return state.version ? `v${state.version}` : '' } }
  const title = { textContent:'更新 99.78.0' }, confirm = { disabled:false }
  const internal = {
    getAppVersion: () => Promise.resolve('0.9.79'),
    updaterCheckUpdate: () => Promise.resolve({success:true,hasUpdate:true,status:'available',updateInfo:{version:'99.78.0',changelog:'fixture'}}),
    updaterSetAutoCheck: enabled => Promise.resolve({revision:(enabled?'1':'2').repeat(32),value:{autoCheckUpdate:enabled},notificationDelivered:true,runtimeApplied:true,runtimeError:null}),
  }
  const window = { ztools:role==='child'?{internal,outPlugin(){state.closed++;return Promise.resolve()}}:role==='main'?{openSettings(){state.opened++}}:{updater:{startUpdate(){}}},
    __ATOOLS_SETTINGS_VIEW_CONFIG__:role==='child'?{bundleRevision:'b'.repeat(64)}:undefined,
    __ATOOLS_UPDATER_WINDOW_ID__:'c'.repeat(32),
    __ATOOLS_ZTOOLS_HOST_ADAPTER__:{snapshot:()=>({disposed:state.disposed,outstandingNativeCalls:0})},
    __TAURI_INTERNALS__:{invoke(command,args) { nativeCalls.push({command,args}); if(command==='updater_about_observe') {
      if(args.token!==token && options.holdBadToken)return new Promise(() => {});
      if(args.token!==token || role==='main' && args.stage==='popup-ready')return Promise.reject(Error('forbidden'));
      sent.push(args);return Promise.resolve()
    } return Promise.resolve() }},
    dispatchEvent(event){ if(event.type==='pagehide'){state.disposed=true;window.ztools=undefined} },
  }
  const aboutMenu={querySelector:()=>({textContent:'关于'}),click(){void window.ztools.internal.getAppVersion().then(v=>{state.version=v})}}
  const document={ querySelector(selector) { return ({'.about-version':role==='child'?version:null,'#auto-check-update':role==='child'?checkbox:null,
    '.check-update-btn':role==='child'?button:null,'.settings-sidebar .menu-item':role==='child'?aboutMenu:null,'.title':role==='popup'?title:null,
    '.update-window':role==='popup'?{textContent:'更新 99.78.0'}:null,'.btn.confirm':role==='popup'?confirm:null})[selector] ?? null },
    querySelectorAll:selector=>selector==='.settings-sidebar .menu-item'?[aboutMenu]:[] }
  const timeout = options.shortDeadline ? (fn, ms) => setTimeout(fn, ms === 12000 ? 5 : ms) : setTimeout
  const context={window,document,TextEncoder,performance,setTimeout:timeout,clearTimeout,Promise,Reflect,Event};
  runInNewContext(source.replace('"__UPDATER_ABOUT_NATIVE_TOKEN__"',JSON.stringify(token)),context)
  return {probe:window.__ATOOLS_UPDATER_ABOUT_NATIVE_PROBE__,sent,nativeCalls,state,window}
}
const keys = value => Object.keys(value).sort()
test('main negative admissions are real rejected invocations and opener only calls original facade', async () => {
  const f=setup('main'); await f.probe.run('main-ready'); f.probe.openSettings()
  assert.equal(f.state.opened,1); assert.equal(f.nativeCalls.filter(x=>x.command==='updater_about_observe').length,3)
  const row=f.sent[0]; assert.deepEqual(JSON.parse(JSON.stringify(row.receipt.receipt.negative)),{badToken:true,wrongFrame:true})
  assert.deepEqual(keys(row.receipt.dom),['appVersion','autoChecked','bridgePresent','bundleRevision','checkDisabled','disposed','ready','text','title'])
})
test('child actual calls are forwarded once and stage receipts preserve committed result', async () => {
  const f=setup('child'); await f.probe.run('about-ready'); await f.probe.run('about-manual'); await f.probe.run('auto-on'); await f.probe.run('auto-off'); await f.probe.closeSettings()
  assert.equal(f.state.closed,1); assert.deepEqual(f.sent.map(x=>x.stage),['about-ready','about-manual','auto-on','auto-off'])
  const rows=f.sent.map(x=>JSON.parse(JSON.stringify(x.receipt.receipt)))
  assert.deepEqual(rows.map(x=>x.apiCalls),[{version:1,manual:0,auto:0},{version:1,manual:1,auto:0},{version:1,manual:1,auto:1},{version:1,manual:1,auto:2}])
  assert.equal(rows[0].version,'0.9.79'); assert.equal(rows[1].manual.version,'99.78.0'); assert.equal(rows[2].auto.autoValue,true);assert.equal(rows[3].auto.autoValue,false)
  assert.ok(f.sent.every(x=>Buffer.byteLength(JSON.stringify(x.receipt))<=8192));assert.equal(f.sent[0].receipt.dom.appVersion,'v0.9.79')
})
test('popup uses real bridge disposal then exact-window close, no download', async () => {
  const f=setup('popup');await f.probe.run('popup-ready');await f.probe.run('popup-disposed')
  assert.equal(f.sent[1].receipt.dom.disposed,true);assert.equal(f.sent[1].receipt.dom.bridgePresent,false)
  const actions=f.nativeCalls.filter(x=>x.command==='renderer_updater_window');assert.equal(actions.length,1)
  assert.equal(actions[0].args.request.op,'close');assert.equal(actions[0].args.request.windowId,'c'.repeat(32))
})
test('unsupported Native-only stage refuses before sending', async () => {
  const f=setup('main');await assert.rejects(f.probe.run('settings-closed'));assert.equal(f.sent.length,0)
})


test('rejected original facade is reported as failure without a fabricated result', async () => {
  const f=setup('child'); f.window.ztools.internal.updaterCheckUpdate=()=>Promise.reject(Error('fixture failure'))
  await f.probe.run('about-ready'); await f.probe.run('about-manual')
  const failure=f.sent.at(-1).receipt
  assert.equal(failure.dom.ready,false);assert.match(failure.dom.text,/request failed/);assert.equal(failure.receipt.manual,null)
})


test('negative admission timeout is failure, never counted as rejection', async () => {
  const f=setup('main',{holdBadToken:true,shortDeadline:true});await f.probe.run('main-ready')
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].receipt.dom.ready,false)
  assert.equal(f.sent[0].receipt.receipt.negative,null);assert.match(f.sent[0].receipt.dom.text,/timed out/)
})
