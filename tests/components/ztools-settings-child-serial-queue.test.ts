import { describe, expect, it } from 'vitest'
import { createSettingsChildSerialQueue } from '../../packages/ztools-settings/src/childBridgeSerialQueue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('settings child serial queue', () => {
  it('runs queued work once at a time in FIFO order', async () => {
    const firstGate = deferred<void>()
    const secondDone = deferred<void>()
    const order: number[] = []
    let active = 0
    let maxActive = 0
    const queue = createSettingsChildSerialQueue(() => true, async (value: number) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(value)
      if (value === 1) await firstGate.promise
      active -= 1
      if (value === 2) secondDone.resolve()
    })

    queue.enqueue(1)
    queue.enqueue(2)
    expect(order).toEqual([1])
    firstGate.resolve()
    await secondDone.promise

    expect(order).toEqual([1, 2])
    expect(maxActive).toBe(1)
  })

  it('allows an owner to drain queued work before the runner becomes live', async () => {
    let live = false
    const processed: number[] = []
    const queue = createSettingsChildSerialQueue(() => live, async (value: number) => {
      processed.push(value)
    })

    queue.enqueue(1)
    queue.enqueue(2)
    expect(queue.drain()).toEqual([1, 2])
    live = true
    queue.enqueue(3)
    await Promise.resolve()

    expect(processed).toEqual([3])
  })
})
