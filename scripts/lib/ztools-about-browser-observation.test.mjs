import test from 'node:test'
import assert from 'node:assert/strict'
import { assertMainPreference, assertSettledAuto, captureFailureFacts, compactFixture } from './ztools-about-browser-observation.mjs'
import { createAboutBrowserFixture } from './ztools-about-browser-fixture.mjs'

test('notice assertion requires real store, same candidate, closed plugin and visible true/false', () => {
  const on = { storeAvailable:true, auto:true, pluginActive:false, candidate:{hasUpdate:true,version:'1.0.0'},noticeExists:true,noticeVisible:true,shouldShow:true }
  const expected = {enabled:true,pluginActive:false,candidateVersion:'1.0.0'}
  assert.doesNotThrow(() => assertMainPreference(on, expected))
  for (const bad of [{...on,storeAvailable:false},{...on,pluginActive:true},{...on,candidate:{hasUpdate:true,version:'2'}},{...on,auto:false},{...on,noticeVisible:false}]) assert.throws(() => assertMainPreference(bad, expected))
  assert.doesNotThrow(() => assertMainPreference({...on,auto:false,noticeExists:false,noticeVisible:false,shouldShow:false},{...expected,enabled:false}))
})
test('only settled revision receipt and delivered boolean pass', async () => {
  const f = createAboutBrowserFixture(), beforeRevision = f.read().revision
  const result = await f.handle({ operation:'setAutoCheckUpdate',payload:{revision:beforeRevision,enabled:false},sessionId:'s' }, {sessionId:'s',publish:async()=>1})
  assert.equal(result.ok, true); const call = f.snapshot().calls.at(-1), expected = {enabled:false,beforeRevision}
  assert.doesNotThrow(() => assertSettledAuto(call, expected))
  for (const bad of [{...call,status:'pending'},{...call,receipt:{...call.receipt,revision:beforeRevision}},{...call,delivery:{payload:true,count:1}},{...call,delivery:{payload:false,count:0}}]) assert.throws(() => assertSettledAuto(bad, expected))
})
test('failure facts use only bounded allowlisted synthetic metrics before cleanup', async () => {
  const f=createAboutBrowserFixture(); const metrics=compactFixture(f.snapshot())
  assert.deepEqual(metrics.counts, {}); const facts=await captureFailureFacts({runtime:null,mainPage:null,childPage:null,fixture:f,pendingNative:new Set(),stage:'r79-failure'})
  assert.equal(facts.stage,'r79-failure'); assert.equal(facts.synthetic,true); assert.equal(facts.nativePending,0)
  assert.equal(Object.hasOwn(facts.about,'raw'),false)
})

test('committed, rejected, and partial outcomes retain their distinct saved truths', async () => {
  const { assertAutoOutcome } = await import('./ztools-about-browser-observation.mjs')
  const cases = [
    {outcome:'committed',intent:false,confirmed:true,stored:false,checkbox:false},
    {outcome:'rejected',intent:false,confirmed:true,stored:true,checkbox:true},
    {outcome:'partial',intent:false,confirmed:true,stored:false,checkbox:false},
  ]
  for (const value of cases) {
    assert.doesNotThrow(() => assertAutoOutcome(value))
    assert.throws(() => assertAutoOutcome({...value,checkbox:!value.checkbox}))
    assert.throws(() => assertAutoOutcome({...value,stored:!value.stored}))
  }
  assert.throws(() => assertAutoOutcome({...cases[0],outcome:'unknown'}))
})
