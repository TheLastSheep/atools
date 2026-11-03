import test from 'node:test'
import assert from 'node:assert/strict'
import { capDiagnostics, createAboutTimeline } from './ztools-about-browser-diagnostics.mjs'
function report() { return { console:{exceptions:[],errors:[],warnings:[],unhandled:[]}, network:{requests:[],denied:[],externalAttempts:[],failures:[]},cleanup:{errors:[]} } }
test('R79 retains 512 mixed network records; 513th and other collection overflow fail independently', () => {
  const r=report();capDiagnostics(r)
  for(let i=0;i<512;i++) r.network.requests.push({type:i%2 ? 'data' : 'local'})
  assert.equal(r.network.requests.length,512);assert.equal(r.cleanup.errors.length,0)
  r.network.requests.push({type:'external'});r.network.requests.push({type:'data'})
  assert.equal(r.network.requests.length,512);assert.equal(r.diagnosticOverflow['network.requests'].dropped,2)
  for(let i=0;i<201;i++)r.console.errors.push({})
  assert.equal(r.console.errors.length,200);assert.equal(r.diagnosticOverflow['console.errors'].dropped,1)
  assert.deepEqual(r.cleanup.errors,['network.requests diagnostic limit exceeded','console.errors diagnostic limit exceeded'])
})
test('bounded timeline correlates observed route, conflict, close and error without paths or tokens', () => {
  const r=report();let session='12345678secret';let time=0
  const d=createAboutTimeline({report:r,getStage:()=> 'r79-auto-conflict',getSession:()=>session,now:()=>++time})
  d.route('http://example.invalid/setting/index.html#/about');d.opened();d.operation('setAutoCheckUpdate','rejected','SETTINGS_REVISION_CONFLICT');d.closing();session=null
  d.console({type:'error',args:[{value:'加载设置失败:'},{description:'SettingsBridgeError: rejected\n    at Y (http://secret.invalid/file.js:18:35356)'}]});d.pagehide()
  const error=r.aboutTimeline.entries.find(e=>e.kind==='console-error')
  assert.equal(error.route,'#/about');assert.equal(error.conflictKnown,true);assert.equal(error.phase,'close-requested');assert.equal(error.liveness,'no-active-synthetic-session')
  assert.deepEqual(error.stack,[{functionName:'Y',line:18,column:35356}]);assert.ok(!JSON.stringify(r.aboutTimeline).includes('secret.invalid'))
  for(let i=0;i<201;i++)d.note('test');assert.equal(r.aboutTimeline.entries.length,200);assert.ok(r.aboutTimeline.dropped>0);assert.ok(r.cleanup.errors.includes('about timeline diagnostic limit exceeded'))
})

test('known General error remains an acceptance blocker', async () => {
  const { classifySettingsInputSlice } = await import('./ztools-settings-input-browser-acceptance.mjs')
  const r=report();capDiagnostics(r);r.console.errors.push({page:'child',type:'error',text:'加载设置失败: SettingsBridgeError: 设置已变化，请关闭并重新打开。'})
  const result=classifySettingsInputSlice({mode:'acceptance',acceptanceCompleted:true,checksCount:1,sourceStable:true,resourcesClean:true,cleanupErrorCount:0,updaterCapability:'limited',consoleDiagnostics:{...r.console,expectedAliasConflict:[]},network:{...r.network,pending:0},serverRejected:0})
  assert.equal(result.passed,false);assert.ok(result.blockers.includes('other_console_or_runtime_issues'));assert.equal(r.console.errors.length,1)
})
