/** Bound drain; timeout is a failure, but all owned cleanup and report stages still execute. */
export async function finishAboutCleanup({ pending, timeoutMs, onTimeout, cleanup, writeReport }) {
  let timer
  if (pending.size) {
    const settled = await Promise.race([
      Promise.allSettled([...pending]).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    clearTimeout(timer)
    if (!settled) onTimeout()
  }
  try { await cleanup() } finally { await writeReport() }
}
