export interface SettingsChildSerialQueue<T> {
  enqueue(value: T): void
  drain(): T[]
}

export function createSettingsChildSerialQueue<T>(
  canRun: () => boolean,
  run: (value: T) => Promise<void>
): SettingsChildSerialQueue<T> {
  const pending: T[] = []
  let running = false

  async function pump(): Promise<void> {
    if (running || !canRun()) return
    running = true
    try {
      while (canRun() && pending.length > 0) await run(pending.shift()!)
    } finally {
      running = false
      if (pending.length > 0 && canRun()) void pump()
    }
  }

  return {
    enqueue(value) {
      pending.push(value)
      void pump()
    },
    drain: () => pending.splice(0)
  }
}
