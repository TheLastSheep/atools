import assert from 'node:assert/strict'
import { cleanup, createHarness, expectCode } from './ztools-settings-child-bridge-test-helpers.mjs'

async function testBothApiProxiesShareSafeLookupBehavior() {
  const harness = createHarness()
  try {
    const proxies = [harness.target.ztools, harness.target.ztools.internal]
    for (const proxy of proxies) {
      assert.equal(proxy.then, undefined)
      assert.equal(await Promise.resolve(proxy), proxy)

      const stringProbe = '__receiverProbe'
      Object.defineProperty(proxy, stringProbe, {
        configurable: true,
        get() { return this }
      })
      assert.equal(proxy[stringProbe], proxy)

      const symbolProbe = Symbol('receiverProbe')
      Object.defineProperty(proxy, symbolProbe, {
        configurable: true,
        get() { return this }
      })
      assert.equal(proxy[symbolProbe], proxy)
      assert.equal(proxy[Symbol('missing')], undefined)
    }

    const nativeCalls = harness.calls.length
    const errorCount = harness.errors.length
    await expectCode(harness.target.ztools.unknownOuterMethod(), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
    await expectCode(harness.target.ztools.internal.unknownInnerMethod(), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
    await expectCode(harness.target.ztools.toString(), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
    await expectCode(harness.target.ztools.internal.toString(), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')

    assert.equal(harness.errors.length - errorCount, 4)
    assert.deepEqual(harness.errors.slice(errorCount), Array(4).fill('此设置暂不支持修改。'))
    assert.equal(harness.calls.length, nativeCalls)
  } finally {
    harness.bridge.dispose()
  }
}

try {
  await testBothApiProxiesShareSafeLookupBehavior()
  process.stdout.write('PASS testBothApiProxiesShareSafeLookupBehavior\n')
} finally {
  await cleanup()
}
